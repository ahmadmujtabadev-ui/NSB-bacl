import { Project } from '../../../models/Project.js';
import { Universe } from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { KnowledgeBase } from '../../../models/KnowledgeBase.js';
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

function buildProjectStyleLock(project, universeStyle, kb, ageMode) {
  const bs = project.bookStyle || {};

  // Pull per-age-group background rules from KB if available
  const bgKey = ageMode === 'underSix' ? 'junior'
    : ageMode === 'junior' ? 'junior'
    : ageMode === 'saeeda' ? 'saeeda'
    : 'middleGrade';
  const kbBg = kb?.backgroundSettings?.[bgKey];

  const lines = [
    'STYLE LOCK — MUST stay consistent across the whole book:',
    `• Illustration style: ${universeStyle || bs.artStyle || 'pixar-3d'}`,
    `• Color palette: ${bs.colorPalette || kbBg?.colorStyle || 'warm-pastels'}`,
    `• Lighting style: ${bs.lightingStyle || kbBg?.lightingStyle || 'warm-golden'}`,
    `• Background style: ${bs.backgroundStyle || 'mixed'}`,
    `• Indoor environment: ${bs.indoorRoomDescription || 'warm cozy room'}`,
    `• Outdoor environment: ${bs.outdoorDescription || 'pleasant natural outdoor scene'}`,
    `• Islamic decor style: ${bs.islamicDecorStyle || 'subtle'}`,
  ];

  if (kbBg?.tone)        lines.push(`• Scene tone: ${kbBg.tone}`);
  if (kbBg?.locations?.length) lines.push(`• Approved locations: ${kbBg.locations.join(', ')}`);
  if (kbBg?.keyFeatures?.length) lines.push(`• Background key features: ${kbBg.keyFeatures.join('; ')}`);
  if (kbBg?.timeOfDay)   lines.push(`• Default time of day: ${kbBg.timeOfDay} (use this unless scene overrides)`);
  if (kbBg?.cameraHint)  lines.push(`• Default camera hint: ${kbBg.cameraHint} (use this unless scene overrides)`);
  if (kbBg?.additionalNotes) lines.push(`• Background notes: ${kbBg.additionalNotes}`);

  if (kb?.backgroundSettings?.avoidBackgrounds?.length)
    lines.push(`• AVOID backgrounds: ${kb.backgroundSettings.avoidBackgrounds.join(', ')}`);
  if (kb?.backgroundSettings?.universalRules)
    lines.push(`• Universal rule: ${kb.backgroundSettings.universalRules}`);

  lines.push('• Keep same rendering quality, same shading language, same proportions, same visual universe in every image.');
  return lines.join('\n');
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
    // Hair — hard lock, same language as glasses/facial hair
    safeStr(vd.hijabStyle)
      ? `  HIJAB LOCK — ALWAYS WEARING: ${safeStr(vd.hijabStyle)} in ${safeStr(vd.hijabColor) || 'same color'} — never remove, never change style or color`
      : safeStr(vd.hairStyle)
        ? `  HAIR LOCK — ALWAYS: ${safeStr(vd.hairStyle)} in ${safeStr(vd.hairColor) || 'natural color'} — NEVER change hairstyle, NEVER change hair color between images — zero variation allowed`
        : `  HAIR: match reference image exactly — NEVER randomise hairstyle`,
    `  Hair visibility: ${safeStr(vd.hairVisibility) || 'N/A'}`,
    // Facial hair — explicit lock either way so AI never randomises
    safeStr(vd.facialHair)
      ? `  FACIAL HAIR LOCK — ALWAYS SHOW: ${safeStr(vd.facialHair)} — never remove, never change style or color`
      : `  FACIAL HAIR: NONE — completely clean-shaven, NO beard, NO mustache, NO stubble — NEVER add any facial hair`,
    // Glasses — explicit lock either way
    safeStr(vd.glasses)
      ? `  GLASSES LOCK — ALWAYS WEARING: ${safeStr(vd.glasses)} — never remove glasses from this character`
      : `  GLASSES: NONE — this character does NOT wear glasses — NEVER add glasses or spectacles`,
    `  Top garment: ${safeStr(vd.topGarmentType) || 'N/A'} (${safeStr(vd.topGarmentColor) || 'N/A'})`,
    `  Top garment details: ${safeStr(vd.topGarmentDetails) || 'N/A'}`,
    `  Bottom garment: ${safeStr(vd.bottomGarmentType) || 'N/A'} (${safeStr(vd.bottomGarmentColor) || 'N/A'})`,
    `  Shoes: ${safeStr(vd.shoeType) || 'N/A'} (${safeStr(vd.shoeColor) || 'N/A'})`,
    `  Outfit rules: ${safeStr(vd.outfitRules) || 'N/A'}`,
    `  Outfit color lock: ${outfitColor}`,
    // Body build + weight — hard lock
    `  BODY LOCK — build: ${safeStr(vd.bodyBuild) || 'medium'}, weight category: ${safeStr(vd.weightCategory) || 'average'} — NEVER alter body weight, muscle mass, or proportions from scene to scene`,
    // Height — explicit cm or relative feel, always locked
    vd.heightCm > 0
      ? `  HEIGHT LOCK — EXACTLY ${vd.heightCm}cm — this character must appear at this EXACT height relative to every other character in every scene`
      : `  HEIGHT LOCK — feel: ${safeStr(vd.heightFeel) || 'average'} — NEVER change apparent height between images`,
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
    const hairLock = safeStr(vd.hijabStyle)
      ? `HIJAB: ${safeStr(vd.hijabStyle)} ${safeStr(vd.hijabColor) || ''} — LOCKED`
      : `HAIR: ${safeStr(vd.hairStyle) || 'match ref'} ${safeStr(vd.hairColor) || ''} — LOCKED`;
    return [
      `• ${c.name}:`,
      `  - Top: ${safeStr(vd.topGarmentType) || 'N/A'} (${safeStr(vd.topGarmentColor) || 'N/A'})`,
      `  - Bottom: ${safeStr(vd.bottomGarmentType) || 'N/A'} (${safeStr(vd.bottomGarmentColor) || 'N/A'})`,
      `  - Shoes: ${safeStr(vd.shoeType) || 'N/A'} (${safeStr(vd.shoeColor) || 'N/A'})`,
      `  - ${hairLock}`,
      `  - Body: ${safeStr(vd.weightCategory) || 'average'} build — LOCKED`,
    ].join('\n');
  });

  return `
OUTFIT & APPEARANCE LOCK — ABSOLUTE — SAME IN EVERY IMAGE
${lines.join('\n')}
Rules:
• NEVER redesign clothing
• NEVER change colors
• NEVER replace garments
• NEVER add random accessories
• NEVER change hairstyle, hair color, or hair length
• NEVER alter body weight, build, or proportions
`.trim();
}

