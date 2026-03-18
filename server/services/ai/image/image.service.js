// server/services/ai/image/image.service.js
// FIXES APPLIED:
// FIX 1:  isSpreadOnlyProject() — age-first detection (isPictureBook first, then flag, then spreads array)
//         used consistently everywhere instead of bare artifacts.spreadOnly flag check
// FIX 2:  buildSpreadPrompt spreadLabel is always "Spread N of M" — never "Chapter X Spread Y"
// FIX 3:  negative_prompt injected into every generateImage() call to suppress borders/frames
// FIX 4:  Wrong scene — spread.text fallback now derives from chapter prose, not keyScene
// FIX 5:  Outfit color parsed from outfitRules string when outfitColor field is empty
// FIX 6:  character.poseSheetUrl / imageUrl used as firstIdentityRef from spread 1 (no null anchor)
// FIX 7:  generateBookIllustrations uses isSpreadOnlyProject() not bare flag (matches route)
// FIX 8:  saveSpreadIllustration replaced with inline Project usage (no require() in ESM)
// FIX 9:  All chapter-based labels removed from spread-only path

import { Project }   from '../../../models/Project.js';
import { Universe }  from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { NotFoundError } from '../../../errors.js';
import { generateImage }  from './image.providers.js';

// ─── Negative prompt (injected into every image call) ─────────────────────────
// FIX 3: Forces provider-level suppression of frames/borders

const NEGATIVE_PROMPT =
  'border, frame, decorative frame, vignette, watercolor edges, rounded card outline, ' +
  'scrapbook border, sticker border, painted edges, inner border, outer stroke, ' +
  'comic panel, multiple panels, storyboard, grid, text, watermark, letter, number, word, ' +
  'signature, logo, extra characters, background people, crowd, silhouette';

// ─── Array helpers ────────────────────────────────────────────────────────────

export function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];
  const keys = Object.keys(val).map(Number).filter(n => !Number.isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr.filter(v => v != null);
}

export function isPictureBook(ageRange) {
  if (!ageRange) return true;
  const first = String(ageRange).match(/\d+/)?.[0];
  return first ? Number(first) <= 8 : true;
}

export function getImagesPerChapter(ageRange) {
  const first = String(ageRange || '').match(/\d+/)?.[0];
  const age   = first ? Number(first) : 7;
  return age <= 6 ? 2 : 1;
}

export function getSafeChapterCount(project) {
  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const rawCount = outlineChapters.length || Number(project.chapterCount) || 4;
  return Math.max(4, Math.min(rawCount, 9));
}

// FIX 1 & 7: Age-first spread-only detection — single source of truth
// Age 2-8 = always spread-only regardless of flag
export function isSpreadOnlyProject(project) {
  if (isPictureBook(project.ageRange)) return true;
  if (project.artifacts?.spreadOnly === true) return true;
  if (normArr(project.artifacts?.spreads || []).length > 0) return true;
  return false;
}

// ─── Load characters ──────────────────────────────────────────────────────────

async function loadUniverseCharacters(project) {
  if (!project) return [];
  if (project.characterIds?.length) {
    return Character.find({ _id: { $in: project.characterIds } });
  }
  if (project.universeId) {
    return Character.find({ universeId: project.universeId });
  }
  return [];
}

// ─── FIX 5: Parse outfit color from outfitRules when outfitColor is missing ───

const COLOR_WORDS = [
  'white','cream','beige','ivory','off-white',
  'black','gray','grey','charcoal',
  'blue','navy','sky','royal','teal','cyan','aqua',
  'green','olive','mint','sage','emerald','forest',
  'red','crimson','maroon','burgundy','rose',
  'pink','magenta','fuchsia','lilac','lavender',
  'purple','violet','indigo','plum',
  'orange','amber','mustard','gold','yellow','lemon',
  'brown','tan','caramel','chocolate','khaki',
  'silver','bronze','copper',
];

function extractOutfitColor(vd) {
  if (vd.outfitColor && vd.outfitColor.trim() && vd.outfitColor !== 'see description') {
    return vd.outfitColor.trim();
  }
  if (vd.primaryColor && vd.primaryColor.trim()) return vd.primaryColor.trim();
  // Try to parse from outfitRules string
  const rules = (vd.outfitRules || '').toLowerCase();
  for (const color of COLOR_WORDS) {
    if (rules.includes(color)) return color;
  }
  return 'as described in outfit rules';
}

