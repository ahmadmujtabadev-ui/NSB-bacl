// server/services/ai/image/image.service.js
import { Project }   from '../../../models/Project.js';
import { Universe }  from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { NotFoundError } from '../../../errors.js';
import { generateImage }  from './image.providers.js';

// ─── Array helpers ────────────────────────────────────────────────────────────

function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];
  const keys = Object.keys(val).map(Number).filter(n => !Number.isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr.filter(v => v != null);
}

function isPictureBook(ageRange) {
  if (!ageRange) return true;
  const first = String(ageRange).match(/\d+/)?.[0];
  return first ? Number(first) <= 8 : true;
}

function getImagesPerChapter(ageRange) {
  const first = String(ageRange || '').match(/\d+/)?.[0];
  const age   = first ? Number(first) : 7;
  return age <= 6 ? 2 : 1;
}

function getSafeChapterCount(project) {
  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const rawCount = outlineChapters.length || Number(project.chapterCount) || 4;
  return Math.max(4, Math.min(rawCount, 9));
}

// ─── Load all universe characters for a project ───────────────────────────────

async function loadUniverseCharacters(project) {
  if (!project) return [];

  // Priority 1: characters explicitly assigned to project
  if (project.characterIds?.length) {
    return Character.find({ _id: { $in: project.characterIds } });
  }

  // Priority 2: all characters in linked universe
  if (project.universeId) {
    return Character.find({ universeId: project.universeId });
  }

  return [];
}

// ─── Build strict per-character visual description ────────────────────────────

function describeCharacter(c) {
  if (!c) return '';
  const vd  = c.visualDNA    || {};
  const mod = c.modestyRules || {};

  const gender = mod.hijabAlways
    ? 'GIRL'
    : (vd.gender?.toUpperCase() || (c.name?.toLowerCase().match(/^(ahmed|omar|ali|hassan|yusuf|ibrahim|adam|zaid|bilal|muhammad|usman)/) ? 'BOY' : 'GIRL'));

  const lines = [
    `  • ${c.name} [${c.role || 'character'}] — ${gender}, age ${c.ageRange || 'child'}`,
    `    Skin: ${vd.skinTone || 'N/A'} | Eyes: ${vd.eyeColor || 'N/A'} | Face: ${vd.faceShape || 'N/A'}`,
    `    Hair/Hijab: ${vd.hairOrHijab || 'N/A'}`,
    `    ════ LOCKED OUTFIT COLOR — NEVER CHANGE ════`,
    `    Outfit: ${vd.outfitRules || 'N/A'}`,
    `    Primary outfit color: ${vd.outfitColor || vd.primaryColor || 'as described above'}`,
    `    ⚑ This EXACT outfit and color must appear in EVERY scene — no substitutions`,
    mod.hijabAlways   ? `    ⚑ Hijab: ALWAYS visible — never remove under any circumstance` : '',
    mod.longSleeves   ? `    ⚑ Long sleeves: always` : '',
    mod.looseClothing ? `    ⚑ Loose clothing: always` : '',
    `    Personality: ${(c.traits || []).join(', ')}`,
  ].filter(Boolean).join('\n');

  return lines;
}

// ─── Build outfit-only quick-reference (injected near top of every prompt) ───

function buildOutfitQuickRef(characters) {
  if (!characters?.length) return '';
  const lines = characters.map(c => {
    const vd  = c.visualDNA || {};
    const color = vd.outfitColor || vd.primaryColor || 'see description';
    return `  ${c.name}: ALWAYS wears ${vd.outfitRules || 'their standard outfit'} — COLOR: ${color} — NEVER changed`;
  });
  return `
⚠ OUTFIT COLOR LOCK (applies to EVERY illustration in this book):
${lines.join('\n')}
These colors are FROZEN for the entire book. Do NOT change them between scenes or chapters.`;
}

// ─── Master character lock block (injected into every prompt) ─────────────────