function buildHeightHierarchy(characters) {
  if (!characters?.length) return '';
  // Sort tallest → shortest using heightCm when available
  const withHeight = characters.map((c) => ({
    name: c.name,
    cm: Number(c.visualDNA?.heightCm) || 0,
    feel: safeStr(c.visualDNA?.heightFeel) || '',
    ageRange: c.ageRange || '',
  }));
  const hasCm = withHeight.some((c) => c.cm > 0);
  const sorted = [...withHeight].sort((a, b) => {
    if (hasCm) return b.cm - a.cm;
    return 0; // can't sort without data — keep declaration order
  });

  const lines = sorted.map((c, i) => {
    if (c.cm > 0) return `• ${c.name}: ${c.cm}cm`;
    if (c.feel) return `• ${c.name}: ${c.feel}`;
    // Derive from age range as last resort
    const ageLow = parseInt(String(c.ageRange).split('-')[0], 10) || 10;
    return `• ${c.name}: age ${c.ageRange || 'unknown'} — scale height to match age`;
  });

  const relativeLines = sorted.length > 1
    ? sorted.map((c, i) => {
        if (i === 0) return `• ${c.name} is the TALLEST character in this scene`;
        const prev = sorted[i - 1];
        if (c.cm > 0 && prev.cm > 0) {
          const diff = prev.cm - c.cm;
          return `• ${c.name} is ${diff}cm SHORTER than ${prev.name} — always visibly shorter`;
        }
        return `• ${c.name} is SHORTER than ${prev.name} — always visibly shorter in frame`;
      })
    : [];

  return [
    'HEIGHT HIERARCHY — ABSOLUTE LOCK — maintain in EVERY image:',
    lines.join('\n'),
    relativeLines.length ? '\nRelative heights:' : '',
    relativeLines.join('\n'),
    'NEVER let character heights swap, drift, or equalise between images.',
  ].filter(Boolean).join('\n');
}

