// server/services/ai/image/image.service.js
import { Project } from '../../../models/Project.js';
import { Character } from '../../../models/Character.js';
import { NotFoundError } from '../../../errors.js';
import { generateImage } from './image.providers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize Mongoose Mixed { '0': v, '1': v } -> real array */
function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];
  const keys = Object.keys(val).map(Number).filter((n) => !Number.isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach((k) => { arr[k] = val[k]; });
  return arr.filter((v) => v != null);
}

function getImagesPerChapter(ageRange) {
  if (!ageRange) return 1;
  const firstNumber = String(ageRange).match(/\d+/)?.[0];
  const minAge = firstNumber ? Number(firstNumber) : 7;
  return minAge <= 6 ? 2 : 1;
}

function getSafeChapterCount(project) {
  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const rawCount = outlineChapters.length || Number(project.chapterCount) || 4;
  return Math.max(4, Math.min(rawCount, 9));
}

/**
 * Builds a rich character description from the protagonist document.
 * This is injected into EVERY illustration prompt so the AI keeps
 * the character consistent across all images.
 */
function buildCharacterDescription(protagonist) {
  if (!protagonist) return '';
  const vd  = protagonist.visualDNA  || {};
  const mod = protagonist.modestyRules || {};

  const parts = [
    protagonist.name ? `Main character named ${protagonist.name}` : 'Main character',
    protagonist.ageRange ? `(${protagonist.ageRange})` : '',
    vd.gender ? vd.gender : '',
    vd.skinTone    ? `${vd.skinTone} skin tone` : '',
    vd.eyeColor    ? `${vd.eyeColor} eyes` : '',
    vd.faceShape   ? `${vd.faceShape} face` : '',
    vd.hairOrHijab ? vd.hairOrHijab : '',
    vd.outfitRules ? `wearing ${vd.outfitRules}` : '',
    mod.hijabAlways   ? 'hijab always visible' : '',
    mod.longSleeves   ? 'long sleeves' : '',
    (protagonist.traits || []).slice(0, 4).join(', '),
  ].filter(Boolean);

  return parts.join(', ');
}

/**
 * Single-panel enforcement suffix — appended to EVERY prompt.
 * Prevents AI from generating comic strips / storyboards / collages.
 */
const SINGLE_PANEL = [
  'Single full-bleed illustration, ONE scene only.',
  'NOT a comic strip. NOT a storyboard. NOT a grid layout.',
  'NOT multiple panels. NOT multiple frames. NOT a collage.',
  'One continuous image filling the entire frame.',
].join(' ');

function buildImagePrompt(task, { bookTitle, chTitle, keyScene, characterDesc }) {
  const charPart = characterDesc ? `${characterDesc}.` : '';

  if (task === 'cover') {
    return [
      `Children's book front cover illustration for "${bookTitle}".`,
      charPart,
      'Main character prominently featured in a warm, inviting, cinematic scene.',
      'Portrait orientation. Pixar 3D animation style, vibrant colors, golden lighting.',
      'Absolutely no text, letters, numbers, watermark, or words anywhere.',
      SINGLE_PANEL,
    ].filter(Boolean).join(' ');
  }

  if (task === 'back-cover') {
    return [
      `Children's book back cover illustration for "${bookTitle}".`,
      charPart,
      'Soft, simple, complementary background scene matching the front cover mood.',
      'The main character shown in a peaceful, happy, concluding moment.',
      'Portrait orientation. Pixar 3D animation style.',
      'Absolutely no text, letters, numbers, watermark, or words anywhere.',
      SINGLE_PANEL,
    ].filter(Boolean).join(' ');
  }

  return [
    `Children's book illustration for "${bookTitle}".`,
    charPart,
    chTitle ? `Chapter: "${chTitle}".` : '',
    keyScene ? `Scene: ${keyScene}.` : 'Scene: A warm, child-friendly story moment.',
    'Pixar 3D animation style, warm lighting, child-friendly, vibrant colors.',
    'No text, letters, numbers, watermark, or words in the image.',
    SINGLE_PANEL,
  ].filter(Boolean).join(' ');
}

function buildIllustrationPromptByAge({
  bookTitle,
  chapterTitle,
  keyScene,
  chapterNumber,
  imageSlot,
  imagesPerChapter,
  ageRange,
  characterDesc,
}) {
  const firstNumber = String(ageRange || '').match(/\d+/)?.[0];
  const minAge = firstNumber ? Number(firstNumber) : 7;
  const isYoung = minAge <= 6;
  const charPart = characterDesc ? `${characterDesc}.` : '';

  if (isYoung && imagesPerChapter === 2) {
    const shotInstruction = imageSlot === 0
      ? 'Show the beginning or setup moment of the chapter — the first emotional beat.'
      : 'Show the exciting action or happy resolution — the emotional payoff of the chapter.';

    return [
      `Children's picture book illustration for "${bookTitle}".`,
      charPart,
      `Chapter ${chapterNumber}: "${chapterTitle || `Chapter ${chapterNumber}`}".`,
      keyScene ? `Key scene: ${keyScene}.` : '',
      shotInstruction,
      'Very expressive faces, simple bold composition for ages 4-6.',
      'Pixar 3D animation style, warm lighting, vibrant child-friendly colors.',
      'No text, letters, numbers, watermark, or words.',
      SINGLE_PANEL,
    ].filter(Boolean).join(' ');
  }

  return [
    `Children's book illustration for "${bookTitle}".`,
    charPart,
    `Chapter ${chapterNumber}: "${chapterTitle || `Chapter ${chapterNumber}`}".`,
    keyScene ? `Scene: ${keyScene}.` : '',
    'One strong, expressive storytelling image for this chapter.',
    'Pixar 3D animation style, warm lighting, child-friendly, vibrant colors.',
    'No text, letters, numbers, watermark, or words.',
    SINGLE_PANEL,
  ].filter(Boolean).join(' ');
}