function buildCharacterLockBlock(characters) {
  if (!characters?.length) return '';

  const approvedNames = characters.map(c => c.name).join(', ');
  const descriptions  = characters.map(describeCharacter).join('\n\n');

  return `
╔══════════════════════════════════════════════════════════════╗
║           UNIVERSE CHARACTERS — ABSOLUTE RULES              ║
╠══════════════════════════════════════════════════════════════╣
║ ONLY these characters may appear in this image:             ║
╚══════════════════════════════════════════════════════════════╝

APPROVED CHARACTERS:
${descriptions}

══ ILLUSTRATION LAWS (violating any = wrong output) ══════════
LAW 1: ONLY draw characters listed above — ${approvedNames}
LAW 2: Do NOT invent, add, or imply ANY new character
LAW 3: Do NOT add unnamed background people or silhouettes
LAW 4: Do NOT change any character's gender — ever
LAW 5: Every character must look IDENTICAL to their description above
LAW 6: Outfit, hair, hijab must match exactly — no stylistic variation
LAW 7: The reference image(s) provided show these characters — match them
LAW 8: If a scene requires only 1 character, draw only that character
LAW 9: Hijab MUST be worn by any character with hijabAlways=true
LAW 10: This is an Islamic children's book — all characters are modest
LAW 11: CHARACTER OUTFIT COLORS ARE FROZEN — identical in every single image
LAW 12: Do NOT recolor outfits between chapters or scenes under any circumstance
══════════════════════════════════════════════════════════════`;
}

// ─── Pose reference instruction ───────────────────────────────────────────────

function buildPoseRefInstruction(characters) {
  const withPoseSheets = characters.filter(c => c.poseSheetUrl);
  if (!withPoseSheets.length) return '';

  const names = withPoseSheets.map(c => c.name).join(', ');
  return `
POSE REFERENCE: Pose sheet(s) are provided for ${names}.
Use the pose sheets to match exact body proportions, face shape, and clothing.
The poses in the sheet show how each character should look from all angles.
Always use these reference images to maintain visual consistency.`;
}

// ─── Cross-chapter visual anchor (critical consistency block) ─────────────────

function buildCrossChapterAnchor(firstIdentityRef, chapterIndex, spreadIndex) {
  if (!firstIdentityRef) return '';
  return `
╔══════════════════════════════════════════════════════════════╗
║        CROSS-CHAPTER VISUAL CONSISTENCY — CRITICAL          ║
╠══════════════════════════════════════════════════════════════╣
║ The reference image provided is Chapter 1, Spread 1         ║
║ — the MASTER VISUAL ANCHOR for this entire book.            ║
╚══════════════════════════════════════════════════════════════╝
This is illustration Ch.${chapterIndex + 1} Spread ${spreadIndex + 1}.
MATCH the reference image EXACTLY for:
  • Every character's face shape, skin tone, eye color
  • Every character's outfit — same garment, same color, same style
  • Art style, lighting quality, and color temperature
  • Character proportions and relative sizes
The ONLY thing that changes between illustrations is the SCENE/POSE.
Everything else — characters, outfits, art style — is IDENTICAL to the reference.`;
}

// ─── Single-panel enforcement ─────────────────────────────────────────────────

const SINGLE_PANEL = [
  'IMPORTANT: Single full-bleed illustration — ONE scene only.',
  'NOT a comic strip. NOT a storyboard. NOT a grid. NOT multiple panels.',
  'One continuous image filling the entire frame.',
].join(' ');

// ─── Clean background rules ───────────────────────────────────────────────────

const CLEAN_BACKGROUND = `
BACKGROUND RULES — STRICTLY ENFORCED:
  • Background must be CLEAN and SIMPLE — do NOT clutter it
  • No excessive decorative elements, ornate arches, or heavy floral arrangements
  • No intricate Islamic geometric tile patterns as dominant background elements
  • Soft, out-of-focus environment — the CHARACTER is the focus, not the background
  • Allowed: simple sky, gentle soft-focus garden, plain room with 1-2 objects, soft color wash
  • NOT allowed: busy markets, elaborate arabesque walls, dense flower arrangements dominating the frame
  • Background colors should be soft pastels or neutrals — never compete with characters
  • Keep at least 60% of the background area clean and uncluttered`;

// ─── Text safe-zone ───────────────────────────────────────────────────────────