function buildCharacterLockBlock(characters) {
  if (!characters?.length) return '';

  const approvedNames = characters.map((c) => c.name).join(', ');
  const descriptions = characters.map(describeCharacter).join('\n\n');
  const heightHierarchy = buildHeightHierarchy(characters);

  const masterNotes = characters
    .filter((c) => c.promptConfig?.masterSystemNote)
    .map((c) => `• ${c.name}: ${c.promptConfig.masterSystemNote.trim()}`)
    .join('\n');

  return `
CHARACTER IDENTITY LOCK — MUST BE FOLLOWED EXACTLY

Approved characters in this scene:
${approvedNames}

Character details:
${descriptions}
${masterNotes ? `\nCHARACTER CUSTOM RULES:\n${masterNotes}` : ''}

${heightHierarchy}

Rules:
• Use ONLY the approved characters needed for this scene
• Do NOT invent extra people
• Do NOT add background people, silhouettes, crowd, or duplicates
• Keep exact same face, age appearance, skin tone, eye color, hair style, hair color, outfit, colors, and body proportions
• HAIRSTYLE IS LOCKED — the same cut, length, and texture must appear in every single image
• BODY WEIGHT AND BUILD ARE LOCKED — never make a character thinner, heavier, taller, or shorter than defined
• HEIGHT RATIOS ARE LOCKED — the taller character must always appear taller in every frame
• Match references exactly while only changing pose, angle, expression, and action
• NEVER change a character's age, height, skin tone, or face shape from one image to another
• NEVER redesign clothing or accessories between images
• A character who appears young in one image must appear exactly the same age in every image
`.trim();
}