async function getProtagonist(project) {
  if (!project.characterIds?.length) return null;
  return Character.findOne({
    _id: { $in: project.characterIds },
    role: 'protagonist',
  });
}

function getPrimaryIllustrationRef(illustrations) {
  const firstChapter = illustrations?.[0];
  if (!firstChapter) return null;
  const selectedIndex = firstChapter.selectedVariantIndex ?? 0;
  return (
    firstChapter?.variants?.[selectedIndex]?.imageUrl ||
    firstChapter?.variants?.[0]?.imageUrl ||
    null
  );
}

// ─── Generate full-book illustrations ────────────────────────────────────────

export async function generateBookIllustrations({
  projectId,
  userId,
  style,
  seed,
  traceId,
}) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const outlineChapters  = normArr(project.artifacts?.outline?.chapters);
  const bookTitle        = project.artifacts?.outline?.bookTitle || project.title;
  const chapterCount     = getSafeChapterCount(project);
  const imagesPerChapter = getImagesPerChapter(project.ageRange);

  const protagonist     = await getProtagonist(project);
  const characterDesc   = buildCharacterDescription(protagonist);
  const illustrations   = normArr(project.artifacts?.illustrations);

  let firstIdentityRef = getPrimaryIllustrationRef(illustrations);
  let providerUsed     = 'unknown';

  console.log(`[image.service] Generating ${chapterCount} chapters × ${imagesPerChapter} images. Character: ${characterDesc || 'none'}`);

  // ── Chapter illustrations ──────────────────────────────────
  for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex++) {
    const chapterData  = outlineChapters[chapterIndex] || {};
    const chapterNumber = chapterIndex + 1;

    const existing = illustrations[chapterIndex] || {
      chapterNumber,
      imagesPerChapter,
      variants: [],
      selectedVariantIndex: 0,
    };

    existing.chapterNumber    = chapterNumber;
    existing.imagesPerChapter = imagesPerChapter;
    existing.variants         = normArr(existing.variants);

    for (let imageSlot = existing.variants.length; imageSlot < imagesPerChapter; imageSlot++) {
      const prompt = buildIllustrationPromptByAge({
        bookTitle,
        chapterTitle: chapterData.title,
        keyScene:     chapterData.keyScene,
        chapterNumber,
        imageSlot,
        imagesPerChapter,
        ageRange:      project.ageRange,
        characterDesc, // ← character always included
      });

      // Build references: character portrait + pose sheet for identity consistency
      const references = [];
      if (firstIdentityRef) references.push(firstIdentityRef);
      if (protagonist?.poseSheetUrl) references.push(protagonist.poseSheetUrl);
      else if (protagonist?.imageUrl) references.push(protagonist.imageUrl);

      const trId = traceId
        || `trace_${Date.now()}_${chapterIndex}_${imageSlot}_${Math.random().toString(36).slice(2, 8)}`;

      console.log(`[image.service] Generating ch${chapterNumber} slot${imageSlot} | refs: ${references.length}`);

      const result = await generateImage({
        task: 'illustration',
        prompt,
        references,
        style,
        seed,
        projectId,
        traceId: trId,
      });

      providerUsed = result.provider || providerUsed;

      existing.variants.push({
        variantIndex: imageSlot,
        imageUrl:     result.imageUrl,
        prompt,
        seed:         seed || null,
        selected:     imageSlot === 0,
        pageRole:     imagesPerChapter === 2
          ? imageSlot === 0 ? 'scene-a' : 'scene-b'
          : 'main',
      });

      // Use first generated image as identity reference for subsequent chapters
      if (!firstIdentityRef && result.imageUrl) {
        firstIdentityRef = result.imageUrl;
      }
    }

    if (
      existing.selectedVariantIndex == null ||
      existing.selectedVariantIndex >= existing.variants.length
    ) {
      existing.selectedVariantIndex = 0;
    }

    illustrations[chapterIndex] = existing;
  }

  // Save chapter illustrations
  await Project.findByIdAndUpdate(projectId, {
    $set: {
      'artifacts.illustrations': illustrations,
      currentStage: 'illustrations',
    },
  });

  // ── Always generate BACK COVER after illustrations ─────────
  // Only generate if not already present
  const existingBackUrl = project.artifacts?.cover?.backUrl;
  if (!existingBackUrl) {
    console.log('[image.service] Generating back cover...');
    try {
      const backPrompt = buildImagePrompt('back-cover', { bookTitle, characterDesc });
      const backRefs   = [];
      if (protagonist?.imageUrl)    backRefs.push(protagonist.imageUrl);
      if (firstIdentityRef)         backRefs.push(firstIdentityRef);

      const backResult = await generateImage({
        task: 'back-cover',
        prompt: backPrompt,
        references: backRefs,
        style,
        seed,
        projectId,
        traceId: `trace_backcover_${Date.now()}`,
      });

      await Project.findByIdAndUpdate(projectId, {
        $set: {
          'artifacts.cover': {
            ...(project.artifacts?.cover || {}),
            backUrl:    backResult.imageUrl,
            backPrompt: backPrompt,
          },
        },
      });

      providerUsed = backResult.provider || providerUsed;
      console.log('[image.service] Back cover generated:', backResult.imageUrl ? 'ok' : 'failed');
    } catch (err) {
      // Non-fatal — log and continue
      console.error('[image.service] Back cover generation failed (non-fatal):', err.message);
    }
  }

  return {
    provider: providerUsed,
    illustrations,
    imagesPerChapter,
    chapterCount,
  };
}

