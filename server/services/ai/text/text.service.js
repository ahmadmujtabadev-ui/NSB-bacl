import { Project } from '../../../models/Project.js';
import { Universe } from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { KnowledgeBase } from '../../../models/KnowledgeBase.js';
import { NotFoundError } from '../../../errors.js';
import { generateText } from './text.providers.js';
import { AI_TOKEN_BUDGETS, estimateTokens } from '../policies/tokenBudget.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mongoose Mixed may store "arrays" as { '0': v, '1': v } — normalise to real array */
function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];
  const keys = Object.keys(val).map(Number).filter(n => !isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr;
}

/**
 * Strip markdown code fences from Claude responses.
 * Claude wraps JSON in ```json ... ``` even when explicitly told not to.
 */
function stripFences(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/** Safe JSON parse — strips fences first, logs on failure */
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

  const universe = project.universeId ? await Universe.findById(project.universeId) : null;
  const characters = project.characterIds?.length
    ? await Character.find({ _id: { $in: project.characterIds } })
    : [];
  const kb = universe
    ? await KnowledgeBase.findOne({ universeId: universe._id, userId })
    : null;

  console.log(`[TextService] Context built: project="${project.title}" universe="${universe?.name}" chars=${characters.length} kb=${!!kb}`);
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

function charactersBlock(characters) {
  if (!characters?.length) return '';
  return characters.map(c => {
    const vd = c.visualDNA || {};
    return `CHARACTER: ${c.name} (${c.role}, ${c.ageRange || 'unknown'})
Traits: ${(c.traits || []).join(', ')}
Speaking style: ${c.speakingStyle || 'N/A'}
Visual DNA: skin=${vd.skinTone}, eyes=${vd.eyeColor}, face=${vd.faceShape}, hair/hijab=${vd.hairOrHijab}
Outfit: ${vd.outfitRules || 'N/A'} | Accessories: ${vd.accessories || 'none'}`;
  }).join('\n\n');
}

function kbBlock(kb) {
  if (!kb) return '';
  const duas = (kb.duas || []).map(d => `  • ${d.transliteration} — ${d.meaning}`).join('\n');
  const vocab = (kb.vocabulary || []).map(v => `  • ${v.word}: ${v.definition}`).join('\n');
  return `KNOWLEDGE BASE: ${kb.name}
Islamic Values: ${(kb.islamicValues || []).join(', ')}
Duas:\n${duas || '  (none)'}
Vocabulary:\n${vocab || '  (none)'}
Avoid Topics: ${(kb.avoidTopics || []).join(', ') || 'none'}
Custom Rules: ${kb.customRules || 'none'}`;
}

// ─── Stage Prompt Builders ────────────────────────────────────────────────────

function buildOutlinePrompt({ project, universe, characters, kb }) {
  const system = `You are an expert Islamic children's book author and curriculum designer.
CRITICAL: Output ONLY raw valid JSON. Absolutely NO markdown, NO code fences, NO backticks, NO preamble, NO explanation.
Your entire response must start with { and end with }
${universeBlock(universe)}
${kbBlock(kb)}`;

  const prompt = `Create a ${project.chapterCount || 4}-chapter book outline.

Title: "${project.title}"
Age Range: ${project.ageRange || '6-8 years'}
Learning Objective: ${project.learningObjective || 'Islamic values'}
Template: ${project.template || 'moral'}
Author: ${project.authorName || 'NoorStudio'}

${charactersBlock(characters)}

Respond with ONLY this JSON (no fences, no markdown, raw JSON only — start with {):
{
  "bookTitle": "string",
  "moral": "string",
  "chapters": [
    { "title": "string", "goal": "string", "keyScene": "string", "duaHint": "string" }
  ]
}`;

  return { system, prompt };
}

function buildChapterPrompt({ project, universe, characters, kb }, chapterIndex) {
  const outline = project.artifacts?.outline;
  const chapterOutline = outline?.chapters?.[chapterIndex];

  const system = `You are an expert Islamic children's book author.
Write warm, engaging prose for ages ${project.ageRange || '6-8'}.
CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
Your entire response must start with { and end with }
${universeBlock(universe)}
${kbBlock(kb)}`;

  const prompt = `Write Chapter ${chapterIndex + 1} of "${project.title}".

Chapter outline:
- Title: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
- Goal: ${chapterOutline?.goal || ''}
- Key Scene: ${chapterOutline?.keyScene || ''}
- Dua Hint: ${chapterOutline?.duaHint || ''}

${charactersBlock(characters)}

Respond with ONLY this JSON (raw JSON, no fences, start with {):
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "text": "string (the full chapter prose, minimum 200 words)",
  "vocabularyNotes": ["string"],
  "islamicAdabChecks": ["string"]
}`;

  return { system, prompt };
}

function buildHumanizePrompt({ project, kb }, chapterIndex) {
  const chaptersArr = normArr(project.artifacts?.chapters);
  const chapter = chaptersArr[chapterIndex];
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';

  const system = `You are a children's book editor specialising in Islamic content for ages ${project.ageRange || '6-8'}.
Improve naturalness, read-aloud rhythm, and age-appropriateness. Check avoid-topics list.
CRITICAL: Output ONLY raw valid JSON. NO markdown, NO code fences, NO backticks, NO preamble.
Your entire response must start with { and end with }`;

  const prompt = `Polish this chapter. Improve dialogue, sentence rhythm, and vocabulary for young readers.

Chapter: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}
Original text:
${chapter?.text || '(no text — write something warm and age-appropriate based on the chapter title)'}

Topics to AVOID: ${avoidTopics}

Respond with ONLY this JSON (raw JSON, no fences, start with {):
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "text": "string (improved full chapter prose, minimum 200 words)",
  "changesMade": ["string (describe each change you made)"]
}`;

  return { system, prompt };
}

// ─── Stage Builders Map ───────────────────────────────────────────────────────

const STAGE_BUILDERS = {
  outline: (ctx, _idx) => buildOutlinePrompt(ctx),
  chapter: (ctx, idx) => buildChapterPrompt(ctx, idx),
  humanize: (ctx, idx) => buildHumanizePrompt(ctx, idx),
};

// ─── Main Entry ───────────────────────────────────────────────────────────────

export async function generateStageText({ stage, projectId, userId, chapterIndex = 0 }) {
  console.log(`\n[TextService] ▶ stage=${stage} project=${projectId} chapterIndex=${chapterIndex}`);

  const ctx = await buildUniverseContext(projectId, userId);
  const budget = AI_TOKEN_BUDGETS[stage] || AI_TOKEN_BUDGETS.chapter;

  const builder = STAGE_BUILDERS[stage];
  if (!builder) throw new Error(`Unknown stage: ${stage}`);

  const { system, prompt } = builder(ctx, chapterIndex);

  const promptTokens = estimateTokens(system + prompt);
  console.log(`[TextService] Prompt tokens ~${promptTokens} (max ${budget.maxPromptTokens})`);

  if (promptTokens > budget.maxPromptTokens) {
    throw Object.assign(
      new Error(`Prompt too large for ${stage}: ${promptTokens} > ${budget.maxPromptTokens}`),
      { code: 'AI_TOKEN_BUDGET_EXCEEDED' }
    );
  }

  console.log(`[TextService] Calling AI provider for stage="${stage}"...`);
  const aiRes = await generateText({ system, prompt, maxOutputTokens: budget.maxOutputTokens, stage });

  console.log(`[TextService] Provider: ${aiRes.provider}, response length: ${aiRes.text?.length} chars`);
  console.log(`[TextService] Raw response preview (first 300): ${aiRes.text?.slice(0, 300)}`);

  // ── Parse — always strip fences first ─────────────────────────────────
  const parsed = safeParse(aiRes.text);

  if (parsed.raw) {
    // Fence-stripping failed — Claude changed format. Log and continue with raw.
    console.error('[TextService] ⚠ Could not parse JSON even after fence-stripping. Storing raw.');
  }

  // ── Save to MongoDB — write as full arrays, never dot-notation ─────────
  const freshProject = await Project.findById(projectId);
  const setFields = {};

  if (stage === 'outline') {
    setFields['artifacts.outline'] = parsed;
    setFields.currentStage = 'outline';
    console.log('[TextService] Saving outline — bookTitle:', parsed.bookTitle, 'chapters:', parsed.chapters?.length);

  } else if (stage === 'chapter') {
    const chapters = normArr(freshProject.artifacts?.chapters);
    chapters[chapterIndex] = parsed;
    setFields['artifacts.chapters'] = chapters;
    setFields.currentStage = 'chapters';
    console.log(`[TextService] Saving chapter[${chapterIndex}] — text length: ${parsed.text?.length}, chapterTitle: ${parsed.chapterTitle}`);

  } else if (stage === 'humanize') {
    const humanized = normArr(freshProject.artifacts?.humanized);
    humanized[chapterIndex] = parsed;
    setFields['artifacts.humanized'] = humanized;
    setFields.currentStage = 'humanized';
    console.log(`[TextService] Saving humanized[${chapterIndex}] — text length: ${parsed.text?.length}, changesMade: ${parsed.changesMade?.length}`);
  }

  setFields[`aiUsage.stages.${stage}`] = {
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

  console.log(`[TextService] ✓ stage="${stage}" persisted to MongoDB`);
  return { result: parsed, usage: aiRes.usage, provider: aiRes.provider };
}
