// server/services/ai/image/image.service.js

import { Project } from '../../../models/Project.js';
import { Universe } from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { NotFoundError } from '../../../errors.js';
import { generateImage } from './image.providers.js';

// ─── Negative prompt ──────────────────────────────────────────────────────────

const BASE_NEGATIVE_PROMPT = [
  'border',
  'frame',
  'decorative frame',
  'vignette frame',
  'scrapbook border',
  'watercolor edges',
  'painted edges',
  'rounded card outline',
  'inner border',
  'outer stroke',
  'comic panel',
  'multiple panels',
  'storyboard',
  'grid layout',
  'text',
  'letters',
  'numbers',
  'caption',
  'watermark',
  'signature',
  'logo',
  'brand mark',
  'extra characters',
  'background people',
  'crowd',
  'silhouette people',
  'duplicate face',
  'duplicate child',
  'extra fingers',
  'deformed hands',
  'face distortion',
  'different outfit',
  'different age',
  'different hairstyle',
  'different hijab color',
  'different skin tone',
].join(', ');

// ─── Array helpers ────────────────────────────────────────────────────────────

export function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];
  const keys = Object.keys(val).map(Number).filter((n) => !Number.isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach((k) => {
    arr[k] = val[k];
  });
  return arr.filter((v) => v != null);
}

// ─── Age mode ────────────────────────────────────────────────────────────────
// < 6   → spreads-only
// 6-8   → picture-book
// 9+    → chapter-book

export function getAgeMode(ageRange) {
  if (!ageRange) return 'picture-book';
  const nums = String(ageRange).match(/\d+/g) || [];
  const first = Number(nums[0] || 8);
  const last = Number(nums[1] || first);
  const avg = (first + last) / 2;

  if (first <= 5) return 'spreads-only';
  if (avg <= 8) return 'picture-book';
  return 'chapter-book';
}

export function isPictureBook(ageRange) {
  const mode = getAgeMode(ageRange);
  return mode === 'picture-book' || mode === 'spreads-only';
}

export function isChapterBook(ageRange) {
  return getAgeMode(ageRange) === 'chapter-book';
}

export function getImagesPerChapter(ageRange) {
  const mode = getAgeMode(ageRange);
  if (mode === 'spreads-only') return 1; // per spread page
  if (mode === 'picture-book') return 2; // more illustrations
  return 2; // age 9+ max 2 illustrations per chapter
}

export function getSafeChapterCount(project) {
  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const rawCount = outlineChapters.length || Number(project.chapterCount) || 4;
  const max = isChapterBook(project.ageRange) ? 10 : 8;
  return Math.max(2, Math.min(rawCount, max));
}

