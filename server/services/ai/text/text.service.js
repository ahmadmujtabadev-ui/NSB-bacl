// server/services/ai/text/text.service.js
// FIXES:
// 1. Children below age 6 → no chapters, spreads-only mode
// 2. Per-page text + prompt history saved and returned
// 3. Arabic text hallucination fixed — strict transliteration system prompt
// 4. Humanize stage now works for spreadOnly books (humanizes flat spreads, no chapters)
// 5. Improved buildSpreadRerunPrompt — warm/vivid English, shows current text to AI

import { Project }       from '../../../models/Project.js';
import { Universe }      from '../../../models/Universe.js';
import { Character }     from '../../../models/Character.js';
import { KnowledgeBase } from '../../../models/KnowledgeBase.js';
import { NotFoundError } from '../../../errors.js';
import { generateText }  from './text.providers.js';
import { AI_TOKEN_BUDGETS, estimateTokens } from '../policies/tokenBudget.js';

// ─── Age helpers ──────────────────────────────────────────────────────────────

function isPictureBook(ageRange) {
  if (!ageRange) return true;
  const first = String(ageRange).match(/\d+/)?.[0];
  return first ? Number(first) <= 8 : true;
}

function isSpreadOnlyMode(ageRange) {
  if (!ageRange) return false;
  const first = String(ageRange).match(/\d+/)?.[0];
  return first ? Number(first) < 6 : false;
}

function getTextLimit(ageRange) {
  const first = Number(String(ageRange || '').match(/\d+/)?.[0] || 7);
  if (first <= 3) return { maxWords: 5,  sentences: 1, rhyme: true,  spreadOnly: true  };
  if (first <= 5) return { maxWords: 10, sentences: 1, rhyme: true,  spreadOnly: true  };
  if (first <= 6) return { maxWords: 15, sentences: 2, rhyme: true,  spreadOnly: false };
  if (first <= 8) return { maxWords: 25, sentences: 2, rhyme: false, spreadOnly: false };
  return { maxWords: 120, sentences: 8, rhyme: false, spreadOnly: false };
}

// ─── Array helpers ────────────────────────────────────────────────────────────

function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];
  const keys = Object.keys(val).map(Number).filter(n => !isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr;
}