// ─── Generate single image (manual rerun / cover / back-cover) ───────────────

export async function generateStageImage({
  task,
  chapterIndex = 0,
  projectId,
  userId,
  customPrompt,
  seed,
  style,
  traceId,
}) {
  console.log(`\n[ImageService] ▶ task=${task} chapterIndex=${chapterIndex} projectId=${projectId}`);

  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const outlineChapters  = normArr(project.artifacts?.outline?.chapters);
  const chapterData      = outlineChapters[chapterIndex] || {};
  const bookTitle        = project.artifacts?.outline?.bookTitle || project.title;
  const protagonist      = await getProtagonist(project);
  const characterDesc    = buildCharacterDescription(protagonist);

  const prompt = customPrompt || buildImagePrompt(task, {
    bookTitle,
    chTitle:       chapterData.title,
    keyScene:      chapterData.keyScene,
    characterDesc, // ← always included
  });

  const references = [];
  const protagonist2 = protagonist; // alias for clarity

  if (task === 'pose-sheet' && protagonist2?.imageUrl) {
    references.push(protagonist2.imageUrl);
  } else if (task === 'illustration') {
    const illustrations  = normArr(project.artifacts?.illustrations);
    const primaryRef     = getPrimaryIllustrationRef(illustrations);
    if (chapterIndex > 0 && primaryRef) references.push(primaryRef);
    if (protagonist2?.poseSheetUrl)      references.push(protagonist2.poseSheetUrl);
    else if (protagonist2?.imageUrl)     references.push(protagonist2.imageUrl);
  } else if (task === 'cover' || task === 'back-cover') {
    if (protagonist2?.imageUrl) references.push(protagonist2.imageUrl);
    // Also reference first illustration for style consistency
    const illustrations = normArr(project.artifacts?.illustrations);
    const primaryRef    = getPrimaryIllustrationRef(illustrations);
    if (primaryRef) references.push(primaryRef);
  }

  const trId = traceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const result = await generateImage({ task, prompt, references, style, seed, projectId, traceId: trId });

  const setFields = {};

  if (task === 'illustration') {
    const illustrations = normArr(project.artifacts?.illustrations);
    const existing = illustrations[chapterIndex] || {
      chapterNumber:    chapterIndex + 1,
      imagesPerChapter: getImagesPerChapter(project.ageRange),
      variants:         [],
      selectedVariantIndex: 0,
    };

    existing.chapterNumber    = chapterIndex + 1;
    existing.imagesPerChapter = getImagesPerChapter(project.ageRange);
    existing.variants         = normArr(existing.variants);

    const variantIndex = existing.variants.length;
    existing.variants.push({
      variantIndex,
      imageUrl: result.imageUrl,
      prompt,
      seed:     seed || null,
      selected: variantIndex === 0,
    });

    if (
      existing.selectedVariantIndex == null ||
      existing.selectedVariantIndex >= existing.variants.length
    ) {
      existing.selectedVariantIndex = 0;
    }

    illustrations[chapterIndex] = existing;
    setFields['artifacts.illustrations'] = illustrations;

  } else if (task === 'cover') {
    setFields['artifacts.cover'] = {
      ...(project.artifacts?.cover || {}),
      frontUrl:    result.imageUrl,
      frontPrompt: prompt,
    };
  } else if (task === 'back-cover') {
    setFields['artifacts.cover'] = {
      ...(project.artifacts?.cover || {}),
      backUrl:    result.imageUrl,
      backPrompt: prompt,
    };
  }

  if (Object.keys(setFields).length) {
    await Project.findByIdAndUpdate(projectId, { $set: setFields });
  }

  return { ...result, traceId: trId };
}

export {
  normArr,
  getImagesPerChapter,
  getSafeChapterCount,
  buildImagePrompt,
  buildIllustrationPromptByAge,
  buildCharacterDescription,
};