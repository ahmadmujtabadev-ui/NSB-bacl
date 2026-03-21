// server/services/ai/text/text.service.js
//
// Age routing:
//   < 6   → SPREADS-ONLY  (no chapters, max 10 words/page, complete natural sentences)
//   6-8   → PICTURE BOOK  (chapter structure, short spread text)
//   9+    → CHAPTER BOOK  (full prose chapters, 900-1400 words, optional illustration moments)

import { Project } from '../../../models/Project.js';
import { Universe } from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { KnowledgeBase } from '../../../models/KnowledgeBase.js';
import { NotFoundError } from '../../../errors.js';
import { generateText } from './text.providers.js';
import { AI_TOKEN_BUDGETS, estimateTokens } from '../policies/tokenBudget.js';

// ─── Age routing — single source of truth ─────────────────────────────────────

export function getAgeProfile(ageRange) {
  const nums = String(ageRange || '').match(/\d+/g) || [];
  const first = Number(nums[0] || 8);
  const last = Number(nums[1] || first);
  const avg = (first + last) / 2;

  // Under 6 → no chapters anywhere
  if (first <= 5) {
    return {
      mode: 'spreads-only',
      spreadOnly: true,
      chapterProse: false,
      rhyme: true,

      maxWords: 10,
      minWords: 0,

      minChapterWords: 0,
      maxChapterWords: 0,

      illustrationsPerChapter: 0,
      spreadsPerChapter: 0,
      sentenceStyle: 'simple-complete',
    };
  }

  // 6–8 → picture-book chapter flow
  if (avg <= 8) {
    return {
      mode: 'picture-book',
      spreadOnly: false,
      chapterProse: false,
      rhyme: false,

      maxWords: 24,
      minWords: 0,

      minChapterWords: 0,
      maxChapterWords: 0,

      illustrationsPerChapter: 2,
      spreadsPerChapter: 2,
      sentenceStyle: 'simple-narrative',
    };
  }

  // 9+ → full prose chapter book
  return {
    mode: 'chapter-book',
    spreadOnly: false,
    chapterProse: true,
    rhyme: false,

    maxWords: 0,
    minWords: 0,

    minChapterWords: 900,
    maxChapterWords: 1400,

    illustrationsPerChapter: 2,
    spreadsPerChapter: 0,
    sentenceStyle: 'rich-novelistic',
  };
}

export function isPictureBook(ageRange) {
  const p = getAgeProfile(ageRange);
  return p.mode === 'picture-book' || p.mode === 'spreads-only';
}

export function isSpreadOnlyMode(ageRange) {
  return getAgeProfile(ageRange).mode === 'spreads-only';
}

// Legacy compat
export function getTextLimit(ageRange) {
  const p = getAgeProfile(ageRange);
  return {
    maxWords: p.maxWords,
    minChapterWords: p.minChapterWords,
    maxChapterWords: p.maxChapterWords,
    sentences: p.chapterProse ? 0 : 2,
    rhyme: p.rhyme,
    spreadOnly: p.spreadOnly,
    chapterProse: p.chapterProse,
  };
}

// ─── Array helpers ────────────────────────────────────────────────────────────

export function normArr(val) {
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
  if (!text) return { ok: false, data: { raw: text } };

  const clean = stripFences(text);

  try {
    const parsed = JSON.parse(clean);
    return { ok: true, data: parsed };
  } catch (_) {
    // continue
  }

  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const slice = clean.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(slice);
      console.warn('[TextService] JSON recovered via brace-slicing');
      return { ok: true, data: parsed };
    } catch (_) {
      // continue
    }
  }

  if (firstBrace !== -1) {
    try {
      let partial = clean.slice(firstBrace);
      let openBraces = 0;
      let openBrackets = 0;
      let inString = false;
      let escaped = false;

      for (const ch of partial) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++;
        if (ch === ']') openBrackets--;
      }

      if (inString) partial += '"...(truncated)"';
      while (openBrackets > 0) { partial += ']'; openBrackets--; }
      while (openBraces > 0) { partial += '}'; openBraces--; }

      const parsed = JSON.parse(partial);
      console.warn('[TextService] JSON recovered by closing truncated structure');
      return { ok: true, data: parsed };
    } catch (_) {
      // fall through
    }
  }

  console.error('[TextService] All JSON parse attempts failed');
  console.error('[TextService] Raw preview:', text?.slice(0, 400));
  return { ok: false, data: { raw: text } };
}

// ─── Arabic safety block ──────────────────────────────────────────────────────