function stripFences(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function safeParse(text) {
  const clean = stripFences(text);
  try {
    const parsed = JSON.parse(clean);
    console.log('[TextService] ✓ JSON parsed, keys:', Object.keys(parsed).join(', '));
    return parsed;
  } catch (err) {
    console.error('[TextService] ✗ JSON parse failed:', err.message);
    console.error('[TextService] Raw (first 500 chars):', text?.slice(0, 500));
    return { raw: text };
  }
}

// ─── Arabic safety block ──────────────────────────────────────────────────────

const ARABIC_PHRASES = {
  bismillah:       { arabic: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', transliteration: 'Bismillah ir-Rahman ir-Raheem', meaning: 'In the name of Allah, the Most Gracious, the Most Merciful' },
  alhamdulillah:   { arabic: 'الْحَمْدُ لِلَّهِ',                      transliteration: 'Alhamdulillah',                 meaning: 'All praise is for Allah' },
  subhanallah:     { arabic: 'سُبْحَانَ اللَّهِ',                      transliteration: 'SubhanAllah',                   meaning: 'Glory be to Allah' },
  allahu_akbar:    { arabic: 'اللَّهُ أَكْبَرُ',                       transliteration: 'Allahu Akbar',                  meaning: 'Allah is the Greatest' },
  inshallah:       { arabic: 'إِنْ شَاءَ اللَّهُ',                     transliteration: "In sha' Allah",                 meaning: 'If Allah wills' },
  mashallah:       { arabic: 'مَا شَاءَ اللَّهُ',                      transliteration: "Masha' Allah",                  meaning: 'What Allah has willed' },
  assalamu_alaykum:{ arabic: 'السَّلَامُ عَلَيْكُمْ',                  transliteration: 'Assalamu Alaykum',              meaning: 'Peace be upon you' },
  jazakallah_khair:{ arabic: 'جَزَاكَ اللَّهُ خَيْرًا',               transliteration: 'Jazakallah Khair',              meaning: 'May Allah reward you with goodness' },
  astaghfirullah:  { arabic: 'أَسْتَغْفِرُ اللَّهَ',                   transliteration: 'Astaghfirullah',                meaning: 'I seek forgiveness from Allah' },
  sabr:            { arabic: 'صَبْر',                                    transliteration: 'Sabr',                          meaning: 'Patience' },
  tawakkul:        { arabic: 'تَوَكُّل',                                 transliteration: 'Tawakkul',                      meaning: 'Trust in Allah' },
  shukr:           { arabic: 'شُكْر',                                    transliteration: 'Shukr',                         meaning: 'Gratitude' },
};

function buildArabicSafetyBlock() {
  const phraseList = Object.values(ARABIC_PHRASES)
    .map(p => `  • ${p.transliteration}: "${p.arabic}" — ${p.meaning}`)
    .join('\n');
  return `
╔══════════════════════════════════════════════════════════════╗
║           ARABIC TEXT — CRITICAL RULES                      ║
╠══════════════════════════════════════════════════════════════╣
║  NEVER generate Arabic script yourself — use EXACT          ║
║  Unicode from the approved list below ONLY.                 ║
╚══════════════════════════════════════════════════════════════╝

APPROVED ARABIC PHRASES:
${phraseList}

ARABIC RULES:
1. NEVER invent or generate your own Arabic script
2. ONLY use the exact Unicode strings from the list above
3. Always include: arabic (exact Unicode), transliteration, meaning
4. If phrase is NOT in the list, use ONLY the transliteration (English letters)
`;
}

// ─── Context Builder ──────────────────────────────────────────────────────────

export async function buildUniverseContext(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe   = project.universeId ? await Universe.findById(project.universeId) : null;
  const characters = project.characterIds?.length
    ? await Character.find({ _id: { $in: project.characterIds } })
    : universe
      ? await Character.find({ universeId: universe._id })
      : [];

  const kb = universe
    ? await KnowledgeBase.findOne({ universeId: universe._id, userId })
    : null;

  console.log(`[TextService] Context: project="${project.title}" universe="${universe?.name}" chars=${characters.length} kb=${!!kb}`);
  return { project, universe, characters, kb };
}

// ─── Prompt Blocks ────────────────────────────────────────────────────────────

function universeBlock(universe) {
  if (!universe) return '';
  const r = universe.islamicRules || {};
  return `UNIVERSE: ${universe.name}
Series Bible: ${universe.seriesBible || 'N/A'}
Art Style: ${universe.artStyle}
Color Palette: ${(universe.colorPalette || []).join(', ') || 'N/A'}
Islamic Rules: hijabAlways=${r.hijabAlways}, noMusic=${r.noMusic}, custom: ${r.customRules || 'none'}`;
}

function kbBlock(kb) {
  if (!kb) return '';
  const duas  = (kb.duas       || []).map(d => `  • ${d.transliteration} — ${d.meaning}`).join('\n');
  const vocab = (kb.vocabulary || []).map(v => `  • ${v.word}: ${v.definition}`).join('\n');
  return `KNOWLEDGE BASE: ${kb.name}
Islamic Values: ${(kb.islamicValues || []).join(', ')}
Duas:\n${duas || '  (none)'}
Vocabulary:\n${vocab || '  (none)'}
Avoid Topics: ${(kb.avoidTopics || []).join(', ') || 'none'}
Custom Rules: ${kb.customRules || 'none'}`;
}

function buildStrictCharactersBlock(characters) {
  if (!characters?.length) return '';
  const charDescriptions = characters.map(c => {
    const vd  = c.visualDNA    || {};
    const mod = c.modestyRules || {};
    const gender = mod.hijabAlways
      ? 'girl'
      : (vd.gender || (c.name?.toLowerCase().match(/^(ahmed|omar|ali|hassan|yusuf|ibrahim|adam|zaid|bilal)/) ? 'boy' : 'girl'));
    return [
      `  CHARACTER: ${c.name}`,
      `  - Gender: ${gender} (ALWAYS ${gender}, never change)`,
      `  - Role: ${c.role || 'character'}`,
      `  - Age: ${c.ageRange || 'child'}`,
      `  - Personality: ${(c.traits || []).join(', ')}`,
      `  - Speaking style: ${c.speakingStyle || 'warm and friendly'}`,
      mod.hijabAlways ? `  - Hijab: ALWAYS visible` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  const names = characters.map(c => c.name).join(', ');
  return `
═══════════════════════════════════════════════
UNIVERSE CHARACTERS — STRICT RULES
═══════════════════════════════════════════════
APPROVED CHARACTERS: ${names}
${charDescriptions}
RULES: Only use listed characters. Never invent new ones.
═══════════════════════════════════════════════`;
}

// ─── Stage Prompt Builders ────────────────────────────────────────────────────

function buildOutlinePrompt({ project, universe, characters, kb }) {
  const spreadOnly  = isSpreadOnlyMode(project.ageRange);
  const limits      = getTextLimit(project.ageRange);
  const charBlock   = buildStrictCharactersBlock(characters);
  const arabicBlock = buildArabicSafetyBlock();

  const formatDescription = spreadOnly
    ? `SPREADS-ONLY PICTURE BOOK for ages ${project.ageRange}. NO chapters. Just a sequence of 8-12 illustrated spreads. MAX ${limits.maxWords} words per spread. Must rhyme.`
    : isPictureBook(project.ageRange)
      ? `PICTURE BOOK for ages ${project.ageRange}. Each chapter = 4-6 spreads. MAX ${limits.maxWords} words per spread.`
      : `CHAPTER BOOK for ages ${project.ageRange} with prose narrative.`;

  const system = `You are an expert Islamic children's book author.
${formatDescription}
CRITICAL: Output ONLY raw valid JSON. NO markdown. NO code fences. Start with { end with }
${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}
${arabicBlock}`;

  const promptBody = spreadOnly ? `
Create a spreads-only picture book outline (NO chapters for this age group).
Title: "${project.title}"
Age Range: ${project.ageRange}
Learning Objective: ${project.learningObjective || 'Islamic values'}
IMPORTANT: This age group (${project.ageRange}) does NOT use chapters.
Respond with ONLY this JSON:
{
  "bookTitle": "string",
  "moral": "string",
  "spreadOnly": true,
  "totalSpreads": 10,
  "dedicationMessage": "string",
  "islamicTheme": {
    "title": "string",
    "arabicPhrase": "COPY EXACT Unicode from approved list above",
    "transliteration": "string",
    "meaning": "string",
    "reference": "string",
    "referenceText": "string",
    "whyWeDoIt": "string"
  },
  "spreads": [
    {
      "spreadIndex": 0,
      "sceneDescription": "string",
      "illustrationHint": "string",
      "textHint": "max ${limits.maxWords} words, rhyming",
      "islamicValue": "string"
    }
  ]
}` : `
Create a ${project.chapterCount || 4}-chapter outline.
Title: "${project.title}"
Age Range: ${project.ageRange}
Learning Objective: ${project.learningObjective || 'Islamic values'}
Respond with ONLY this JSON:
{
  "bookTitle": "string",
  "moral": "string",
  "spreadOnly": false,
  "dedicationMessage": "string",
  "islamicTheme": {
    "title": "string",
    "arabicPhrase": "COPY EXACT Unicode from approved list above",
    "transliteration": "string",
    "meaning": "string",
    "reference": "string",
    "referenceText": "string",
    "whyWeDoIt": "string"
  },
  "chapters": [
    {
      "title": "string",
      "goal": "string",
      "keyScene": "string",
      "duaHint": "string",
      "charactersInScene": ["names from approved list only"]
    }
  ]
}`;

  return { system, prompt: promptBody };
}

function buildDedicationPrompt({ project }) {
  const arabicBlock = buildArabicSafetyBlock();
  const system = `You are a warm Islamic children's book author.
CRITICAL: Output ONLY raw valid JSON. No markdown. Start with { end with }
${arabicBlock}`;
  const prompt = `Write dedication page for "${project.title}" by ${project.authorName || 'NoorStudio'}.
Respond ONLY with:
{
  "greeting": "Assalamu Alaikum, dear parents!",
  "message": "string (2-4 warm sentences)",
  "closing": "Jazakallah Khair — ${project.authorName || 'NoorStudio'}",
  "includeQrPlaceholder": true
}`;
  return { system, prompt };
}

function buildThemePagePrompt({ project, kb }) {
  const arabicBlock = buildArabicSafetyBlock();
  const system = `You are an Islamic educator writing for children ages ${project.ageRange || '6-8'}.
CRITICAL: Output ONLY raw valid JSON. No markdown. Start with { end with }
${arabicBlock}`;
  const prompt = `Create Islamic theme reference page for "${project.title}".
Learning Objective: ${project.learningObjective || 'Islamic values'}
${kb ? kbBlock(kb) : ''}
Respond ONLY with:
{
  "sectionTitle": "string",
  "arabicPhrase": "COPY from approved list — exact Unicode",
  "transliteration": "string",
  "meaning": "string",
  "referenceType": "quran",
  "referenceSource": "string",
  "referenceText": "string",
  "explanation": "string (3-4 child-friendly sentences)",
  "dailyPractice": "string (1 sentence)",
  "decorativeElement": "string"
}`;
  return { system, prompt };
}

function buildChapterPrompt({ project, universe, characters, kb }, chapterIndex) {
  if (isSpreadOnlyMode(project.ageRange)) {
    throw Object.assign(
      new Error(`Age group ${project.ageRange} uses spreads-only mode. Run 'spreads' stage instead of 'chapter'.`),
      { code: 'SPREADS_ONLY_MODE' }
    );
  }

  const outline        = project.artifacts?.outline;
  const chapterOutline = outline?.chapters?.[chapterIndex];
  const pictureBook    = isPictureBook(project.ageRange);
  const limits         = getTextLimit(project.ageRange);
  const charBlock      = buildStrictCharactersBlock(characters);
  const arabicBlock    = buildArabicSafetyBlock();
  const sceneCharNames  = chapterOutline?.charactersInScene || [];
  const sceneCharacters = sceneCharNames.length
    ? characters.filter(c => sceneCharNames.includes(c.name))
    : characters;

  const system = `You are an expert Islamic children's book author.
${pictureBook
    ? `PICTURE BOOK for ages ${project.ageRange}. MAX ${limits.maxWords} words per spread. NEVER paragraphs.`
    : `CHAPTER BOOK for ages ${project.ageRange} with full prose.`}
CRITICAL: Output ONLY raw valid JSON. No markdown. Start with { end with }
${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}
${arabicBlock}`;

  if (pictureBook) {
    const prompt = `Write Chapter ${chapterIndex + 1} of PICTURE BOOK "${project.title}".
Chapter: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
Goal: ${chapterOutline?.goal || ''}
Key Scene: ${chapterOutline?.keyScene || ''}
Characters in scene: ${sceneCharacters.map(c => c.name).join(', ')}
STRICT TEXT RULES FOR AGES ${project.ageRange}:
- MAX ${limits.maxWords} WORDS PER SPREAD — hard limit
- ${limits.rhyme ? 'MUST rhyme — simple AABB couplets' : 'Simple clear sentences'}
- 4-6 spreads per chapter
Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "max ${limits.maxWords} words",
      "prompt": "The exact instruction used to write this spread text",
      "illustrationHint": "approved characters, what they do, setting",
      "charactersInSpread": ["approved names only"],
      "textPosition": "bottom",
      "arabicPhrase": null
    }
  ],
  "islamicAdabChecks": ["string"],
  "vocabularyNotes": ["string"]
}`;
    return { system, prompt };
  }

  const prompt = `Write Chapter ${chapterIndex + 1} of "${project.title}".
Chapter: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
Goal: ${chapterOutline?.goal || ''}
Key Scene: ${chapterOutline?.keyScene || ''}
Characters: ${sceneCharacters.map(c => c.name).join(', ')}
Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "text": "string (min 200 words)",
  "prompt": "The instruction used to write this chapter",
  "chapterIllustrationHint": "string — only approved characters",
  "vocabularyNotes": ["string"],
  "islamicAdabChecks": ["string"]
}`;
  return { system, prompt };
}

function buildSpreadsOnlyPrompt({ project, universe, characters, kb }) {
  const limits      = getTextLimit(project.ageRange);
  const charBlock   = buildStrictCharactersBlock(characters);
  const arabicBlock = buildArabicSafetyBlock();
  const outline     = project.artifacts?.outline;

  const system = `You are an expert Islamic children's PICTURE BOOK author for ages ${project.ageRange}.
This is a SPREADS-ONLY book — no chapters, just illustrated pages.
MAX ${limits.maxWords} words per spread. MUST rhyme. One sentence max.
CRITICAL: Output ONLY raw valid JSON. No markdown. Start with { end with }
${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}
${arabicBlock}`;

  const outlineSpreads = normArr(outline?.spreads || []);
  const spreadCount    = outlineSpreads.length || 10;

  const prompt = `Write all ${spreadCount} spreads for this picture book.
Title: "${project.title}"
Age Range: ${project.ageRange} (NO chapters for this age)
Learning Objective: ${project.learningObjective || ''}
Outline spreads:
${JSON.stringify(outlineSpreads, null, 2)}
STRICT RULES:
- MAX ${limits.maxWords} words per spread — HARD limit
- MUST rhyme (AABB pattern)
- Child vocabulary only
Respond ONLY with:
{
  "spreadOnly": true,
  "totalSpreads": ${spreadCount},
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "max ${limits.maxWords} words, rhyming",
      "prompt": "Instruction used to write this spread",
      "illustrationHint": "approved characters only, simple scene",
      "textPosition": "bottom",
      "arabicPhrase": null
    }
  ]
}`;
  return { system, prompt };
}

// ── Humanize for chapter-based books (age ≥ 6) ───────────────────────────────
function buildHumanizePrompt({ project, kb, characters }, chapterIndex) {
  const chaptersArr = normArr(project.artifacts?.chapters);
  const chapter     = chaptersArr[chapterIndex];
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';
  const pictureBook = isPictureBook(project.ageRange);
  const charBlock   = buildStrictCharactersBlock(characters);
  const arabicBlock = buildArabicSafetyBlock();

  const system = `You are a children's book editor for Islamic content, ages ${project.ageRange || '6-8'}.
CRITICAL: Output ONLY raw valid JSON. No markdown. Start with { end with }
${charBlock}
${arabicBlock}`;

  if (pictureBook) {
    const limits = getTextLimit(project.ageRange);
    const prompt = `Polish this PICTURE BOOK chapter. Keep prompts intact.
Chapter: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}
Spreads:
${JSON.stringify(chapter?.spreads || [], null, 2)}
Avoid: ${avoidTopics}
MAX ${limits.maxWords} words per spread. Rhyme: ${limits.rhyme}.
Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "string",
      "prompt": "Updated instruction — preserve for user editing",
      "illustrationHint": "string — only approved characters",
      "charactersInSpread": ["approved names only"],
      "textPosition": "bottom",
      "arabicPhrase": null
    }
  ],
  "changesMade": ["string"]
}`;
    return { system, prompt };
  }

  const prompt = `Polish chapter for "${project.title}".
Chapter: ${chapter?.chapterTitle}
Text: ${chapter?.text || '(no text)'}
Avoid: ${avoidTopics}
Approved characters: ${(characters || []).map(c => c.name).join(', ')}
Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "text": "string (min 200 words)",
  "prompt": "The instruction used — preserved for user editing",
  "chapterIllustrationHint": "string — only approved characters",
  "changesMade": ["string"]
}`;
  return { system, prompt };
}

// ── FIX 4: Humanize for spreadOnly books (age < 6) — NEW ─────────────────────
// Humanizes all spreads as a single flat list — no chapter concept at all.
function buildSpreadHumanizePrompt({ project, characters, kb }) {
  const spreads     = normArr(project.artifacts?.spreads || []);
  const limits      = getTextLimit(project.ageRange);
  const charBlock   = buildStrictCharactersBlock(characters);
  const arabicBlock = buildArabicSafetyBlock();
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';

  const system = `You are an expert Islamic children's picture book editor for ages ${project.ageRange}.
This is a SPREADS-ONLY book — ${spreads.length} illustrated pages, NO chapters.

WRITING QUALITY RULES:
• Warm, vivid, child-friendly English — never bland or mechanical
• MAX ${limits.maxWords} words per spread — hard limit, no exceptions
• ${limits.rhyme ? 'Every spread MUST rhyme — simple AABB couplets' : 'Clear simple sentences, no rhyme required'}
• Active voice, age-appropriate vocabulary for a ${project.ageRange}-year-old
• Evoke wonder, warmth, joy — one clear emotion per spread
• Never use chapter language — these are PAGES, not chapters

CRITICAL: Output ONLY raw valid JSON. No markdown. Start with { end with }
${charBlock}
${arabicBlock}`;

  const prompt = `Polish all ${spreads.length} spreads of this Islamic picture book.
Title: "${project.title}"
Age Range: ${project.ageRange}
Avoid topics: ${avoidTopics}

CURRENT SPREADS:
${JSON.stringify(spreads, null, 2)}

RULES:
- Keep spreadIndex values UNCHANGED
- MAX ${limits.maxWords} words per spread — HARD LIMIT
- ${limits.rhyme ? 'MUST rhyme (AABB pattern)' : 'Simple clear sentences'}
- Only improve the 'text' field — keep illustrationHint and textPosition unchanged
- Keep the 'prompt' field on each spread UNCHANGED
- For Arabic phrases: ONLY use exact Unicode from the approved list above

Respond ONLY with:
{
  "spreadOnly": true,
  "totalSpreads": ${spreads.length},
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "polished page text — max ${limits.maxWords} words",
      "prompt": "(copy the original prompt field — do not change)",
      "illustrationHint": "(copy unchanged)",
      "textPosition": "bottom",
      "arabicPhrase": null
    }
  ],
  "changesMade": ["list what was improved per spread"]
}`;

  return { system, prompt };
}

// ── FIX 5: Improved single spread rerun ───────────────────────────────────────
function buildSpreadRerunPrompt({ project, characters, kb }, spreadIndex, customPrompt) {
  const limits      = getTextLimit(project.ageRange);
  const charBlock   = buildStrictCharactersBlock(characters);
  const arabicBlock = buildArabicSafetyBlock();

  // Give the AI the current spread text so it knows what to improve
  const currentSpreads = normArr(
    project.artifacts?.spreads ||
    project.artifacts?.humanized?.[0]?.spreads ||
    project.artifacts?.chapters?.[0]?.spreads ||
    []
  );
  const currentSpread = currentSpreads[spreadIndex] || {};
  const currentText   = currentSpread.text || '(none yet)';

  const system = `You are an expert Islamic children's picture book author for ages ${project.ageRange}.

WRITING QUALITY RULES:
• Warm, vivid, child-friendly English — never bland or mechanical
• MAX ${limits.maxWords} words — hard limit, no exceptions
• ${limits.rhyme ? 'Lines MUST rhyme — simple AABB couplet' : 'Clear flowing sentence, no rhyme required'}
• Active voice only — age-appropriate vocabulary
• Evoke wonder, warmth, joy — one clear emotion

CRITICAL: Output ONLY raw valid JSON. No markdown. Start with { end with }
${charBlock}
${arabicBlock}`;

  const prompt = `Rewrite spread ${spreadIndex + 1} of "${project.title}" using the editor's instruction.

CURRENT PAGE TEXT:
"${currentText}"

EDITOR'S INSTRUCTION:
${customPrompt}

Apply the instruction to produce a better version.
MAX ${limits.maxWords} words. ${limits.rhyme ? 'MUST rhyme (AABB).' : ''}
Make the English natural, warm and engaging for a ${project.ageRange}-year-old.

Respond ONLY with:
{
  "spreadIndex": ${spreadIndex},
  "text": "improved page text — max ${limits.maxWords} words",
  "prompt": ${JSON.stringify(customPrompt)},
  "illustrationHint": "approved characters only — describe the scene",
  "textPosition": "bottom"
}`;

  return { system, prompt };
}

// ─── Stage Builders Map ───────────────────────────────────────────────────────

const STAGE_BUILDERS = {
  outline:     (ctx, _idx)               => buildOutlinePrompt(ctx),
  dedication:  (ctx, _idx)               => buildDedicationPrompt(ctx),
  theme:       (ctx, _idx)               => buildThemePagePrompt(ctx),
  chapter:     (ctx, idx)                => buildChapterPrompt(ctx, idx),
  spreads:     (ctx, _idx)               => buildSpreadsOnlyPrompt(ctx),
  humanize:    (ctx, idx)                => buildHumanizePrompt(ctx, idx),
  spreadRerun: (ctx, idx, customPrompt)  => buildSpreadRerunPrompt(ctx, idx, customPrompt),
};

// ─── Save prompt to history ───────────────────────────────────────────────────

async function savePromptHistory(projectId, stage, index, promptText, result, provider) {
  const historyEntry = {
    stage,
    index,
    prompt: promptText,
    resultPreview: typeof result === 'object'
      ? JSON.stringify(result).slice(0, 200)
      : String(result).slice(0, 200),
    provider,
    createdAt: new Date().toISOString(),
  };
  await Project.findByIdAndUpdate(projectId, {
    $push: {
      'artifacts.promptHistory': { $each: [historyEntry], $slice: -100 },
    },
  });
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

export async function generateStageText({ stage, projectId, userId, chapterIndex = 0, spreadIndex = 0, customPrompt }) {
  console.log(`\n[TextService] ▶ stage=${stage} project=${projectId} chapterIndex=${chapterIndex} spreadIndex=${spreadIndex}`);

  const ctx = await buildUniverseContext(projectId, userId);

  // Auto-redirect chapter → spreads for age < 6
  if (stage === 'chapter' && isSpreadOnlyMode(ctx.project.ageRange)) {
    console.log(`[TextService] ↩ Age ${ctx.project.ageRange} → redirecting chapter→spreads`);
    stage = 'spreads';
  }

  const budget = AI_TOKEN_BUDGETS[stage] || AI_TOKEN_BUDGETS.chapter;

  const builder = STAGE_BUILDERS[stage];
  if (!builder) throw new Error(`Unknown stage: ${stage}`);

  // ── FIX 4: Route humanize to spreadOnly builder when appropriate ──────────
  let builderResult;
  if (stage === 'spreadRerun') {
    builderResult = builder(ctx, spreadIndex, customPrompt);
  } else if (stage === 'humanize' && ctx.project.artifacts?.spreadOnly) {
    // SpreadOnly books: humanize all spreads at once — no chapterIndex needed
    console.log(`[TextService] Humanize → spreadOnly mode (all spreads, no chapters)`);
    builderResult = buildSpreadHumanizePrompt(ctx);
  } else {
    builderResult = builder(ctx, chapterIndex);
  }
  const { system, prompt } = builderResult;

  const promptTokens = estimateTokens(system + prompt);
  console.log(`[TextService] Prompt ~${promptTokens} tokens (max ${budget.maxPromptTokens})`);

  if (promptTokens > budget.maxPromptTokens) {
    throw Object.assign(
      new Error(`Prompt too large for ${stage}: ${promptTokens} > ${budget.maxPromptTokens}`),
      { code: 'AI_TOKEN_BUDGET_EXCEEDED' }
    );
  }

  const aiRes = await generateText({ system, prompt, maxOutputTokens: budget.maxOutputTokens, stage });

  console.log(`[TextService] Provider: ${aiRes.provider}, length: ${aiRes.text?.length}`);
  console.log(`[TextService] Preview: ${aiRes.text?.slice(0, 300)}`);

  const parsed = safeParse(aiRes.text);
  if (parsed.raw) console.error('[TextService] ⚠ JSON parse failed, storing raw.');

  const freshProject = await Project.findById(projectId);
  const setFields    = {};

  if (stage === 'outline') {
    setFields['artifacts.outline'] = parsed;
    if (parsed.dedicationMessage) {
      setFields['artifacts.dedication'] = {
        greeting: 'Assalamu Alaikum, dear parents!',
        message:  parsed.dedicationMessage,
        closing:  `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`,
        includeQrPlaceholder: true,
      };
    }
    if (parsed.islamicTheme) setFields['artifacts.themePage'] = parsed.islamicTheme;
    setFields.currentStage = 'outline';

  } else if (stage === 'dedication') {
    setFields['artifacts.dedication'] = parsed;

  } else if (stage === 'theme') {
    setFields['artifacts.themePage'] = parsed;

  } else if (stage === 'chapter') {
    const chapters = normArr(freshProject.artifacts?.chapters);
    chapters[chapterIndex] = parsed;
    setFields['artifacts.chapters'] = chapters;
    setFields.currentStage = 'chapters';

  } else if (stage === 'spreads') {
    setFields['artifacts.spreads']    = parsed.spreads || [];
    setFields['artifacts.spreadOnly'] = true;
    setFields.currentStage = 'spreads';

  } else if (stage === 'humanize') {
    // ── FIX 4: SpreadOnly humanize saves back into artifacts.spreads ──────
    if (freshProject.artifacts?.spreadOnly) {
      setFields['artifacts.spreads']    = parsed.spreads || freshProject.artifacts.spreads;
      setFields['artifacts.spreadOnly'] = true;
    } else {
      const humanized = normArr(freshProject.artifacts?.humanized);
      humanized[chapterIndex] = parsed;
      setFields['artifacts.humanized'] = humanized;
    }
    setFields.currentStage = 'humanized';

  } else if (stage === 'spreadRerun') {
    if (freshProject.artifacts?.spreadOnly) {
      const spreads = normArr(freshProject.artifacts?.spreads);
      spreads[spreadIndex] = { ...spreads[spreadIndex], ...parsed };
      setFields['artifacts.spreads'] = spreads;
    } else {
      const chapters = normArr(freshProject.artifacts?.humanized?.length
        ? freshProject.artifacts.humanized
        : freshProject.artifacts?.chapters);
      const chapter   = chapters[chapterIndex] || {};
      const chapSpreads = normArr(chapter.spreads);
      chapSpreads[spreadIndex] = { ...chapSpreads[spreadIndex], ...parsed };
      chapter.spreads = chapSpreads;
      chapters[chapterIndex] = chapter;
      const key = freshProject.artifacts?.humanized?.length
        ? 'artifacts.humanized'
        : 'artifacts.chapters';
      setFields[key] = chapters;
    }
  }

  setFields[`aiUsage.stages.${stage}`] = {
    inputTokens:  aiRes.usage?.inputTokens,
    outputTokens: aiRes.usage?.outputTokens,
    updatedAt:    new Date(),
  };

  await Project.findByIdAndUpdate(projectId, {
    $set: setFields,
    $inc: {
      'aiUsage.totalInputTokens':  aiRes.usage?.inputTokens  || 0,
      'aiUsage.totalOutputTokens': aiRes.usage?.outputTokens || 0,
    },
  });

  await savePromptHistory(
    projectId,
    stage,
    stage === 'chapter' ? chapterIndex : spreadIndex,
    prompt,
    parsed,
    aiRes.provider,
  );

  console.log(`[TextService] ✓ stage="${stage}" saved`);
  return { result: parsed, usage: aiRes.usage, provider: aiRes.provider, prompt };
} 