function textSafeZone(textPosition) {
  if (!textPosition) return '';
  if (textPosition === 'top'    || textPosition === 'overlay-top')
    return 'Keep TOP 20% visually simple (light sky or soft background) — text overlaid there.';
  if (textPosition === 'bottom' || textPosition === 'overlay-bottom')
    return 'Keep BOTTOM 20% visually simple (soft ground or faded colour) — text overlaid there.';
  return '';
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSpreadPrompt({
  bookTitle,
  chapterTitle,
  spreadIndex,
  chapterIndex,
  illustrationHint,
  textPosition,
  ageRange,
  characterLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
  crossChapterAnchor,
}) {
  const first   = String(ageRange || '').match(/\d+/)?.[0];
  const minAge  = first ? Number(first) : 7;
  const isYoung = minAge <= 6;

  return [
    `Children's Islamic picture book illustration for "${bookTitle}".`,
    `Chapter: "${chapterTitle}" — Spread ${spreadIndex + 1}.`,
    outfitQuickRef,
    crossChapterAnchor,
    characterLockBlock,
    poseRefBlock,
    CLEAN_BACKGROUND,
    illustrationHint
      ? `SCENE TO ILLUSTRATE: ${illustrationHint}`
      : 'SCENE: A warm, child-friendly Islamic story moment.',
    isYoung
      ? 'Very expressive faces, bold simple composition for ages 4-6.'
      : 'Expressive warm storytelling for ages 6-8.',
    textSafeZone(textPosition),
    `Art style: ${universeStyle || 'Pixar 3D animation'}, warm golden lighting, vibrant child-friendly colors.`,
    'ZERO text, letters, numbers, watermarks, or words anywhere in the image.',
    SINGLE_PANEL,
  ].filter(Boolean).join('\n\n');
}

function buildChapterBookIllustrationPrompt({
  bookTitle,
  chapterTitle,
  chapterNumber,
  chapterIllustrationHint,
  characterLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
  crossChapterAnchor,
}) {
  return [
    `Children's Islamic chapter book illustration for "${bookTitle}".`,
    `Chapter ${chapterNumber}: "${chapterTitle}".`,
    outfitQuickRef,
    crossChapterAnchor,
    characterLockBlock,
    poseRefBlock,
    CLEAN_BACKGROUND,
    chapterIllustrationHint
      ? `SCENE TO ILLUSTRATE: ${chapterIllustrationHint}`
      : 'SCENE: A warm, meaningful Islamic story moment.',
    'Soft watercolor or ink style — classic chapter-book feel for ages 8-14.',
    `Art style: ${universeStyle || 'Pixar 3D animation'}.`,
    'ZERO text, letters, numbers, watermarks, or words anywhere in the image.',
    SINGLE_PANEL,
  ].filter(Boolean).join('\n\n');
}

function buildCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef }) {
  return [
    `Children's Islamic book FRONT COVER for "${bookTitle}".`,
    outfitQuickRef,
    characterLockBlock,
    poseRefBlock,
    CLEAN_BACKGROUND,
    'SCENE: Main character prominently featured in a warm, inviting, cinematic scene.',
    'Portrait orientation. Full vibrant cover art.',
    `Art style: ${universeStyle || 'Pixar 3D animation'}, golden cinematic lighting.`,
    'ZERO text, letters, numbers, titles, author names, or watermarks in the image.',
    SINGLE_PANEL,
  ].filter(Boolean).join('\n\n');
}

function buildBackCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef }) {
  return [
    `Children's Islamic book BACK COVER for "${bookTitle}".`,
    outfitQuickRef,
    characterLockBlock,
    poseRefBlock,
    CLEAN_BACKGROUND,
    'SCENE: Main character in a peaceful, happy, concluding moment. Soft and warm.',
    'Portrait orientation.',
    `Art style: ${universeStyle || 'Pixar 3D animation'}.`,
    'ZERO text, letters, numbers, or watermarks in the image.',
    SINGLE_PANEL,
  ].filter(Boolean).join('\n\n');
}

// ─── Build references array for a request ─────────────────────────────────────

function buildReferences(characters, firstIdentityRef) {
  const refs = [];

  // 1. First consistency ref (first illustration generated — anchors style + outfits)
  //    Always placed FIRST so provider treats it as the master visual reference
  if (firstIdentityRef) refs.push(firstIdentityRef);

  // 2. Pose sheets (best reference — full body from all angles)
  for (const c of characters) {
    if (c.poseSheetUrl && c.poseSheetUrl.startsWith('https://')) {
      refs.push(c.poseSheetUrl);
    }
  }

  // 3. Portraits as fallback if no pose sheet
  for (const c of characters) {
    if (!c.poseSheetUrl && c.imageUrl && c.imageUrl.startsWith('https://')) {
      refs.push(c.imageUrl);
    }
  }

  // Deduplicate
  return [...new Set(refs)];
}

function getPrimaryIllustrationRef(illustrations) {
  const first = illustrations?.[0];
  if (!first) return null;
  const idx = first.selectedVariantIndex ?? 0;
  return first?.variants?.[idx]?.imageUrl || first?.variants?.[0]?.imageUrl || null;
}

