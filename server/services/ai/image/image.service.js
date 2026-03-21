import { Project } from '../../../models/Project.js';
import { Universe } from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { NotFoundError } from '../../../errors.js';
import { generateImage } from './image.providers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Negative prompt
// ─────────────────────────────────────────────────────────────────────────────

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
  'different face shape',
  'different nose',
  'different eye color',
  'different body proportions',
].join(', ');

// ─────────────────────────────────────────────────────────────────────────────
// Basic helpers
// ─────────────────────────────────────────────────────────────────────────────

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

function safeStr(v) {
  return v == null ? '' : String(v).trim();
}

function uniqueStrings(arr = []) {
  return [...new Set(arr.filter(Boolean).map((x) => String(x).trim()).filter(Boolean))];
}

function startsWithHttp(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Age mode
// ─────────────────────────────────────────────────────────────────────────────

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
  if (mode === 'spreads-only') return 1;
  if (mode === 'picture-book') return 2;
  return 2; // 9+ => max 2 illustrations per chapter
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

// ─────────────────────────────────────────────────────────────────────────────
// Character loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadUniverseCharacters(project) {
  if (!project) return [];

  // Prefer explicit project characters
  if (project.characterIds?.length) {
    return Character.find({
      _id: { $in: project.characterIds },
      status: { $in: ['approved', 'generated'] },
    }).sort({ updatedAt: -1 });
  }

  if (project.universeId) {
    return Character.find({
      universeId: project.universeId,
      status: { $in: ['approved', 'generated'] },
    }).sort({ updatedAt: -1 });
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual DNA helpers
// ─────────────────────────────────────────────────────────────────────────────

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
  const direct =
    vd.topGarmentColor ||
    vd.bottomGarmentColor ||
    vd.hijabColor ||
    vd.primaryColor ||
    vd.outfitColor;

  if (safeStr(direct)) return safeStr(direct);

  const rules = safeStr(vd.outfitRules).toLowerCase();
  for (const color of COLOR_WORDS) {
    if (rules.includes(color)) return color;
  }

  return 'locked-from-visual-dna';
}

function formatAccessories(vd = {}) {
  if (Array.isArray(vd.accessories)) return vd.accessories.join(', ') || 'none';
  return safeStr(vd.accessories) || 'none';
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
• Keep same rendering quality, same shading language, same proportions, same visual universe in every image.
`.trim();
}

function describeCharacter(c) {
  if (!c) return '';

  const vd = c.visualDNA || {};
  const mod = c.modestyRules || {};
  const outfitColor = extractOutfitColor(vd);

  const gender = mod.hijabAlways
    ? 'GIRL'
    : (safeStr(vd.gender).toUpperCase() || 'CHILD');

  return [
    `• ${c.name} [${c.role || 'character'}] — ${gender}, age ${c.ageRange || 'child'}`,
    `  Skin tone: ${safeStr(vd.skinTone) || 'N/A'}`,
    `  Eye color: ${safeStr(vd.eyeColor) || 'N/A'}`,
    `  Face shape: ${safeStr(vd.faceShape) || 'N/A'}`,
    `  Eyebrow style: ${safeStr(vd.eyebrowStyle) || 'N/A'}`,
    `  Nose style: ${safeStr(vd.noseStyle) || 'N/A'}`,
    `  Cheek style: ${safeStr(vd.cheekStyle) || 'N/A'}`,
    `  Hair style: ${safeStr(vd.hairStyle) || 'N/A'}`,
    `  Hair color: ${safeStr(vd.hairColor) || 'N/A'}`,
    `  Hair visibility: ${safeStr(vd.hairVisibility) || 'N/A'}`,
    `  Hijab style: ${safeStr(vd.hijabStyle) || 'N/A'}`,
    `  Hijab color: ${safeStr(vd.hijabColor) || 'N/A'}`,
    `  Top garment: ${safeStr(vd.topGarmentType) || 'N/A'} (${safeStr(vd.topGarmentColor) || 'N/A'})`,
    `  Top garment details: ${safeStr(vd.topGarmentDetails) || 'N/A'}`,
    `  Bottom garment: ${safeStr(vd.bottomGarmentType) || 'N/A'} (${safeStr(vd.bottomGarmentColor) || 'N/A'})`,
    `  Shoes: ${safeStr(vd.shoeType) || 'N/A'} (${safeStr(vd.shoeColor) || 'N/A'})`,
    `  Outfit rules: ${safeStr(vd.outfitRules) || 'N/A'}`,
    `  Outfit color lock: ${outfitColor}`,
    `  Body build: ${safeStr(vd.bodyBuild) || 'N/A'}`,
    `  Height feel: ${safeStr(vd.heightFeel) || 'N/A'}`,
    `  Accessories: ${formatAccessories(vd)}`,
    `  Palette notes: ${safeStr(vd.paletteNotes) || 'none'}`,
    mod.hijabAlways ? `  Hijab: ALWAYS visible` : '',
    mod.longSleeves ? `  Long sleeves: ALWAYS` : '',
    mod.looseClothing ? `  Loose clothing: ALWAYS` : '',
    `  Traits: ${(c.traits || []).join(', ') || 'none'}`,
  ].filter(Boolean).join('\n');
}

function buildOutfitQuickRef(characters) {
  if (!characters?.length) return '';

  const lines = characters.map((c) => {
    const vd = c.visualDNA || {};
    return [
      `• ${c.name}:`,
      `  - Top: ${safeStr(vd.topGarmentType) || 'N/A'} (${safeStr(vd.topGarmentColor) || 'N/A'})`,
      `  - Bottom: ${safeStr(vd.bottomGarmentType) || 'N/A'} (${safeStr(vd.bottomGarmentColor) || 'N/A'})`,
      `  - Shoes: ${safeStr(vd.shoeType) || 'N/A'} (${safeStr(vd.shoeColor) || 'N/A'})`,
      `  - Hijab: ${safeStr(vd.hijabStyle) || 'none'} (${safeStr(vd.hijabColor) || 'N/A'})`,
      `  - Hair: ${safeStr(vd.hairStyle) || 'N/A'} (${safeStr(vd.hairColor) || 'N/A'})`,
    ].join('\n');
  });

  return `
OUTFIT LOCK — ABSOLUTE
${lines.join('\n')}
Rules:
• NEVER redesign clothing
• NEVER change colors
• NEVER replace garments
• NEVER add random accessories
`.trim();
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
• Do NOT add background people, silhouettes, crowd, or duplicates
• Keep exact same face, age appearance, skin tone, eye color, hair/hijab, outfit, colors, and body proportions
• Match references exactly while only changing pose, angle, expression, and action
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pose helpers
// ─────────────────────────────────────────────────────────────────────────────

const POSE_ALIAS_MAP = {
  intro: 'standing',
  neutral: 'standing',
  standing: 'standing',
  sit: 'sitting',
  sitting: 'sitting',
  read: 'reading-quran',
  reading: 'reading-quran',
  quran: 'reading-quran',
  prayer: 'praying-salah',
  salah: 'praying-salah',
  praying: 'praying-salah',
  walk: 'walking',
  walking: 'walking',
  journey: 'walking',
  run: 'running',
  running: 'running',
  action: 'running',
  chase: 'running',
  wave: 'waving',
  greeting: 'waving',
  think: 'thinking',
  thinking: 'thinking',
  reflection: 'thinking',
  decision: 'thinking',
  laugh: 'laughing',
  laughing: 'laughing',
  joy: 'laughing',
  sad: 'sad',
  loss: 'sad',
  mistake: 'sad',
  surprise: 'surprised',
  surprised: 'surprised',
  discovery: 'surprised',
  kneeling: 'kneeling',
  gentle: 'kneeling',
  'gentle-action': 'kneeling',
};

function normalizePoseKey(value = '') {
  const raw = safeStr(value).toLowerCase();
  if (!raw) return '';
  return POSE_ALIAS_MAP[raw] || raw;
}

function inferPoseCandidates({ spread = {}, moment = {}, chapterData = {} }) {
  const candidates = [];

  const directPose =
    spread.poseKey ||
    moment.poseKey ||
    chapterData.poseKey;

  if (directPose) candidates.push(normalizePoseKey(directPose));

  const sceneBits = [
    safeStr(spread.illustrationHint),
    safeStr(spread.text),
    safeStr(moment.illustrationHint),
    safeStr(moment.momentTitle),
    safeStr(chapterData.keyScene),
    safeStr(chapterData.endingBeat),
  ]
    .join(' ')
    .toLowerCase();

  if (sceneBits.includes('wave') || sceneBits.includes('greet')) candidates.push('waving');
  if (sceneBits.includes('run') || sceneBits.includes('rush') || sceneBits.includes('chase')) candidates.push('running');
  if (sceneBits.includes('walk') || sceneBits.includes('journey') || sceneBits.includes('hallway')) candidates.push('walking');
  if (sceneBits.includes('sit') || sceneBits.includes('seated')) candidates.push('sitting');
  if (sceneBits.includes('pray') || sceneBits.includes('salah')) candidates.push('praying-salah');
  if (sceneBits.includes('quran') || sceneBits.includes('read')) candidates.push('reading-quran');
  if (sceneBits.includes('think') || sceneBits.includes('wonder') || sceneBits.includes('decide') || sceneBits.includes('reflect')) candidates.push('thinking');
  if (sceneBits.includes('laugh') || sceneBits.includes('smile') || sceneBits.includes('joy')) candidates.push('laughing');
  if (sceneBits.includes('sad') || sceneBits.includes('cry') || sceneBits.includes('regret') || sceneBits.includes('mistake')) candidates.push('sad');
  if (sceneBits.includes('surprise') || sceneBits.includes('discover') || sceneBits.includes('suddenly')) candidates.push('surprised');
  if (sceneBits.includes('kneel')) candidates.push('kneeling');

  candidates.push('standing');

  return uniqueStrings(candidates.map(normalizePoseKey));
}

function getApprovedPosesForCharacter(character) {
  const poses = normArr(character.poseLibrary || []);
  const approvedKeys = new Set(uniqueStrings(character.approvedPoseKeys || []));

  const approved = poses.filter((p) => {
    const key = normalizePoseKey(p.poseKey);
    return p.approved !== false && (!approvedKeys.size || approvedKeys.has(key));
  });

  return approved.length ? approved : poses;
}

function selectBestPoseForCharacter(character, context = {}) {
  const approved = getApprovedPosesForCharacter(character);
  const candidates = inferPoseCandidates(context);

  for (const wanted of candidates) {
    const exact = approved.find((p) => normalizePoseKey(p.poseKey) === wanted && startsWithHttp(p.imageUrl));
    if (exact) return exact;
  }

  for (const wanted of candidates) {
    const useForScenes = approved.find((p) =>
      normArr(p.useForScenes || []).map(normalizePoseKey).includes(wanted) && startsWithHttp(p.imageUrl)
    );
    if (useForScenes) return useForScenes;
  }

  const firstWithImage = approved.find((p) => startsWithHttp(p.imageUrl));
  if (firstWithImage) return firstWithImage;

  const firstApproved = approved[0] || null;
  return firstApproved;
}

function buildPoseLockBlock(selectedPoses = []) {
  if (!selectedPoses.length) return '';

  return `
POSE LOCK — MUST FOLLOW EXACTLY
${selectedPoses.map((p) => `• ${p.characterName}: use approved pose "${p.poseKey}" (${p.label || p.poseKey})`).join('\n')}
Rules:
• Match body posture from approved pose reference
• Do NOT invent random body positions
• Only minor camera-angle adjustment is allowed
`.trim();
}

function buildPoseRefInstruction(selectedPoses = [], characters = []) {
  const hasPortraits = characters.some((c) => startsWithHttp(c.masterReferenceUrl || c.imageUrl));
  const hasPoseImages = selectedPoses.some((p) => startsWithHttp(p.imageUrl));
  const hasSheets = characters.some((c) => startsWithHttp(c.poseSheetUrl));

  if (!hasPortraits && !hasPoseImages && !hasSheets) return '';

  const poseLines = selectedPoses
    .filter((p) => startsWithHttp(p.imageUrl))
    .map((p) => `• ${p.characterName}: approved pose image for "${p.poseKey}" is attached`)
    .join('\n');

  return `
REFERENCE IMAGE RULE:
• Use attached master portrait references as hard identity anchors
• Use attached approved pose images as hard body-position anchors
• Use pose sheet only as fallback support, not as primary identity source
• Match face, body proportions, clothing, hijab/hair, and pose exactly

${poseLines || ''}
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-page anchor
// ─────────────────────────────────────────────────────────────────────────────

function buildCrossPageAnchor(label, sceneCharacters = []) {
  const names = sceneCharacters.map((c) => c.name).join(', ');
  return `
MASTER CONSISTENCY ANCHOR
This image belongs to "${label}".
Keep these characters visually identical across the whole book: ${names || 'scene characters'}.
Only scene, camera angle, and facial expression may change.
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene helpers
// ─────────────────────────────────────────────────────────────────────────────

const NO_BORDER_BLOCK = `
FRAMING RULES:
• No borders
• No frames
• No card edges
• No vignette borders
• No scrapbook styling
• Full-bleed single illustration only
`.trim();

const SINGLE_PANEL = `
IMAGE FORMAT:
• Single full-bleed illustration
• One scene only
• Not a comic
• Not a storyboard
• Not a multi-panel page
`.trim();

const CLEAN_BACKGROUND = `
BACKGROUND RULES:
• Background should support the story, not overpower the characters
• No clutter
• No extra background people
• Clear, readable storytelling composition
• Simple clean composition preferred over dramatic complexity
`.trim();

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

function normalizeName(value) {
  return safeStr(value).toLowerCase();
}

function getSceneCharacters(allCharacters, names = []) {
  const wanted = uniqueStrings(names).map(normalizeName);
  if (!wanted.length) return allCharacters;

  const wantedSet = new Set(wanted);

  return allCharacters.filter((c) => {
    const byName = normalizeName(c.name);
    const byId = normalizeName(c._id);
    const byId2 = normalizeName(c.id);
    return wantedSet.has(byName) || wantedSet.has(byId) || wantedSet.has(byId2);
  });
}

function buildSceneSelection(allCharacters, context = {}) {
  const sceneCharacters = getSceneCharacters(
    allCharacters,
    context.names || context.charactersInScene || []
  );

  const selectedPoses = sceneCharacters.map((character) => {
    const pose = selectBestPoseForCharacter(character, context);
    return {
      characterId: String(character._id),
      characterName: character.name,
      poseKey: pose?.poseKey || 'standing',
      label: pose?.label || pose?.poseKey || 'standing',
      prompt: pose?.prompt || '',
      imageUrl: pose?.imageUrl || '',
      sourceSheetUrl: pose?.sourceSheetUrl || '',
    };
  });

  return { sceneCharacters, selectedPoses };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapter moment helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeIllustrationMoment(moment, idx, chapterData = {}, chapterContent = {}) {
  if (!moment) {
    return {
      momentTitle: `Moment ${idx + 1}`,
      illustrationHint: chapterData.keyScene || chapterContent.chapterSummary || 'Important emotional chapter moment',
      charactersInScene: normArr(chapterData.charactersInScene || []),
      sceneEnvironment: 'mixed',
      timeOfDay: 'day',
      poseKey: '',
    };
  }

  if (typeof moment === 'string') {
    return {
      momentTitle: `Moment ${idx + 1}`,
      illustrationHint: moment,
      charactersInScene: normArr(chapterData.charactersInScene || []),
      sceneEnvironment: 'mixed',
      timeOfDay: 'day',
      poseKey: '',
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
    poseKey: moment.poseKey || '',
  };
}

function getChapterIllustrationMoments(chapterData, chapterContent, ageRange) {
  const maxMoments = getImagesPerChapter(ageRange);

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
      charactersInScene: normArr(chapterData?.charactersInScene || []),
      sceneEnvironment: 'mixed',
      timeOfDay: 'day',
      poseKey: '',
    },
    {
      momentTitle: 'Ending beat',
      illustrationHint:
        chapterData?.endingBeat ||
        chapterContent?.chapterSummary ||
        chapterData?.keyScene ||
        'Meaningful closing chapter moment',
      charactersInScene: normArr(chapterData?.charactersInScene || []),
      sceneEnvironment: 'mixed',
      timeOfDay: 'evening',
      poseKey: '',
    },
  ];

  return fallback.slice(0, maxMoments).map((m, i) =>
    normalizeIllustrationMoment(m, i, chapterData, chapterContent)
  );
}

function deriveSceneText(spread, chapterData, chapterContent) {
  if (safeStr(spread?.text)) return safeStr(spread.text);
  if (safeStr(spread?.illustrationHint)) return safeStr(spread.illustrationHint);

  const prose =
    safeStr(chapterContent?.chapterText) ||
    safeStr(chapterContent?.content) ||
    safeStr(chapterContent?.text);

  if (prose) {
    const sentences = prose.match(/[^.!?]+[.!?]+/g) || [];
    const snippet = sentences.slice(0, 2).join(' ').trim();
    if (snippet) return snippet;
  }

  if (safeStr(chapterContent?.chapterSummary)) return safeStr(chapterContent.chapterSummary);
  if (safeStr(chapterData?.keyScene)) return safeStr(chapterData.keyScene);

  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────────────────────

function buildSpreadPrompt({
  project,
  bookTitle,
  spreadText,
  illustrationHint,
  spreadLabel,
  textPosition,
  ageRange,
  characterLockBlock,
  poseLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
  crossPageAnchor,
  sceneCharacters,
}) {
  const first = String(ageRange || '').match(/\d+/)?.[0];
  const minAge = first ? Number(first) : 7;
  const isYoung = minAge <= 6;
  const styleLock = buildProjectStyleLock(project, universeStyle);
  const allowedNames = sceneCharacters.map((c) => c.name).join(', ');

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
    poseLockBlock,
    poseRefBlock,
    `Only these characters may appear: ${allowedNames || 'scene characters only'}.`,
    sceneInstruction,
    isYoung
      ? 'Composition: very clear, warm, expressive, simple, easy for young children to read visually.'
      : 'Composition: simple clear composition, focus on characters, minimal distractions, readable storytelling.',
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
  sceneCharacters,
}) {
  const styleLock = buildProjectStyleLock(project, universeStyle);
  const allowedNames = sceneCharacters.map((c) => c.name).join(', ');

  return [
    `Front cover illustration for Islamic children's book "${bookTitle}".`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    CLEAN_BACKGROUND,
    styleLock,
    outfitQuickRef,
    characterLockBlock,
    poseRefBlock,
    `Only these characters may appear: ${allowedNames || 'main characters only'}.`,
    'Scene: warm, inviting, memorable hero image with the main character(s) in a clean strong composition.',
    'Portrait cover composition, full bleed, polished and consistent.',
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
  sceneCharacters,
}) {
  const styleLock = buildProjectStyleLock(project, universeStyle);
  const allowedNames = sceneCharacters.map((c) => c.name).join(', ');

  return [
    `Back cover illustration for Islamic children's book "${bookTitle}".`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    CLEAN_BACKGROUND,
    styleLock,
    outfitQuickRef,
    characterLockBlock,
    poseRefBlock,
    `Only these characters may appear: ${allowedNames || 'main characters only'}.`,
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
  poseLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
  crossPageAnchor,
  sceneCharacters,
}) {
  const styleLock = buildProjectStyleLock(project, universeStyle);
  const allowedNames = sceneCharacters.map((c) => c.name).join(', ');

  return [
    `Islamic middle-grade chapter book illustration for "${bookTitle}".`,
    `Chapter ${chapterNumber}: "${chapterTitle}".`,
    `Illustration moment: ${moment.momentTitle}.`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    CLEAN_BACKGROUND,
    styleLock,
    outfitQuickRef,
    crossPageAnchor,
    characterLockBlock,
    poseLockBlock,
    poseRefBlock,
    `Only these characters may appear: ${allowedNames || 'scene characters only'}.`,
    `
SCENE TO ILLUSTRATE:
${moment.illustrationHint}

Scene environment: ${moment.sceneEnvironment || 'mixed'}
Time of day: ${moment.timeOfDay || 'day'}

Visual goal:
• emotionally clear
• simple readable composition
• strong character focus
• minimal distractions
• rich but controlled atmosphere
`.trim(),
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
    : (safeStr(vd.gender) || 'child');

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
• Skin tone: ${safeStr(vd.skinTone) || 'N/A'}
• Eye color: ${safeStr(vd.eyeColor) || 'N/A'}
• Face shape: ${safeStr(vd.faceShape) || 'N/A'}
• Eyebrow style: ${safeStr(vd.eyebrowStyle) || 'N/A'}
• Nose style: ${safeStr(vd.noseStyle) || 'N/A'}
• Cheek style: ${safeStr(vd.cheekStyle) || 'N/A'}
• Hair style: ${safeStr(vd.hairStyle) || 'N/A'}
• Hair color: ${safeStr(vd.hairColor) || 'N/A'}
• Hair visibility: ${safeStr(vd.hairVisibility) || 'N/A'}
• Hijab style: ${safeStr(vd.hijabStyle) || 'N/A'}
• Hijab color: ${safeStr(vd.hijabColor) || 'N/A'}
• Top garment: ${safeStr(vd.topGarmentType) || 'N/A'} (${safeStr(vd.topGarmentColor) || 'N/A'})
• Top garment details: ${safeStr(vd.topGarmentDetails) || 'N/A'}
• Bottom garment: ${safeStr(vd.bottomGarmentType) || 'N/A'} (${safeStr(vd.bottomGarmentColor) || 'N/A'})
• Shoes: ${safeStr(vd.shoeType) || 'N/A'} (${safeStr(vd.shoeColor) || 'N/A'})
• Outfit rules: ${safeStr(vd.outfitRules) || 'N/A'}
• Outfit color lock: ${outfitColor}
• Body build: ${safeStr(vd.bodyBuild) || 'N/A'}
• Height feel: ${safeStr(vd.heightFeel) || 'N/A'}
• Accessories: ${formatAccessories(vd)}
• Palette notes: ${safeStr(vd.paletteNotes) || 'none'}
${mod.hijabAlways ? '• Hijab always visible' : ''}
${mod.longSleeves ? '• Long sleeves always' : ''}
${mod.looseClothing ? '• Loose modest clothing always' : ''}
`.trim(),
    `
PORTRAIT GOAL:
• full clear character reference
• strong face visibility
• strong outfit visibility
• clean neutral background
• simple polished render
`.trim(),
    'This image will be reused as a hard consistency anchor for all book illustrations.',
    'No text, no letters, no watermark.',
  ].filter(Boolean).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference handling
// ─────────────────────────────────────────────────────────────────────────────

function getPortraitRefs(character) {
  const refs = [];
  if (startsWithHttp(character.masterReferenceUrl)) refs.push(character.masterReferenceUrl);
  else if (startsWithHttp(character.imageUrl)) refs.push(character.imageUrl);
  return refs;
}

function getPoseRefs(selectedPoses = []) {
  return uniqueStrings(
    selectedPoses
      .map((p) => p.imageUrl)
      .filter(startsWithHttp)
  );
}

function getPoseSheetRefs(characters = []) {
  return uniqueStrings(
    characters
      .map((c) => c.poseSheetUrl)
      .filter(startsWithHttp)
  );
}

function buildInitialRefs(characters) {
  const refs = [];

  for (const c of characters) {
    refs.push(...getPortraitRefs(c));
  }

  for (const c of characters) {
    if (startsWithHttp(c.poseSheetUrl)) refs.push(c.poseSheetUrl);
  }

  return uniqueStrings(refs);
}

function buildReferences(sceneCharacters, selectedPoses = []) {
  const refs = [];

  for (const c of sceneCharacters) {
    refs.push(...getPortraitRefs(c));
  }

  refs.push(...getPoseRefs(selectedPoses));

  // pose sheet only as fallback support
  for (const c of sceneCharacters) {
    if (startsWithHttp(c.poseSheetUrl)) refs.push(c.poseSheetUrl);
  }

  return uniqueStrings(refs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider wrapper
// ─────────────────────────────────────────────────────────────────────────────

function generateImageSafe(project, params) {
  const extraNeg = safeStr(project?.bookStyle?.negativePrompt);
  const negative_prompt = extraNeg
    ? `${BASE_NEGATIVE_PROMPT}, ${extraNeg}`
    : BASE_NEGATIVE_PROMPT;

  return generateImage({
    ...params,
    negative_prompt,
    guidance_scale: project?.bookStyle?.guidanceScale ?? 7,
    steps: project?.bookStyle?.inferenceSteps ?? 35,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Full book generation
// ─────────────────────────────────────────────────────────────────────────────

export async function generateBookIllustrations({ projectId, userId, style, seed, traceId }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const universe = project.universeId ? await Universe.findById(project.universeId) : null;
  const allCharacters = await loadUniverseCharacters(project);
  const universeStyle = style || universe?.artStyle || project.bookStyle?.artStyle || 'pixar-3d';

  const bookTitle = project.artifacts?.outline?.bookTitle || project.title;
  let providerUsed = 'unknown';

  // Important: do not use previously generated scene images as identity anchors.
  // Always use character refs.
  const stableIdentityRefs = buildInitialRefs(allCharacters);

  // ── Spread-only path (<6) ─────────────────────────────────────────────────
  if (isSpreadOnlyProject(project)) {
    const allSpreads = normArr(project.artifacts?.spreads || []);
    const existingSpreadIlls = normArr(project.artifacts?.spreadIllustrations || []);
    const totalSpreads = allSpreads.length;

    for (let si = 0; si < totalSpreads; si++) {
      if (existingSpreadIlls[si]?.imageUrl) continue;

      const spread = allSpreads[si] || {};
      const { sceneCharacters, selectedPoses } = buildSceneSelection(allCharacters, {
        spread,
        names: spread.charactersInScene || [],
      });

      const refs = uniqueStrings([
        ...buildReferences(sceneCharacters, selectedPoses),
        ...stableIdentityRefs,
      ]);

      const spreadLabel = `Spread ${si + 1} of ${totalSpreads}`;
      const spreadText = deriveSceneText(spread, {}, {});
      const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
      const poseLockBlock = buildPoseLockBlock(selectedPoses);
      const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
      const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
      const crossPageAnchor = buildCrossPageAnchor(spreadLabel, sceneCharacters);

      const prompt = buildSpreadPrompt({
        project,
        bookTitle,
        spreadText,
        illustrationHint: spread.illustrationHint || '',
        spreadLabel,
        textPosition: spread.textPosition || 'bottom',
        ageRange: project.ageRange,
        characterLockBlock,
        poseLockBlock,
        poseRefBlock,
        universeStyle,
        outfitQuickRef,
        crossPageAnchor,
        sceneCharacters,
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
        sceneCharacters: sceneCharacters.map((c) => c.name),
        poseSelection: selectedPoses,
        createdAt: new Date().toISOString(),
      };

      await Project.findByIdAndUpdate(projectId, {
        $set: { 'artifacts.spreadIllustrations': existingSpreadIlls },
      });
    }

    if (!project.artifacts?.cover?.backUrl) {
      try {
        const sceneCharacters = allCharacters;
        const selectedPoses = sceneCharacters.map((c) => {
          const pose = selectBestPoseForCharacter(c, { spread: {}, moment: {}, chapterData: {} });
          return {
            characterId: String(c._id),
            characterName: c.name,
            poseKey: pose?.poseKey || 'standing',
            label: pose?.label || pose?.poseKey || 'standing',
            prompt: pose?.prompt || '',
            imageUrl: pose?.imageUrl || '',
            sourceSheetUrl: pose?.sourceSheetUrl || '',
          };
        });

        const refs = buildReferences(sceneCharacters, selectedPoses);
        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);

        const prompt = buildBackCoverPrompt({
          project,
          bookTitle,
          characterLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          sceneCharacters,
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
              poseKey: '',
            }));

      for (let si = existing.spreads.length; si < targetSpreads.length; si++) {
        const spread = targetSpreads[si] || {};

        const { sceneCharacters, selectedPoses } = buildSceneSelection(allCharacters, {
          spread,
          chapterData,
          names: spread.charactersInScene || chapterData.charactersInScene || [],
        });

        const refs = uniqueStrings([
          ...buildReferences(sceneCharacters, selectedPoses),
          ...stableIdentityRefs,
        ]);

        const totalBookSpreads = chapterCount * targetSpreads.length;
        const globalSpreadIdx = ci * targetSpreads.length + si;
        const spreadLabel = `Spread ${globalSpreadIdx + 1} of ${totalBookSpreads}`;

        const spreadText = deriveSceneText(spread, chapterData, chapterContent_);
        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseLockBlock = buildPoseLockBlock(selectedPoses);
        const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
        const crossPageAnchor = buildCrossPageAnchor(spreadLabel, sceneCharacters);

        const prompt = buildSpreadPrompt({
          project,
          bookTitle,
          spreadText,
          illustrationHint: spread.illustrationHint || chapterData.keyScene || '',
          spreadLabel,
          textPosition: spread.textPosition || 'bottom',
          ageRange: project.ageRange,
          characterLockBlock,
          poseLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossPageAnchor,
          sceneCharacters,
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
          sceneCharacters: sceneCharacters.map((c) => c.name),
          poseSelection: selectedPoses,
          createdAt: new Date().toISOString(),
        };
      }
    } else {
      // age 9+ → max 2 best illustration moments per chapter
      const moments = getChapterIllustrationMoments(chapterData, chapterContent_, project.ageRange);

      for (let si = existing.spreads.length; si < moments.length; si++) {
        const moment = moments[si];

        const { sceneCharacters, selectedPoses } = buildSceneSelection(allCharacters, {
          moment,
          chapterData,
          names: moment.charactersInScene || chapterData.charactersInScene || [],
        });

        const refs = uniqueStrings([
          ...buildReferences(sceneCharacters, selectedPoses),
          ...stableIdentityRefs,
        ]);

        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseLockBlock = buildPoseLockBlock(selectedPoses);
        const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
        const crossPageAnchor = buildCrossPageAnchor(`Chapter ${ci + 1} · Moment ${si + 1}`, sceneCharacters);

        const prompt = buildChapterBookIllustrationPrompt({
          project,
          bookTitle,
          chapterTitle,
          chapterNumber: ci + 1,
          moment,
          characterLockBlock,
          poseLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossPageAnchor,
          sceneCharacters,
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
          sceneCharacters: sceneCharacters.map((c) => c.name),
          poseSelection: selectedPoses,
          sceneEnvironment: moment.sceneEnvironment || 'mixed',
          timeOfDay: moment.timeOfDay || 'day',
          createdAt: new Date().toISOString(),
        };
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
      const sceneCharacters = allCharacters;
      const selectedPoses = sceneCharacters.map((c) => {
        const pose = selectBestPoseForCharacter(c, {});
        return {
          characterId: String(c._id),
          characterName: c.name,
          poseKey: pose?.poseKey || 'standing',
          label: pose?.label || pose?.poseKey || 'standing',
          prompt: pose?.prompt || '',
          imageUrl: pose?.imageUrl || '',
          sourceSheetUrl: pose?.sourceSheetUrl || '',
        };
      });

      const refs = buildReferences(sceneCharacters, selectedPoses);
      const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
      const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
      const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);

      const prompt = buildBackCoverPrompt({
        project,
        bookTitle,
        characterLockBlock,
        poseRefBlock,
        universeStyle,
        outfitQuickRef,
        sceneCharacters,
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

// ─────────────────────────────────────────────────────────────────────────────
// Single image generation
// ─────────────────────────────────────────────────────────────────────────────

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
  const stableIdentityRefs = buildInitialRefs(allCharacters);

  let prompt;
  let refs = stableIdentityRefs;
  let sceneCharacters = [];
  let selectedPoses = [];
  let momentTitle = '';
  let illustrationHint = '';
  let sceneEnvironment = '';
  let timeOfDay = '';

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

      const sceneSelection = buildSceneSelection(allCharacters, {
        spread,
        names: spread.charactersInScene || [],
      });

      sceneCharacters = sceneSelection.sceneCharacters;
      selectedPoses = sceneSelection.selectedPoses;
      refs = uniqueStrings([
        ...buildReferences(sceneCharacters, selectedPoses),
        ...stableIdentityRefs,
      ]);

      const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
      const poseLockBlock = buildPoseLockBlock(selectedPoses);
      const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
      const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
      const crossPageAnchor = buildCrossPageAnchor(spreadLabel, sceneCharacters);

      illustrationHint = spread.illustrationHint || '';

      prompt = buildSpreadPrompt({
        project,
        bookTitle,
        spreadText,
        illustrationHint,
        spreadLabel,
        textPosition: spread.textPosition || 'bottom',
        ageRange: project.ageRange,
        characterLockBlock,
        poseLockBlock,
        poseRefBlock,
        universeStyle,
        outfitQuickRef,
        crossPageAnchor,
        sceneCharacters,
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

        const sceneSelection = buildSceneSelection(allCharacters, {
          spread,
          chapterData,
          names: spread.charactersInScene || chapterData.charactersInScene || [],
        });

        sceneCharacters = sceneSelection.sceneCharacters;
        selectedPoses = sceneSelection.selectedPoses;
        refs = uniqueStrings([
          ...buildReferences(sceneCharacters, selectedPoses),
          ...stableIdentityRefs,
        ]);

        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseLockBlock = buildPoseLockBlock(selectedPoses);
        const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
        const crossPageAnchor = buildCrossPageAnchor(spreadLabel, sceneCharacters);

        illustrationHint = spread.illustrationHint || chapterData.keyScene || '';

        prompt = buildSpreadPrompt({
          project,
          bookTitle,
          spreadText,
          illustrationHint,
          spreadLabel,
          textPosition: spread.textPosition || 'bottom',
          ageRange: project.ageRange,
          characterLockBlock,
          poseLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossPageAnchor,
          sceneCharacters,
        });
      } else {
        const moments = getChapterIllustrationMoments(chapterData, chapterContent_, project.ageRange);
        const moment = moments[spreadIndex] || moments[0];

        const sceneSelection = buildSceneSelection(allCharacters, {
          moment,
          chapterData,
          names: moment.charactersInScene || chapterData.charactersInScene || [],
        });

        sceneCharacters = sceneSelection.sceneCharacters;
        selectedPoses = sceneSelection.selectedPoses;
        refs = uniqueStrings([
          ...buildReferences(sceneCharacters, selectedPoses),
          ...stableIdentityRefs,
        ]);

        const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
        const poseLockBlock = buildPoseLockBlock(selectedPoses);
        const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
        const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);
        const crossPageAnchor = buildCrossPageAnchor(
          `Chapter ${chapterIndex + 1} · Moment ${spreadIndex + 1}`,
          sceneCharacters
        );

        momentTitle = moment.momentTitle || '';
        illustrationHint = moment.illustrationHint || '';
        sceneEnvironment = moment.sceneEnvironment || '';
        timeOfDay = moment.timeOfDay || '';

        prompt = buildChapterBookIllustrationPrompt({
          project,
          bookTitle,
          chapterTitle,
          chapterNumber: chapterIndex + 1,
          moment,
          characterLockBlock,
          poseLockBlock,
          poseRefBlock,
          universeStyle,
          outfitQuickRef,
          crossPageAnchor,
          sceneCharacters,
        });
      }
    }
  } else if (task === 'cover') {
    sceneCharacters = allCharacters;
    selectedPoses = sceneCharacters.map((c) => {
      const pose = selectBestPoseForCharacter(c, {});
      return {
        characterId: String(c._id),
        characterName: c.name,
        poseKey: pose?.poseKey || 'standing',
        label: pose?.label || pose?.poseKey || 'standing',
        prompt: pose?.prompt || '',
        imageUrl: pose?.imageUrl || '',
        sourceSheetUrl: pose?.sourceSheetUrl || '',
      };
    });

    refs = buildReferences(sceneCharacters, selectedPoses);

    const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
    const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
    const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);

    prompt = buildCoverPrompt({
      project,
      bookTitle,
      characterLockBlock,
      poseRefBlock,
      universeStyle,
      outfitQuickRef,
      sceneCharacters,
    });
  } else if (task === 'back-cover') {
    sceneCharacters = allCharacters;
    selectedPoses = sceneCharacters.map((c) => {
      const pose = selectBestPoseForCharacter(c, {});
      return {
        characterId: String(c._id),
        characterName: c.name,
        poseKey: pose?.poseKey || 'standing',
        label: pose?.label || pose?.poseKey || 'standing',
        prompt: pose?.prompt || '',
        imageUrl: pose?.imageUrl || '',
        sourceSheetUrl: pose?.sourceSheetUrl || '',
      };
    });

    refs = buildReferences(sceneCharacters, selectedPoses);

    const characterLockBlock = buildCharacterLockBlock(sceneCharacters);
    const poseRefBlock = buildPoseRefInstruction(selectedPoses, sceneCharacters);
    const outfitQuickRef = buildOutfitQuickRef(sceneCharacters);

    prompt = buildBackCoverPrompt({
      project,
      bookTitle,
      characterLockBlock,
      poseRefBlock,
      universeStyle,
      outfitQuickRef,
      sceneCharacters,
    });
  } else if (task === 'character-style') {
    let character = null;

    if (characterId) character = await Character.findById(characterId);
    else character = allCharacters[0] || null;

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

    return {
      ...result,
      prompt,
      traceId: trId,
      masterReferenceUrl: result.imageUrl,
    };
  }

  if (task === 'illustration') {
    if (isSpreadOnlyProject(project)) {
      const ills = normArr(project.artifacts?.spreadIllustrations || []);
      const allSpreads = normArr(project.artifacts?.spreads || []);
      const spread = allSpreads[spreadIndex] || {};
      const spreadText = deriveSceneText(spread, {}, {});

      ills[spreadIndex] = {
        ...(ills[spreadIndex] || {}),
        spreadIndex,
        imageUrl: result.imageUrl,
        prompt,
        text: spreadText,
        textPosition: spread.textPosition || 'bottom',
        illustrationHint: spread.illustrationHint || '',
        sceneCharacters: sceneCharacters.map((c) => c.name),
        poseSelection: selectedPoses,
        createdAt: new Date().toISOString(),
      };

      setFields['artifacts.spreadIllustrations'] = ills;
    } else {
      const illustrations = normArr(project.artifacts?.illustrations || []);
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
        momentTitle,
        illustrationHint,
        sceneEnvironment,
        timeOfDay,
        sceneCharacters: sceneCharacters.map((c) => c.name),
        poseSelection: selectedPoses,
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

  return {
    ...result,
    prompt,
    traceId: trId,
    sceneCharacters: sceneCharacters.map((c) => c.name),
    poseSelection: selectedPoses,
    momentTitle,
    illustrationHint,
    sceneEnvironment,
    timeOfDay,
  };
}