export function isSpreadOnlyProject(project) {
  if (getAgeMode(project.ageRange) === 'spreads-only') return true;
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

// ─── Visual helpers ───────────────────────────────────────────────────────────

const COLOR_WORDS = [
  'white', 'cream', 'beige', 'ivory', 'off-white',
  'black', 'gray', 'grey', 'charcoal',
  'blue', 'navy', 'sky', 'royal', 'teal', 'cyan', 'aqua',
  'green', 'olive', 'mint', 'sage', 'emerald', 'forest',
  'red', 'crimson', 'maroon', 'burgundy', 'rose',
  'pink', 'magenta', 'fuchsia', 'lilac', 'lavender',
  'purple', 'violet', 'indigo', 'plum',
  'orange', 'amber', 'mustard', 'gold', 'yellow', 'lemon',
  'brown', 'tan', 'caramel', 'chocolate', 'khaki',
  'silver', 'bronze', 'copper',
];

function extractOutfitColor(vd = {}) {
  if (vd.outfitColor && vd.outfitColor.trim() && vd.outfitColor !== 'see description') {
    return vd.outfitColor.trim();
  }
  if (vd.primaryColor && vd.primaryColor.trim()) return vd.primaryColor.trim();

  const rules = (vd.outfitRules || '').toLowerCase();
  for (const color of COLOR_WORDS) {
    if (rules.includes(color)) return color;
  }
  return 'as described in outfit rules';
}

function buildProjectStyleLock(project, universeStyle) {
  const bs = project.bookStyle || {};
  return `
STYLE LOCK — MUST stay consistent across the whole book:
• Illustration style: ${universeStyle || bs.artStyle || 'pixar-3d'}
• Color palette: ${bs.colorPalette || 'warm-pastels'}
• Lighting style: ${bs.lightingStyle || 'warm-golden'}
• Background style: ${bs.backgroundStyle || 'mixed'}
• Indoor environment: ${bs.indoorRoomDescription || 'warm cozy room'}
• Outdoor environment: ${bs.outdoorDescription || 'pleasant natural outdoor scene'}
• Islamic decor style: ${bs.islamicDecorStyle || 'subtle'}
• Keep same rendering quality, same character proportions, same visual universe across every image.
`;
}

function describeCharacter(c) {
  if (!c) return '';
  const vd = c.visualDNA || {};
  const mod = c.modestyRules || {};
  const outfitColor = extractOutfitColor(vd);
  const gender = mod.hijabAlways
    ? 'GIRL'
    : (vd.gender?.toUpperCase() ||
      (c.name?.toLowerCase().match(/^(ahmed|omar|ali|hassan|yusuf|ibrahim|adam|zaid|bilal|muhammad|usman)/)
        ? 'BOY'
        : 'GIRL'));

  return [
    `• ${c.name} [${c.role || 'character'}] — ${gender}, age ${c.ageRange || 'child'}`,
    `  Skin tone: ${vd.skinTone || 'N/A'}`,
    `  Eye color: ${vd.eyeColor || 'N/A'}`,
    `  Face shape: ${vd.faceShape || 'N/A'}`,
    `  Hair / hijab: ${vd.hairOrHijab || 'N/A'}`,
    `  Outfit rules: ${vd.outfitRules || 'N/A'}`,
    `  Outfit color lock: ${outfitColor}`,
    `  Accessories: ${vd.accessories || 'none'}`,
    `  Palette notes: ${vd.paletteNotes || 'none'}`,
    mod.hijabAlways ? '  Hijab: ALWAYS visible' : '',
    mod.longSleeves ? '  Long sleeves: ALWAYS' : '',
    mod.looseClothing ? '  Loose clothing: ALWAYS' : '',
    `  Traits: ${(c.traits || []).join(', ') || 'none'}`,
  ].filter(Boolean).join('\n');
}

function buildOutfitQuickRef(characters) {
  if (!characters?.length) return '';
  const lines = characters.map((c) => {
    const vd = c.visualDNA || {};
    const color = extractOutfitColor(vd);
    return `• ${c.name}: ALWAYS wears ${vd.outfitRules || 'their standard modest outfit'} — exact color lock: ${color}`;
  });

  return `
OUTFIT LOCK — NEVER CHANGE:
${lines.join('\n')}
No redesign. No alternate costume. No random color shift.
`;
}

function buildCharacterLockBlock(characters) {
  if (!characters?.length) return '';
  const approvedNames = characters.map((c) => c.name).join(', ');
  const descriptions = characters.map(describeCharacter).join('\n\n');

  return `
CHARACTER IDENTITY LOCK — MUST BE FOLLOWED EXACTLY

Approved characters in this scene:
${approvedNames}

Character details:
${descriptions}

Rules:
• Use ONLY the approved characters needed for this scene
• Do NOT invent extra people
• Do NOT change face shape, age, skin tone, eye color, hairstyle, hijab style, clothing, or body proportions
• Keep the exact same identity across all images
• Keep age appearance constant
• Keep modesty rules constant
• Keep outfit colors constant
• Match reference images exactly while only changing pose, angle, expression, and scene action
`;
}

function buildPoseRefInstruction(characters) {
  const withSheets = characters.filter((c) => c.poseSheetUrl);
  const withPortraits = characters.filter((c) => c.masterReferenceUrl || c.imageUrl);

  if (!withSheets.length && !withPortraits.length) return '';

  return `
REFERENCE IMAGE RULE:
• Use attached character pose sheets / portrait references as hard identity anchors
• Match face, body proportions, clothing, and hijab exactly
• Scene may change, but character identity must remain visually identical
`;
}

function buildCrossPageAnchor(identityRef, label) {
  if (!identityRef) return '';
  return `
MASTER CONSISTENCY ANCHOR
This image is part of "${label}".
Match the master reference exactly:
• same face
• same proportions
• same outfit
• same color palette
• same overall identity
Only the scene, pose, expression, and camera angle may change.
`;
}

const NO_BORDER_BLOCK = `
FRAMING RULES:
• No borders
• No frames
• No card edges
• No vignette borders
• No scrapbook styling
• Full-bleed single illustration only
`;

const SINGLE_PANEL = `
IMAGE FORMAT:
• Single full-bleed illustration
• One scene only
• Not a comic
• Not a storyboard
• Not a multi-panel page
`;

const CLEAN_BACKGROUND = `
BACKGROUND RULES:
• Background should support the story, not overpower the characters
• No clutter
• No extra background people
• Clear readable storytelling composition
`;

function textSafeZone(textPosition) {
  if (!textPosition) return '';
  if (textPosition === 'top' || textPosition === 'overlay-top') {
    return 'Keep TOP 20% visually calm for text placement.';
  }
  if (textPosition === 'bottom' || textPosition === 'overlay-bottom') {
    return 'Keep BOTTOM 20% visually calm for text placement.';
  }
  return '';
}

// ─── Scene character selection ────────────────────────────────────────────────

function getSceneCharacters(allCharacters, names = []) {
  const wanted = new Set((names || []).filter(Boolean));
  if (!wanted.size) return allCharacters;
  return allCharacters.filter((c) => wanted.has(c.name));
}

// ─── Chapter moment selection for age 9+ ─────────────────────────────────────

function normalizeIllustrationMoment(moment, idx, chapterData = {}, chapterContent = {}) {
  if (!moment) {
    return {
      momentTitle: `Moment ${idx + 1}`,
      illustrationHint: chapterData.keyScene || chapterContent.chapterSummary || 'Important emotional chapter moment',
      charactersInScene: chapterData.charactersInScene || [],
      sceneEnvironment: 'mixed',
      timeOfDay: 'day',
    };
  }

  if (typeof moment === 'string') {
    return {
      momentTitle: `Moment ${idx + 1}`,
      illustrationHint: moment,
      charactersInScene: chapterData.charactersInScene || [],
      sceneEnvironment: 'mixed',
      timeOfDay: 'day',
    };
  }

  return {
    momentTitle: moment.momentTitle || `Moment ${idx + 1}`,
    illustrationHint:
      moment.illustrationHint ||
      moment.scene ||
      moment.text ||
      chapterData.keyScene ||
      chapterContent.chapterSummary ||
      'Important emotional chapter moment',
    charactersInScene:
      normArr(moment.charactersInScene || []).length
        ? normArr(moment.charactersInScene)
        : normArr(chapterData.charactersInScene || []),
    sceneEnvironment: moment.sceneEnvironment || 'mixed',
    timeOfDay: moment.timeOfDay || 'day',
  };
}

function getChapterIllustrationMoments(chapterData, chapterContent, ageRange) {
  const maxMoments = getImagesPerChapter(ageRange); // 2 for chapter-book

  const raw =
    normArr(chapterContent?.illustrationMoments) ||
    normArr(chapterData?.illustrationMoments) ||
    [];

  if (raw.length) {
    return raw.slice(0, maxMoments).map((m, i) =>
      normalizeIllustrationMoment(m, i, chapterData, chapterContent)
    );
  }

  const fallback = [
    {
      momentTitle: 'Key scene',
      illustrationHint: chapterData?.keyScene || chapterContent?.chapterSummary || 'Main turning point',
      charactersInScene: chapterData?.charactersInScene || [],
      sceneEnvironment: 'mixed',
      timeOfDay: 'day',
    },
    {
      momentTitle: 'Ending beat',
      illustrationHint:
        chapterData?.endingBeat ||
        chapterContent?.chapterSummary ||
        chapterData?.keyScene ||
        'Meaningful closing chapter moment',
      charactersInScene: chapterData?.charactersInScene || [],
      sceneEnvironment: 'mixed',
      timeOfDay: 'evening',
    },
  ];

  return fallback.slice(0, maxMoments).map((m, i) =>
    normalizeIllustrationMoment(m, i, chapterData, chapterContent)
  );
}

// ─── Scene text derivation ────────────────────────────────────────────────────

function deriveSceneText(spread, chapterData, chapterContent) {
  if (spread?.text?.trim()) return spread.text.trim();
  if (spread?.illustrationHint?.trim()) return spread.illustrationHint.trim();

  const prose = chapterContent?.chapterText || chapterContent?.content || chapterContent?.text || '';
  if (prose.trim()) {
    const sentences = prose.match(/[^.!?]+[.!?]+/g) || [];
    const snippet = sentences.slice(0, 2).join(' ').trim();
    if (snippet) return snippet;
  }

  if (chapterContent?.chapterSummary?.trim()) return chapterContent.chapterSummary.trim();
  if (chapterData?.keyScene?.trim()) return chapterData.keyScene.trim();

  return '';
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSpreadPrompt({
  project,
  bookTitle,
  spreadText,
  illustrationHint,
  spreadLabel,
  textPosition,
  ageRange,
  characterLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
  crossPageAnchor,
}) {
  const first = String(ageRange || '').match(/\d+/)?.[0];
  const minAge = first ? Number(first) : 7;
  const isYoung = minAge <= 6;
  const styleLock = buildProjectStyleLock(project, universeStyle);

  const sceneInstruction = spreadText
    ? `SCENE TO ILLUSTRATE:
Text to match exactly: "${spreadText}"
${illustrationHint ? `Additional scene hint: ${illustrationHint}` : ''}`
    : illustrationHint
      ? `SCENE TO ILLUSTRATE: ${illustrationHint}`
      : 'SCENE: A warm child-friendly Islamic story moment.';

  return [
    `Islamic children's book illustration for "${bookTitle}".`,
    `Page label: ${spreadLabel}.`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    CLEAN_BACKGROUND,
    styleLock,
    outfitQuickRef,
    crossPageAnchor,
    characterLockBlock,
    poseRefBlock,
    sceneInstruction,
    isYoung
      ? 'Composition: very clear, warm, expressive, simple, easy for young children to read visually.'
      : 'Composition: strong storytelling, expressive emotions, clean scene focus.',
    textSafeZone(textPosition),
    `Render style: ${universeStyle || 'pixar-3d'}.`,
    'No text, no letters, no numbers, no watermark anywhere.',
  ].filter(Boolean).join('\n\n');
}

function buildCoverPrompt({
  project,
  bookTitle,
  characterLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
}) {
  const styleLock = buildProjectStyleLock(project, universeStyle);

  return [
    `Front cover illustration for Islamic children's book "${bookTitle}".`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    CLEAN_BACKGROUND,
    styleLock,
    outfitQuickRef,
    characterLockBlock,
    poseRefBlock,
    'Scene: warm, inviting, memorable hero image with the main character(s) in a visually striking but clean composition.',
    'Portrait cover composition, full bleed, polished and cinematic.',
    'No title text, no author text, no watermark, no letters.',
  ].filter(Boolean).join('\n\n');
}

function buildBackCoverPrompt({
  project,
  bookTitle,
  characterLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
}) {
  const styleLock = buildProjectStyleLock(project, universeStyle);

  return [
    `Back cover illustration for Islamic children's book "${bookTitle}".`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    CLEAN_BACKGROUND,
    styleLock,
    outfitQuickRef,
    characterLockBlock,
    poseRefBlock,
    'Scene: peaceful, concluding, calm emotional moment that complements the front cover.',
    'No text, no barcode, no letters, no watermark.',
  ].filter(Boolean).join('\n\n');
}

function buildChapterBookIllustrationPrompt({
  project,
  bookTitle,
  chapterTitle,
  chapterNumber,
  moment,
  characterLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
  crossPageAnchor,
}) {
  const styleLock = buildProjectStyleLock(project, universeStyle);

  return [
    `Islamic middle-grade chapter book illustration for "${bookTitle}".`,
    `Chapter ${chapterNumber}: "${chapterTitle}".`,
    `Illustration moment: ${moment.momentTitle}.`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    styleLock,
    outfitQuickRef,
    crossPageAnchor,
    characterLockBlock,
    poseRefBlock,
    `
SCENE TO ILLUSTRATE:
${moment.illustrationHint}

Scene environment: ${moment.sceneEnvironment || 'mixed'}
Time of day: ${moment.timeOfDay || 'day'}

This should feel like one of the strongest visual moments of the chapter:
• emotionally clear
• cinematic
• detailed
• rich atmosphere
• excellent storytelling composition
`,
    'No text, no letters, no numbers, no watermark.',
  ].filter(Boolean).join('\n\n');
}

function buildCharacterStylePrompt({
  character,
  project,
  selectedStyle,
  outfitQuickRef,
}) {
  const vd = character.visualDNA || {};
  const mod = character.modestyRules || {};
  const outfitColor = extractOutfitColor(vd);
  const styleLock = buildProjectStyleLock(project, selectedStyle);

  const gender = mod.hijabAlways
    ? 'girl'
    : (vd.gender ||
      (character.name?.toLowerCase().match(/^(ahmed|omar|ali|hassan|yusuf|ibrahim|adam|zaid|bilal|muhammad|usman)/)
        ? 'boy'
        : 'girl'));

  return [
    `MASTER CHARACTER REFERENCE PORTRAIT for "${character.name}".`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    CLEAN_BACKGROUND,
    styleLock,
    outfitQuickRef,
    `
CHARACTER REFERENCE — MUST DEFINE FUTURE CONSISTENCY:
• Name: ${character.name}
• Gender: ${gender}
• Age appearance: ${character.ageRange || 'child'}
• Skin tone: ${vd.skinTone || 'warm fair'}
• Eye color: ${vd.eyeColor || 'dark brown'}
• Face shape: ${vd.faceShape || 'round youthful face'}
• Hair or hijab: ${vd.hairOrHijab || 'simple child hairstyle'}
• Outfit: ${vd.outfitRules || 'simple modest Islamic clothing'}
• Outfit color lock: ${outfitColor}
• Accessories: ${vd.accessories || 'none'}
• Palette notes: ${vd.paletteNotes || 'none'}
${mod.hijabAlways ? '• Hijab always visible' : ''}
${mod.longSleeves ? '• Long sleeves always' : ''}
${mod.looseClothing ? '• Loose modest clothing always' : ''}
`,
    `
PORTRAIT GOAL:
• full clear character reference
• strong face visibility
• strong outfit visibility
• warm storybook expression
• clean neutral background
• child-friendly polished render
`,
    'This image will be reused as a hard consistency anchor for all book illustrations.',
    'No text, no letters, no watermark.',
  ].filter(Boolean).join('\n\n');
}

// ─── Reference handling ───────────────────────────────────────────────────────

function buildInitialRefs(characters) {
  const refs = [];

  for (const c of characters) {
    if (c.masterReferenceUrl?.startsWith('https://')) refs.push(c.masterReferenceUrl);
  }
  for (const c of characters) {
    if (c.poseSheetUrl?.startsWith('https://')) refs.push(c.poseSheetUrl);
  }
  for (const c of characters) {
    if (c.imageUrl?.startsWith('https://')) refs.push(c.imageUrl);
  }

  return [...new Set(refs)];
}

function buildReferences(characters, identityRef) {
  const refs = [];
  if (identityRef) refs.push(identityRef);

  for (const c of characters) {
    if (c.masterReferenceUrl?.startsWith('https://')) refs.push(c.masterReferenceUrl);
  }
  for (const c of characters) {
    if (c.poseSheetUrl?.startsWith('https://')) refs.push(c.poseSheetUrl);
  }
  for (const c of characters) {
    if (c.imageUrl?.startsWith('https://')) refs.push(c.imageUrl);
  }

  return [...new Set(refs)];
}

function getMasterAnchorRef(illustrations) {
  const firstChapter = illustrations?.[0];
  if (firstChapter?.spreads?.[0]?.imageUrl) return firstChapter.spreads[0].imageUrl;
  return null;
}

function getCharacterAnchorRef(characters) {
  for (const c of characters) {
    if (c.masterReferenceUrl?.startsWith('https://')) return c.masterReferenceUrl;
  }
  for (const c of characters) {
    if (c.poseSheetUrl?.startsWith('https://')) return c.poseSheetUrl;
  }
  for (const c of characters) {
    if (c.imageUrl?.startsWith('https://')) return c.imageUrl;
  }
  return null;
}

// ─── Provider wrapper ─────────────────────────────────────────────────────────

function generateImageSafe(project, params) {
  const extraNeg = project?.bookStyle?.negativePrompt?.trim();
  const negative_prompt = extraNeg
    ? `${BASE_NEGATIVE_PROMPT}, ${extraNeg}`
    : BASE_NEGATIVE_PROMPT;

  return generateImage({
    ...params,
    negative_prompt,
  });
}

// ─── Full book illustrations ──────────────────────────────────────────────────

export async function generateBookIllustrations({ projectId, userId, style, seed, traceId }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe = project.universeId ? await Universe.findById(project.universeId) : null;
  const allCharacters = await loadUniverseCharacters(project);
  const universeStyle = style || universe?.artStyle || project.bookStyle?.artStyle || 'pixar-3d';

  const bookTitle = project.artifacts?.outline?.bookTitle || project.title;
  let providerUsed = 'unknown';

  let firstIdentityRef =
    getMasterAnchorRef(normArr(project.artifacts?.illustrations)) ||
    getMasterAnchorRef(normArr(project.artifacts?.spreadIllustrations)) ||
    getCharacterAnchorRef(allCharacters);

  // ── Spread-only path (<6) ─────────────────────────────────────────────────
  if (isSpreadOnlyProject(project)) {
    const allSpreads = normArr(project.artifacts?.spreads || []);
    const existingSpreadIlls = normArr(project.artifacts?.spreadIllustrations || []);
    const totalSpreads = allSpreads.length;

    for (let si = 0; si < totalSpreads; si++) {
      if (existingSpreadIlls[si]?.imageUrl) {
        if (!firstIdentityRef) firstIdentityRef = existingSpreadIlls[si].imageUrl;
        continue;
      }

      const spread = allSpreads[si] || {};
      const sceneCharacters = getSceneCharacters(allCharacters, spread.charactersInScene || []);
      const refs = buildReferences(sceneCharacters, firstIdentityRef);

      const spreadLabel = `Spread ${si + 1} of ${totalSpreads}`;
      const crossPageAnchor = buildCrossPageAnchor(firstIdentityRef, spreadLabel);
      const spreadText = deriveSceneText(spread, {}, {});
      const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
      const poseRefBlock = buildPoseRefInstruction(sceneCharacters);
      const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);

      const prompt = buildSpreadPrompt({
        project,
        bookTitle,
        spreadText,
        illustrationHint: spread.illustrationHint || '',
        spreadLabel,
        textPosition: spread.textPosition || 'bottom',
        ageRange: project.ageRange,
        characterLockBlock,
        poseRefBlock,
        universeStyle,
        outfitQuickRef,
        crossPageAnchor,
      });

      const result = await generateImageSafe(project, {
        task: 'illustration',
        prompt,
        references: refs,
        style: universeStyle,
        seed,
        projectId,
        traceId: `${traceId || 'trace'}_s${si}_${Date.now()}`,
      });

      providerUsed = result.provider || providerUsed;

      existingSpreadIlls[si] = {
        spreadIndex: si,
        imageUrl: result.imageUrl,
        prompt,
        text: spreadText,
        textPosition: spread.textPosition || 'bottom',
        illustrationHint: spread.illustrationHint || '',
        createdAt: new Date().toISOString(),
      };

      await Project.findByIdAndUpdate(projectId, {
        $set: { 'artifacts.spreadIllustrations': existingSpreadIlls },
      });

      if (!firstIdentityRef && result.imageUrl) firstIdentityRef = result.imageUrl;
    }

    if (!project.artifacts?.cover?.backUrl) {
      try {
        const refs = buildReferences(allCharacters, firstIdentityRef);
        const characterLockBlock = buildCharacterLockBlock(allCharacters);
        const poseRefBlock = buildPoseRefInstruction(allCharacters);
        const outfitQuickRef = buildOutfitQuickRef(allCharacters);

        const prompt = buildBackCoverPrompt({
          project,
          bookTitle,
          characterLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
        });

        const result = await generateImageSafe(project, {
          task: 'back-cover',
          prompt,
          references: refs,
          style: universeStyle,
          seed,
          projectId,
          traceId: `trace_backcover_${Date.now()}`,
        });

        await Project.findByIdAndUpdate(projectId, {
          $set: {
            'artifacts.cover': {
              ...(project.artifacts?.cover || {}),
              backUrl: result.imageUrl,
              backPrompt: prompt,
            },
          },
        });

        providerUsed = result.provider || providerUsed;
      } catch (err) {
        console.error('[image.service] Back cover failed (non-fatal):', err.message);
      }
    }

    return {
      provider: providerUsed,
      spreadOnly: true,
      spreadCount: allSpreads.length,
    };
  }

  // ── Chapter-based path (6–8 and 9+) ───────────────────────────────────────
  const pictureBook = isPictureBook(project.ageRange);
  const chapterCount = getSafeChapterCount(project);

  const outlineChapters = normArr(project.artifacts?.outline?.chapters);
  const chapterContent = normArr(
    project.artifacts?.humanized?.length
      ? project.artifacts.humanized
      : project.artifacts?.chapters
  );

  const illustrations = normArr(project.artifacts?.illustrations || []);

  for (let ci = 0; ci < chapterCount; ci++) {
    const chapterData = outlineChapters[ci] || {};
    const chapterContent_ = chapterContent[ci] || {};
    const chapterTitle =
      chapterContent_?.chapterTitle ||
      chapterData?.title ||
      `Chapter ${ci + 1}`;

    const existing = illustrations[ci] || {
      chapterNumber: ci + 1,
      spreads: [],
      selectedVariantIndex: 0,
    };

    existing.spreads = normArr(existing.spreads);

    if (pictureBook) {
      const spreads = normArr(chapterContent_?.spreads);
      const imagesPerChapter = getImagesPerChapter(project.ageRange);

      const targetSpreads =
        spreads.length > 0
          ? spreads.slice(0, imagesPerChapter)
          : Array.from({ length: imagesPerChapter }, (_, i) => ({
              spreadIndex: i,
              text: '',
              illustrationHint: chapterData.keyScene || '',
              textPosition: 'bottom',
              charactersInScene: chapterData.charactersInScene || [],
            }));

      for (let si = existing.spreads.length; si < targetSpreads.length; si++) {
        const spread = targetSpreads[si] || {};
        const sceneCharacters = getSceneCharacters(allCharacters, spread.charactersInScene || chapterData.charactersInScene || []);
        const refs = buildReferences(sceneCharacters, firstIdentityRef);

        const totalBookSpreads = chapterCount * targetSpreads.length;
        const globalSpreadIdx = ci * targetSpreads.length + si;
        const spreadLabel = `Spread ${globalSpreadIdx + 1} of ${totalBookSpreads}`;

        const crossPageAnchor = buildCrossPageAnchor(firstIdentityRef, spreadLabel);
        const spreadText = deriveSceneText(spread, chapterData, chapterContent_);
        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseRefBlock = buildPoseRefInstruction(sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);

        const prompt = buildSpreadPrompt({
          project,
          bookTitle,
          spreadText,
          illustrationHint: spread.illustrationHint || chapterData.keyScene || '',
          spreadLabel,
          textPosition: spread.textPosition || 'bottom',
          ageRange: project.ageRange,
          characterLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossPageAnchor,
        });

        const result = await generateImageSafe(project, {
          task: 'illustration',
          prompt,
          references: refs,
          style: universeStyle,
          seed,
          projectId,
          traceId: `trace_${Date.now()}_ch${ci}_s${si}_${Math.random().toString(36).slice(2, 8)}`,
        });

        providerUsed = result.provider || providerUsed;

        existing.spreads[si] = {
          spreadIndex: si,
          imageUrl: result.imageUrl,
          prompt,
          seed: seed || null,
          text: spreadText,
          textPosition: spread.textPosition || 'bottom',
          illustrationHint: spread.illustrationHint || '',
        };

        if (!firstIdentityRef && result.imageUrl) firstIdentityRef = result.imageUrl;
      }
    } else {
      // age 9+ → max 2 best illustration moments per chapter
      const moments = getChapterIllustrationMoments(chapterData, chapterContent_, project.ageRange);

      for (let si = existing.spreads.length; si < moments.length; si++) {
        const moment = moments[si];
        const sceneCharacters = getSceneCharacters(allCharacters, moment.charactersInScene || chapterData.charactersInScene || []);
        const refs = buildReferences(sceneCharacters, firstIdentityRef);

        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseRefBlock = buildPoseRefInstruction(sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
        const crossPageAnchor = buildCrossPageAnchor(firstIdentityRef, `Chapter ${ci + 1} · Moment ${si + 1}`);

        const prompt = buildChapterBookIllustrationPrompt({
          project,
          bookTitle,
          chapterTitle,
          chapterNumber: ci + 1,
          moment,
          characterLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossPageAnchor,
        });

        const result = await generateImageSafe(project, {
          task: 'illustration',
          prompt,
          references: refs,
          style: universeStyle,
          seed,
          projectId,
          traceId: `trace_${Date.now()}_ch${ci}_m${si}_${Math.random().toString(36).slice(2, 8)}`,
        });

        providerUsed = result.provider || providerUsed;

        existing.spreads[si] = {
          spreadIndex: si,
          imageUrl: result.imageUrl,
          prompt,
          seed: seed || null,
          illustrationHint: moment.illustrationHint,
          momentTitle: moment.momentTitle,
          charactersInScene: moment.charactersInScene || [],
          sceneEnvironment: moment.sceneEnvironment || 'mixed',
          timeOfDay: moment.timeOfDay || 'day',
        };

        if (!firstIdentityRef && result.imageUrl) firstIdentityRef = result.imageUrl;
      }
    }

    existing.selectedVariantIndex = 0;
    illustrations[ci] = existing;
  }

  await Project.findByIdAndUpdate(projectId, {
    $set: {
      'artifacts.illustrations': illustrations,
      currentStage: 'illustrations',
    },
  });

  if (!project.artifacts?.cover?.backUrl) {
    try {
      const refs = buildReferences(allCharacters, firstIdentityRef);
      const characterLockBlock = buildCharacterLockBlock(allCharacters);
      const poseRefBlock = buildPoseRefInstruction(allCharacters);
      const outfitQuickRef = buildOutfitQuickRef(allCharacters);

      const prompt = buildBackCoverPrompt({
        project,
        bookTitle,
        characterLockBlock,
        poseRefBlock,
        universeStyle,
        outfitQuickRef,
      });

      const result = await generateImageSafe(project, {
        task: 'back-cover',
        prompt,
        references: refs,
        style: universeStyle,
        seed,
        projectId,
        traceId: `trace_backcover_${Date.now()}`,
      });

      await Project.findByIdAndUpdate(projectId, {
        $set: {
          'artifacts.cover': {
            ...(project.artifacts?.cover || {}),
            backUrl: result.imageUrl,
            backPrompt: prompt,
          },
        },
      });

      providerUsed = result.provider || providerUsed;
    } catch (err) {
      console.error('[image.service] Back cover failed (non-fatal):', err.message);
    }
  }

  return {
    provider: providerUsed,
    illustrations,
    pictureBook,
    chapterCount,
  };
}

// ─── Single image generation ──────────────────────────────────────────────────

export async function generateStageImage({
  task,
  chapterIndex = 0,
  spreadIndex = 0,
  projectId,
  userId,
  customPrompt,
  seed,
  style,
  traceId,
  characterId,
}) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe = project.universeId ? await Universe.findById(project.universeId) : null;
  const allCharacters = await loadUniverseCharacters(project);
  const universeStyle = style || universe?.artStyle || project.bookStyle?.artStyle || 'pixar-3d';

  const bookTitle = project.artifacts?.outline?.bookTitle || project.title;

  const spreadIllustrations = normArr(project.artifacts?.spreadIllustrations || []);
  const illustrations = normArr(project.artifacts?.illustrations || []);

  const masterAnchorRef =
    spreadIllustrations[0]?.imageUrl ||
    getMasterAnchorRef(illustrations) ||
    getCharacterAnchorRef(allCharacters);

  let prompt;
  let refs = buildReferences(allCharacters, masterAnchorRef);

  if (customPrompt) {
    prompt = customPrompt.includes('FRAMING RULES')
      ? customPrompt
      : `${NO_BORDER_BLOCK}\n\n${customPrompt}`;
  } else if (task === 'illustration') {
    if (isSpreadOnlyProject(project)) {
      const allSpreads = normArr(project.artifacts?.spreads || []);
      const totalSpreads = allSpreads.length;
      const spread = allSpreads[spreadIndex] || {};
      const spreadLabel = `Spread ${spreadIndex + 1} of ${totalSpreads}`;
      const spreadText = deriveSceneText(spread, {}, {});
      const sceneCharacters = getSceneCharacters(allCharacters, spread.charactersInScene || []);
      const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
      const poseRefBlock = buildPoseRefInstruction(sceneCharacters);
      const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
      const crossPageAnchor = buildCrossPageAnchor(masterAnchorRef, spreadLabel);

      refs = buildReferences(sceneCharacters, masterAnchorRef);

      prompt = buildSpreadPrompt({
        project,
        bookTitle,
        spreadText,
        illustrationHint: spread.illustrationHint || '',
        spreadLabel,
        textPosition: spread.textPosition || 'bottom',
        ageRange: project.ageRange,
        characterLockBlock,
        poseRefBlock,
        universeStyle,
        outfitQuickRef,
        crossPageAnchor,
      });
    } else {
      const pictureBook = isPictureBook(project.ageRange);
      const outlineChapters = normArr(project.artifacts?.outline?.chapters);
      const chapterContent = normArr(
        project.artifacts?.humanized?.length
          ? project.artifacts.humanized
          : project.artifacts?.chapters
      );

      const chapterData = outlineChapters[chapterIndex] || {};
      const chapterContent_ = chapterContent[chapterIndex] || {};
      const chapterTitle =
        chapterContent_?.chapterTitle ||
        chapterData?.title ||
        `Chapter ${chapterIndex + 1}`;

      if (pictureBook) {
        const chapterSpreads = normArr(chapterContent_?.spreads);
        const spreadsPerChapter = chapterSpreads.length || getImagesPerChapter(project.ageRange);
        const totalSpreads = getSafeChapterCount(project) * spreadsPerChapter;
        const globalIdx = chapterIndex * spreadsPerChapter + spreadIndex;
        const spreadLabel = `Spread ${globalIdx + 1} of ${totalSpreads}`;
        const spread = chapterSpreads[spreadIndex] || {};
        const spreadText = deriveSceneText(spread, chapterData, chapterContent_);
        const sceneCharacters = getSceneCharacters(allCharacters, spread.charactersInScene || chapterData.charactersInScene || []);
        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseRefBlock = buildPoseRefInstruction(sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
        const crossPageAnchor = buildCrossPageAnchor(masterAnchorRef, spreadLabel);

        refs = buildReferences(sceneCharacters, masterAnchorRef);

        prompt = buildSpreadPrompt({
          project,
          bookTitle,
          spreadText,
          illustrationHint: spread.illustrationHint || chapterData.keyScene || '',
          spreadLabel,
          textPosition: spread.textPosition || 'bottom',
          ageRange: project.ageRange,
          characterLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossPageAnchor,
        });
      } else {
        const moments = getChapterIllustrationMoments(chapterData, chapterContent_, project.ageRange);
        const moment = moments[spreadIndex] || moments[0];
        const sceneCharacters = getSceneCharacters(allCharacters, moment.charactersInScene || chapterData.charactersInScene || []);
        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseRefBlock = buildPoseRefInstruction(sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
        const crossPageAnchor = buildCrossPageAnchor(
          masterAnchorRef,
          `Chapter ${chapterIndex + 1} · Moment ${spreadIndex + 1}`
        );

        refs = buildReferences(sceneCharacters, masterAnchorRef);

        prompt = buildChapterBookIllustrationPrompt({
          project,
          bookTitle,
          chapterTitle,
          chapterNumber: chapterIndex + 1,
          moment,
          characterLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossPageAnchor,
        });
      }
    }
  } else if (task === 'cover') {
    const characterLockBlock = buildCharacterLockBlock(allCharacters);
    const poseRefBlock = buildPoseRefInstruction(allCharacters);
    const outfitQuickRef = buildOutfitQuickRef(allCharacters);

    prompt = buildCoverPrompt({
      project,
      bookTitle,
      characterLockBlock,
      poseRefBlock,
      universeStyle,
      outfitQuickRef,
    });
  } else if (task === 'back-cover') {
    const characterLockBlock = buildCharacterLockBlock(allCharacters);
    const poseRefBlock = buildPoseRefInstruction(allCharacters);
    const outfitQuickRef = buildOutfitQuickRef(allCharacters);

    prompt = buildBackCoverPrompt({
      project,
      bookTitle,
      characterLockBlock,
      poseRefBlock,
      universeStyle,
      outfitQuickRef,
    });
  } else if (task === 'character-style') {
    let character = null;

    if (characterId) {
      character = await Character.findById(characterId);
    } else {
      character = allCharacters[0] || null;
    }

    if (!character) {
      throw Object.assign(new Error('No character found for character-style task'), {
        code: 'CHARACTER_NOT_FOUND',
      });
    }

    refs = buildInitialRefs([character]);
    const selectedStyle = style || 'pixar-3d';
    const charOutfitRef = buildOutfitQuickRef([character]);

    prompt = buildCharacterStylePrompt({
      character,
      project,
      selectedStyle,
      outfitQuickRef: charOutfitRef,
    });
  } else {
    throw Object.assign(
      new Error(`Unknown image task: "${task}". Valid tasks: illustration, illustrations, cover, back-cover, character-style`),
      { code: 'UNKNOWN_TASK' }
    );
  }

  const trId = traceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const result = await generateImageSafe(project, {
    task: task === 'character-style' ? 'portrait' : task,
    prompt,
    references: refs,
    style: universeStyle,
    seed,
    projectId,
    traceId: trId,
  });

  const setFields = {};

  if (task === 'character-style') {
    const targetCharId = characterId || allCharacters[0]?._id;
    if (targetCharId && result.imageUrl) {
      await Character.findByIdAndUpdate(targetCharId, {
        $set: {
          masterReferenceUrl: result.imageUrl,
          selectedStyle: style || 'pixar-3d',
          styleApprovedAt: new Date().toISOString(),
          status: 'generated',
        },
      });
    }
    return { ...result, prompt, traceId: trId, masterReferenceUrl: result.imageUrl };
  }

  if (task === 'illustration') {
    if (isSpreadOnlyProject(project)) {
      const ills = normArr(project.artifacts?.spreadIllustrations || []);
      const allSpreads = normArr(project.artifacts?.spreads || []);
      const spread = allSpreads[spreadIndex] || {};
      const spreadText = deriveSceneText(spread, {}, {});

      ills[spreadIndex] = {
        spreadIndex,
        imageUrl: result.imageUrl,
        prompt,
        text: spreadText,
        textPosition: spread.textPosition || 'bottom',
        createdAt: new Date().toISOString(),
      };

      setFields['artifacts.spreadIllustrations'] = ills;
    } else {
      const existing = illustrations[chapterIndex] || {
        chapterNumber: chapterIndex + 1,
        spreads: [],
        selectedVariantIndex: 0,
      };

      existing.spreads = normArr(existing.spreads);
      existing.spreads[spreadIndex] = {
        ...(existing.spreads[spreadIndex] || {}),
        spreadIndex,
        imageUrl: result.imageUrl,
        prompt,
        seed: seed || null,
        createdAt: new Date().toISOString(),
      };

      illustrations[chapterIndex] = existing;
      setFields['artifacts.illustrations'] = illustrations;
    }
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

  return { ...result, prompt, traceId: trId };
}