function buildScenePromptOverrides(characters = []) {
  const prefixes = characters
    .filter((c) => c.promptConfig?.scenePromptPrefix)
    .map((c) => c.promptConfig.scenePromptPrefix.trim())
    .filter(Boolean);
  const suffixes = characters
    .filter((c) => c.promptConfig?.scenePromptSuffix)
    .map((c) => c.promptConfig.scenePromptSuffix.trim())
    .filter(Boolean);
  const parts = [];
  if (prefixes.length) parts.push(`CHARACTER SCENE OVERRIDES:\n${prefixes.join('\n')}`);
  if (suffixes.length) parts.push(suffixes.join('\n'));
  return parts.join('\n') || '';
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
  const ageLines = sceneCharacters
    .map((c) => `• ${c.name}: age ${c.ageRange || 'child'}, ${c.visualDNA?.skinTone || ''} skin`)
    .filter(Boolean)
    .join('\n');
  const heightLines = sceneCharacters
    .filter((c) => c.visualDNA?.heightCm > 0)
    .map((c) => `• ${c.name}: exactly ${c.visualDNA.heightCm}cm`)
    .join('\n');

  return `
MASTER CONSISTENCY ANCHOR — ABSOLUTE RULES
This illustration belongs to "${label}".
Characters must look IDENTICAL to every other illustration in this book: ${names || 'scene characters'}.

LOCKED — NEVER CHANGE BETWEEN ILLUSTRATIONS:
${ageLines}
${heightLines ? `Heights (fixed):\n${heightLines}` : ''}
• Face structure, bone shape, features — IDENTICAL each time
• Skin tone — IDENTICAL each time
• Eye color, eyebrow shape — IDENTICAL each time
• Hair color, style, length — IDENTICAL each time
• Clothing colors and style — IDENTICAL each time
• Body proportions and build — IDENTICAL each time

ALLOWED TO CHANGE: pose, camera angle, facial expression, scene background.
DO NOT age-up, age-down, change skin tone, or redesign any character between illustrations.
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
  const sceneOverrides = buildScenePromptOverrides(sceneCharacters);

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
    sceneOverrides || null,
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

function buildCoverKbBlock(cd, project, ageMode) {
  if (!cd) return null;
  const bs = project?.bookStyle || {};
  const lines = ['COVER DESIGN — LOCKED DIRECTIVES FROM KNOWLEDGE BASE (non-negotiable):'];

  // ── Atmosphere / mood ────────────────────────────────────────────────────────
  const atmosphere = ageMode === 'underSix' || ageMode === 'junior'
    ? (cd.atmosphere?.junior || '')
    : ageMode === 'saeeda'
      ? (cd.atmosphere?.saeeda || '')
      : (cd.atmosphere?.middleGrade || '');
  if (atmosphere) lines.push(`• ATMOSPHERE LOCK: ${atmosphere}`);

  // ── Typography style directives (font names drive visual tone even for AI) ──
  const typography = ageMode === 'underSix' || ageMode === 'junior'
    ? (cd.typography?.junior || '')
    : ageMode === 'saeeda'
      ? (cd.typography?.saeeda || '')
      : (cd.typography?.middleGrade || '');
  if (typography) {
    lines.push(`• TYPOGRAPHY & TITLE ZONE STYLE: ${typography}. The top zone background must visually match this typographic personality — e.g. if fonts are playful rounded (Fredoka, Baloo), the top zone must be bright, bubbly, cheerful; if serif adventurous, the zone must feel dramatic and cinematic.`);
  }

  // ── Color palette ────────────────────────────────────────────────────────────
  if (bs.colorPalette) lines.push(`• COLOR PALETTE LOCK: ${bs.colorPalette}. Every element — sky, ground, clothing, environment — must use this palette.`);

  // ── Lighting ────────────────────────────────────────────────────────────────
  if (bs.lightingStyle) lines.push(`• LIGHTING LOCK: ${bs.lightingStyle}. Apply this lighting consistently.`);

  // ── Islamic motifs ──────────────────────────────────────────────────────────
  if (cd.islamicMotifs?.length) {
    lines.push(`• ISLAMIC MOTIFS — REQUIRED (woven naturally into the scene, not as decorative borders): ${cd.islamicMotifs.join(', ')}.`);
  }

  // ── Character composition ────────────────────────────────────────────────────
  if (cd.characterComposition?.length) {
    lines.push(`• CHARACTER COMPOSITION LAW: ${cd.characterComposition.join('. ')}.`);
  }

  // ── Branding rules ──────────────────────────────────────────────────────────
  if (cd.brandingRules?.length) {
    lines.push(`• BRANDING RULES: ${cd.brandingRules.join('. ')}.`);
  }

  // ── Title placement override ─────────────────────────────────────────────────
  if (cd.titlePlacement) {
    lines.push(`• TITLE PLACEMENT ZONE: ${cd.titlePlacement}`);
  }

  // ── Optional addons ──────────────────────────────────────────────────────────
  if (cd.optionalAddons?.length) {
    lines.push(`• ATMOSPHERIC ADDONS: ${cd.optionalAddons.join(', ')}.`);
  }

  // ── Avoid list ───────────────────────────────────────────────────────────────
  if (cd.avoidCover?.length) {
    lines.push(`• HARD NEVER — MUST AVOID: ${cd.avoidCover.join(', ')}.`);
  }

  // ── Extra notes ──────────────────────────────────────────────────────────────
  if (cd.extraNotes) lines.push(`• EXTRA NOTES: ${cd.extraNotes}`);

  return lines.length > 1 ? lines.join('\n') : null;
}

function buildCoverPrompt({
  project,
  bookTitle,
  characterLockBlock,
  poseRefBlock,
  universeStyle,
  outfitQuickRef,
  sceneCharacters,
  kb,
  ageMode,
}) {
  const styleLock = buildProjectStyleLock(project, universeStyle, kb, ageMode);
  const allowedNames = sceneCharacters.map((c) => c.name).join(', ');
  const cd = kb?.coverDesign || {};
  const bs = project?.bookStyle || {};

  const atmosphereNote = ageMode === 'underSix' || ageMode === 'junior'
    ? (cd.atmosphere?.junior || 'Bright, warm, joyful colors; cheerful sky; safe and exciting feeling')
    : ageMode === 'saeeda'
      ? (cd.atmosphere?.saeeda || 'Dreamlike, magical atmosphere; soft glowing light; elegant wonder-filled scenery')
      : (cd.atmosphere?.middleGrade || 'Cinematic sunset or golden-hour lighting; rich depth; sense of adventure and discovery');

  const typographyZone = cd.titlePlacement
    ? cd.titlePlacement
    : 'Top 25% of cover — keep this zone lighter in tone (sky, gradient, or soft background) so a bold title can be overlaid clearly';

  const authorZone = 'Bottom 12% of cover — keep this strip slightly darker or with a subtle gradient band so the author name can be overlaid in contrasting color';

  const kbBlock = buildCoverKbBlock(cd, project, ageMode);

  return [
    `PROFESSIONAL PUBLISHED BOOK FRONT COVER — Islamic children\'s book titled "${bookTitle}".`,
    `Design standard: Match the production quality of bestselling published Islamic children\'s books (Kube Publishing, Prolance, Day of Difference level). Cinematic, emotionally rich, print-ready.`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    kbBlock,
    `COVER LAYOUT ZONES — CRITICAL:
• TOP ZONE (top 25%): ${typographyZone}. Leave this area clean and bright — the book title text will be overlaid here in post-production.
• CENTER ZONE (middle 60%): Main character(s) featured in a dynamic, emotionally expressive pose. Character anchored in lower-center, looking active and alive. Rich layered background behind.
• BOTTOM ZONE (bottom 12%): ${authorZone}. The author name will be overlaid here.
• Do NOT place character faces or important detail in the very top or very bottom zones.`,
    styleLock,
    outfitQuickRef,
    characterLockBlock,
    poseRefBlock,
    `Only these characters may appear: ${allowedNames || 'main characters only'}.`,
    !cd.characterComposition?.length
      ? `Character composition: Main character(s) positioned center-to-lower-center as the dominant focal point. Dynamic pose — NOT a static front-facing stance. One character slightly in front of the other for depth. Expression warm and engaging, as if inviting the reader into the story.`
      : null,
    `Visual atmosphere: ${atmosphereNote}.`,
    `Background depth: Three distinct layers — foreground detail, mid-ground character scene, richly painted distant background (architecture, nature, or landscape relevant to the story). NO flat or plain backgrounds.`,
    !cd.islamicMotifs?.length
      ? `Islamic design elements: Subtle mosque silhouette or geometric pattern in the distant background. Islamic architectural details in the environment. Natural and organic — not decorative borders.`
      : null,
    `FINAL QUALITY RULES:
• Full-bleed portrait illustration, no white margins
• Rich color depth, professional rendering quality
• Emotionally resonant — the cover must make a reader WANT to open this book
• No rendered title text, no author name text, no watermark, no speech bubbles — typography is added in post-production
• No borders, no frames, no vignette edges`,
  ].filter(Boolean).join('\n\n');
}