// ─── Also extract first spread image as the master anchor ─────────────────────

function getMasterAnchorRef(illustrations) {
  // Try spread[0] of chapter[0] first (picture books)
  const firstChapter = illustrations?.[0];
  if (firstChapter?.spreads?.[0]?.imageUrl) return firstChapter.spreads[0].imageUrl;
  // Fall back to variant
  return getPrimaryIllustrationRef(illustrations);
}

// ─── Generate full-book illustrations ────────────────────────────────────────

export async function generateBookIllustrations({ projectId, userId, style, seed, traceId }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe     = project.universeId ? await Universe.findById(project.universeId) : null;
  const characters   = await loadUniverseCharacters(project);
  const universeStyle = style || universe?.artStyle || 'pixar-3d';

  console.log(`[image.service] Universe: "${universe?.name || 'none'}" | Characters: ${characters.map(c => c.name).join(', ') || 'none'}`);
  console.log(`[image.service] Pose sheets: ${characters.filter(c => c.poseSheetUrl).map(c => c.name).join(', ') || 'none'}`);

  if (!characters.length) {
    console.warn('[image.service] ⚠ No characters found for this project — illustrations will have no character reference');
  }

  const characterLockBlock = buildCharacterLockBlock(characters);
  const poseRefBlock       = buildPoseRefInstruction(characters);
  const outfitQuickRef     = buildOutfitQuickRef(characters);

  const pictureBook     = isPictureBook(project.ageRange);
  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const chapterContent  = normArr(project.artifacts?.humanized?.length
    ? project.artifacts.humanized
    : project.artifacts?.chapters);

  const bookTitle    = project.artifacts?.outline?.bookTitle || project.title;
  const chapterCount = getSafeChapterCount(project);
  const illustrations = normArr(project.artifacts?.illustrations);

  // Master visual anchor — first generated image anchors ALL subsequent images
  let masterAnchorRef  = getMasterAnchorRef(illustrations);
  let firstIdentityRef = masterAnchorRef;
  let providerUsed     = 'unknown';

  console.log(`[image.service] Mode: ${pictureBook ? 'PICTURE BOOK' : 'CHAPTER BOOK'} | ${chapterCount} chapters | anchor: ${masterAnchorRef ? 'EXISTS' : 'NONE'}`);

  for (let ci = 0; ci < chapterCount; ci++) {
    const chapterData    = outlineChapters[ci] || {};
    const chapterContent_ = chapterContent[ci] || {};
    const chapterTitle   = chapterContent_?.chapterTitle || chapterData?.title || `Chapter ${ci + 1}`;

    const existing = illustrations[ci] || {
      chapterNumber: ci + 1,
      variants: [],
      spreads:  [],
      selectedVariantIndex: 0,
    };
    existing.variants = normArr(existing.variants);
    existing.spreads  = normArr(existing.spreads);

    if (pictureBook) {
      const spreads = normArr(chapterContent_?.spreads);
      const imagesPerChapter = getImagesPerChapter(project.ageRange);
      const targetSpreads = spreads.length > 0
        ? spreads
        : Array.from({ length: imagesPerChapter }, (_, i) => ({
            spreadIndex:      i,
            text:             '',
            illustrationHint: chapterData.keyScene || '',
            textPosition:     'bottom',
          }));

      for (let si = existing.spreads.length; si < targetSpreads.length; si++) {
        const spread = targetSpreads[si] || {};

        // Always pass master anchor as first reference for every single image
        const refs = buildReferences(characters, firstIdentityRef);

        // Cross-chapter anchor block only appears after Ch1Spread1 is generated
        const crossChapterAnchor = (ci > 0 || si > 0)
          ? buildCrossChapterAnchor(firstIdentityRef, ci, si)
          : '';

        const prompt = buildSpreadPrompt({
          bookTitle,
          chapterTitle,
          spreadIndex:      si,
          chapterIndex:     ci,
          illustrationHint: spread.illustrationHint || chapterData.keyScene || '',
          textPosition:     spread.textPosition     || 'bottom',
          ageRange:         project.ageRange,
          characterLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossChapterAnchor,
        });

        const trId = `trace_${Date.now()}_ch${ci}_s${si}_${Math.random().toString(36).slice(2, 8)}`;
        console.log(`[image.service] ch${ci + 1} spread${si} | refs: ${refs.length} | anchor: ${firstIdentityRef ? 'YES' : 'NO'} | chars: ${characters.map(c => c.name).join(', ')}`);

        const result = await generateImage({ task: 'illustration', prompt, references: refs, style: universeStyle, seed, projectId, traceId: trId });
        providerUsed = result.provider || providerUsed;

        existing.spreads.push({
          spreadIndex:      si,
          imageUrl:         result.imageUrl,
          prompt,
          seed:             seed || null,
          text:             spread.text          || '',
          textPosition:     spread.textPosition  || 'bottom',
          illustrationHint: spread.illustrationHint || '',
        });

        // The very first image becomes the master anchor for the entire book
        if (!firstIdentityRef && result.imageUrl) {
          firstIdentityRef = result.imageUrl;
          masterAnchorRef  = result.imageUrl;
          console.log(`[image.service] ✓ Master anchor set from Ch1 Spread1: ${firstIdentityRef}`);
        }
      }

    } else {
      if (existing.variants.length === 0) {
        const refs = buildReferences(characters, firstIdentityRef);

        const crossChapterAnchor = ci > 0
          ? buildCrossChapterAnchor(firstIdentityRef, ci, 0)
          : '';

        const prompt = buildChapterBookIllustrationPrompt({
          bookTitle,
          chapterTitle,
          chapterNumber:           ci + 1,
          chapterIllustrationHint: chapterContent_?.chapterIllustrationHint || chapterData.keyScene || '',
          characterLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossChapterAnchor,
        });

        const trId = `trace_${Date.now()}_ch${ci}_${Math.random().toString(36).slice(2, 8)}`;
        console.log(`[image.service] ch${ci + 1} chapter-book | refs: ${refs.length} | anchor: ${firstIdentityRef ? 'YES' : 'NO'}`);

        const result = await generateImage({ task: 'illustration', prompt, references: refs, style: universeStyle, seed, projectId, traceId: trId });
        providerUsed = result.provider || providerUsed;

        existing.variants.push({
          variantIndex: 0,
          imageUrl:     result.imageUrl,
          prompt,
          seed:         seed || null,
          selected:     true,
        });

        if (!firstIdentityRef && result.imageUrl) {
          firstIdentityRef = result.imageUrl;
          masterAnchorRef  = result.imageUrl;
          console.log(`[image.service] ✓ Master anchor set from Ch1: ${firstIdentityRef}`);
        }
      }
    }

    existing.selectedVariantIndex = 0;
    illustrations[ci] = existing;
  }

  await Project.findByIdAndUpdate(projectId, {
    $set: { 'artifacts.illustrations': illustrations, currentStage: 'illustrations' },
  });

  // ── Back cover ────────────────────────────────────────────────────────────
  if (!project.artifacts?.cover?.backUrl) {
    console.log('[image.service] Generating back cover...');
    try {
      const refs   = buildReferences(characters, firstIdentityRef);
      const prompt = buildBackCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef });
      const result = await generateImage({ task: 'back-cover', prompt, references: refs, style: universeStyle, seed, projectId, traceId: `trace_backcover_${Date.now()}` });
      await Project.findByIdAndUpdate(projectId, {
        $set: { 'artifacts.cover': { ...(project.artifacts?.cover || {}), backUrl: result.imageUrl, backPrompt: prompt } },
      });
      providerUsed = result.provider || providerUsed;
    } catch (err) {
      console.error('[image.service] Back cover failed (non-fatal):', err.message);
    }
  }

  return { provider: providerUsed, illustrations, pictureBook, chapterCount };
}