// ─── Character description ────────────────────────────────────────────────────

function describeCharacter(c) {
  if (!c) return '';
  const vd  = c.visualDNA    || {};
  const mod = c.modestyRules || {};
  const gender = mod.hijabAlways
    ? 'GIRL'
    : (vd.gender?.toUpperCase() || (c.name?.toLowerCase().match(/^(ahmed|omar|ali|hassan|yusuf|ibrahim|adam|zaid|bilal|muhammad|usman)/) ? 'BOY' : 'GIRL'));

  const outfitColor = extractOutfitColor(vd); // FIX 5

  return [
    `  • ${c.name} [${c.role || 'character'}] — ${gender}, age ${c.ageRange || 'child'}`,
    `    Skin: ${vd.skinTone || 'N/A'} | Eyes: ${vd.eyeColor || 'N/A'} | Face: ${vd.faceShape || 'N/A'}`,
    `    Hair/Hijab: ${vd.hairOrHijab || 'N/A'}`,
    `    ════ LOCKED OUTFIT COLOR — NEVER CHANGE ════`,
    `    Outfit: ${vd.outfitRules || 'N/A'}`,
    `    Primary outfit color: ${outfitColor}`,
    `    ⚑ EXACT outfit and color in EVERY scene — no substitutions ever`,
    mod.hijabAlways   ? `    ⚑ Hijab: ALWAYS visible` : '',
    mod.longSleeves   ? `    ⚑ Long sleeves: always` : '',
    mod.looseClothing ? `    ⚑ Loose clothing: always` : '',
    `    Personality: ${(c.traits || []).join(', ')}`,
  ].filter(Boolean).join('\n');
}

// ─── Outfit quick-ref ─────────────────────────────────────────────────────────

function buildOutfitQuickRef(characters) {
  if (!characters?.length) return '';
  const lines = characters.map(c => {
    const vd    = c.visualDNA || {};
    const color = extractOutfitColor(vd); // FIX 5
    return `  ${c.name}: ALWAYS wears ${vd.outfitRules || 'their standard outfit'} — COLOR: ${color} — NEVER changed`;
  });
  return `
⚠ OUTFIT COLOR LOCK (EVERY illustration, no exceptions):
${lines.join('\n')}
Colors are FROZEN for the entire book.`;
}

// ─── Character lock block ─────────────────────────────────────────────────────

function buildCharacterLockBlock(characters) {
  if (!characters?.length) return '';
  const approvedNames = characters.map(c => c.name).join(', ');
  const descriptions  = characters.map(describeCharacter).join('\n\n');

  return `
╔══════════════════════════════════════════════════════════════╗
║           UNIVERSE CHARACTERS — ABSOLUTE RULES              ║
╠══════════════════════════════════════════════════════════════╣
║ ONLY these characters may appear in this image              ║
╚══════════════════════════════════════════════════════════════╝

APPROVED CHARACTERS:
${descriptions}

══ CHARACTER CONSISTENCY LAWS (ALL must be obeyed) ══════════════
LAW 1:  ONLY draw characters listed above — ${approvedNames}
LAW 2:  Do NOT invent, add, or imply ANY new character
LAW 3:  Do NOT add background people, silhouettes, or crowd
LAW 4:  Do NOT change gender — ever
LAW 5:  Face shape, skin tone, eye color IDENTICAL to description
LAW 6:  Outfit, hair, hijab match EXACTLY — zero variation
LAW 7:  The reference image shows these characters — match them
LAW 8:  Only draw characters needed for this scene
LAW 9:  Hijab MUST be worn if hijabAlways=true
LAW 10: Islamic children's book — all characters are modest
LAW 11: OUTFIT COLORS FROZEN — identical in every single image
LAW 12: Body proportions, height, and build IDENTICAL across all images
LAW 13: Same age appearance in every image — do NOT make character look older or younger
LAW 14: Same hairstyle and hair color in every image — no variation
══════════════════════════════════════════════════════════════`;
}

// ─── Pose reference ───────────────────────────────────────────────────────────

function buildPoseRefInstruction(characters) {
  const withSheets = characters.filter(c => c.poseSheetUrl);
  if (!withSheets.length) return '';
  const names = withSheets.map(c => c.name).join(', ');
  return `
POSE REFERENCE: Pose sheets provided for ${names}.
Match exact body proportions, face shape, clothing. Use as consistency anchor.`;
}

