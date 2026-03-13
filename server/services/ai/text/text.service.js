// server/services/ai/text/text.service.js
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

function getTextLimit(ageRange) {
  const first = Number(String(ageRange || '').match(/\d+/)?.[0] || 7);
  if (first <= 4) return { maxWords: 8,  sentences: 1, rhyme: true  };
  if (first <= 6) return { maxWords: 15, sentences: 2, rhyme: true  };
  if (first <= 8) return { maxWords: 25, sentences: 2, rhyme: false };
  return null;
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

// ─── Context Builder ──────────────────────────────────────────────────────────

export async function buildUniverseContext(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe   = project.universeId ? await Universe.findById(project.universeId) : null;

  // Load ALL characters in this universe (not just protagonist)
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

/**
 * Builds a strict character block injected into EVERY prompt.
 * Tells the AI exactly who exists in this universe and forbids
 * inventing any new characters.
 */
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
      `  - Skin tone: ${vd.skinTone || 'N/A'}`,
      `  - Eyes: ${vd.eyeColor || 'N/A'}`,
      `  - Face: ${vd.faceShape || 'N/A'}`,
      `  - Hair/Hijab: ${vd.hairOrHijab || 'N/A'}`,
      `  - Outfit: ${vd.outfitRules || 'N/A'}`,
      mod.hijabAlways   ? `  - Hijab: ALWAYS visible, never remove` : '',
      mod.longSleeves   ? `  - Long sleeves: always` : '',
      mod.looseClothing ? `  - Loose clothing: always` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const names = characters.map(c => c.name).join(', ');

  return `
═══════════════════════════════════════════════
UNIVERSE CHARACTERS — STRICT RULES (READ FIRST)
═══════════════════════════════════════════════
APPROVED CHARACTERS (only these may appear in this book):
${charDescriptions}

CHARACTER RULES (non-negotiable):
1. ONLY use the characters listed above — ${names}
2. Do NOT invent, add, or imply any other characters
3. Every character must look IDENTICAL to their description in every scene
4. Gender, outfit, and hijab rules must NEVER change between scenes
5. These characters are from an Islamic children's book — keep them modest and consistent
═══════════════════════════════════════════════`;
}

// ─── Stage Prompt Builders ────────────────────────────────────────────────────

// ── 1. Outline ────────────────────────────────────────────────────────────────
function buildOutlinePrompt({ project, universe, characters, kb }) {
  const pictureBook = isPictureBook(project.ageRange);
  const limits      = getTextLimit(project.ageRange);
  const charBlock   = buildStrictCharactersBlock(characters);

  const system = `You are an expert Islamic children's book author and curriculum designer.
${pictureBook
    ? `You write PICTURE BOOKS for ages ${project.ageRange}. Every spread is MAX ${limits?.maxWords} words. You NEVER write paragraphs.`
    : `You write chapter books for ages ${project.ageRange} with full prose narratives.`
  }
CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
Your entire response must start with { and end with }
${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}`;

  const prompt = `Create a ${project.chapterCount || 4}-chapter book outline.

Title: "${project.title}"
Age Range: ${project.ageRange || '6-8 years'}
Format: ${pictureBook ? 'PICTURE BOOK — illustration-heavy, minimal text per spread' : 'CHAPTER BOOK — text-driven narrative'}
Learning Objective: ${project.learningObjective || 'Islamic values'}
Template: ${project.template || 'moral'}
Author: ${project.authorName || 'NoorStudio'}

IMPORTANT: The story must ONLY feature the universe characters listed above.
Do not add parents, siblings, teachers, or any other character not listed.
If the story needs supporting characters, use only what is already defined.

Respond with ONLY this JSON:
{
  "bookTitle": "string",
  "moral": "string",
  "dedicationMessage": "string (warm 2-3 sentence message from author to parents)",
  "islamicTheme": {
    "title": "string",
    "arabicPhrase": "string",
    "transliteration": "string",
    "meaning": "string",
    "reference": "string (Quran verse or Hadith)",
    "referenceText": "string",
    "whyWeDoIt": "string"
  },
  "chapters": [
    { "title": "string", "goal": "string", "keyScene": "string", "duaHint": "string", "charactersInScene": ["character names from approved list only"] }
  ]
}`;

  return { system, prompt };
}

// ── 2. Dedication page ────────────────────────────────────────────────────────
function buildDedicationPrompt({ project }) {
  const system = `You are a warm, caring Islamic children's book author.
CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
Your entire response must start with { and end with }`;

  const prompt = `Write the dedication page for this children's book.
Book: "${project.title}"
Author: ${project.authorName || 'NoorStudio'}
Age Range: ${project.ageRange || '6-8'}

Respond with ONLY this JSON:
{
  "greeting": "string (e.g. Assalamu Alaikum, dear parents!)",
  "message": "string (2-4 warm sentences)",
  "closing": "string (e.g. Jazakallah Khair — AuthorName)",
  "includeQrPlaceholder": true
}`;

  return { system, prompt };
}

// ── 3. Theme page ─────────────────────────────────────────────────────────────
function buildThemePagePrompt({ project, kb }) {
  const system = `You are an Islamic educator writing for children ages ${project.ageRange || '6-8'}.
CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
Your entire response must start with { and end with }`;

  const prompt = `Create the Islamic theme reference page for "${project.title}".
Learning Objective: ${project.learningObjective || 'Islamic values'}
${kb ? kbBlock(kb) : ''}

Respond with ONLY this JSON:
{
  "sectionTitle": "string",
  "arabicPhrase": "string",
  "transliteration": "string",
  "meaning": "string",
  "referenceType": "quran | hadith",
  "referenceSource": "string",
  "referenceText": "string",
  "explanation": "string (3-4 child-friendly sentences)",
  "dailyPractice": "string (1 sentence)",
  "decorativeElement": "string"
}`;

  return { system, prompt };
}

// ── 4. Chapter ────────────────────────────────────────────────────────────────
function buildChapterPrompt({ project, universe, characters, kb }, chapterIndex) {
  const outline        = project.artifacts?.outline;
  const chapterOutline = outline?.chapters?.[chapterIndex];
  const pictureBook    = isPictureBook(project.ageRange);
  const limits         = getTextLimit(project.ageRange);
  const charBlock      = buildStrictCharactersBlock(characters);

  // Filter to only characters mentioned in this chapter's scene
  const sceneCharNames  = chapterOutline?.charactersInScene || [];
  const sceneCharacters = sceneCharNames.length
    ? characters.filter(c => sceneCharNames.includes(c.name))
    : characters;

  const system = `You are an expert Islamic children's book author.
${pictureBook
    ? `You write PICTURE BOOKS for ages ${project.ageRange}. MAX ${limits?.maxWords} words per spread. NEVER write paragraphs.`
    : `You write chapter books for ages ${project.ageRange} with full prose narratives.`
  }
CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
Your entire response must start with { and end with }
${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}`;

  if (pictureBook) {
    const prompt = `Write Chapter ${chapterIndex + 1} of PICTURE BOOK "${project.title}".

Chapter outline:
- Title: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
- Goal: ${chapterOutline?.goal || ''}
- Key Scene: ${chapterOutline?.keyScene || ''}
- Dua Hint: ${chapterOutline?.duaHint || ''}
- Characters in this scene: ${sceneCharacters.map(c => c.name).join(', ') || 'all characters'}

STRICT TEXT RULES FOR AGES ${project.ageRange}:
- MAX ${limits.maxWords} WORDS PER SPREAD — hard limit, never exceed
- MAX ${limits.sentences} sentence(s) per spread
- ${limits.rhyme ? 'MUST rhyme — simple AABB couplets' : 'Simple clear sentences'}
- Child-level vocabulary only
- 4-6 spreads per chapter

STRICT CHARACTER RULES:
- ONLY use: ${characters.map(c => c.name).join(', ')}
- Do NOT introduce any new characters — no parents, teachers, friends unless already defined above
- Each character must match their visual description exactly

Respond with ONLY this JSON:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "max ${limits.maxWords} words",
      "illustrationHint": "describe exactly which character(s) from the approved list appear, what they are doing, setting, mood",
      "charactersInSpread": ["approved character names only"],
      "textPosition": "bottom"
    }
  ],
  "islamicAdabChecks": ["string"],
  "vocabularyNotes": ["string"]
}`;

    return { system, prompt };
  }

  // Chapter-book mode
  const prompt = `Write Chapter ${chapterIndex + 1} of "${project.title}".

Chapter outline:
- Title: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
- Goal: ${chapterOutline?.goal || ''}
- Key Scene: ${chapterOutline?.keyScene || ''}
- Characters in scene: ${sceneCharacters.map(c => c.name).join(', ')}

STRICT CHARACTER RULES:
- ONLY use characters: ${characters.map(c => c.name).join(', ')}
- Do NOT invent any new characters
- Refer to each character consistently using their exact name and traits

Respond with ONLY this JSON:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "text": "string (full chapter prose, minimum 200 words)",
  "chapterIllustrationHint": "describe which approved character(s) appear and what they are doing",
  "vocabularyNotes": ["string"],
  "islamicAdabChecks": ["string"]
}`;

  return { system, prompt };
}

// ── 5. Humanize ───────────────────────────────────────────────────────────────
function buildHumanizePrompt({ project, kb, characters }, chapterIndex) {
  const chaptersArr = normArr(project.artifacts?.chapters);
  const chapter     = chaptersArr[chapterIndex];
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';
  const pictureBook = isPictureBook(project.ageRange);
  const charBlock   = buildStrictCharactersBlock(characters);

  const system = `You are a children's book editor for Islamic content, ages ${project.ageRange || '6-8'}.
CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
Your entire response must start with { and end with }
${charBlock}`;

  if (pictureBook) {
    const limits = getTextLimit(project.ageRange);

    const prompt = `Polish this PICTURE BOOK chapter.

Chapter: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}
Original spreads:
${JSON.stringify(chapter?.spreads || [], null, 2)}

Topics to AVOID: ${avoidTopics}

STRICT RULES FOR AGES ${project.ageRange}:
- MAX ${limits.maxWords} WORDS per spread — HARD LIMIT
- Ages 2-4: 1 sentence, must rhyme
- Ages 4-6: max 2 sentences, rhyming preferred
- REJECT any spread over ${limits.maxWords} words and rewrite shorter

CHARACTER RULES:
- Only approved characters may appear: ${(characters || []).map(c => c.name).join(', ')}
- If any spread mentions an unapproved character, remove them
- Keep each character's name, gender and traits consistent

Respond with ONLY this JSON:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "string",
      "illustrationHint": "string — only approved characters",
      "charactersInSpread": ["approved names only"],
      "textPosition": "bottom"
    }
  ],
  "changesMade": ["string"]
}`;

    return { system, prompt };
  }

  const prompt = `Polish this chapter for "${project.title}".

Chapter: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}
Text:
${chapter?.text || '(no text)'}

Topics to AVOID: ${avoidTopics}
Approved characters only: ${(characters || []).map(c => c.name).join(', ')}

Respond with ONLY this JSON:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "text": "string (minimum 200 words)",
  "chapterIllustrationHint": "string — only approved characters",
  "changesMade": ["string"]
}`;

  return { system, prompt };
}

// ─── Stage Builders Map ───────────────────────────────────────────────────────

const STAGE_BUILDERS = {
  outline:    (ctx, _idx) => buildOutlinePrompt(ctx),
  dedication: (ctx, _idx) => buildDedicationPrompt(ctx),
  theme:      (ctx, _idx) => buildThemePagePrompt(ctx),
  chapter:    (ctx, idx)  => buildChapterPrompt(ctx, idx),
  humanize:   (ctx, idx)  => buildHumanizePrompt(ctx, idx),
};

// ─── Main Entry ───────────────────────────────────────────────────────────────

export async function generateStageText({ stage, projectId, userId, chapterIndex = 0 }) {
  console.log(`\n[TextService] ▶ stage=${stage} project=${projectId} chapterIndex=${chapterIndex}`);

  const ctx    = await buildUniverseContext(projectId, userId);
  const budget = AI_TOKEN_BUDGETS[stage] || AI_TOKEN_BUDGETS.chapter;

  const builder = STAGE_BUILDERS[stage];
  if (!builder) throw new Error(`Unknown stage: ${stage}`);

  const { system, prompt } = builder(ctx, chapterIndex);

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

  } else if (stage === 'humanize') {
    const humanized = normArr(freshProject.artifacts?.humanized);
    humanized[chapterIndex] = parsed;
    setFields['artifacts.humanized'] = humanized;
    setFields.currentStage = 'humanized';
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

  console.log(`[TextService] ✓ stage="${stage}" saved`);
  return { result: parsed, usage: aiRes.usage, provider: aiRes.provider };
}

// // server/services/ai/text/text.service.js
// import { Project } from '../../../models/Project.js';
// import { Universe } from '../../../models/Universe.js';
// import { Character } from '../../../models/Character.js';
// import { KnowledgeBase } from '../../../models/KnowledgeBase.js';
// import { NotFoundError } from '../../../errors.js';
// import { generateText } from './text.providers.js';
// import { AI_TOKEN_BUDGETS, estimateTokens } from '../policies/tokenBudget.js';

// // ─── Age helpers ──────────────────────────────────────────────────────────────

// /**
//  * Returns true when the project targets young readers (ages 4–8).
//  * Picture-book mode: illustration-heavy, 1–2 sentences per spread.
//  */
// function isPictureBook(ageRange) {
//   if (!ageRange) return true;
//   const first = String(ageRange).match(/\d+/)?.[0];
//   return first ? Number(first) <= 8 : true;
// }

// function getTextLimit(ageRange) {
//   const first = Number(String(ageRange || '').match(/\d+/)?.[0] || 7);
//   if (first <= 4) return { maxWords: 8, sentences: 1, rhyme: true };  // ages 2-4
//   if (first <= 6) return { maxWords: 15, sentences: 2, rhyme: true };  // ages 4-6
//   if (first <= 8) return { maxWords: 25, sentences: 2, rhyme: false };  // ages 6-8
//   return null; // chapter book
// }
// // ─── Array helpers ────────────────────────────────────────────────────────────

// /** Mongoose Mixed may store arrays as { '0': v, '1': v } — normalise */
// function normArr(val) {
//   if (!val) return [];
//   if (Array.isArray(val)) return [...val];
//   const keys = Object.keys(val).map(Number).filter(n => !isNaN(n));
//   if (!keys.length) return [];
//   const arr = [];
//   keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
//   return arr;
// }

// /** Strip markdown code fences (Claude wraps JSON even when told not to) */
// function stripFences(raw) {
//   if (!raw || typeof raw !== 'string') return raw;
//   return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
// }

// /** Safe JSON parse */
// function safeParse(text) {
//   const clean = stripFences(text);
//   try {
//     const parsed = JSON.parse(clean);
//     console.log('[TextService] ✓ JSON parsed, keys:', Object.keys(parsed).join(', '));
//     return parsed;
//   } catch (err) {
//     console.error('[TextService] ✗ JSON parse failed:', err.message);
//     console.error('[TextService] Raw (first 500 chars):', text?.slice(0, 500));
//     return { raw: text };
//   }
// }

// // ─── Context Builder ──────────────────────────────────────────────────────────

// export async function buildUniverseContext(projectId, userId) {
//   const project = await Project.findOne({ _id: projectId, userId });
//   if (!project) throw new NotFoundError('Project not found');

//   const universe = project.universeId ? await Universe.findById(project.universeId) : null;
//   const characters = project.characterIds?.length
//     ? await Character.find({ _id: { $in: project.characterIds } })
//     : [];
//   const kb = universe
//     ? await KnowledgeBase.findOne({ universeId: universe._id, userId })
//     : null;

//   console.log(`[TextService] Context: project="${project.title}" universe="${universe?.name}" chars=${characters.length} kb=${!!kb}`);
//   return { project, universe, characters, kb };
// }

// // ─── Prompt Blocks ────────────────────────────────────────────────────────────

// function universeBlock(universe) {
//   if (!universe) return '';
//   const r = universe.islamicRules || {};
//   return `UNIVERSE: ${universe.name}
// Series Bible: ${universe.seriesBible || 'N/A'}
// Art Style: ${universe.artStyle}
// Color Palette: ${(universe.colorPalette || []).join(', ') || 'N/A'}
// Islamic Rules: hijabAlways=${r.hijabAlways}, noMusic=${r.noMusic}, custom: ${r.customRules || 'none'}`;
// }

// function charactersBlock(characters) {
//   if (!characters?.length) return '';
//   return characters.map(c => {
//     const vd = c.visualDNA || {};
//     return `CHARACTER: ${c.name} (${c.role}, ${c.ageRange || 'unknown'})
// Traits: ${(c.traits || []).join(', ')}
// Speaking style: ${c.speakingStyle || 'N/A'}
// Visual DNA: skin=${vd.skinTone}, eyes=${vd.eyeColor}, face=${vd.faceShape}, hair/hijab=${vd.hairOrHijab}
// Outfit: ${vd.outfitRules || 'N/A'} | Accessories: ${vd.accessories || 'none'}`;
//   }).join('\n\n');
// }

// function kbBlock(kb) {
//   if (!kb) return '';
//   const duas = (kb.duas || []).map(d => `  • ${d.transliteration} — ${d.meaning}`).join('\n');
//   const vocab = (kb.vocabulary || []).map(v => `  • ${v.word}: ${v.definition}`).join('\n');
//   return `KNOWLEDGE BASE: ${kb.name}
// Islamic Values: ${(kb.islamicValues || []).join(', ')}
// Duas:\n${duas || '  (none)'}
// Vocabulary:\n${vocab || '  (none)'}
// Avoid Topics: ${(kb.avoidTopics || []).join(', ') || 'none'}
// Custom Rules: ${kb.customRules || 'none'}`;
// }

// // ─── Stage Prompt Builders ────────────────────────────────────────────────────

// // ── 1. Outline ────────────────────────────────────────────────────────────────
// function buildOutlinePrompt({ project, universe, characters, kb }) {
//   const pictureBook = isPictureBook(project.ageRange);

//   const system = `You are an expert Islamic children's book author and curriculum designer.
// CRITICAL: Output ONLY raw valid JSON. Absolutely NO markdown, NO code fences, NO backticks, NO preamble, NO explanation.
// Your entire response must start with { and end with }
// ${universeBlock(universe)}
// ${kbBlock(kb)}`;

//   const prompt = `Create a ${project.chapterCount || 4}-chapter book outline.

// Title: "${project.title}"
// Age Range: ${project.ageRange || '6-8 years'}
// Format: ${pictureBook ? 'PICTURE BOOK (ages 4-8) — illustration-heavy, 1-2 short sentences per spread' : 'CHAPTER BOOK (ages 8-14) — text-driven narrative'}
// Learning Objective: ${project.learningObjective || 'Islamic values'}
// Template: ${project.template || 'moral'}
// Author: ${project.authorName || 'NoorStudio'}

// ${charactersBlock(characters)}

// Respond with ONLY this JSON (raw JSON only — start with {):
// {
//   "bookTitle": "string",
//   "moral": "string",
//   "dedicationMessage": "string (warm 2-3 sentence message from author to parents/children, e.g. I hope your child enjoys...)",
//   "islamicTheme": {
//     "title": "string (e.g. The Blessing of Gratitude)",
//     "arabicPhrase": "string (e.g. الحمد لله)",
//     "transliteration": "string (e.g. Alhamdulillah)",
//     "meaning": "string (plain English meaning for children)",
//     "reference": "string (Quran verse or Hadith reference, e.g. Quran 14:7)",
//     "referenceText": "string (the actual verse or hadith text, child-friendly translation)",
//     "whyWeDoIt": "string (2-3 child-friendly sentences explaining importance)"
//   },
//   "chapters": [
//     { "title": "string", "goal": "string", "keyScene": "string", "duaHint": "string" }
//   ]
// }`;

//   return { system, prompt };
// }

// // ── 2. Dedication page ────────────────────────────────────────────────────────
// function buildDedicationPrompt({ project, universe, kb }) {
//   const system = `You are a warm, caring Islamic children's book author.
// CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
// Your entire response must start with { and end with }`;

//   const prompt = `Write the dedication / opening message for this children's book.

// Book: "${project.title}"
// Author: ${project.authorName || 'NoorStudio'}
// Learning Objective: ${project.learningObjective || 'Islamic values'}
// Age Range: ${project.ageRange || '6-8'}

// Write a warm, loving message to parents and children (2-4 sentences).
// Mention how much care went into making the book.
// End with a dua or blessing for the reader.

// Respond with ONLY this JSON:
// {
//   "greeting": "string (e.g. Assalamu Alaikum, dear parents!)",
//   "message": "string (2-4 warm sentences)",
//   "closing": "string (e.g. Jazakallah Khair — AuthorName)",
//   "includeQrPlaceholder": true
// }`;

//   return { system, prompt };
// }

// // ── 3. Theme / Islamic reference page ─────────────────────────────────────────
// function buildThemePagePrompt({ project, kb }) {
//   const system = `You are an Islamic educator writing for children ages ${project.ageRange || '6-8'}.
// CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
// Your entire response must start with { and end with }`;

//   const prompt = `Create the Islamic theme / reference page for this children's book.

// Book: "${project.title}"
// Learning Objective: ${project.learningObjective || 'Islamic values'}
// Knowledge Base:
// ${kb ? kbBlock(kb) : 'No knowledge base provided'}

// This page explains the key Islamic concept the book teaches.
// Use simple language for young children (ages ${project.ageRange || '6-8'}).
// Include an authentic Quran verse OR Hadith (with source).

// Respond with ONLY this JSON:
// {
//   "sectionTitle": "string (e.g. What is Alhamdulillah and Why Do We Say It?)",
//   "arabicPhrase": "string",
//   "transliteration": "string",
//   "meaning": "string (simple child-friendly meaning)",
//   "referenceType": "quran | hadith",
//   "referenceSource": "string (e.g. Quran 14:7 or Sahih Bukhari)",
//   "referenceText": "string (the verse/hadith, simple translation)",
//   "explanation": "string (3-4 short sentences why this is important in Islam)",
//   "dailyPractice": "string (1 simple sentence: how children can use this every day)",
//   "decorativeElement": "string (suggest a simple decorative motif, e.g. olive branch, crescent)"
// }`;

//   return { system, prompt };
// }

// // ── 4. Chapter (picture book: spreads) ────────────────────────────────────────
// function buildChapterPrompt({ project, universe, characters, kb }, chapterIndex) {
//   const outline = project.artifacts?.outline;
//   const chapterOutline = outline?.chapters?.[chapterIndex];
//   const pictureBook = isPictureBook(project.ageRange);

//   // FIX — replace those first two lines with:
//   const system = `You are an expert Islamic children's book author.
// ${isPictureBook(project.ageRange)
//       ? `You write PICTURE BOOKS for ages ${project.ageRange}. Every spread is MAX ${getTextLimit(project.ageRange)?.maxWords} words. You NEVER write paragraphs.`
//       : `You write chapter books for ages ${project.ageRange} with full prose narratives.`
//     }
// CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
// Your entire response must start with { and end with }
// ${universeBlock(universe)}
// ${kbBlock(kb)}`;

//   // Replace the picture-book prompt section with:
//   if (pictureBook) {
//     const limits = getTextLimit(project.ageRange);

//     const prompt = `Write Chapter ${chapterIndex + 1} of the PICTURE BOOK "${project.title}".

// Chapter outline:
// - Title: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
// - Goal: ${chapterOutline?.goal || ''}
// - Key Scene: ${chapterOutline?.keyScene || ''}
// - Dua Hint: ${chapterOutline?.duaHint || ''}

// ${charactersBlock(characters)}

// STRICT RULES FOR AGES ${project.ageRange}:
// - MAX ${limits.maxWords} WORDS PER SPREAD — this is a hard limit, never exceed it
// - MAX ${limits.sentences} sentence(s) per spread
// - ${limits.rhyme ? 'MUST rhyme — simple AABB couplets like Dr. Seuss' : 'Simple clear sentences'}
// - Words must be understood by a ${project.ageRange} year old child
// - NO long descriptions, NO complex vocabulary, NO paragraphs
// - Child cannot read — text is read ALOUD by parent, illustrations tell the story
// - 4-6 spreads per chapter, each spread = one clear moment

// Respond with ONLY this JSON (raw JSON, no fences, start with {):
// {
//   "chapterNumber": ${chapterIndex + 1},
//   "chapterTitle": "${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}",
//   "spreads": [
//     {
//       "spreadIndex": 0,
//       "text": "ONE or TWO short sentences MAX — ${limits.maxWords} words hard limit",
//       "illustrationHint": "detailed scene description for illustrator",
//       "textPosition": "bottom"
//     }
//   ],
//   "islamicAdabChecks": ["string"],
//   "vocabularyNotes": ["string"]
// }`;

//     return { system, prompt };
//   }

//   // Chapter-book mode (ages 8+): full prose
//   const prompt = `Write Chapter ${chapterIndex + 1} of "${project.title}".

// Chapter outline:
// - Title: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
// - Goal: ${chapterOutline?.goal || ''}
// - Key Scene: ${chapterOutline?.keyScene || ''}
// - Dua Hint: ${chapterOutline?.duaHint || ''}

// ${charactersBlock(characters)}

// Respond with ONLY this JSON:
// {
//   "chapterNumber": ${chapterIndex + 1},
//   "chapterTitle": "string",
//   "text": "string (the full chapter prose, minimum 200 words)",
//   "chapterIllustrationHint": "string (describe ONE illustration to open the chapter)",
//   "vocabularyNotes": ["string"],
//   "islamicAdabChecks": ["string"]
// }`;

//   return { system, prompt };
// }

// // ── 5. Humanize ───────────────────────────────────────────────────────────────
// function buildHumanizePrompt({ project, kb }, chapterIndex) {
//   const chaptersArr = normArr(project.artifacts?.chapters);
//   const chapter = chaptersArr[chapterIndex];
//   const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';
//   const pictureBook = isPictureBook(project.ageRange);

//   const system = `You are a children's book editor specialising in Islamic content for ages ${project.ageRange || '6-8'}.
// Improve naturalness, read-aloud rhythm, and age-appropriateness. Check avoid-topics list.
// CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
// Your entire response must start with { and end with }`;

//   if (pictureBook) {
//     const limits = getTextLimit(project.ageRange); // ← ADD THIS LINE

//     const prompt = `Polish this PICTURE BOOK chapter. Improve rhyme, rhythm, and simplicity for young readers.

// Chapter: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}
// Original spreads:
// ${JSON.stringify(chapter?.spreads || [], null, 2)}

// Topics to AVOID: ${avoidTopics}

// STRICT RULES FOR AGES ${project.ageRange}:
// - MAX ${limits.maxWords} WORDS per spread — HARD LIMIT
// - Ages 2-4: exactly 1 sentence, must rhyme
// - Ages 4-6: max 2 short sentences, rhyming preferred  
// - REJECT any spread text over ${limits.maxWords} words and rewrite it shorter

// Respond with ONLY this JSON:
// {
//   "chapterNumber": ${chapterIndex + 1},
//   "chapterTitle": "string",
//   "spreads": [
//     {
//       "spreadIndex": 0,
//       "text": "string (polished 1-2 sentences)",
//       "illustrationHint": "string",
//       "textPosition": "top | bottom | overlay-top | overlay-bottom"
//     }
//   ],
//   "changesMade": ["string (describe each change)"]
// }`;

//     return { system, prompt };
//   }

//   // Chapter-book humanize
//   const prompt = `Polish this chapter. Improve dialogue, sentence rhythm, and vocabulary for young readers.

// Chapter: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}
// Original text:
// ${chapter?.text || '(no text)'}

// Topics to AVOID: ${avoidTopics}

// Respond with ONLY this JSON:
// {
//   "chapterNumber": ${chapterIndex + 1},
//   "chapterTitle": "string",
//   "text": "string (improved full chapter prose, minimum 200 words)",
//   "chapterIllustrationHint": "string",
//   "changesMade": ["string"]
// }`;

//   return { system, prompt };
// }

// // ─── Stage Builders Map ───────────────────────────────────────────────────────

// const STAGE_BUILDERS = {
//   outline: (ctx, _idx) => buildOutlinePrompt(ctx),
//   dedication: (ctx, _idx) => buildDedicationPrompt(ctx),
//   theme: (ctx, _idx) => buildThemePagePrompt(ctx),
//   chapter: (ctx, idx) => buildChapterPrompt(ctx, idx),
//   humanize: (ctx, idx) => buildHumanizePrompt(ctx, idx),
// };

// // ─── Main Entry ───────────────────────────────────────────────────────────────

// export async function generateStageText({ stage, projectId, userId, chapterIndex = 0 }) {
//   console.log(`\n[TextService] ▶ stage=${stage} project=${projectId} chapterIndex=${chapterIndex}`);

//   const ctx = await buildUniverseContext(projectId, userId);
//   const budget = AI_TOKEN_BUDGETS[stage] || AI_TOKEN_BUDGETS.chapter;

//   const builder = STAGE_BUILDERS[stage];
//   if (!builder) throw new Error(`Unknown stage: ${stage}`);

//   const { system, prompt } = builder(ctx, chapterIndex);

//   const promptTokens = estimateTokens(system + prompt);
//   console.log(`[TextService] Prompt tokens ~${promptTokens} (max ${budget.maxPromptTokens})`);

//   if (promptTokens > budget.maxPromptTokens) {
//     throw Object.assign(
//       new Error(`Prompt too large for ${stage}: ${promptTokens} > ${budget.maxPromptTokens}`),
//       { code: 'AI_TOKEN_BUDGET_EXCEEDED' }
//     );
//   }

//   console.log(`[TextService] Calling AI provider for stage="${stage}"...`);
//   const aiRes = await generateText({ system, prompt, maxOutputTokens: budget.maxOutputTokens, stage });

//   console.log(`[TextService] Provider: ${aiRes.provider}, response length: ${aiRes.text?.length} chars`);
//   console.log(`[TextService] Raw response preview (first 300): ${aiRes.text?.slice(0, 300)}`);

//   const parsed = safeParse(aiRes.text);

//   if (parsed.raw) {
//     console.error('[TextService] ⚠ Could not parse JSON even after fence-stripping. Storing raw.');
//   }

//   // ── Persist to MongoDB ─────────────────────────────────────────────────────
//   const freshProject = await Project.findById(projectId);
//   const setFields = {};

//   if (stage === 'outline') {
//     setFields['artifacts.outline'] = parsed;
//     // Also hoist dedication + theme if outline returned them
//     if (parsed.dedicationMessage) {
//       setFields['artifacts.dedication'] = {
//         greeting: 'Assalamu Alaikum, dear parents!',
//         message: parsed.dedicationMessage,
//         closing: `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`,
//         includeQrPlaceholder: true,
//       };
//     }
//     if (parsed.islamicTheme) {
//       setFields['artifacts.themePage'] = parsed.islamicTheme;
//     }
//     setFields.currentStage = 'outline';
//     console.log('[TextService] Saving outline — bookTitle:', parsed.bookTitle, 'chapters:', parsed.chapters?.length);

//   } else if (stage === 'dedication') {
//     setFields['artifacts.dedication'] = parsed;
//     console.log('[TextService] Saving dedication page');

//   } else if (stage === 'theme') {
//     setFields['artifacts.themePage'] = parsed;
//     console.log('[TextService] Saving theme page — section:', parsed.sectionTitle);

//   } else if (stage === 'chapter') {
//     const chapters = normArr(freshProject.artifacts?.chapters);
//     chapters[chapterIndex] = parsed;
//     setFields['artifacts.chapters'] = chapters;
//     setFields.currentStage = 'chapters';
//     const spreadsCount = parsed.spreads?.length;
//     console.log(`[TextService] Saving chapter[${chapterIndex}] — spreads: ${spreadsCount ?? 'N/A (chapter-book)'}, title: ${parsed.chapterTitle}`);

//   } else if (stage === 'humanize') {
//     const humanized = normArr(freshProject.artifacts?.humanized);
//     humanized[chapterIndex] = parsed;
//     setFields['artifacts.humanized'] = humanized;
//     setFields.currentStage = 'humanized';
//     console.log(`[TextService] Saving humanized[${chapterIndex}] — changesMade: ${parsed.changesMade?.length}`);
//   }

//   setFields[`aiUsage.stages.${stage}`] = {
//     inputTokens: aiRes.usage?.inputTokens,
//     outputTokens: aiRes.usage?.outputTokens,
//     updatedAt: new Date(),
//   };

//   await Project.findByIdAndUpdate(projectId, {
//     $set: setFields,
//     $inc: {
//       'aiUsage.totalInputTokens': aiRes.usage?.inputTokens || 0,
//       'aiUsage.totalOutputTokens': aiRes.usage?.outputTokens || 0,
//     },
//   });

//   console.log(`[TextService] ✓ stage="${stage}" persisted to MongoDB`);
//   return { result: parsed, usage: aiRes.usage, provider: aiRes.provider };
// }