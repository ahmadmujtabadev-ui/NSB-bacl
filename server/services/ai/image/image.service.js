// ─── Imports MUST be at top — ES module syntax error otherwise ────────────────
import { Project }   from '../../../models/Project.js';
import { Character } from '../../../models/Character.js';
import { NotFoundError } from '../../../errors.js';
import { generateImage } from './image.providers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise Mongoose Mixed { '0': v, '1': v } → real array */
function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];
  const keys = Object.keys(val).map(Number).filter(n => !isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr;
}

function buildImagePrompt(task, { bookTitle, chTitle, keyScene }) {
  if (task === 'cover') {
    return `Children's book cover illustration for "${bookTitle}". Main character in a sunlit garden at golden hour. Warm, inviting, portrait orientation. Pixar 3D animation style. Absolutely no text, letters, numbers, or words anywhere in the image.`;
  }
  return [
    `Children's book illustration for "${bookTitle}".`,
    chTitle  ? `Chapter: "${chTitle}".`                                : '',
    keyScene ? `Scene: ${keyScene}`                                    : 'Scene: A young girl in a beautiful garden.',
    'Pixar 3D animation style, warm lighting, child-friendly, vibrant colors.',
    'No text or letters in the image.',
  ].filter(Boolean).join(' ');
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

export async function generateStageImage({ task, chapterIndex = 0, projectId, userId, customPrompt, seed, style, traceId }) {
  console.log(`\n[ImageService] ▶ task=${task} chapterIndex=${chapterIndex} projectId=${projectId}`);

  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  // ── Build prompt ──────────────────────────────────────────────────────
  // outline.chapters may be stored as object if previously saved via dot-notation
  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const chapterData     = outlineChapters[chapterIndex] || {};
  const bookTitle       = project.artifacts?.outline?.bookTitle || project.title;

  const prompt = customPrompt || buildImagePrompt(task, {
    bookTitle,
    chTitle:  chapterData.title,
    keyScene: chapterData.keyScene,
  });

  console.log(`[ImageService] Prompt (first 120): ${prompt.slice(0, 120)}`);

  // ── Auto-fetch character references ───────────────────────────────────
  const references = [];

  if (project.characterIds?.length) {
    const protagonist = await Character.findOne({
      _id: { $in: project.characterIds },
      role: 'protagonist',
    });
    console.log(`[ImageService] Protagonist: ${protagonist?.name || 'none'}, imageUrl: ${!!protagonist?.imageUrl}, poseSheetUrl: ${!!protagonist?.poseSheetUrl}`);

    if (task === 'pose-sheet' && protagonist?.imageUrl) {
      references.push(protagonist.imageUrl);
      console.log('[ImageService] Using portrait as pose-sheet reference');

    } else if (task === 'illustration' && chapterIndex > 0) {
      // Ch2+ — use Ch1 illustration as identity anchor
      const illustrations = normArr(project.artifacts?.illustrations);
      const ch1           = illustrations[0];
      const ch1Url        = ch1?.variants?.[ch1.selectedVariantIndex ?? 0]?.imageUrl;

      if (ch1Url) {
        references.push(ch1Url);
        console.log(`[ImageService] Using Ch1 illustration as identity ref: ${ch1Url.slice(0, 80)}`);
      } else {
        console.log('[ImageService] No Ch1 illustration found — continuing without reference');
      }
      if (protagonist?.poseSheetUrl) {
        references.push(protagonist.poseSheetUrl);
        console.log('[ImageService] Also using pose-sheet reference');
      }

    } else if (task === 'cover' && protagonist?.imageUrl) {
      references.push(protagonist.imageUrl);
      console.log('[ImageService] Using portrait as cover reference');
    }
  } else {
    console.log('[ImageService] No characterIds on project');
  }

  console.log(`[ImageService] Total references: ${references.length}`);

  const trId = traceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // ── Call provider ─────────────────────────────────────────────────────
  console.log(`[ImageService] Calling generateImage provider...`);
  const result = await generateImage({ task, prompt, references, style, seed, projectId, traceId: trId });
  console.log(`[ImageService] ✓ Provider: ${result.provider}, imageUrl: ${result.imageUrl?.slice(0, 80)}`);

  // ── Persist to artifacts ──────────────────────────────────────────────
  const setFields = {};

  if (task === 'illustration') {
    const illustrations          = normArr(project.artifacts?.illustrations);
    const existing               = illustrations[chapterIndex] || {
      chapterNumber: chapterIndex + 1,
      variants: [],
      selectedVariantIndex: 0,
    };
    const variantIndex           = existing.variants.length;
    existing.variants.push({ variantIndex, imageUrl: result.imageUrl, prompt, seed: seed || null, selected: variantIndex === 0 });
    illustrations[chapterIndex]  = existing;
    setFields['artifacts.illustrations'] = illustrations;
    console.log(`[ImageService] Saved illustration[${chapterIndex}] variant ${variantIndex}`);

  } else if (task === 'cover') {
    setFields['artifacts.cover'] = {
      ...(project.artifacts?.cover || {}),
      frontUrl: result.imageUrl,
      prompt,
    };
    console.log('[ImageService] Saved cover.frontUrl');
  }
  // portrait → saved to Character directly by the character route, not here

  if (Object.keys(setFields).length) {
    await Project.findByIdAndUpdate(projectId, { $set: setFields });
    console.log('[ImageService] ✓ MongoDB updated');
  }

  return { ...result, traceId: trId };
}