// ─── Cross-page anchor ────────────────────────────────────────────────────────

function buildCrossPageAnchor(firstIdentityRef, spreadLabel) {
  if (!firstIdentityRef) return '';
  return `
╔══════════════════════════════════════════════════════════════╗
║   VISUAL CONSISTENCY — CRITICAL                              ║
╠══════════════════════════════════════════════════════════════╣
║ Reference image = MASTER VISUAL ANCHOR for entire book      ║
╚══════════════════════════════════════════════════════════════╝
This is ${spreadLabel}.
MATCH the reference image EXACTLY:
  • Face shape, skin tone, eye color, hair
  • Outfit — same garment, same color, same style
  • Body proportions, height, build
  • Art style, lighting quality, color temperature
ONLY the scene/pose/expression changes. Everything else is IDENTICAL.`;
}

// ─── No-border enforcement ────────────────────────────────────────────────────

const NO_BORDER_BLOCK = `
╔══════════════════════════════════════════════════════════════╗
║   FRAMING — ABSOLUTE RULES                                   ║
╚══════════════════════════════════════════════════════════════╝
• ZERO decorative borders, frames, outlines, or painted edges
• ZERO scrapbook-style borders or watercolor edge effects
• ZERO vignette frames, sticker borders, or card outlines
• Full-bleed illustration filling the ENTIRE canvas edge-to-edge
• No inner border, no outer stroke, no rounded corner card effect
• The image IS the full canvas — no frame around it`;

const SINGLE_PANEL = `IMPORTANT: Single full-bleed illustration — ONE scene only. NOT a comic strip. NOT multiple panels. One image filling the entire frame.`;

const CLEAN_BACKGROUND = `
BACKGROUND:
  • Clean and simple — do NOT clutter
  • No ornate arches, no heavy floral arrangements
  • Soft out-of-focus environment — character is the focus
  • Allowed: simple sky, soft-focus garden, plain room with 1-2 objects
  • Background: soft pastels or neutrals — never compete with characters
  • 60% of background area clean and uncluttered`;

function textSafeZone(textPosition) {
  if (!textPosition) return '';
  if (textPosition === 'top' || textPosition === 'overlay-top')
    return 'Keep TOP 20% visually simple — text overlaid there.';
  if (textPosition === 'bottom' || textPosition === 'overlay-bottom')
    return 'Keep BOTTOM 20% visually simple — text overlaid there.';
  return '';
}

// ─── FIX 4: Derive scene text from chapter prose if spread.text is empty ──────

function deriveSceneText(spread, chapterData, chapterContent_) {
  // Priority: spread.text → spread.illustrationHint → chapter summary → keyScene
  if (spread.text?.trim()) return spread.text.trim();
  if (spread.illustrationHint?.trim()) return spread.illustrationHint.trim();
  // Try to pull a sentence from chapter prose
  const prose = chapterContent_?.content || chapterContent_?.text || '';
  if (prose.trim()) {
    // Take first 2 sentences as scene anchor
    const sentences = prose.match(/[^.!?]+[.!?]+/g) || [];
    const snippet   = sentences.slice(0, 2).join(' ').trim();
    if (snippet) return snippet;
  }
  // Last resort: keyScene (but never use this alone — it produces wrong scenes)
  if (chapterData?.keyScene?.trim()) return chapterData.keyScene.trim();
  return '';
}

// ─── Spread prompt builder ────────────────────────────────────────────────────
// FIX 2: spreadLabel is always "Spread N of M" — callers must NOT pass "Chapter X"