// ─── Generate single image (rerun / cover / back-cover) ──────────────────────

export async function generateStageImage({ task, chapterIndex = 0, spreadIndex = 0, projectId, userId, customPrompt, seed, style, traceId }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe      = project.universeId ? await Universe.findById(project.universeId) : null;
  const characters    = await loadUniverseCharacters(project);
  const universeStyle = style || universe?.artStyle || 'pixar-3d';

  const characterLockBlock = buildCharacterLockBlock(characters);
  const poseRefBlock       = buildPoseRefInstruction(characters);
  const outfitQuickRef     = buildOutfitQuickRef(characters);

  const pictureBook     = isPictureBook(project.ageRange);
  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const chapterContent  = normArr(project.artifacts?.humanized?.length
    ? project.artifacts.humanized
    : project.artifacts?.chapters);

  const chapterData    = outlineChapters[chapterIndex]  || {};
  const chapterContent_ = chapterContent[chapterIndex]   || {};
  const bookTitle      = project.artifacts?.outline?.bookTitle || project.title;
  const chapterTitle   = chapterContent_?.chapterTitle   || chapterData?.title || `Chapter ${chapterIndex + 1}`;

  const illustrations   = normArr(project.artifacts?.illustrations);
  const masterAnchorRef = getMasterAnchorRef(illustrations);

  // Always use master anchor for reruns so they match the rest of the book
  const refs = buildReferences(characters, masterAnchorRef);

  // Cross-chapter anchor for reruns
  const crossChapterAnchor = masterAnchorRef
    ? buildCrossChapterAnchor(masterAnchorRef, chapterIndex, spreadIndex)
    : '';

  let prompt;

  if (customPrompt) {
    prompt = customPrompt;
  } else if (task === 'illustration' && pictureBook) {
    const spread = normArr(chapterContent_?.spreads)[spreadIndex] || {};
    prompt = buildSpreadPrompt({
      bookTitle, chapterTitle, spreadIndex, chapterIndex,
      illustrationHint: spread.illustrationHint || chapterData.keyScene || '',
      textPosition:     spread.textPosition     || 'bottom',
      ageRange:         project.ageRange,
      characterLockBlock, poseRefBlock, universeStyle,
      outfitQuickRef, crossChapterAnchor,
    });
  } else if (task === 'illustration' && !pictureBook) {
    prompt = buildChapterBookIllustrationPrompt({
      bookTitle, chapterTitle, chapterNumber: chapterIndex + 1,
      chapterIllustrationHint: chapterContent_?.chapterIllustrationHint || chapterData.keyScene || '',
      characterLockBlock, poseRefBlock, universeStyle,
      outfitQuickRef, crossChapterAnchor,
    });
  } else if (task === 'cover') {
    prompt = buildCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef });
  } else if (task === 'back-cover') {
    prompt = buildBackCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef });
  } else {
    prompt = [
      `Children's Islamic book image for "${bookTitle}".`,
      outfitQuickRef,
      crossChapterAnchor,
      characterLockBlock,
      poseRefBlock,
      CLEAN_BACKGROUND,
      chapterData.keyScene ? `Scene: ${chapterData.keyScene}` : '',
      SINGLE_PANEL,
    ].filter(Boolean).join('\n\n');
  }

  const trId = traceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[image.service] single task=${task} ch=${chapterIndex} spread=${spreadIndex} refs=${refs.length} anchor=${masterAnchorRef ? 'YES' : 'NO'} chars=${characters.map(c => c.name).join(', ')}`);

  const result    = await generateImage({ task, prompt, references: refs, style: universeStyle, seed, projectId, traceId: trId });
  const setFields = {};

  if (task === 'illustration') {
    const existing = illustrations[chapterIndex] || { chapterNumber: chapterIndex + 1, variants: [], spreads: [], selectedVariantIndex: 0 };
    existing.variants = normArr(existing.variants);
    existing.spreads  = normArr(existing.spreads);

    if (pictureBook) {
      const spread = normArr(chapterContent_?.spreads)[spreadIndex] || {};
      existing.spreads[spreadIndex] = {
        spreadIndex, imageUrl: result.imageUrl, prompt, seed: seed || null,
        text: spread.text || '', textPosition: spread.textPosition || 'bottom',
        illustrationHint: spread.illustrationHint || '',
      };
    } else {
      const vi = existing.variants.length;
      existing.variants.push({ variantIndex: vi, imageUrl: result.imageUrl, prompt, seed: seed || null, selected: vi === 0 });
      if (!existing.selectedVariantIndex) existing.selectedVariantIndex = 0;
    }

    illustrations[chapterIndex]          = existing;
    setFields['artifacts.illustrations'] = illustrations;

  } else if (task === 'cover') {
    setFields['artifacts.cover'] = { ...(project.artifacts?.cover || {}), frontUrl: result.imageUrl, frontPrompt: prompt };
  } else if (task === 'back-cover') {
    setFields['artifacts.cover'] = { ...(project.artifacts?.cover || {}), backUrl: result.imageUrl, backPrompt: prompt };
  }

  if (Object.keys(setFields).length) {
    await Project.findByIdAndUpdate(projectId, { $set: setFields });
  }

  return { ...result, traceId: trId };
}

// ─── Named exports (used by other modules) ────────────────────────────────────
export { normArr, isPictureBook, getImagesPerChapter, getSafeChapterCount };