const ARABIC_PHRASES = {
  bismillah:        { arabic: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', transliteration: 'Bismillah ir-Rahman ir-Raheem', meaning: 'In the name of Allah, the Most Gracious, the Most Merciful' },
  alhamdulillah:    { arabic: 'الْحَمْدُ لِلَّهِ', transliteration: 'Alhamdulillah', meaning: 'All praise is for Allah' },
  subhanallah:      { arabic: 'سُبْحَانَ اللَّهِ', transliteration: 'SubhanAllah', meaning: 'Glory be to Allah' },
  allahu_akbar:     { arabic: 'اللَّهُ أَكْبَرُ', transliteration: 'Allahu Akbar', meaning: 'Allah is the Greatest' },
  inshallah:        { arabic: 'إِنْ شَاءَ اللَّهُ', transliteration: "In sha' Allah", meaning: 'If Allah wills' },
  mashallah:        { arabic: 'مَا شَاءَ اللَّهُ', transliteration: "Masha' Allah", meaning: 'What Allah has willed' },
  assalamu_alaykum: { arabic: 'السَّلَامُ عَلَيْكُمْ', transliteration: 'Assalamu Alaykum', meaning: 'Peace be upon you' },
  jazakallah_khair: { arabic: 'جَزَاكَ اللَّهُ خَيْرًا', transliteration: 'Jazakallah Khair', meaning: 'May Allah reward you with goodness' },
  astaghfirullah:   { arabic: 'أَسْتَغْفِرُ اللَّهَ', transliteration: 'Astaghfirullah', meaning: 'I seek forgiveness from Allah' },
  sabr:             { arabic: 'صَبْر', transliteration: 'Sabr', meaning: 'Patience' },
  tawakkul:         { arabic: 'تَوَكُّل', transliteration: 'Tawakkul', meaning: 'Trust in Allah' },
  shukr:            { arabic: 'شُكْر', transliteration: 'Shukr', meaning: 'Gratitude' },
};

function buildArabicBlock() {
  const list = Object.values(ARABIC_PHRASES)
    .map(p => `  • ${p.transliteration}: "${p.arabic}" — ${p.meaning}`)
    .join('\n');

  return `
ARABIC RULES (CRITICAL — violations break the book):
1. NEVER generate Arabic script yourself
2. ONLY use exact Unicode strings from this approved list:
${list}
3. If phrase is NOT in the list, use ONLY the transliteration
4. Always return: { arabic, transliteration, meaning } as separate fields`;
}

// ─── Context helpers ──────────────────────────────────────────────────────────

function universeBlock(universe) {
  if (!universe) return '';
  return `UNIVERSE: ${universe.name}
Description: ${universe.description || 'Islamic family stories'}
Art style: ${universe.artStyle || 'Pixar 3D animation'}`;
}

function kbBlock(kb) {
  if (!kb) return '';
  return `KNOWLEDGE BASE: ${kb.name}
Islamic Values: ${(kb.islamicValues || []).join(', ')}
Avoid Topics: ${(kb.avoidTopics || []).join(', ')}
Illustration Rules: ${(kb.illustrationRules || []).join('; ')}`;
}

function characterBlock(characters) {
  if (!characters?.length) return 'No specific characters defined.';
  return `APPROVED CHARACTERS (use ONLY these names):
${characters.map(c => {
  const vd = c.visualDNA || {};
  const mod = c.modestyRules || {};
  return `  • ${c.name} — ${c.role}, age ${c.ageRange}, ${vd.gender || 'child'}
    Traits: ${(c.traits || []).join(', ')}
    Speech: ${c.speakingStyle || c.speechStyle || 'warm and kind'}
    ${mod.hijabAlways ? 'ALWAYS wears hijab' : ''}
    ${mod.looseClothing ? 'Always modestly dressed' : ''}`;
}).join('\n')}
RULE: Only use character names from this list. Do NOT invent new characters.`;
}

// ─── Context loader ───────────────────────────────────────────────────────────

export async function buildUniverseContext(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const [universe, kb] = await Promise.all([
    project.universeId ? Universe.findById(project.universeId) : null,
    project.knowledgeBaseId ? KnowledgeBase.findById(project.knowledgeBaseId) : null,
  ]);

  let characters = [];
  if (project.characterIds?.length) {
    characters = await Character.find({ _id: { $in: project.characterIds } });
  } else if (project.universeId) {
    characters = await Character.find({ universeId: project.universeId });
  }

  return { project, universe, characters, kb };
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1: STORY GENERATION
// ══════════════════════════════════════════════════════════════════════════════

function buildStoryPrompt({ project, universe, characters, kb }, storyIdea) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const charBlock = characterBlock(characters);

  const formatDesc = profile.mode === 'spreads-only'
    ? `SPREADS-ONLY PICTURE BOOK for ages ${project.ageRange}:
  - NO chapters — just illustrated pages with short text
  - Max ${profile.maxWords} words per page
  - Simple, warm, complete sentences
  - Each page is one natural, complete thought
  - Story total: 300-500 words flowing narrative`
    : profile.mode === 'picture-book'
      ? `PICTURE BOOK for ages ${project.ageRange}:
  - Simple chapters with illustrated spreads
  - Max ${profile.maxWords} words per spread
  - Warm storytelling with clear scenes
  - Story total: 400-700 words`
      : `CHAPTER BOOK for ages ${project.ageRange}:
  - Story step generates: title, synopsis, moral, character descriptions, and chapter outline
  - Full chapter prose is generated separately per chapter
  - Keep storyText to 500-900 words — a strong narrative synopsis of the full book arc, not full chapter prose
  - Style: immersive, literary, upper middle-grade, emotionally warm, adventurous, and faith-grounded`;

  const system = `You are an expert Islamic children's book author.
Book Format:
${formatDesc}

${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}
${arabic}
CRITICAL: Output ONLY raw valid JSON. NO markdown fences. Start with { end with }`;

  const chapterBookExtra = profile.mode === 'chapter-book' ? `
This is a CHAPTER BOOK for ages ${project.ageRange}.
The "storyText" field should be a SYNOPSIS (500-900 words), NOT the full book prose.
The full chapter text is generated separately as real prose chapters.
Each later chapter should expand into rich narrative scenes with dialogue, setting, tension, and natural Islamic values.
Also include "chapterOutline" — EXACTLY ${project.chapterCount || 4} chapters with title, goal, keyScene, islamicMoment, endingBeat, and optional illustration moments.` : '';

  const prompt = `Write an Islamic children's story from this idea:

STORY IDEA: "${storyIdea || project.title}"
Age Range: ${project.ageRange}
Islamic Theme: ${project.learningObjective || 'Islamic values, character building'}
Language: ${project.language || 'english'}
Author: ${project.authorName || 'NoorStudio'}
${chapterBookExtra}

The story must:
- Be age-appropriate for ${project.ageRange} year olds
- Teach Islamic values naturally through the plot (never preachy)
- Feature the approved characters with distinct personalities
- Have a clear story arc: beginning → rising action → climax → resolution
- Include natural Islamic moments (dua, prayer, Bismillah) woven into daily life
- End with a memorable Islamic moral/lesson

Respond ONLY with this JSON (keep storyText under ${profile.mode === 'chapter-book' ? '900' : '600'} words):
{
  "bookTitle": "engaging, age-appropriate title",
  "synopsis": "2-3 sentence summary",
  "moral": "The specific Islamic lesson this story teaches",
  "storyText": "${profile.mode === 'chapter-book' ? 'Narrative synopsis 500-900 words — full story arc, not full prose' : 'Complete story 300-600 words'}",
  "suggestedPageCount": ${profile.mode === 'chapter-book' ? 0 : 10},
  "suggestedChapterCount": ${profile.mode === 'chapter-book' ? (project.chapterCount || 4) : 0},
  "spreadOnly": ${profile.spreadOnly},
  "islamicTheme": {
    "concept": "the core Islamic concept",
    "arabicPhrase": "EXACT Unicode from approved list only",
    "transliteration": "string",
    "meaning": "string"
  },
  "dedicationMessage": "2-3 warm sentences to parents",
  "characters": [
    {
      "name": "string",
      "role": "protagonist|supporting|parent",
      "ageRange": "string",
      "gender": "boy|girl",
      "keyTraits": ["trait1", "trait2"]
    }
  ]${profile.mode === 'chapter-book' ? `,
  "chapterOutline": [
    {
      "chapterNumber": 1,
      "title": "engaging chapter title",
      "goal": "what happens and why it matters",
      "keyScene": "specific moment — who does what, where",
      "islamicMoment": "natural Islamic element in this chapter",
      "endingBeat": "what emotional note or suspense closes the chapter",
      "illustrationMoments": ["short visual beat 1", "short visual beat 2"]
    }
  ]` : ''}
}`;

  return { system, prompt };
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2a: SPREAD PLANNING (for ages < 6 and 6-8)
// ══════════════════════════════════════════════════════════════════════════════

function buildSpreadPlanningPrompt({ project, universe, characters, kb }) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const charBlock = characterBlock(characters);
  const storyText = project.artifacts?.storyText || project.artifacts?.outline?.synopsis || '';
  const bookStyle = project.bookStyle || {};
  const pageCount = project.chapterCount || 10;

  const textRules = profile.mode === 'spreads-only'
    ? `TEXT RULES FOR AGE ${project.ageRange} (CRITICAL):
  - Each page gets EXACTLY ONE complete, natural sentence (max ${profile.maxWords} words)
  - The sentence must make complete sense on its own
  - Use simple vocabulary a ${project.ageRange}-year-old understands
  - Warm, gentle, comforting tone
  - Can rhyme naturally (AABB pattern) but never force rhyme at the cost of clarity
  - GOOD examples: "Layla heard the Adhan and ran to make wudu."
                  "She washed her hands, face, and feet — all clean and ready."
                  "Mama smiled and said, 'Time to pray, my love.'"
  - BAD examples: "Layla wudu" (fragment)
                  "The washing of hands before prayer Bismillah" (run-on fragment)
                  "She ran fast quick smile" (not a sentence)
  - EVERY text field must be a grammatically complete sentence.`
    : `TEXT RULES FOR AGE ${project.ageRange}:
  - 1-2 complete sentences per spread (max ${profile.maxWords} words)
  - Clear, warm narrative prose
  - Age-appropriate vocabulary`;

  const system = `You are an expert Islamic children's picture book author and illustrator.
Age: ${project.ageRange} — Mode: ${profile.mode}

${textRules}

CRITICAL: Output ONLY raw valid JSON. Start with { end with }
${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}
${arabic}`;

  const prompt = `Break this story into ${pageCount} illustrated page spreads.

STORY:
"${storyText}"

Book title: "${project.artifacts?.outline?.bookTitle || project.title}"
Art style: ${bookStyle.artStyle || 'Pixar 3D animation'}
Background: ${bookStyle.backgroundStyle || 'mixed indoor/outdoor'}
Indoor setting: ${bookStyle.indoorRoomDescription || 'warm cozy room with soft colors'}
Outdoor setting: ${bookStyle.outdoorDescription || 'sunny garden with green grass and flowers'}
Recurring props: ${bookStyle.bookProps || 'none specified'}

For EACH of the ${pageCount} spreads, write:
- A COMPLETE NATURAL SENTENCE for "text" (not a fragment — see rules above)
- A rich illustration scene description
- Character emotions
- Scene environment

Respond ONLY with:
{
  "spreadOnly": ${profile.spreadOnly},
  "totalSpreads": ${pageCount},
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "${profile.mode === 'spreads-only' ? `ONE complete natural sentence, max ${profile.maxWords} words` : `1-2 sentences, max ${profile.maxWords} words`}",
      "prompt": "The writing instruction that produced this page text",
      "illustrationHint": "Vivid scene: who is doing what, where, with what expression, specific objects visible",
      "charactersInScene": ["approved character names only"],
      "characterEmotion": { "CharacterName": "specific emotion like happy, curious, peaceful" },
      "sceneEnvironment": "indoor|outdoor",
      "timeOfDay": "morning|afternoon|evening|night",
      "textPosition": "bottom|top",
      "islamicElement": "specific Islamic detail in this scene or null"
    }
  ]
}`;
  return { system, prompt };
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2b: CHAPTER GENERATION (for ages 6-8 picture books)
// ══════════════════════════════════════════════════════════════════════════════

function buildPictureBookChapterPrompt({ project, universe, characters, kb }, chapterIndex) {
  const profile = getAgeProfile(project.ageRange);
  const outline = project.artifacts?.outline;
  const chapterOutline = outline?.chapters?.[chapterIndex];
  const arabic = buildArabicBlock();
  const sceneChars = (chapterOutline?.charactersInScene || []).length
    ? characters.filter(c => chapterOutline.charactersInScene.includes(c.name))
    : characters;

  const system = `You are an expert Islamic children's picture book author.
PICTURE BOOK for ages ${project.ageRange}. MAX ${profile.maxWords} words per spread.
Each spread = one illustrated page with 1-2 short sentences.
Output ONLY raw valid JSON. No markdown.
${universeBlock(universe)}
${kbBlock(kb)}
${characterBlock(sceneChars)}
${arabic}`;

  return {
    system,
    prompt: `Write Chapter ${chapterIndex + 1} of "${project.title}".
Chapter: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
Goal: ${chapterOutline?.goal || ''}
Key Scene: ${chapterOutline?.keyScene || ''}
Characters in this chapter: ${sceneChars.map(c => c.name).join(', ')}
MAX ${profile.maxWords} words per spread text.

Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "1-2 clear sentences, max ${profile.maxWords} words",
      "prompt": "instruction used to write this spread",
      "illustrationHint": "detailed scene — who, what, where, emotions",
      "charactersInSpread": ["approved names only"],
      "textPosition": "bottom",
      "characterEmotion": { "Name": "emotion" },
      "sceneEnvironment": "indoor|outdoor"
    }
  ]
}`
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAPTER BOOK PROSE GENERATION (ages 9+)
// ══════════════════════════════════════════════════════════════════════════════

function buildChapterBookProsePrompt({ project, universe, characters, kb }, chapterIndex) {
  const profile = getAgeProfile(project.ageRange);
  const outline = project.artifacts?.outline || {};
  const chapterOutline = normArr(outline?.chapters || [])[chapterIndex];
  const storyText = project.artifacts?.storyText || '';
  const arabic = buildArabicBlock();
  const bookStyle = project.bookStyle || {};

  const totalChapters = normArr(outline?.chapters || []).length || project.chapterCount || 4;

  const previousChapters = normArr(project.artifacts?.chapters)
    .slice(0, chapterIndex)
    .map((ch, i) => ({
      chapterNumber: i + 1,
      chapterTitle: ch.chapterTitle || ch.title || `Chapter ${i + 1}`,
      chapterSummary: ch.chapterSummary || '',
      chapterTextPreview: String(ch.chapterText || ch.text || '').slice(0, 500),
    }));

  const sceneChars = (chapterOutline?.charactersInScene || []).length
    ? characters.filter(c => chapterOutline.charactersInScene.includes(c.name))
    : characters;

  const system = `You are an expert Islamic children's chapter book author for ages ${project.ageRange}.

This is a REAL CHAPTER BOOK, not a spread-based picture book.

CRITICAL WRITING RULES:
- Write ONE full prose chapter.
- Length: ${profile.minChapterWords}-${profile.maxChapterWords} words.
- Use polished, descriptive, upper middle-grade English.
- Write like a real published children's adventure novel.
- Blend atmosphere, action, dialogue, emotion, and character thoughts naturally.
- Use strong scene-setting with sensory detail: light, sound, texture, weather, movement, and mood.
- Keep dialogue natural and character-specific.
- Maintain continuity with earlier chapters.
- Use third-person narrative past tense.
- Integrate Islamic values naturally through character choices, duas, prayer, gratitude, honesty, patience, or trust in Allah.
- Never make the chapter read like page text, spread text, fragments, or mini summaries.
- Do not compress the chapter too much.
- End with suspense, curiosity, discovery, or a meaningful emotional shift.

STYLE TARGET:
- immersive
- literary but age-appropriate
- emotionally warm
- adventurous
- faith-grounded
- novel-like, not lesson-like

${universeBlock(universe)}
${kbBlock(kb)}
${characterBlock(sceneChars)}
${arabic}

CRITICAL: Output ONLY raw valid JSON. No markdown fences. No extra commentary.`;

  const prompt = `Write Chapter ${chapterIndex + 1} of ${totalChapters} of "${project.title}".

BOOK SYNOPSIS:
${storyText.slice(0, 2200)}

CHAPTER DETAILS:
Number: ${chapterIndex + 1}
Title: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
Goal: ${chapterOutline?.goal || 'Advance the story meaningfully and deepen character growth'}
Key Scene: ${chapterOutline?.keyScene || 'A meaningful turning point in the chapter'}
Islamic Moment: ${chapterOutline?.duaHint || 'A natural Islamic value or faith moment'}
Ending Beat: ${chapterOutline?.endingBeat || 'End with momentum, curiosity, or emotional resonance'}
Characters: ${sceneChars.map(c => c.name).join(', ') || 'Use approved characters only'}
Art Style Reference: ${bookStyle.artStyle || 'Pixar 3D animation'}
Setting Reference: ${
  bookStyle.backgroundStyle === 'indoor'
    ? (bookStyle.indoorRoomDescription || 'indoor setting')
    : bookStyle.backgroundStyle === 'outdoor'
      ? (bookStyle.outdoorDescription || 'outdoor setting')
      : 'mixed indoor/outdoor'
}

${previousChapters.length ? `PREVIOUS CHAPTER CONTEXT:
${JSON.stringify(previousChapters, null, 2)}` : 'This is the opening chapter.'}

Respond ONLY with this JSON:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}",
  "islamicMoment": "specific Islamic value, dua, prayer, or faith-based moment in this chapter",
  "chapterSummary": "2-3 sentence summary of what happens",
  "chapterText": "Full prose chapter of ${profile.minChapterWords}-${profile.maxChapterWords} words",
  "illustrationMoments": [
    {
      "momentTitle": "short label for the illustration moment",
      "illustrationHint": "detailed visual scene from the chapter with characters, setting, mood, and action",
      "charactersInScene": ["approved character names only"],
      "sceneEnvironment": "indoor|outdoor",
      "timeOfDay": "morning|afternoon|evening|night"
    }
  ]
}`;
  return { system, prompt };
}

// ══════════════════════════════════════════════════════════════════════════════
// SPREADS-ONLY PROMPT (explicit stage for age < 6)
// ══════════════════════════════════════════════════════════════════════════════

function buildSpreadsOnlyPrompt({ project, universe, characters, kb }) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const outline = project.artifacts?.outline;
  const count = normArr(outline?.spreads || []).length || project.chapterCount || 10;

  const system = `You are an expert Islamic picture book author for very young children (ages ${project.ageRange}).

SENTENCE RULES — READ CAREFULLY:
Every single "text" field MUST be ONE complete, natural, grammatically correct sentence.
Maximum ${profile.maxWords} words per sentence.

GOOD examples of complete sentences (${profile.maxWords} words max):
✓ "Hana washed her hands and face, ready to pray."
✓ "Baba smiled and held her little hand tight."
✓ "She heard the Adhan and her heart felt warm."
✓ "Bismillah, said Mia, before she took a bite."

BAD examples — these will BREAK the book:
✗ "Hana wudu prayer" (fragment — not a sentence)
✗ "The morning light Adhan calling" (fragment)
✗ "She ran quick Mama smile happy" (not grammatical)

Each sentence should carry ONE clear, warm emotional moment.
The ${count} sentences together should tell a complete story arc.

Output ONLY raw valid JSON.
${universeBlock(universe)}
${kbBlock(kb)}
${characterBlock(characters)}
${arabic}`;

  return {
    system,
    prompt: `Write all ${count} pages for "${project.title}".
Age: ${project.ageRange}
Islamic Objective: ${project.learningObjective || 'Islamic daily life and values'}
Outline: ${JSON.stringify(normArr(outline?.spreads || []).map(s => s.textHint || s.sceneDescription || ''), null, 2)}

Write ONE complete grammatical sentence per page (max ${profile.maxWords} words each).
${profile.rhyme ? 'The sentences may rhyme (AABB) if it sounds natural — but NEVER sacrifice clarity for rhyme.' : ''}

Respond ONLY with:
{
  "spreadOnly": true,
  "totalSpreads": ${count},
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "ONE complete grammatical sentence, max ${profile.maxWords} words",
      "prompt": "instruction for this page",
      "illustrationHint": "detailed scene: characters, actions, setting, mood, specific objects",
      "textPosition": "bottom",
      "charactersInScene": ["approved names only"],
      "characterEmotion": { "Name": "emotion" },
      "sceneEnvironment": "indoor|outdoor",
      "timeOfDay": "morning|afternoon|evening"
    }
  ]
}`
  };
}

// ─── Outline ──────────────────────────────────────────────────────────────────

function buildOutlinePrompt({ project, universe, characters, kb }) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();

  const system = `You are an expert Islamic children's book author.
CRITICAL: Output ONLY raw valid JSON. NO markdown. Start with { end with }
${universeBlock(universe)}
${kbBlock(kb)}
${characterBlock(characters)}
${arabic}`;

  const prompt = profile.spreadOnly ? `
Create a spreads-only picture book outline for ages ${project.ageRange}.
Title: "${project.title}"
Learning Objective: ${project.learningObjective || 'Islamic values'}
NO chapters — just ${project.chapterCount || 10} illustrated spreads.
Respond ONLY with:
{
  "bookTitle": "string",
  "moral": "string",
  "synopsis": "string",
  "spreadOnly": true,
  "totalSpreads": ${project.chapterCount || 10},
  "dedicationMessage": "string",
  "islamicTheme": {
    "title": "string",
    "arabicPhrase": "EXACT Unicode from approved list",
    "transliteration": "string",
    "meaning": "string",
    "reference": "string",
    "referenceText": "string",
    "whyWeDoIt": "string"
  },
  "spreads": [
    {
      "spreadIndex": 0,
      "sceneDescription": "vivid scene description",
      "illustrationHint": "string",
      "textHint": "one sentence idea for this page",
      "islamicValue": "string"
    }
  ]
}` : `
Create EXACTLY ${project.chapterCount || 4} chapters for "${project.title}".
CRITICAL: Generate EXACTLY ${project.chapterCount || 4} chapter objects — not more, not fewer.
Age Range: ${project.ageRange}
Mode: ${profile.mode}
Learning Objective: ${project.learningObjective || 'Islamic values'}
${profile.mode === 'chapter-book' ? `
CHAPTER BOOK RULES (ages ${project.ageRange}):
- Each chapter is a full prose chapter, not spread text
- Each chapter should support a ${profile.minChapterWords}-${profile.maxChapterWords} word final chapter draft
- Each chapter must have a clear mini-arc: setup → development → turning point → closing beat
- Tension should build chapter by chapter toward the final resolution
- Islamic values should emerge naturally through choices, relationships, and consequences
- Include 1 natural Islamic moment per chapter (dua, Bismillah, prayer, tawakkul, shukr, sabr, etc.)
- Each chapter should end with curiosity, suspense, discovery, or emotional momentum
- You may include 1-3 optional illustration moments inside the chapter, but the chapter itself is prose
` : `
PICTURE BOOK RULES (ages ${project.ageRange}):
- Each chapter uses short illustrated spreads
- Language must stay simple, warm, and clear
- Islamic moments should feel natural
`}
Respond ONLY with:
{
  "bookTitle": "string",
  "moral": "the specific Islamic lesson",
  "synopsis": "2-3 sentence summary",
  "spreadOnly": false,
  "chapterCount": ${project.chapterCount || 4},
  "dedicationMessage": "string",
  "islamicTheme": {
    "title": "string",
    "arabicPhrase": "EXACT Unicode from approved list",
    "transliteration": "string",
    "meaning": "string",
    "reference": "string",
    "referenceText": "string",
    "whyWeDoIt": "string"
  },
  "chapters": [
    {
      "title": "engaging chapter title",
      "goal": "what happens and why it matters to the overall story",
      "keyScene": "specific action or turning point — who does what, where",
      "duaHint": "natural Islamic moment in this chapter",
      "endingBeat": "what emotional note or suspense closes the chapter",
      "charactersInScene": ["approved names only"],
      "chapterNumber": 1,
      "illustrationMoments": [
        "short visual moment 1",
        "short visual moment 2"
      ]
    }
  ]
}
IMPORTANT: The chapters array MUST have exactly ${project.chapterCount || 4} items.`;

  return { system, prompt };
}

// ─── Dedication ───────────────────────────────────────────────────────────────

function buildDedicationPrompt({ project }) {
  const arabic = buildArabicBlock();
  return {
    system: `You are a warm Islamic children's book author. Output ONLY raw valid JSON. ${arabic}`,
    prompt: `Write dedication for "${project.title}" by ${project.authorName || 'NoorStudio'}.
Respond ONLY with:
{
  "greeting": "Assalamu Alaikum, dear parents!",
  "message": "2-4 warm sentences about the book and Islamic parenting",
  "closing": "Jazakallah Khair — ${project.authorName || 'NoorStudio'}",
  "includeQrPlaceholder": true
}`
  };
}

// ─── Islamic Theme Page ───────────────────────────────────────────────────────

function buildThemePagePrompt({ project, kb }) {
  const arabic = buildArabicBlock();
  return {
    system: `You are an Islamic educator for children ages ${project.ageRange}. Output ONLY raw valid JSON. ${arabic}`,
    prompt: `Create Islamic theme reference page for "${project.title}".
Objective: ${project.learningObjective || 'Islamic values'}
${kb ? kbBlock(kb) : ''}
Respond ONLY with:
{
  "sectionTitle": "string",
  "arabicPhrase": "EXACT Unicode from approved list",
  "transliteration": "string",
  "meaning": "string",
  "referenceType": "quran|hadith",
  "referenceSource": "string",
  "referenceText": "string",
  "explanation": "3-4 child-friendly sentences",
  "dailyPractice": "1 sentence — what children can do today"
}`
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HUMANIZE
// ══════════════════════════════════════════════════════════════════════════════

function buildHumanizePrompt({ project, kb, characters }, chapterIndex) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';
  const chaptersArr = normArr(project.artifacts?.chapters);
  const chapter = chaptersArr[chapterIndex];

  const system = `You are a children's book editor for Islamic content, ages ${project.ageRange}.
Output ONLY raw valid JSON.
${characterBlock(characters)}
${arabic}`;

  if (profile.mode === 'chapter-book') {
    const chapterText = String(chapter?.chapterText || chapter?.text || '');

    return {
      system,
      prompt: `Polish Chapter ${chapterIndex + 1} of "${project.title}".

Current chapter title: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}

Current chapter text:
${chapterText}

Editing rules:
- Keep the original plot and meaning intact
- Keep the chapter in the ${profile.minChapterWords}-${profile.maxChapterWords} word range where reasonably possible
- Improve sentence flow, rhythm, and paragraph transitions
- Strengthen atmosphere, dialogue, and emotional clarity
- Make the writing feel immersive and novel-like
- Keep Islamic values natural and warm, never preachy
- Preserve continuity with earlier chapters
- Avoid: ${avoidTopics}

Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}",
  "chapterText": "improved full prose chapter",
  "chapterSummary": "improved 2-3 sentence summary",
  "changesMade": ["list of specific improvements"]
}`
    };
  }

  if (profile.mode === 'picture-book') {
    return {
      system,
      prompt: `Polish picture book chapter ${chapterIndex + 1} of "${project.title}".
Current spreads: ${JSON.stringify(chapter?.spreads || [], null, 2)}
Avoid: ${avoidTopics}
MAX ${profile.maxWords} words per spread.
Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "improved text, max ${profile.maxWords} words",
      "prompt": "updated instruction",
      "illustrationHint": "string",
      "charactersInSpread": [],
      "textPosition": "bottom",
      "characterEmotion": {},
      "sceneEnvironment": "indoor|outdoor"
    }
  ],
  "changesMade": ["list of changes"]
}`
    };
  }

  return buildSpreadHumanizePrompt({ project, characters, kb });
}

// ─── Spread humanize ──────────────────────────────────────────────────────────

function buildSpreadHumanizePrompt({ project, characters, kb }) {
  const profile = getAgeProfile(project.ageRange);
  const spreads = normArr(project.artifacts?.spreads || []);
  const arabic = buildArabicBlock();
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';

  const system = `You are an expert Islamic picture book editor for ages ${project.ageRange}.
SPREADS-ONLY book — ${spreads.length} pages, NO chapters.
EACH "text" MUST BE one complete, grammatically correct sentence (max ${profile.maxWords} words).
Output ONLY raw valid JSON.
${characterBlock(characters)}
${arabic}`;

  return {
    system,
    prompt: `Polish all ${spreads.length} page texts for "${project.title}".
Avoid: ${avoidTopics}
Keep spreadIndex, illustrationHint, textPosition, prompt UNCHANGED.
Only improve the "text" field — it must be ONE complete natural sentence per page.

Current spreads: ${JSON.stringify(spreads, null, 2)}

Respond ONLY with:
{
  "spreadOnly": true,
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "ONE complete grammatical sentence, max ${profile.maxWords} words",
      "prompt": "(copy original — do not change)",
      "illustrationHint": "(copy unchanged)",
      "textPosition": "bottom",
      "charactersInScene": [],
      "characterEmotion": {},
      "sceneEnvironment": "indoor|outdoor"
    }
  ],
  "changesMade": ["what improved"]
}`
  };
}

// ─── Spread rerun ─────────────────────────────────────────────────────────────

function buildSpreadRerunPrompt({ project, characters }, spreadIndex, customPrompt) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const current = normArr(
    project.artifacts?.spreads ||
    project.artifacts?.humanized?.[0]?.spreads ||
    project.artifacts?.chapters?.[0]?.spreads || []
  )[spreadIndex] || {};

  const system = `You are an expert Islamic ${profile.mode === 'picture-book' ? 'picture book' : 'spreads-only picture book'} author for ages ${project.ageRange}.
${profile.mode === 'spreads-only' ? `CRITICAL: The "text" field must be ONE complete natural sentence, max ${profile.maxWords} words.` : `MAX ${profile.maxWords} words per page.`}
Output ONLY raw valid JSON.
${characterBlock(characters)}
${arabic}`;

  return {
    system,
    prompt: `Rewrite page ${spreadIndex + 1} of "${project.title}".
Current text: "${current.text || '(none)'}"
Editor instruction: ${customPrompt}
Apply the instruction. ${profile.mode === 'spreads-only' ? `Result must be ONE complete sentence, max ${profile.maxWords} words.` : `Max ${profile.maxWords} words.`}
Respond ONLY with:
{
  "spreadIndex": ${spreadIndex},
  "text": "${profile.mode === 'spreads-only' ? 'ONE complete grammatical sentence' : 'improved text'}",
  "prompt": ${JSON.stringify(customPrompt)},
  "illustrationHint": "updated scene for approved characters",
  "textPosition": "bottom"
}`
  };
}

// ─── Save prompt history ──────────────────────────────────────────────────────

async function savePromptHistory(projectId, stage, index, promptText, result, provider) {
  const entry = {
    stage,
    index,
    prompt: promptText?.slice(0, 1000),
    resultPreview: JSON.stringify(result)?.slice(0, 200),
    provider,
    createdAt: new Date().toISOString(),
  };

  await Project.findByIdAndUpdate(projectId, {
    $push: { 'artifacts.promptHistory': { $each: [entry], $slice: -100 } },
  });
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function generateStageText({
  stage,
  projectId,
  userId,
  chapterIndex = 0,
  spreadIndex = 0,
  customPrompt,
  storyIdea,
}) {
  console.log(`\n[TextService] stage=${stage} project=${projectId} ch=${chapterIndex} sp=${spreadIndex}`);

  const ctx = await buildUniverseContext(projectId, userId);
  const profile = getAgeProfile(ctx.project.ageRange);

  let effectiveStage = stage;

  if ((stage === 'chapter' || stage === 'chapters') && profile.mode === 'spreads-only') {
    console.log(`[TextService] Age ${ctx.project.ageRange} (spreads-only) → redirecting ${stage}→spreads`);
    effectiveStage = 'spreads';
  }

  if (stage === 'spreadPlanning' && profile.mode === 'chapter-book') {
    console.log(`[TextService] Age ${ctx.project.ageRange} (chapter-book) → spread planning generates chapter outline`);
  }

  if (stage === 'spreadRerun' && profile.mode === 'chapter-book') {
    throw Object.assign(
      new Error('spreadRerun is not supported for chapter-book prose mode. Use chapter rerun instead.'),
      { code: 'INVALID_STAGE_FOR_MODE' }
    );
  }

  let builtPrompt;
  switch (effectiveStage) {
    case 'story':
      builtPrompt = buildStoryPrompt(ctx, storyIdea || ctx.project.artifacts?.storyIdea);
      break;

    case 'spreadPlanning':
      if (profile.mode === 'chapter-book') {
        builtPrompt = buildOutlinePrompt(ctx);
      } else {
        builtPrompt = buildSpreadPlanningPrompt(ctx);
      }
      break;

    case 'outline':
      builtPrompt = buildOutlinePrompt(ctx);
      break;

    case 'dedication':
      builtPrompt = buildDedicationPrompt(ctx);
      break;

    case 'theme':
      builtPrompt = buildThemePagePrompt(ctx);
      break;

    case 'chapter':
    case 'chapters':
      if (profile.mode === 'chapter-book') {
        builtPrompt = buildChapterBookProsePrompt(ctx, chapterIndex);
      } else if (profile.mode === 'picture-book') {
        builtPrompt = buildPictureBookChapterPrompt(ctx, chapterIndex);
      } else {
        builtPrompt = buildSpreadsOnlyPrompt(ctx);
      }
      break;

    case 'spreads':
      builtPrompt = buildSpreadsOnlyPrompt(ctx);
      break;

    case 'humanize':
      builtPrompt = profile.spreadOnly
        ? buildSpreadHumanizePrompt(ctx)
        : buildHumanizePrompt(ctx, chapterIndex);
      break;

    case 'spreadRerun':
      if (!customPrompt) {
        throw Object.assign(new Error('customPrompt required for spreadRerun'), { code: 'MISSING_PROMPT' });
      }
      builtPrompt = buildSpreadRerunPrompt(ctx, spreadIndex, customPrompt);
      break;

    default:
      throw Object.assign(new Error(`Unknown stage: ${effectiveStage}`), { code: 'UNKNOWN_STAGE' });
  }

  const { system, prompt } = builtPrompt;

  const budget = AI_TOKEN_BUDGETS[effectiveStage] || AI_TOKEN_BUDGETS.chapter || {
    maxPromptTokens: 8000,
    maxOutputTokens: 4000,
  };

  let outputTokens;
  if (effectiveStage === 'story' && profile.mode === 'chapter-book') {
    outputTokens = Math.max(budget.maxOutputTokens || 0, 6000);
  } else if ((effectiveStage === 'chapter' || effectiveStage === 'chapters') && profile.mode === 'chapter-book') {
    outputTokens = Math.max(budget.maxOutputTokens || 0, 7000);
  } else if (effectiveStage === 'chapter' || effectiveStage === 'chapters') {
    outputTokens = Math.max(budget.maxOutputTokens || 0, 4000);
  } else {
    outputTokens = budget.maxOutputTokens || 2000;
  }

  const promptTokens = estimateTokens(system + prompt);
  console.log(`[TextService] ~${promptTokens} prompt tokens, ${outputTokens} max output`);

  if (promptTokens > (budget.maxPromptTokens || 12000)) {
    throw Object.assign(
      new Error(`Prompt too large for ${effectiveStage}: ${promptTokens} > ${budget.maxPromptTokens}`),
      { code: 'AI_TOKEN_BUDGET_EXCEEDED' }
    );
  }

  const aiRes = await generateText({
    system,
    prompt,
    maxOutputTokens: outputTokens,
    stage: effectiveStage,
  });

  console.log(`[TextService] Provider: ${aiRes.provider} | length: ${aiRes.text?.length}`);

  const { ok, data: parsed } = safeParse(aiRes.text);
  if (!ok) console.error('[TextService] ⚠ JSON parse failed — storing raw response');

  const fresh = await Project.findById(projectId);
  const setFields = {};

  switch (effectiveStage) {
    case 'story': {
      setFields['artifacts.storyText'] = parsed.storyText || '';
      setFields['artifacts.storyIdea'] = storyIdea || ctx.project.artifacts?.storyIdea || '';

      const storyOutline = {
        bookTitle: parsed.bookTitle,
        moral: parsed.moral,
        synopsis: parsed.synopsis,
        spreadOnly: parsed.spreadOnly || false,
        islamicTheme: parsed.islamicTheme,
        characters: parsed.characters,
        suggestedChapterCount: parsed.suggestedChapterCount || parsed.chapterCount,
      };

      if (Array.isArray(parsed.chapterOutline) && parsed.chapterOutline.length > 0) {
        storyOutline.chapters = parsed.chapterOutline.map((ch, i) => ({
          title: ch.title || ch.chapterTitle || `Chapter ${i + 1}`,
          goal: ch.goal || '',
          keyScene: ch.keyScene || '',
          duaHint: ch.islamicMoment || ch.duaHint || 'natural Islamic moment',
          endingBeat: ch.endingBeat || 'end with momentum or emotional resonance',
          chapterNumber: ch.chapterNumber || i + 1,
          charactersInScene: [],
          illustrationMoments: normArr(ch.illustrationMoments),
        }));
        console.log(`[TextService] Story included chapterOutline: ${storyOutline.chapters.length} chapters pre-saved`);
      }

      setFields['artifacts.outline'] = storyOutline;

      if (parsed.dedicationMessage) {
        setFields['artifacts.dedication'] = {
          greeting: 'Assalamu Alaikum, dear parents!',
          message: parsed.dedicationMessage,
          closing: `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`,
          includeQrPlaceholder: true,
        };
      }

      if (parsed.bookTitle && parsed.bookTitle !== ctx.project.title) {
        setFields.title = parsed.bookTitle;
      }

      setFields.currentStage = 'story';
      setFields['stepsComplete.story'] = true;
      setFields.currentStep = Math.max(fresh.currentStep || 1, 2);
      break;
    }

    case 'spreadPlanning': {
      if (profile.mode === 'chapter-book') {
        setFields['artifacts.outline'] = parsed;
        setFields['artifacts.spreadOnly'] = false;

        if (parsed.islamicTheme) setFields['artifacts.themePage'] = parsed.islamicTheme;

        if (parsed.dedicationMessage) {
          setFields['artifacts.dedication'] = {
            greeting: 'Assalamu Alaikum, dear parents!',
            message: parsed.dedicationMessage,
            closing: `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`,
            includeQrPlaceholder: true,
          };
        }
      } else {
        setFields['artifacts.spreads'] = parsed.spreads || [];
        setFields['artifacts.spreadOnly'] = parsed.spreadOnly || false;
      }

      setFields.currentStage = 'spreadPlanning';
      setFields['stepsComplete.spreads'] = true;
      setFields.currentStep = Math.max(fresh.currentStep || 1, 3);
      break;
    }

    case 'outline': {
      setFields['artifacts.outline'] = parsed;

      if (parsed.dedicationMessage) {
        setFields['artifacts.dedication'] = {
          greeting: 'Assalamu Alaikum, dear parents!',
          message: parsed.dedicationMessage,
          closing: `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`,
          includeQrPlaceholder: true,
        };
      }

      if (parsed.islamicTheme) setFields['artifacts.themePage'] = parsed.islamicTheme;
      setFields.currentStage = 'outline';
      break;
    }

    case 'dedication':
      setFields['artifacts.dedication'] = parsed;
      break;

    case 'theme':
      setFields['artifacts.themePage'] = parsed;
      break;

    case 'chapter':
    case 'chapters': {
      const chapters = normArr(fresh.artifacts?.chapters);

      if (profile.mode === 'chapter-book') {
        chapters[chapterIndex] = {
          chapterNumber: parsed.chapterNumber || chapterIndex + 1,
          chapterTitle: parsed.chapterTitle || `Chapter ${chapterIndex + 1}`,
          islamicMoment: parsed.islamicMoment || null,
          chapterSummary: parsed.chapterSummary || '',
          chapterText: parsed.chapterText || '',
          illustrationMoments: normArr(parsed.illustrationMoments),
          prompt: null,
          spreads: [],
          text: parsed.chapterText || null,
          chapterIllustrationHint: normArr(parsed.illustrationMoments)[0]?.illustrationHint || null,
        };
      } else {
        chapters[chapterIndex] = {
          chapterNumber: parsed.chapterNumber || chapterIndex + 1,
          chapterTitle: parsed.chapterTitle,
          islamicMoment: parsed.islamicMoment,
          chapterSummary: parsed.chapterSummary,
          prompt: parsed.prompt,
          spreads: normArr(parsed.spreads),
          text: parsed.text || null,
          chapterIllustrationHint: parsed.chapterIllustrationHint || null,
        };
      }

      setFields['artifacts.chapters'] = chapters;
      setFields.currentStage = 'chapters';
      break;
    }

    case 'spreads': {
      setFields['artifacts.spreads'] = parsed.spreads || [];
      setFields['artifacts.spreadOnly'] = true;
      setFields.currentStage = 'spreads';
      break;
    }

    case 'humanize': {
      if (fresh.artifacts?.spreadOnly || profile.spreadOnly) {
        setFields['artifacts.spreads'] = parsed.spreads || fresh.artifacts.spreads;
        setFields['artifacts.spreadOnly'] = true;
      } else {
        const humanized = normArr(fresh.artifacts?.humanized);
        humanized[chapterIndex] = profile.mode === 'chapter-book'
          ? {
              chapterNumber: parsed.chapterNumber || chapterIndex + 1,
              chapterTitle: parsed.chapterTitle,
              chapterText: parsed.chapterText || '',
              chapterSummary: parsed.chapterSummary || '',
              changesMade: parsed.changesMade || [],
            }
          : {
              chapterNumber: parsed.chapterNumber || chapterIndex + 1,
              chapterTitle: parsed.chapterTitle,
              spreads: normArr(parsed.spreads),
              text: parsed.text || null,
              changesMade: parsed.changesMade,
            };

        setFields['artifacts.humanized'] = humanized;
      }

      setFields.currentStage = 'humanized';
      break;
    }

    case 'spreadRerun': {
      if (fresh.artifacts?.spreadOnly || profile.spreadOnly) {
        const spreads = normArr(fresh.artifacts?.spreads);
        spreads[spreadIndex] = { ...spreads[spreadIndex], ...parsed };
        setFields['artifacts.spreads'] = spreads;
      } else {
        const isHumanized = normArr(fresh.artifacts?.humanized).length > 0;
        const key = isHumanized ? 'artifacts.humanized' : 'artifacts.chapters';
        const chapters = normArr(isHumanized ? fresh.artifacts.humanized : fresh.artifacts.chapters);
        const ch = chapters[chapterIndex] || {};
        const chSpreads = normArr(ch.spreads);
        chSpreads[spreadIndex] = { ...chSpreads[spreadIndex], ...parsed };
        chapters[chapterIndex] = { ...ch, spreads: chSpreads };
        setFields[key] = chapters;
      }
      break;
    }

    default:
      break;
  }

  setFields[`aiUsage.stages.${effectiveStage}`] = {
    inputTokens: aiRes.usage?.inputTokens,
    outputTokens: aiRes.usage?.outputTokens,
    updatedAt: new Date(),
  };

  await Project.findByIdAndUpdate(projectId, {
    $set: setFields,
    $inc: {
      'aiUsage.totalInputTokens': aiRes.usage?.inputTokens || 0,
      'aiUsage.totalOutputTokens': aiRes.usage?.outputTokens || 0,
    },
  });

  await savePromptHistory(
    projectId,
    effectiveStage,
    effectiveStage === 'chapter' || effectiveStage === 'chapters' ? chapterIndex : spreadIndex,
    prompt,
    parsed,
    aiRes.provider,
  );

  console.log(`[TextService] ✓ stage="${effectiveStage}" saved | mode=${profile.mode}`);
  return { result: parsed, usage: aiRes.usage, provider: aiRes.provider, prompt, stage: effectiveStage };
}