import { Project } from '../../../models/Project.js';
import { Character } from '../../../models/Character.js';
import { NotFoundError } from '../../../errors.js';
import { generateImage } from './image.providers.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize Mongoose Mixed { '0': v, '1': v } -> real array */
function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];

  const keys = Object.keys(val)
    .map(Number)
    .filter((n) => !Number.isNaN(n));

  if (!keys.length) return [];

  const arr = [];
  keys.sort((a, b) => a - b).forEach((k) => {
    arr[k] = val[k];
  });

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

function buildImagePrompt(task, { bookTitle, chTitle, keyScene }) {
  if (task === 'cover') {
    return `Children's book front cover illustration for "${bookTitle}". Main character in a warm, inviting cinematic scene. Portrait orientation. Pixar 3D animation style. Absolutely no text, letters, numbers, watermark, or words anywhere in the image.`;
  }

  if (task === 'back-cover') {
    return `Children's book back cover illustration for "${bookTitle}". Soft, simple complementary background scene matching the front cover. Portrait orientation. Pixar 3D animation style. Absolutely no text, letters, numbers, watermark, or words anywhere in the image.`;
  }

  return [
    `Children's book illustration for "${bookTitle}".`,
    chTitle ? `Chapter: "${chTitle}".` : '',
    keyScene
      ? `Scene: ${keyScene}`
      : 'Scene: A warm, child-friendly story moment.',
    'Pixar 3D animation style, warm lighting, child-friendly, vibrant colors.',
    'No text, letters, numbers, watermark, or words in the image.',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildIllustrationPromptByAge({
  bookTitle,
  chapterTitle,
  keyScene,
  chapterNumber,
  imageSlot,
  imagesPerChapter,
  ageRange,
}) {
  const firstNumber = String(ageRange || '').match(/\d+/)?.[0];
  const minAge = firstNumber ? Number(firstNumber) : 7;
  const isYoung = minAge <= 6;

  if (isYoung && imagesPerChapter === 2) {
    const shotInstruction =
      imageSlot === 0
        ? 'Show the beginning, setup, or first emotional beat of the chapter.'
        : 'Show the action, emotional payoff, or ending beat of the chapter.';

    return [
      `Children's book illustration for "${bookTitle}".`,
      `Chapter ${chapterNumber}: "${chapterTitle || `Chapter ${chapterNumber}`}".`,
      keyScene ? `Main scene: ${keyScene}` : '',
      shotInstruction,
      'Very clear storytelling image for ages 4 to 6.',
      'Simple composition, expressive faces, warm lighting, child-friendly, vibrant colors.',
      'Pixar 3D animation style.',
      'No text, letters, numbers, watermark, or words in the image.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  return [
    `Children's book illustration for "${bookTitle}".`,
    `Chapter ${chapterNumber}: "${chapterTitle || `Chapter ${chapterNumber}`}".`,
    keyScene ? `Scene: ${keyScene}` : '',
    'One strong storytelling image for this chapter.',
    'Pixar 3D animation style, warm lighting, child-friendly, vibrant colors.',
    'No text, letters, numbers, watermark, or words in the image.',
  ]
    .filter(Boolean)
    .join(' ');
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

  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const bookTitle = project.artifacts?.outline?.bookTitle || project.title;
  const chapterCount = getSafeChapterCount(project);
  const imagesPerChapter = getImagesPerChapter(project.ageRange);

  const protagonist = await getProtagonist(project);
  const illustrations = normArr(project.artifacts?.illustrations);

  let firstIdentityRef = getPrimaryIllustrationRef(illustrations);
  let providerUsed = 'unknown';

  for (let chapterIndex = 0; chapterIndex < chapterCount; chapterIndex++) {
    const chapterData = outlineChapters[chapterIndex] || {};
    const chapterNumber = chapterIndex + 1;

    const existing = illustrations[chapterIndex] || {
      chapterNumber,
      imagesPerChapter,
      variants: [],
      selectedVariantIndex: 0,
    };

    existing.chapterNumber = chapterNumber;
    existing.imagesPerChapter = imagesPerChapter;
    existing.variants = normArr(existing.variants);

    for (
      let imageSlot = existing.variants.length;
      imageSlot < imagesPerChapter;
      imageSlot++
    ) {
      const prompt = buildIllustrationPromptByAge({
        bookTitle,
        chapterTitle: chapterData.title,
        keyScene: chapterData.keyScene,
        chapterNumber,
        imageSlot,
        imagesPerChapter,
        ageRange: project.ageRange,
      });

      const references = [];

      if (firstIdentityRef) {
        references.push(firstIdentityRef);
      }

      if (protagonist?.poseSheetUrl) {
        references.push(protagonist.poseSheetUrl);
      } else if (protagonist?.imageUrl) {
        references.push(protagonist.imageUrl);
      }

      const trId =
        traceId ||
        `trace_${Date.now()}_${chapterIndex}_${imageSlot}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;

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
        imageUrl: result.imageUrl,
        prompt,
        seed: seed || null,
        selected: imageSlot === 0,
        pageRole:
          imagesPerChapter === 2
            ? imageSlot === 0
              ? 'scene-a'
              : 'scene-b'
            : 'main',
      });

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

  await Project.findByIdAndUpdate(projectId, {
    $set: {
      'artifacts.illustrations': illustrations,
      currentStage: 'illustrations',
    },
  });

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
  console.log(
    `\n[ImageService] ▶ task=${task} chapterIndex=${chapterIndex} projectId=${projectId}`
  );

  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const chapterData = outlineChapters[chapterIndex] || {};
  const bookTitle = project.artifacts?.outline?.bookTitle || project.title;

  const prompt =
    customPrompt ||
    buildImagePrompt(task, {
      bookTitle,
      chTitle: chapterData.title,
      keyScene: chapterData.keyScene,
    });

  const references = [];
  const protagonist = await getProtagonist(project);

  if (task === 'pose-sheet' && protagonist?.imageUrl) {
    references.push(protagonist.imageUrl);
  } else if (task === 'illustration') {
    const illustrations = normArr(project.artifacts?.illustrations);
    const primaryRef = getPrimaryIllustrationRef(illustrations);

    if (chapterIndex > 0 && primaryRef) {
      references.push(primaryRef);
    }

    if (protagonist?.poseSheetUrl) {
      references.push(protagonist.poseSheetUrl);
    } else if (protagonist?.imageUrl) {
      references.push(protagonist.imageUrl);
    }
  } else if ((task === 'cover' || task === 'back-cover') && protagonist?.imageUrl) {
    references.push(protagonist.imageUrl);
  }

  const trId =
    traceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const result = await generateImage({
    task,
    prompt,
    references,
    style,
    seed,
    projectId,
    traceId: trId,
  });

  const setFields = {};

  if (task === 'illustration') {
    const illustrations = normArr(project.artifacts?.illustrations);
    const existing = illustrations[chapterIndex] || {
      chapterNumber: chapterIndex + 1,
      imagesPerChapter: getImagesPerChapter(project.ageRange),
      variants: [],
      selectedVariantIndex: 0,
    };

    existing.chapterNumber = chapterIndex + 1;
    existing.imagesPerChapter = getImagesPerChapter(project.ageRange);
    existing.variants = normArr(existing.variants);

    const variantIndex = existing.variants.length;

    existing.variants.push({
      variantIndex,
      imageUrl: result.imageUrl,
      prompt,
      seed: seed || null,
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
      frontUrl: result.imageUrl,
      frontPrompt: prompt,
    };
  } else if (task === 'back-cover') {
    setFields['artifacts.cover'] = {
      ...(project.artifacts?.cover || {}),
      backUrl: result.imageUrl,
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
};