function buildBackCoverPrompt({
  project,
  bookTitle,
  universeStyle,
  kb,
  ageMode,
}) {
  const cd = kb?.coverDesign || {};
  const bs = project?.bookStyle || {};

  const atmosphereNote = ageMode === 'underSix' || ageMode === 'junior'
    ? (cd.atmosphere?.junior || 'Soft, bright, cheerful tones; warm and welcoming')
    : ageMode === 'saeeda'
      ? (cd.atmosphere?.saeeda || 'Soft glowing dreamlike light; elegant calm')
      : (cd.atmosphere?.middleGrade || 'Warm cinematic tones; continuation of front cover mood');

  const styleNote = bs.artStyle
    ? `Match the exact same illustration style as the front cover: ${bs.artStyle}.`
    : 'Match the exact same illustration style as the front cover.';

  // Build back-cover KB directives (subset — no character composition, no title placement)
  const backKbLines = ['BACK COVER DESIGN — LOCKED DIRECTIVES (non-negotiable):'];
  if (atmosphereNote) backKbLines.push(`• ATMOSPHERE LOCK: ${atmosphereNote}`);
  if (bs.colorPalette)  backKbLines.push(`• COLOR PALETTE LOCK: ${bs.colorPalette} — must match front cover exactly.`);
  if (bs.lightingStyle) backKbLines.push(`• LIGHTING LOCK: ${bs.lightingStyle} — continuation of front cover lighting.`);
  if (cd.islamicMotifs?.length) backKbLines.push(`• ISLAMIC MOTIFS (background/decorative only): ${cd.islamicMotifs.join(', ')}.`);
  if (cd.brandingRules?.length)  backKbLines.push(`• BRANDING RULES: ${cd.brandingRules.join('. ')}.`);
  if (cd.avoidCover?.length)     backKbLines.push(`• HARD NEVER — MUST AVOID: ${cd.avoidCover.join(', ')}.`);
  if (cd.extraNotes)             backKbLines.push(`• EXTRA NOTES: ${cd.extraNotes}`);
  const backKbBlock = backKbLines.length > 1 ? backKbLines.join('\n') : null;

  return [
    `PROFESSIONAL PUBLISHED BOOK BACK COVER — Islamic children\'s book "${bookTitle}".`,
    `Design standard: Clean, editorial back cover matching premium Islamic children\'s book publishers. NO characters, NO people, NO figures of any kind.`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    backKbBlock,
    `BACK COVER LAYOUT — REQUIRED:
• TOP SECTION (top 15%): Subtle publisher logo placeholder area — keep clean with a thin ornamental Islamic header divider or crescent/star motif.
• CENTER SECTION (middle 60%): A large, clean, slightly lighter or semi-transparent panel/zone — this is where the synopsis text will be overlaid. Background should be soft enough for dark text to be readable over it. Can have very subtle texture or watermark-style Islamic geometric pattern beneath.
• BOTTOM SECTION (bottom 25%): Bottom-left: small publisher details zone (clean, dark enough for white text). Bottom-right corner: barcode placeholder — a clear 2×1 inch clean white rectangle area at bottom-right where the barcode will be printed.`,
    styleNote,
    `Background: Full-bleed painted background that directly continues the color palette, lighting mood, and atmosphere of the front cover. If front cover had a sunset sky — back cover has the same sky continuing. If front had warm amber tones — back matches. Creates visual wrap-around feel when both covers are viewed together.`,
    !cd.islamicMotifs?.length
      ? `Islamic design elements: Very subtle geometric arabesque pattern as a watermark-level texture in the background. Arch motifs at corners or border edges. Understated and elegant — not overpowering.`
      : null,
    `NO CHARACTERS: Absolutely no people, no figures, no character silhouettes, no portraits. Pure environmental/decorative illustration only.`,
    `Environmental elements (optional, subtle): Story-world objects that complement the front cover — a lantern, an open book, stars, a leaf, a feather, an archway in the distance — only if they enhance the mood without cluttering the text zone.`,
    !cd.avoidCover?.length ? 'AVOID: Cluttered composition, busy patterns that compete with text, dark center (text must be readable over it), random unrelated objects.' : null,
    `FINAL QUALITY RULES:
• Full-bleed portrait composition, no white margins
• Professional print-ready quality
• Center zone must stay clean and light enough for dark synopsis text overlay
• No rendered text, no title, no author name, no letters of any kind
• No borders or frames`,
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
  const sceneOverrides = buildScenePromptOverrides(sceneCharacters);

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
    sceneOverrides || null,
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
  const pc = character.promptConfig || {};
  const outfitColor = extractOutfitColor(vd);
  const styleLock = buildProjectStyleLock(project, selectedStyle);

  const gender = mod.hijabAlways
    ? 'girl'
    : (safeStr(vd.gender) || 'child');

  return [
    pc.portraitPromptPrefix ? pc.portraitPromptPrefix.trim() : null,
    pc.masterSystemNote ? `CHARACTER NOTE: ${pc.masterSystemNote.trim()}` : null,
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
• FACIAL HAIR: ${safeStr(vd.facialHair) ? `ALWAYS SHOW — ${safeStr(vd.facialHair)}` : 'NONE — clean-shaven, NEVER add beard or mustache'}
• GLASSES: ${safeStr(vd.glasses) ? `ALWAYS WEARING — ${safeStr(vd.glasses)}` : 'NONE — no glasses, NEVER add spectacles'}
• Top garment: ${safeStr(vd.topGarmentType) || 'N/A'} (${safeStr(vd.topGarmentColor) || 'N/A'})
• Top garment details: ${safeStr(vd.topGarmentDetails) || 'N/A'}
• Bottom garment: ${safeStr(vd.bottomGarmentType) || 'N/A'} (${safeStr(vd.bottomGarmentColor) || 'N/A'})
• Shoes: ${safeStr(vd.shoeType) || 'N/A'} (${safeStr(vd.shoeColor) || 'N/A'})
• Outfit rules: ${safeStr(vd.outfitRules) || 'N/A'}
• Outfit color lock: ${outfitColor}
• Body build: ${safeStr(vd.bodyBuild) || 'N/A'}
• Height: ${vd.heightCm > 0 ? `EXACTLY ${vd.heightCm}cm — LOCK THIS HEIGHT across all scenes` : (safeStr(vd.heightFeel) || 'N/A')}
• Weight/build category: ${safeStr(vd.weightCategory) || 'N/A'}
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
    pc.portraitPromptSuffix ? pc.portraitPromptSuffix.trim() : null,
    'No text, no letters, no watermark.',
  ].filter(Boolean).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference handling
// ─────────────────────────────────────────────────────────────────────────────

function getPortraitRefs(character) {
  const refs = [];
  // masterReferenceUrl removed — use imageUrl directly
  if (startsWithHttp(character.imageUrl)) refs.push(character.imageUrl);
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

export async function generateBookIllustrations({ projectId, userId, style, seed, traceId, force = false }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const [universe, kb, allCharacters] = await Promise.all([
    project.universeId ? Universe.findById(project.universeId) : null,
    project.knowledgeBaseId ? KnowledgeBase.findById(project.knowledgeBaseId) : null,
    loadUniverseCharacters(project),
  ]);
  const universeStyle = style || universe?.artStyle || project.bookStyle?.artStyle || 'pixar-3d';

  const bookTitle = project.artifacts?.outline?.bookTitle || project.title;
  let providerUsed = 'unknown';

  // Run this in your DB or add a debug log in generateBookIllustrations:
  console.log('[DEBUG] Characters:', allCharacters.map(c => ({
    name: c.name,
    imageUrl: c.imageUrl,
  })));

  // Important: do not use previously generated scene images as identity anchors.
  // Always use character refs.
  const stableIdentityRefs = buildInitialRefs(allCharacters);

  // ── Spread-only path (<6) ─────────────────────────────────────────────────
  if (isSpreadOnlyProject(project)) {
    const allSpreads = normArr(project.artifacts?.spreads || []);
    const existingSpreadIlls = normArr(project.artifacts?.spreadIllustrations || []);
    const totalSpreads = allSpreads.length;

    for (let si = 0; si < totalSpreads; si++) {
      if (!force && existingSpreadIlls[si]?.imageUrl) continue;

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

        const prompt = buildBackCoverPrompt({
          project,
          bookTitle,
          universeStyle,
          kb,
          ageMode: getAgeMode(project.ageRange),
        });

        const result = await generateImageSafe(project, {
          task: 'back-cover',
          prompt,
          references: [],
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

    existing.spreads = force ? [] : normArr(existing.spreads);

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

      const prompt = buildBackCoverPrompt({
        project,
        bookTitle,
        universeStyle,
        kb,
        ageMode: getAgeMode(project.ageRange),
      });

      const result = await generateImageSafe(project, {
        task: 'back-cover',
        prompt,
        references: [],
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

// async function loadUniverseCharacters(project) {
//   if (!project) return [];

//   if (project.characterIds?.length) {
//     return Character.find({
//       _id: { $in: project.characterIds },
//       status: { $in: ['approved', 'generated'] },
//     }).sort({ updatedAt: -1 });
//   }

//   if (project.universeId) {
//     return Character.find({
//       universeId: project.universeId,
//       status: { $in: ['approved', 'generated'] },
//     }).sort({ updatedAt: -1 });
//   }

//   // FALLBACK: load all characters belonging to this user
//   // so projects without explicit links still get character data
//   return Character.find({
//     userId: project.userId,
//     status: { $in: ['approved', 'generated'] },
//   }).sort({ updatedAt: -1 });
// }
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
  compositionDirective = '',
}) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const [universe, kb, allCharacters] = await Promise.all([
    project.universeId ? Universe.findById(project.universeId) : null,
    project.knowledgeBaseId ? KnowledgeBase.findById(project.knowledgeBaseId) : null,
    loadUniverseCharacters(project),
  ]);

  const universeStyle = style || universe?.artStyle || project.bookStyle?.artStyle || 'pixar-3d';

  console.log('[generateStageImage] project.characterIds:', project.characterIds);
  console.log('[generateStageImage] project.universeId:', project.universeId);
  console.log('[generateStageImage] allCharacters loaded:', allCharacters.length,
    allCharacters.map(c => ({ name: c.name, imageUrl: c.imageUrl?.slice(0, 50) }))
  );
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
      // const chapterContent = normArr(
      //   project.artifacts?.humanized?.length
      //     ? project.artifacts.humanized
      //     : project.artifacts?.chapters
      // );

      const humanizedArr2 = normArr(project.artifacts?.humanized || []);
      const chaptersArr2 = normArr(project.artifacts?.chapters || []);
      const totalCh2 = Math.max(humanizedArr2.length, chaptersArr2.length);
      const chapterContent = Array.from({ length: totalCh2 }, (_, i) =>
        (humanizedArr2[i]?.chapterText ? humanizedArr2[i] : null) ?? chaptersArr2[i] ?? {}
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
        let moment = moments[spreadIndex] || moments[0];

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

        // Use KB background timeOfDay/cameraHint as defaults when moment doesn't specify
        {
          const ageMode = getAgeMode(project.ageRange);
          const bgKey = ageMode === 'spreads-only' || ageMode === 'picture-book' ? 'junior' : 'middleGrade';
          const kbBg = kb?.backgroundSettings?.[bgKey];
          timeOfDay = (moment.timeOfDay && moment.timeOfDay !== 'day')
            ? moment.timeOfDay
            : (kbBg?.timeOfDay || moment.timeOfDay || 'afternoon');
          if (kbBg?.cameraHint && !moment.cameraHint) {
            moment = { ...moment, cameraHint: kbBg.cameraHint };
          }
        }

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
      kb,
      ageMode: getAgeMode(project.ageRange),
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

    refs = [];

    prompt = buildBackCoverPrompt({
      project,
      bookTitle,
      universeStyle,
      kb,
      ageMode: getAgeMode(project.ageRange),
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

  // Append composition directive to drive visual variety between variants
  if (compositionDirective && (task === 'illustration' || task === 'cover' || task === 'back-cover')) {
    prompt = `${prompt}\n\n${compositionDirective}`;
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
          imageUrl: result.imageUrl,
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