function buildSpreadPrompt({
  bookTitle,
  spreadText,
  illustrationHint,
  spreadLabel,        // MUST be "Spread N of M" — never "Chapter X Spread Y"
  textPosition,
  ageRange,
  characterLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
  crossPageAnchor,
}) {
  const first   = String(ageRange || '').match(/\d+/)?.[0];
  const minAge  = first ? Number(first) : 7;
  const isYoung = minAge <= 6;

  const sceneInstruction = spreadText
    ? `SCENE TO ILLUSTRATE (MUST match the page text exactly):
Page text: "${spreadText}"
Draw exactly what the text describes. The action, characters, and setting must all match this text.
${illustrationHint ? `Additional context: ${illustrationHint}` : ''}`
    : (illustrationHint
        ? `SCENE TO ILLUSTRATE: ${illustrationHint}`
        : 'SCENE: A warm, child-friendly Islamic story moment.');

  return [
    `Children's Islamic picture book illustration for "${bookTitle}".`,
    `Page: ${spreadLabel}.`,   // FIX 2: always "Spread N of M"
    NO_BORDER_BLOCK,
    outfitQuickRef,
    crossPageAnchor,
    characterLockBlock,
    poseRefBlock,
    CLEAN_BACKGROUND,
    sceneInstruction,
    isYoung
      ? 'Very expressive faces, bold simple composition for young children.'
      : 'Expressive warm storytelling.',
    textSafeZone(textPosition),
    `Art style: ${universeStyle || 'Pixar 3D animation'}, warm golden lighting, vibrant child-friendly colors.`,
    'ZERO text, letters, numbers, watermarks, or words anywhere in the image.',
    SINGLE_PANEL,
  ].filter(Boolean).join('\n\n');
}

function buildCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef }) {
  return [
    `Children's Islamic book FRONT COVER for "${bookTitle}".`,
    NO_BORDER_BLOCK,
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
    NO_BORDER_BLOCK,
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

function buildChapterBookIllustrationPrompt({
  bookTitle, chapterTitle, chapterNumber,
  chapterIllustrationHint, characterLockBlock, poseRefBlock,
  universeStyle, outfitQuickRef, crossPageAnchor,
}) {
  return [
    `Children's Islamic chapter book illustration for "${bookTitle}".`,
    `Chapter ${chapterNumber}: "${chapterTitle}".`,
    NO_BORDER_BLOCK,
    outfitQuickRef,
    crossPageAnchor,
    characterLockBlock,
    poseRefBlock,
    CLEAN_BACKGROUND,
    chapterIllustrationHint
      ? `SCENE TO ILLUSTRATE: ${chapterIllustrationHint}`
      : 'SCENE: A warm, meaningful Islamic story moment.',
    `Art style: ${universeStyle || 'Pixar 3D animation'}.`,
    'ZERO text, letters, numbers, watermarks, or words anywhere in the image.',
    SINGLE_PANEL,
  ].filter(Boolean).join('\n\n');
}

// ─── References ───────────────────────────────────────────────────────────────

// FIX 6: Always seed refs with character sheets so spread 1 has an anchor
function buildInitialRefs(characters) {
  const refs = [];
  for (const c of characters) {
    if (c.poseSheetUrl?.startsWith('https://')) refs.push(c.poseSheetUrl);
  }
  for (const c of characters) {
    if (!c.poseSheetUrl && c.imageUrl?.startsWith('https://')) refs.push(c.imageUrl);
  }
  return [...new Set(refs)];
}

function buildReferences(characters, identityRef) {
  const refs = [];
  if (identityRef) refs.push(identityRef);
  for (const c of characters) {
    if (c.poseSheetUrl?.startsWith('https://')) refs.push(c.poseSheetUrl);
  }
  for (const c of characters) {
    if (!c.poseSheetUrl && c.imageUrl?.startsWith('https://')) refs.push(c.imageUrl);
  }
  return [...new Set(refs)];
}

function getMasterAnchorRef(illustrations) {
  const firstChapter = illustrations?.[0];
  if (firstChapter?.spreads?.[0]?.imageUrl) return firstChapter.spreads[0].imageUrl;
  const idx = firstChapter?.selectedVariantIndex ?? 0;
  return firstChapter?.variants?.[idx]?.imageUrl || null;
}

// FIX 6: Get initial identity ref from characters (so spread 1 is not anchorless)
function getCharacterAnchorRef(characters) {
  for (const c of characters) {
    if (c.poseSheetUrl?.startsWith('https://')) return c.poseSheetUrl;
  }
  for (const c of characters) {
    if (c.imageUrl?.startsWith('https://')) return c.imageUrl;
  }
  return null;
}

// ─── generateImage wrapper — injects negative_prompt (FIX 3) ─────────────────

function generateImageSafe(params) {
  return generateImage({
    ...params,
    negative_prompt: NEGATIVE_PROMPT,
  });
}

// ─── Generate full-book illustrations ────────────────────────────────────────

export async function generateBookIllustrations({ projectId, userId, style, seed, traceId }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe      = project.universeId ? await Universe.findById(project.universeId) : null;
  const characters    = await loadUniverseCharacters(project);
  const universeStyle = style || universe?.artStyle || 'pixar-3d';

  const characterLockBlock = buildCharacterLockBlock(characters);
  const poseRefBlock       = buildPoseRefInstruction(characters);
  const outfitQuickRef     = buildOutfitQuickRef(characters);

  const bookTitle  = project.artifacts?.outline?.bookTitle || project.title;
  let providerUsed = 'unknown';

  // FIX 6: Seed firstIdentityRef from character sheets immediately
  let firstIdentityRef =
    getMasterAnchorRef(normArr(project.artifacts?.illustrations)) ||
    getMasterAnchorRef(normArr(project.artifacts?.spreadIllustrations)) ||
    getCharacterAnchorRef(characters);

  // FIX 7: Use isSpreadOnlyProject() — age-first, consistent with route
  if (isSpreadOnlyProject(project)) {
    const allSpreads         = normArr(project.artifacts?.spreads || []);
    const existingSpreadIlls = normArr(project.artifacts?.spreadIllustrations || []);
    const totalSpreads       = allSpreads.length;

    console.log(`[image.service] SPREAD-ONLY mode | ${totalSpreads} spreads | anchor: ${firstIdentityRef ? 'YES' : 'NO'}`);

    for (let si = 0; si < totalSpreads; si++) {
      if (existingSpreadIlls[si]?.imageUrl) {
        if (!firstIdentityRef) firstIdentityRef = existingSpreadIlls[si].imageUrl;
        continue;
      }

      const spread = allSpreads[si] || {};
      const refs   = buildReferences(characters, firstIdentityRef);

      // FIX 2: label is always "Spread N of M" — never "Chapter X"
      const spreadLabel    = `Spread ${si + 1} of ${totalSpreads}`;
      const crossPageAnchor = buildCrossPageAnchor(firstIdentityRef, spreadLabel);

      // FIX 4: derive scene text rather than falling back to keyScene
      const spreadText = deriveSceneText(spread, {}, {});

      const prompt = buildSpreadPrompt({
        bookTitle,
        spreadText,
        illustrationHint: spread.illustrationHint || '',
        spreadLabel,
        textPosition:     spread.textPosition || 'bottom',
        ageRange:         project.ageRange,
        characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef, crossPageAnchor,
      });

      console.log(`[image.service] Spread ${si + 1}/${totalSpreads} | text: "${spreadText?.slice(0, 60)}" | refs: ${refs.length}`);

      // FIX 3: use generateImageSafe (injects negative_prompt)
      const result = await generateImageSafe({
        task: 'illustration', prompt, references: refs,
        style: universeStyle, seed, projectId,
        traceId: `${traceId || 'trace'}_s${si}_${Date.now()}`,
      });
      providerUsed = result.provider || providerUsed;

      existingSpreadIlls[si] = {
        spreadIndex:      si,
        imageUrl:         result.imageUrl,
        prompt,
        text:             spreadText,
        textPosition:     spread.textPosition || 'bottom',
        illustrationHint: spread.illustrationHint || '',
        createdAt:        new Date().toISOString(),
      };

      await Project.findByIdAndUpdate(projectId, {
        $set: { 'artifacts.spreadIllustrations': existingSpreadIlls },
      });

      if (!firstIdentityRef && result.imageUrl) {
        firstIdentityRef = result.imageUrl;
        console.log(`[image.service] ✓ Master anchor set from Spread 1`);
      }
    }

    // Back cover
    if (!project.artifacts?.cover?.backUrl) {
      try {
        const refs   = buildReferences(characters, firstIdentityRef);
        const prompt = buildBackCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef });
        const result = await generateImageSafe({ // FIX 3
          task: 'back-cover', prompt, references: refs,
          style: universeStyle, seed, projectId,
          traceId: `trace_backcover_${Date.now()}`,
        });
        await Project.findByIdAndUpdate(projectId, {
          $set: { 'artifacts.cover': { ...(project.artifacts?.cover || {}), backUrl: result.imageUrl, backPrompt: prompt } },
        });
        providerUsed = result.provider || providerUsed;
      } catch (err) {
        console.error('[image.service] Back cover failed (non-fatal):', err.message);
      }
    }

    return { provider: providerUsed, spreadOnly: true, spreadCount: allSpreads.length };
  }

  // ── Chapter-based path (age ≥ 9 chapter books) ───────────────────────────
  const pictureBook     = isPictureBook(project.ageRange);
  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const chapterContent  = normArr(
    project.artifacts?.humanized?.length
      ? project.artifacts.humanized
      : project.artifacts?.chapters
  );

  const chapterCount  = getSafeChapterCount(project);
  const illustrations = normArr(project.artifacts?.illustrations);

  console.log(`[image.service] CHAPTER mode | ${pictureBook ? 'picture book' : 'chapter book'} | ${chapterCount} chapters`);

  for (let ci = 0; ci < chapterCount; ci++) {
    const chapterData     = outlineChapters[ci]    || {};
    const chapterContent_ = chapterContent[ci]     || {};
    const chapterTitle    = chapterContent_?.chapterTitle || chapterData?.title || `Chapter ${ci + 1}`;

    const existing = illustrations[ci] || {
      chapterNumber: ci + 1, variants: [], spreads: [], selectedVariantIndex: 0,
    };
    existing.variants = normArr(existing.variants);
    existing.spreads  = normArr(existing.spreads);

    if (pictureBook) {
      const spreads          = normArr(chapterContent_?.spreads);
      const imagesPerChapter = getImagesPerChapter(project.ageRange);
      const targetSpreads    = spreads.length > 0
        ? spreads
        : Array.from({ length: imagesPerChapter }, (_, i) => ({
            spreadIndex: i, text: '', illustrationHint: chapterData.keyScene || '', textPosition: 'bottom',
          }));

      for (let si = existing.spreads.length; si < targetSpreads.length; si++) {
        const spread = targetSpreads[si] || {};
        const refs   = buildReferences(characters, firstIdentityRef);

        // FIX 2: label is always "Spread N of M"
        const totalBookSpreads = chapterCount * targetSpreads.length;
        const globalSpreadIdx  = ci * targetSpreads.length + si;
        const spreadLabel      = `Spread ${globalSpreadIdx + 1} of ${totalBookSpreads}`;
        const crossPageAnchor  = firstIdentityRef
          ? buildCrossPageAnchor(firstIdentityRef, spreadLabel)
          : '';

        // FIX 4: derive scene from prose
        const spreadText = deriveSceneText(spread, chapterData, chapterContent_);

        const prompt = buildSpreadPrompt({
          bookTitle,
          spreadText,
          illustrationHint: spread.illustrationHint || chapterData.keyScene || '',
          spreadLabel,
          textPosition:     spread.textPosition || 'bottom',
          ageRange:         project.ageRange,
          characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef, crossPageAnchor,
        });

        console.log(`[image.service] ch${ci + 1} spread${si} | text: "${spreadText?.slice(0, 60)}"`);

        // FIX 3
        const result = await generateImageSafe({
          task: 'illustration', prompt, references: refs,
          style: universeStyle, seed, projectId,
          traceId: `trace_${Date.now()}_ch${ci}_s${si}_${Math.random().toString(36).slice(2, 8)}`,
        });
        providerUsed = result.provider || providerUsed;

        existing.spreads.push({
          spreadIndex:      si,
          imageUrl:         result.imageUrl,
          prompt,
          seed:             seed || null,
          text:             spreadText,
          textPosition:     spread.textPosition || 'bottom',
          illustrationHint: spread.illustrationHint || '',
        });

        if (!firstIdentityRef && result.imageUrl) firstIdentityRef = result.imageUrl;
      }
    } else {
      // Chapter book — 1 illustration per chapter
      if (existing.variants.length === 0) {
        const refs = buildReferences(characters, firstIdentityRef);
        const spreadLabel    = `Chapter ${ci + 1}`;
        const crossPageAnchor = ci > 0
          ? buildCrossPageAnchor(firstIdentityRef, spreadLabel)
          : '';

        const hint = chapterContent_?.chapterIllustrationHint || chapterData.keyScene || '';

        const prompt = buildChapterBookIllustrationPrompt({
          bookTitle, chapterTitle, chapterNumber: ci + 1,
          chapterIllustrationHint: hint,
          characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef, crossPageAnchor,
        });

        // FIX 3
        const result = await generateImageSafe({
          task: 'illustration', prompt, references: refs,
          style: universeStyle, seed, projectId,
          traceId: `trace_${Date.now()}_ch${ci}_${Math.random().toString(36).slice(2, 8)}`,
        });
        providerUsed = result.provider || providerUsed;

        existing.variants.push({ variantIndex: 0, imageUrl: result.imageUrl, prompt, seed: seed || null, selected: true });

        if (!firstIdentityRef && result.imageUrl) firstIdentityRef = result.imageUrl;
      }
    }

    existing.selectedVariantIndex = 0;
    illustrations[ci] = existing;
  }

  await Project.findByIdAndUpdate(projectId, {
    $set: { 'artifacts.illustrations': illustrations, currentStage: 'illustrations' },
  });

  // Back cover
  if (!project.artifacts?.cover?.backUrl) {
    try {
      const refs   = buildReferences(characters, firstIdentityRef);
      const prompt = buildBackCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef });
      const result = await generateImageSafe({ // FIX 3
        task: 'back-cover', prompt, references: refs,
        style: universeStyle, seed, projectId,
        traceId: `trace_backcover_${Date.now()}`,
      });
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

// ─── Generate single image (rerun / cover) ────────────────────────────────────

export async function generateStageImage({
  task, chapterIndex = 0, spreadIndex = 0,
  projectId, userId, customPrompt, seed, style, traceId,
}) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe      = project.universeId ? await Universe.findById(project.universeId) : null;
  const characters    = await loadUniverseCharacters(project);
  const universeStyle = style || universe?.artStyle || 'pixar-3d';

  const characterLockBlock = buildCharacterLockBlock(characters);
  const poseRefBlock       = buildPoseRefInstruction(characters);
  const outfitQuickRef     = buildOutfitQuickRef(characters);

  const bookTitle = project.artifacts?.outline?.bookTitle || project.title;

  // FIX 6: Seed anchor from character sheets first
  const spreadIllustrations = normArr(project.artifacts?.spreadIllustrations || []);
  const illustrations       = normArr(project.artifacts?.illustrations);
  const masterAnchorRef     =
    spreadIllustrations[0]?.imageUrl ||
    getMasterAnchorRef(illustrations) ||
    getCharacterAnchorRef(characters);

  const refs = buildReferences(characters, masterAnchorRef);

  let prompt;

  if (customPrompt) {
    // FIX 3: always inject no-border block into custom prompts
    prompt = customPrompt.includes('decorative border') || customPrompt.includes('FRAMING')
      ? customPrompt
      : `${NO_BORDER_BLOCK}\n\n${customPrompt}`;

  } else if (task === 'illustration') {
    // FIX 7: Use isSpreadOnlyProject() for consistent routing
    if (isSpreadOnlyProject(project)) {
      const allSpreads  = normArr(project.artifacts?.spreads || []);
      const totalSpreads = allSpreads.length;
      const spread      = allSpreads[spreadIndex] || {};

      // FIX 2: always "Spread N of M"
      const spreadLabel    = `Spread ${spreadIndex + 1} of ${totalSpreads}`;
      const crossPageAnchor = spreadIndex > 0
        ? buildCrossPageAnchor(masterAnchorRef, spreadLabel)
        : '';

      // FIX 4: derive scene from spread text
      const spreadText = deriveSceneText(spread, {}, {});

      prompt = buildSpreadPrompt({
        bookTitle,
        spreadText,
        illustrationHint: spread.illustrationHint || '',
        spreadLabel,
        textPosition:     spread.textPosition || 'bottom',
        ageRange:         project.ageRange,
        characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef, crossPageAnchor,
      });

    } else {
      const pictureBook     = isPictureBook(project.ageRange);
      const outlineChapters = normArr(project.artifacts?.outline?.chapters);
      const chapterContent  = normArr(
        project.artifacts?.humanized?.length
          ? project.artifacts.humanized
          : project.artifacts?.chapters
      );
      const chapterData     = outlineChapters[chapterIndex]  || {};
      const chapterContent_ = chapterContent[chapterIndex]   || {};
      const chapterTitle    = chapterContent_?.chapterTitle  || chapterData?.title || `Chapter ${chapterIndex + 1}`;

      if (pictureBook) {
        const spread = normArr(chapterContent_?.spreads)[spreadIndex] || {};

        // FIX 2: global spread index for "Spread N of M"
        const chapterCount_   = getSafeChapterCount(project);
        const spreadsPerChap  = normArr(chapterContent_?.spreads).length || getImagesPerChapter(project.ageRange);
        const totalSpreads    = chapterCount_ * spreadsPerChap;
        const globalIdx       = chapterIndex * spreadsPerChap + spreadIndex;
        const spreadLabel     = `Spread ${globalIdx + 1} of ${totalSpreads}`;
        const crossPageAnchor = masterAnchorRef
          ? buildCrossPageAnchor(masterAnchorRef, spreadLabel)
          : '';

        // FIX 4
        const spreadText = deriveSceneText(spread, chapterData, chapterContent_);

        prompt = buildSpreadPrompt({
          bookTitle,
          spreadText,
          illustrationHint: spread.illustrationHint || chapterData.keyScene || '',
          spreadLabel,
          textPosition:     spread.textPosition || 'bottom',
          ageRange:         project.ageRange,
          characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef, crossPageAnchor,
        });
      } else {
        const crossPageAnchor = masterAnchorRef
          ? buildCrossPageAnchor(masterAnchorRef, `Chapter ${chapterIndex + 1}`)
          : '';
        prompt = buildChapterBookIllustrationPrompt({
          bookTitle, chapterTitle, chapterNumber: chapterIndex + 1,
          chapterIllustrationHint: chapterContent_?.chapterIllustrationHint || chapterData.keyScene || '',
          characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef, crossPageAnchor,
        });
      }
    }
  } else if (task === 'cover') {
    prompt = buildCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef });
  } else if (task === 'back-cover') {
    prompt = buildBackCoverPrompt({ bookTitle, characterLockBlock, poseRefBlock, universeStyle, outfitQuickRef });
  } else {
    prompt = [`Children's Islamic book image for "${bookTitle}".`, NO_BORDER_BLOCK, SINGLE_PANEL].join('\n\n');
  }

  const trId = traceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // FIX 3: generateImageSafe injects negative_prompt
  const result = await generateImageSafe({
    task, prompt, references: refs, style: universeStyle, seed, projectId, traceId: trId,
  });

  // ── Save result ──────────────────────────────────────────────────────────────
  const setFields = {};

  if (task === 'illustration') {
    if (isSpreadOnlyProject(project)) {
      // FIX 8: use imported Project directly (no require())
      const ills        = normArr(project.artifacts?.spreadIllustrations || []);
      const allSpreads  = normArr(project.artifacts?.spreads || []);
      const spread      = allSpreads[spreadIndex] || {};
      const spreadText  = deriveSceneText(spread, {}, {}); // FIX 4
      ills[spreadIndex] = {
        spreadIndex,
        imageUrl:     result.imageUrl,
        prompt,
        text:         spreadText,
        textPosition: spread.textPosition || 'bottom',
        createdAt:    new Date().toISOString(),
      };
      setFields['artifacts.spreadIllustrations'] = ills;
    } else {
      const existing = illustrations[chapterIndex] || {
        chapterNumber: chapterIndex + 1, variants: [], spreads: [], selectedVariantIndex: 0,
      };
      existing.variants = normArr(existing.variants);
      existing.spreads  = normArr(existing.spreads);

      if (isPictureBook(project.ageRange)) {
        const chapterContent_ = normArr(
          project.artifacts?.humanized?.length ? project.artifacts.humanized : project.artifacts?.chapters
        )[chapterIndex] || {};
        const spread     = normArr(chapterContent_?.spreads)[spreadIndex] || {};
        const spreadText = deriveSceneText(spread, {}, chapterContent_); // FIX 4
        existing.spreads[spreadIndex] = {
          spreadIndex, imageUrl: result.imageUrl, prompt, seed: seed || null,
          text: spreadText, textPosition: spread.textPosition || 'bottom',
          illustrationHint: spread.illustrationHint || '',
        };
      } else {
        const vi = existing.variants.length;
        existing.variants.push({ variantIndex: vi, imageUrl: result.imageUrl, prompt, seed: seed || null, selected: vi === 0 });
        if (!existing.selectedVariantIndex) existing.selectedVariantIndex = 0;
      }

      illustrations[chapterIndex] = existing;
      setFields['artifacts.illustrations'] = illustrations;
    }
  } else if (task === 'cover') {
    setFields['artifacts.cover'] = { ...(project.artifacts?.cover || {}), frontUrl: result.imageUrl, frontPrompt: prompt };
  } else if (task === 'back-cover') {
    setFields['artifacts.cover'] = { ...(project.artifacts?.cover || {}), backUrl: result.imageUrl, backPrompt: prompt };
  }

  if (Object.keys(setFields).length) {
    await Project.findByIdAndUpdate(projectId, { $set: setFields });
  }

  return { ...result, prompt, traceId: trId };
}