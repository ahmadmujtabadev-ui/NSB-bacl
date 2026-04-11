import { Project } from '../../../models/Project.js';
import { Universe } from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { KnowledgeBase } from '../../../models/KnowledgeBase.js';
import { NotFoundError } from '../../../errors.js';
import { generateImage } from './image.providers.js';
import { DEFAULT_COVER_TEMPLATES } from '../../../constants/coverTemplates.js';

// ─────────────────────────────────────────────────────────────────────────────
// Negative prompt
// ─────────────────────────────────────────────────────────────────────────────

const BASE_NEGATIVE_PROMPT = [
  'Arabic text on walls',
  'Arabic letters on background',
  'calligraphy on wall',
  'writing on wall',
  'text on background',
  'words on wall',
  'painted text',
  'wall text',
  'decorative Arabic script on surfaces',
  'Islamic calligraphy on wall surfaces',
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
  'Arabic text',
  'Arabic calligraphy',
  'Arabic script',
  'Islamic calligraphy',
  'written words',
  'overlaid text',
  'text overlay',
  'subtitle',
  'speech bubble',
  'thought bubble',
  'title card',
  'different background',
  'background change',
  'location change',
].join(', ');

// ─────────────────────────────────────────────────────────────────────────────
// Basic helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildKbBackgroundBlock(kb, ageMode) {
  const bgKey = (ageMode === 'spreads-only' || ageMode === 'picture-book') ? 'junior' : 'middleGrade';
  const kbBg = kb?.backgroundSettings?.[bgKey] || {};
  const lines = [];

  if (kbBg.locations?.length)
    lines.push(`Approved scene locations: ${kbBg.locations.join(', ')}.`);
  if (kbBg.keyFeatures?.length)
    lines.push(`Required visual features in every scene: ${kbBg.keyFeatures.join('; ')}.`);
  if (kbBg.additionalNotes)
    lines.push(`Scene direction: ${kbBg.additionalNotes}`);
  if (kb?.backgroundSettings?.avoidBackgrounds?.length)
    lines.push(`NEVER use these backgrounds: ${kb.backgroundSettings.avoidBackgrounds.join(', ')}.`);
  if (kb?.backgroundSettings?.universalRules)
    lines.push(`Universal rule: ${kb.backgroundSettings.universalRules}`);

  return lines.join('\n') || '';
}

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
  const bgKey = (ageMode === 'spreads-only' || ageMode === 'picture-book') ? 'junior' : 'middleGrade';
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

  if (kbBg?.tone) lines.push(`• Scene tone: ${kbBg.tone}`);
  if (kbBg?.locations?.length) lines.push(`• Approved locations: ${kbBg.locations.join(', ')}`);
  if (kbBg?.keyFeatures?.length) lines.push(`• Background key features: ${kbBg.keyFeatures.join('; ')}`);
  if (kbBg?.timeOfDay) lines.push(`• Default time of day: ${kbBg.timeOfDay} (use this unless scene overrides)`);
  if (kbBg?.cameraHint) lines.push(`• Default camera hint: ${kbBg.cameraHint} (use this unless scene overrides)`);
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

  // IDENTITY FIX: slim character description.
  // The portrait reference image handles face, skin, hair, and general outfit.
  // The prompt only re-states what references cannot reliably convey:
  // outfit COLOR (can shift under different lighting), hijab color, glasses, facial hair.
  // Everything else (eyebrow shape, nose, cheeks, face structure) is read from the reference.
  const vd = c.visualDNA || {};
  const mod = c.modestyRules || {};

  const gender = mod.hijabAlways ? 'girl' : (safeStr(vd.gender).toLowerCase() || 'child');
  const age = c.ageRange || 'child';

  // Hair / hijab — color is safe to state; structure comes from reference
  const hairLine = safeStr(vd.hijabStyle)
    ? `${safeStr(vd.hijabColor) || ''} hijab always worn — never remove`.trim()
    : safeStr(vd.hairStyle)
      ? `${safeStr(vd.hairColor) || ''} ${safeStr(vd.hairStyle)} hair — never change`.trim()
      : 'hair matches reference — never change';

  // Facial hair — must state explicitly; model will randomise otherwise
  const facialHairLine = safeStr(vd.facialHair)
    ? `facial hair: ${safeStr(vd.facialHair)} — always show`
    : 'no beard, no mustache, clean-shaven';

  // Glasses — must state explicitly
  const glassesLine = safeStr(vd.glasses)
    ? `always wearing ${safeStr(vd.glasses)}`
    : 'no glasses';

  // Outfit — color only (reference shows the style)
  const outfitLine = [
    safeStr(vd.topGarmentColor) && safeStr(vd.topGarmentType)
      ? `${safeStr(vd.topGarmentColor)} ${safeStr(vd.topGarmentType)}`
      : '',
    safeStr(vd.bottomGarmentColor) && safeStr(vd.bottomGarmentType)
      ? `${safeStr(vd.bottomGarmentColor)} ${safeStr(vd.bottomGarmentType)}`
      : '',
  ].filter(Boolean).join(', ') || extractOutfitColor(vd);

  // Height — only what reference cannot show (relative ratio)
  const heightLine = vd.heightCm > 0
    ? `height ${vd.heightCm}cm`
    : safeStr(vd.heightFeel)
      ? `height: ${safeStr(vd.heightFeel)}`
      : '';

  const modesty = [
    mod.longSleeves ? 'long sleeves always' : '',
    mod.looseClothing ? 'loose modest clothing' : '',
  ].filter(Boolean).join(', ');

  return [
    `${c.name} — ${gender}, age ${age}`,
    `skin: ${safeStr(vd.skinTone) || 'match reference'}`,
    hairLine,
    facialHairLine,
    glassesLine,
    outfitLine ? `outfit: ${outfitLine}` : '',
    heightLine,
    modesty,
  ].filter(Boolean).join(', ');
}

function buildOutfitQuickRef(characters) {
  // IDENTITY FIX: kept intentionally minimal — reference image conveys most of this.
  // Only re-state outfit COLORS (safe to repeat) and the hair/hijab lock (critical for modesty).
  if (!characters?.length) return '';

  const lines = characters.map((c) => {
    const vd = c.visualDNA || {};
    const hairLock = safeStr(vd.hijabStyle)
      ? `${safeStr(vd.hijabColor) || ''} hijab — always worn`.trim()
      : `${safeStr(vd.hairColor) || ''} ${safeStr(vd.hairStyle) || 'hair'} — never change`.trim();

    const outfit = [
      safeStr(vd.topGarmentColor) ? `${safeStr(vd.topGarmentColor)} top` : '',
      safeStr(vd.bottomGarmentColor) ? `${safeStr(vd.bottomGarmentColor)} bottom` : '',
    ].filter(Boolean).join(', ');

    return `${c.name}: ${outfit}${outfit ? ', ' : ''}${hairLock}`;
  });

  return `Appearance locks: ${lines.join(' | ')}. Never redesign clothing or hair between images.`;
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
  // IDENTITY FIX: compact block that fits within CLIP's 77-token context.
  // The reference portrait carries face/hair/outfit structure.
  // This block only restates colors and critical locks the model tends to randomise.
  if (!characters?.length) return '';

  const names = characters.map((c) => c.name).join(', ');
  const descriptions = characters.map(describeCharacter).join(' | ');

  // Height relationship (only if 2 characters with known heights)
  let heightNote = '';
  if (characters.length === 2) {
    const [a, b] = characters;
    const aCm = Number(a.visualDNA?.heightCm) || 0;
    const bCm = Number(b.visualDNA?.heightCm) || 0;
    if (aCm > 0 && bCm > 0 && aCm !== bCm) {
      const taller = aCm > bCm ? a.name : b.name;
      const shorter = aCm > bCm ? b.name : a.name;
      heightNote = `${taller} is visibly taller than ${shorter}.`;
    } else if (a.visualDNA?.heightFeel && b.visualDNA?.heightFeel) {
      heightNote = `${a.name} height: ${a.visualDNA.heightFeel}. ${b.name} height: ${b.visualDNA.heightFeel}.`;
    }
  }

  const masterNotes = characters
    .filter((c) => c.promptConfig?.masterSystemNote)
    .map((c) => `${c.name}: ${c.promptConfig.masterSystemNote.trim()}`)
    .join(' ');

  return [
    `Characters in scene: ${names}.`,
    descriptions,
    heightNote,
    masterNotes,
    'Only these characters. No extra people. No background crowd. Match reference portraits exactly — only pose and expression may change.',
  ].filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Cover-specific helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Story-aware cover character selection.
 *
 * Priority order:
 *  1. Characters named in coverDesign.characterMustInclude (always included)
 *  2. Characters matched by characterComposition role hints (mentor, comedy, moral)
 *  3. Characters whose name appears in the story outline / theme text
 *  4. Remaining characters by array order (author-defined significance)
 *
 * Returns at most 3 characters — the visual limit for a readable cover.
 */
export function selectCoverCharacters(allCharacters, kb, project) {
  if (!allCharacters?.length) return [];

  const cd = kb?.coverDesign || {};
  const MAX = 3;

  // Step 1: must-include list (case-insensitive names from KB)
  const mustIncludeNames = uniqueStrings(cd.characterMustInclude || []).map(n => n.toLowerCase());
  const required = allCharacters.filter(c => mustIncludeNames.includes(c.name.toLowerCase()));
  if (required.length >= MAX) return required.slice(0, MAX);

  // Step 2: parse characterComposition for role hints
  // e.g. ["Ustaz Tariq — authority figure", "Fatima — moral anchor"]
  const compRules = uniqueStrings(cd.characterComposition || []);
  const compositionMatched = [];
  for (const rule of compRules) {
    const namePart = rule.split(/[—–-]/)[0].trim().toLowerCase();
    const match = allCharacters.find(
      c => !mustIncludeNames.includes(c.name.toLowerCase()) &&
           c.name.toLowerCase().includes(namePart)
    );
    if (match && !compositionMatched.includes(match)) compositionMatched.push(match);
  }

  // Step 3: theme / story text hint — find characters whose names appear in outline
  const storyText = [
    project?.artifacts?.outline?.synopsis || '',
    project?.artifacts?.storyText || '',
    project?.artifacts?.outline?.islamicTheme || '',
  ].join(' ').toLowerCase();

  const storyHinted = allCharacters.filter(c =>
    !mustIncludeNames.includes(c.name.toLowerCase()) &&
    !compositionMatched.includes(c) &&
    storyText.includes(c.name.toLowerCase())
  );

  // Step 4: fallback — remaining characters in declaration order
  const alreadyPicked = new Set([
    ...required.map(c => String(c._id)),
    ...compositionMatched.map(c => String(c._id)),
    ...storyHinted.map(c => String(c._id)),
  ]);
  const fallback = allCharacters.filter(c => !alreadyPicked.has(String(c._id)));

  const ordered = [...required, ...compositionMatched, ...storyHinted, ...fallback];
  return ordered.slice(0, MAX);
}

/**
 * Builds a strict age/child-identity lock block.
 * Injected into cover prompts to stop templates from ageing up school-age characters.
 */
function buildCoverCharacterAgeLock(characters) {
  if (!characters?.length) return '';

  const locks = characters.map(c => {
    const ageRange = safeStr(c.ageRange) || 'child';
    const ageLow = parseInt(String(ageRange).split(/[-–to]/)[0].trim(), 10);
    const ageLabel = !isNaN(ageLow) ? `${ageLow}-year-old` : ageRange;
    const vd = c.visualDNA || {};
    const heightNote = vd.heightCm > 0
      ? `height ${vd.heightCm}cm`
      : safeStr(vd.heightFeel) || 'child proportions';
    return `• ${c.name}: strictly a ${ageLabel} child — child face, child body proportions, ${heightNote}. NOT a teenager, NOT an adult, NOT a hero-type. School-age and clearly childlike.`;
  });

  return `CHARACTER AGE LOCK — ABSOLUTE RULE (template style MUST NOT override this):
${locks.join('\n')}
The cover template controls environment, palette, atmosphere, and decorative framing only.
It does NOT change character age, face identity, body proportions, or school uniform appearance.
Every character must still look like a school-age child matching their character reference portrait exactly.`;
}

/**
 * Builds dynamic cover layout zones from KB title/author placement settings.
 * Falls back to sensible defaults if the fields are blank.
 *
 * previewMode=true  → render visible title + author text ON the image
 * previewMode=false → keep zones clean; text added in post-production
 */
function buildCoverLayoutZones(cd, authorName, previewMode) {
  // Resolve title placement
  const titleZone = safeStr(cd.titlePlacement) ||
    'Top 25% of cover — keep this zone lighter in tone so a bold title can be overlaid clearly';
  // Resolve author/tagline placement
  const authorZone = safeStr(cd.authorTaglinePlacement) ||
    'Bottom 12% of cover — keep this strip slightly darker with a subtle gradient band so the author name can be overlaid in contrasting colour';

  if (previewMode) {
    return `COVER LAYOUT ZONES (PREVIEW MODE — render visible typography):
• TITLE ZONE: ${titleZone}. RENDER the book title "${cd.bookTitle || 'Book Title'}" here in legible, styled typography matching the cover template's typographic personality. Bold, clear, professional.
• AUTHOR ZONE: ${authorZone}. RENDER the author name "${authorName || 'Author Name'}" here in smaller complementary typography.
• CENTER ZONE (middle 60%): Main character(s) in dynamic emotionally expressive pose, anchored lower-center. Rich layered background.
• Character faces and key details must NOT be placed in the title or author zones.`;
  }

  return `COVER LAYOUT ZONES (ARTWORK-ONLY MODE — no text rendered):
• TITLE ZONE: ${titleZone}. Keep this area clean, lighter in tone — title text will be added in post-production.
• AUTHOR ZONE: ${authorZone}. Keep clean with subtle gradient — author name added in post-production.
• CENTER ZONE (middle 60%): Main character(s) in dynamic emotionally expressive pose, anchored lower-center. Rich layered background.
• Character faces and key details must NOT be placed in the title or author zones.`;
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

// Pose descriptors: text descriptions of each pose for prompt injection.
// These replace image-based pose references, which carry identity information
// and cause drift when used as reference images.
const POSE_DESCRIPTORS = {
  'standing': 'standing upright, arms relaxed at sides',
  'sitting': 'seated comfortably, hands resting in lap',
  'walking': 'mid-stride, one foot forward, arms in natural swing',
  'running': 'running forward, body leaning, arms pumping',
  'thinking': 'hand raised to chin, head slightly tilted, thoughtful expression',
  'reading-quran': 'sitting cross-legged, hands holding an open book, eyes lowered',
  'praying-salah': 'standing in prayer, arms folded across chest, eyes downcast',
  'waving': 'one arm raised with open hand, warm smile',
  'laughing': 'shoulders relaxed, head slightly back, joyful open expression',
  'sad': 'shoulders dropped, head lowered, eyes downcast',
  'surprised': 'eyes wide, eyebrows raised, mouth slightly open',
  'kneeling': 'one knee on ground, body upright, hands forward',
};

function buildPoseLockBlock(selectedPoses = []) {
  if (!selectedPoses.length) return '';

  // IDENTITY FIX: describe pose in text — do NOT reference pose images.
  // Pose images contain the character's identity and cause blending when
  // passed alongside the master portrait reference.
  const lines = selectedPoses.map((p) => {
    const key = normalizePoseKey(p.poseKey || 'standing');
    const descriptor = POSE_DESCRIPTORS[key] || `in a natural ${key} position`;
    return `• ${p.characterName}: ${descriptor}`;
  });

  return `Character poses:\n${lines.join('\n')}`;
}

function buildPoseRefInstruction(selectedPoses = [], characters = []) {
  const hasPortraits = characters.some((c) => startsWithHttp(c.imageUrl));
  if (!hasPortraits) return '';

  // IDENTITY FIX: only reference the portrait as the identity anchor.
  // Pose images and sheets are NOT attached — they cause identity blending.
  // Pose is controlled via text descriptors in buildPoseLockBlock instead.
  const names = characters.map((c) => c.name).join(', ');
  return `Reference images attached: master portrait(s) for ${names}. Use as hard identity anchor — match face, skin tone, hair, outfit, and proportions exactly.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-page anchor
// ─────────────────────────────────────────────────────────────────────────────

function buildCrossPageAnchor(label, sceneCharacters = []) {
  // IDENTITY FIX: collapsed to a single line to conserve CLIP token budget.
  // The detailed identity information is now carried by the reference portrait image,
  // not by repeated verbose text that gets truncated after token 77.
  const names = sceneCharacters.map((c) => c.name).join(', ');
  if (!names) return '';
  return `Illustration "${label}". Characters must look identical to all other illustrations in this book — same face, skin tone, outfit, hairstyle. The background must match the scene described (kitchen stays kitchen, bedroom stays bedroom). Do NOT change the scene location from what is described.`;
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
• NO Arabic text, calligraphy, or written words on any background surface, wall, or object
• NO decorative script of any kind on walls, tiles, furniture, or props
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
  const matched = getSceneCharacters(
    allCharacters,
    context.names || context.charactersInScene || []
  );

  const sceneCharacters = matched; // no silent slice

  const referenceCharacters = matched.slice(0, 2); // only refs capped
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

  return { sceneCharacters, referenceCharacters, selectedPoses };
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

// Build a contrast note for 2-character scenes to prevent identity blending.
function buildContrastAnchor(sceneCharacters) {
  if (sceneCharacters.length < 2) return '';
  const [a, b] = sceneCharacters;
  const vdA = a.visualDNA || {};
  const vdB = b.visualDNA || {};
  const modA = a.modestyRules || {};
  const modB = b.modestyRules || {};
  const contrasts = [];

  if (vdA.skinTone && vdB.skinTone && vdA.skinTone !== vdB.skinTone) {
    contrasts.push(`${a.name} has ${vdA.skinTone} skin, ${b.name} has ${vdB.skinTone} skin`);
  }
  if (modA.hijabAlways !== modB.hijabAlways) {
    const withHijab = modA.hijabAlways ? a.name : b.name;
    const without = modA.hijabAlways ? b.name : a.name;
    contrasts.push(`only ${withHijab} wears a hijab, ${without} does not`);
  }
  const aCm = Number(vdA.heightCm) || 0;
  const bCm = Number(vdB.heightCm) || 0;
  if (aCm > 0 && bCm > 0 && aCm !== bCm) {
    const taller = aCm > bCm ? a.name : b.name;
    const shorter = aCm > bCm ? b.name : a.name;
    contrasts.push(`${taller} is visibly taller than ${shorter}`);
  }
  return contrasts.length ? `Visual distinction: ${contrasts.join('. ')}.` : '';
}

// Infer an emotion word from a scene description hint.
function inferEmotionFromHint(hint = '') {
  const h = hint.toLowerCase();
  if (/sad|cry|regret|guilt|mistake|loss/.test(h)) return 'sad';
  if (/laugh|giggle|joy|celebrat|excit/.test(h)) return 'joyful';
  if (/scared|fear|worried|anxious|tremble/.test(h)) return 'worried';
  if (/surpris|amaz|discover|shock|sudden/.test(h)) return 'surprised';
  if (/pray|dua|worship|gratitude|grateful/.test(h)) return 'peaceful and devout';
  if (/determin|brave|resolv|courag/.test(h)) return 'determined';
  if (/wonder|curious|interest|ponder/.test(h)) return 'curious';
  if (/angry|frustrat|annoy/.test(h)) return 'frustrated';
  return 'calm and engaged';
}

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
  kb,
  sceneEnvironment = 'indoor',
}) {
  const first = String(ageRange || '').match(/\d+/)?.[0];
  const minAge = first ? Number(first) : 7;
  const isYoung = minAge <= 6;
  const ageMode = getAgeMode(ageRange);
  const bs = project.bookStyle || {};

  // KB background rules for environment section
  const bgKey = ageMode === 'spreads-only' || ageMode === 'picture-book' ? 'junior' : 'middleGrade';
  const kbBg = kb?.backgroundSettings?.[bgKey];

  // 1. Style anchor — MUST be first for maximum CLIP weight
  const styleAnchor = ['FULL-BLEED DIGITAL ILLUSTRATION — no borders, no frames, no card edges, no decorative outline', universeStyle || bs.artStyle || 'Pixar 3D animation style', bs.colorPalette || kbBg?.colorStyle || 'warm pastels', 'Islamic children\'s book interior illustration, professional quality'].join(', ') + '.';

  // 2. Scene — what is happening
  const scene = spreadText
    ? `Scene: ${spreadText}${illustrationHint ? ` — ${illustrationHint}` : ''}`
    : illustrationHint
      ? `Scene: ${illustrationHint}`
      : 'Scene: A warm child-friendly Islamic story moment.';

  // 3. Contrast anchor — prevents identity blending between 2 characters
  const contrastAnchor = buildContrastAnchor(sceneCharacters);

  // 4. Environment — scene location lock + compact lighting/time/camera from KB
  const isIndoor = !sceneEnvironment || sceneEnvironment === 'indoor';
  const locationDesc = isIndoor ? (bs.indoorRoomDescription || 'warm cozy room') : (bs.outdoorDescription || 'pleasant outdoor scene');
  const lighting = bs.lightingStyle || kbBg?.lightingStyle || 'warm golden';
  const timeOfDay = kbBg?.timeOfDay || 'afternoon';
  const envParts = ['SCENE LOCATION LOCK — this scene is ' + (isIndoor ? 'INDOORS' : 'OUTDOORS') + ': ' + locationDesc + '. Keep this exact location. Do NOT change the room or setting.', 'Lighting: ' + lighting, 'Time: ' + timeOfDay];
  if (kbBg?.cameraHint) envParts.push('Camera: ' + kbBg.cameraHint + ' shot');
  if (kbBg?.tone) envParts.push('Tone: ' + kbBg.tone);
  const environment = envParts.join('. ') + '.';

  // 5. KB background directives — locations, keyFeatures, avoidBackgrounds,
  //    additionalNotes, universalRules (previously missing from spread prompts)
  const kbBackgroundBlock = buildKbBackgroundBlock(kb, ageMode);

  // 6. Composition hint — short
  const composition = isYoung
    ? 'Clear warm expressive composition for young children.'
    : 'Simple readable composition, characters in focus.';

  // 7. Text safe zone
  const safeZone = textSafeZone(textPosition);

  // 8. Format — collapsed to one line
  const format = ['Full-bleed single illustration. No text, no borders, no frames, no extra characters.', 'Consistent ' + (universeStyle || 'Pixar 3D') + ' render style — match the shading, line quality, color saturation, and rendering quality of all other illustrations in this book exactly.'].join(' ');

  // 9. Custom scene overrides (character-level prefix/suffix)
  const sceneOverrides = buildScenePromptOverrides(sceneCharacters);

  return [
    styleAnchor,          // style anchor FIRST — max CLIP weight
    scene,                // what is happening
    characterLockBlock,   // who they are (compact: name + color locks only)
    poseLockBlock,        // what pose each character is in (text descriptor)
    contrastAnchor,       // visual distinction between 2 chars (prevents blending)
    outfitQuickRef,       // outfit color quick reference
    poseRefBlock,         // reference image note (portrait anchor only)
    crossPageAnchor,      // consistency note (1 line)
    environment,          // setting, lighting, time, camera, tone
    kbBackgroundBlock,    // locations, keyFeatures, avoidBackgrounds, universalRules
    composition,
    safeZone,
    sceneOverrides || null,
    format,
  ].filter(Boolean).join('\n');
}

function buildCoverKbBlock(cd, project, ageMode) {
  if (!cd) return null;
  const bs = project?.bookStyle || {};
  const lines = ['COVER DESIGN — LOCKED DIRECTIVES FROM KNOWLEDGE BASE (non-negotiable):'];

  // ── Selected visual template (highest priority — defines the entire visual language) ──
  // When a template is active its promptDirective already encodes the full color palette,
  // lighting, and atmosphere — emitting separate colorStyle/lightingEffects lines afterward
  // creates conflicting instructions and the model splits the difference (wrong output).
  let templateActive = false;
  if (cd.selectedCoverTemplate) {
    const tpl = DEFAULT_COVER_TEMPLATES.find(t => t._id === cd.selectedCoverTemplate);
    if (tpl) {
      templateActive = true;
      lines.push(`• ⚠ PRIMARY VISUAL TEMPLATE — "${tpl.name}" (FOLLOW EXACTLY — this overrides all other style defaults):`);
      if (tpl.promptDirective) lines.push(`  ${tpl.promptDirective}`);
      if (tpl.palette?.length)  lines.push(`• TEMPLATE COLOR PALETTE: ${tpl.palette.join(', ')} — use ONLY these hex values for the cover's color scheme.`);
      if (tpl.composition)     lines.push(`• COMPOSITION: ${tpl.composition}`);
      if (tpl.atmosphere)      lines.push(`• ATMOSPHERE: ${tpl.atmosphere}`);
      // KB overrides supplement the template without contradicting its palette
      if (cd.moodTheme) lines.push(`• MOOD SUPPLEMENT: ${cd.moodTheme} — reinforce this mood within the template visual language.`);
      if (cd.colorStyle) lines.push(`• COLOR SUPPLEMENT (works with template palette): ${cd.colorStyle}.`);
      if (cd.lightingEffects) lines.push(`• LIGHTING SUPPLEMENT: ${cd.lightingEffects}.`);
    }
  }

  // ── Main visual concept (scene) ───────────────────────────────────────────────
  if (cd.mainVisualConcept) {
    lines.push(`• MAIN VISUAL CONCEPT (primary scene to illustrate): ${cd.mainVisualConcept}`);
  }

  // ── Character description ─────────────────────────────────────────────────────
  if (cd.characterDescription) {
    lines.push(`• COVER CHARACTER: ${cd.characterDescription}`);
  }

  // ── Mood / theme ──────────────────────────────────────────────────────────────
  if (cd.moodTheme) {
    lines.push(`• MOOD & THEME (locked): ${cd.moodTheme}`);
  }

  // ── Color style — only emit when NO template is driving the palette ────────────
  // (template's promptDirective already contains its full color spec)
  if (!templateActive) {
    if (cd.colorStyle) {
      lines.push(`• COLOR PALETTE (locked — every pixel must use this): ${cd.colorStyle}. Sky, ground, clothing, architecture — ALL must reflect this palette. Do NOT use any other color scheme.`);
    } else if (bs.colorPalette) {
      lines.push(`• COLOR PALETTE LOCK: ${bs.colorPalette}. Every element must use this palette.`);
    }
  }

  // ── Lighting effects — only emit when NO template is active ───────────────────
  if (!templateActive) {
    if (cd.lightingEffects) {
      lines.push(`• LIGHTING (locked — apply globally): ${cd.lightingEffects}. The entire scene must be lit this way.`);
    } else if (bs.lightingStyle) {
      lines.push(`• LIGHTING LOCK: ${bs.lightingStyle}. Apply consistently.`);
    }
  }

  // ── Layering ──────────────────────────────────────────────────────────────────
  const layers = [];
  if (cd.foregroundLayer) layers.push(`Foreground: ${cd.foregroundLayer}`);
  if (cd.midgroundLayer) layers.push(`Midground: ${cd.midgroundLayer}`);
  if (cd.backgroundLayer) layers.push(`Background: ${cd.backgroundLayer}`);
  if (layers.length) lines.push(`• SCENE LAYERS — ${layers.join(' | ')}`);

  // ── Atmosphere / mood per series ──────────────────────────────────────────────
  const atmosphere = (ageMode === 'spreads-only' || ageMode === 'picture-book')
    ? (cd.atmosphere?.junior || cd.atmosphere?.middleGrade || '')
    : (cd.atmosphere?.middleGrade || cd.atmosphere?.junior || '');
  if (atmosphere) lines.push(`• ATMOSPHERE LOCK: ${atmosphere}`);

  // ── Typography (drives title zone visual tone) ────────────────────────────────
  const typographyOverride = [cd.typographyTitle, cd.typographyBody].filter(Boolean).join(' / ') || null;
  const typographyPerSeries = (ageMode === 'spreads-only' || ageMode === 'picture-book')
    ? (cd.typography?.junior || '')
    : (cd.typography?.middleGrade || '');
  const typography = typographyOverride || typographyPerSeries;
  if (typography) {
    lines.push(`• TYPOGRAPHY & TITLE ZONE VISUAL FEEL (locked): ${typography}. The top 25% of the cover background MUST visually match this typographic personality — calligraphic serif = elegant textured top zone; rounded fun = bright bubbly top zone. This is the visual tone of the entire title area.`);
  }

  // ── Title placement ───────────────────────────────────────────────────────────
  if (cd.titlePlacement) {
    lines.push(`• TITLE PLACEMENT ZONE: ${cd.titlePlacement}`);
  }

  // ── Islamic motifs ────────────────────────────────────────────────────────────
  if (cd.islamicMotifs?.length) {
    lines.push(`• ISLAMIC MOTIFS — REQUIRED (woven naturally into scene, not decorative borders): ${cd.islamicMotifs.join(', ')}.`);
  }

  // ── Character composition ─────────────────────────────────────────────────────
  if (cd.characterComposition?.length) {
    lines.push(`• CHARACTER COMPOSITION LAW: ${cd.characterComposition.join('. ')}.`);
  }

  // ── Branding rules ────────────────────────────────────────────────────────────
  if (cd.brandingRules?.length) {
    lines.push(`• BRANDING RULES: ${cd.brandingRules.join('. ')}.`);
  }

  // ── Optional addons ───────────────────────────────────────────────────────────
  if (cd.optionalAddons?.length) {
    lines.push(`• ATMOSPHERIC ADDONS: ${cd.optionalAddons.join(', ')}.`);
  }

  // ── Avoid list ────────────────────────────────────────────────────────────────
  if (cd.avoidCover?.length) {
    lines.push(`• HARD NEVER — MUST AVOID: ${cd.avoidCover.join(', ')}.`);
  }

  // ── Spine template (for full wrap-cover generation) ──────────────────────────
  if (cd.spinePromptDirective) {
    lines.push(`• SPINE VISUAL TEMPLATE: ${cd.spinePromptDirective}`);
  } else if (cd.spineColorBackground || cd.spineTypographyStyle) {
    const spineParts = [];
    if (cd.spineColorBackground) spineParts.push(`Background: ${cd.spineColorBackground}`);
    if (cd.spineTypographyStyle) spineParts.push(`Typography: ${cd.spineTypographyStyle}`);
    lines.push(`• SPINE STYLE: ${spineParts.join(' | ')}`);
  }
  if (cd.spineTitle) lines.push(`• SPINE TITLE: ${cd.spineTitle}`);
  if (cd.spineAuthor) lines.push(`• SPINE AUTHOR: ${cd.spineAuthor}`);
  if (cd.price) lines.push(`• PRICE: ${cd.price}`);

  // ── Extra notes ───────────────────────────────────────────────────────────────
  if (cd.extraNotes) lines.push(`• EXTRA NOTES: ${cd.extraNotes}`);

  return lines.length > 1 ? lines.join('\n') : null;
}

/**
 * Builds the front-cover prompt.
 *
 * previewMode = true  → request rendered title + author typography on the image
 * previewMode = false → artwork-only; no text; clean zones for post-production overlay
 *
 * Key design rules:
 *  • KB block is first — image models weight early tokens most heavily
 *  • Template controls environment/palette/atmosphere ONLY
 *  • Template NEVER overrides character age, face, or school identity
 *  • Layout zones are fully driven by cd.titlePlacement / cd.authorTaglinePlacement
 *  • Default art-style lock (Pixar 3D) is suppressed when a KB template is active
 */
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
  previewMode = false,
}) {
  const cd = kb?.coverDesign || {};

  // Effective title + author (KB fields override project)
  const effectiveTitle = safeStr(cd.bookTitle) || safeStr(bookTitle) || 'Islamic Children\'s Book';
  const authorName = safeStr(cd.authorName);

  // Atmosphere per age group
  const atmosphereNote = (ageMode === 'spreads-only' || ageMode === 'picture-book')
    ? (safeStr(cd.atmosphere?.junior) || safeStr(cd.atmosphere?.middleGrade) || 'Bright, warm, joyful colours; cheerful sky; safe and exciting feeling')
    : (safeStr(cd.atmosphere?.middleGrade) || safeStr(cd.atmosphere?.junior) || 'Cinematic sunset or golden-hour lighting; rich depth; sense of adventure and discovery');

  // ── KB directives block (highest-priority — goes first in prompt) ──────────
  const kbBlock = buildCoverKbBlock(cd, project, ageMode);

  // ── Template override note ──────────────────────────────────────────────────
  // Makes explicit that the template controls ONLY environment/palette/framing.
  const templateScopeNote = cd.selectedCoverTemplate
    ? [
        '⚠ COVER TEMPLATE SCOPE:',
        '  • The selected template above controls: color palette, lighting, atmosphere, environment, decorative motifs, architectural framing.',
        '  • The template does NOT change: character age, face identity, body proportions, school uniform, child appearance.',
        '  • Every character must look EXACTLY like their reference portrait — same age, same face, same school-age child appearance.',
      ].join('\n')
    : null;

  // ── Style lock — suppressed when a KB template is driving the visual language ──
  // Injecting "Pixar 3D" alongside "Islamic Heritage painterly" creates contradictory output.
  const conditionalStyleLock = cd.selectedCoverTemplate
    ? null
    : buildProjectStyleLock(project, universeStyle, kb, ageMode);

  // ── Dynamic layout zones from KB settings ──────────────────────────────────
  const layoutZones = buildCoverLayoutZones(cd, authorName, previewMode);

  // ── Character age lock (injected late in prompt — acts as final constraint) ──
  const ageLock = buildCoverCharacterAgeLock(sceneCharacters);

  // ── Allowed names ──────────────────────────────────────────────────────────
  const allowedNames = sceneCharacters.map((c) => c.name).join(', ');
  const protagonistOnly = sceneCharacters.slice(0, 1);

  // ── Default character composition when KB hasn't specified one ──────────────
  const defaultComposition = !cd.characterComposition?.length
    ? `Character composition: Single main character positioned center-to-lower-center as the ONLY figure on the cover. Dynamic emotionally expressive pose. Large, dominant, full-body or 3/4 body shot. Expression warm and engaging, as if inviting the reader into the story. NO other characters, NO babies, NO siblings.`
    : null;

  // ── Default Islamic motifs when KB hasn't specified any ─────────────────────
  const defaultIslamicMotifs = !cd.islamicMotifs?.length
    ? `Islamic design elements: Subtle mosque silhouette or geometric pattern in the distant background. Islamic architectural details in the environment. Natural and organic — not decorative borders.`
    : null;

  // ── Default background depth when KB layers aren't specified ─────────────────
  const defaultBackground = !cd.foregroundLayer && !cd.midgroundLayer && !cd.backgroundLayer
    ? `Background depth: Three distinct layers — foreground detail, mid-ground character scene, richly painted distant background (architecture, nature, or landscape relevant to the story). NO flat or plain backgrounds.`
    : null;

  // ── Final quality rules — text rendering rules depend on mode ─────────────
  const finalRules = previewMode
    ? `FINAL QUALITY RULES:
• Full-bleed portrait illustration, no white margins
• Rich colour depth, professional rendering quality
• Emotionally resonant — the cover must make a reader WANT to open this book
• Rendered title and author typography must be clearly legible, professionally styled
• No watermarks, no speech bubbles
• No borders, no frames, no vignette edges`
    : `FINAL QUALITY RULES:
• Full-bleed portrait illustration, no white margins
• Rich colour depth, professional rendering quality
• Emotionally resonant — the cover must make a reader WANT to open this book
• NO rendered title text — typography added in post-production
• NO author name text — added in post-production
• No watermarks, no speech bubbles, no captions
• No borders, no frames, no vignette edges`;

  return [
    // 1. KB directives FIRST — heaviest weight for image models
    kbBlock,
    // 2. Template scope clarification — what the template controls vs what it cannot touch
    templateScopeNote,
    // 2a. Hard Arabic calligraphy prohibition — overrides any template default
    'CRITICAL PROHIBITION — applies even if template style suggests it: NO Arabic calligraphy, NO Arabic script, NO Arabic text bands, NO calligraphy borders, NO written Arabic anywhere on the image — not on walls, arches, borders, banners, or any surface. This overrides any template default that includes calligraphic decoration.',
    // 3. Cover identity
    `PROFESSIONAL PUBLISHED BOOK FRONT COVER — Islamic children\'s book: "${effectiveTitle}".`,
    authorName ? `Author: ${authorName}` : null,
    cd.subtitle ? `Subtitle / Tagline: "${cd.subtitle}"` : null,
    `Design standard: Match the production quality of bestselling published Islamic children\'s books (Kube Publishing, Prolance, Day of Difference level). Cinematic, emotionally rich, print-ready.`,
    // 4. Format constraints
    cd.selectedCoverTemplate && (cd.selectedCoverTemplate.includes('ornate') || cd.selectedCoverTemplate.includes('vintage'))
      ? 'FRAMING NOTE: This template uses ornate Islamic architectural elements as part of the scene composition — arches, carved wood, geometric panels are scene elements. However: NO flat page border overlay around the image edges. NO Arabic calligraphy band across the top or bottom. NO text border strip. The ornate elements must be INSIDE the scene as background architecture, not as a frame overlay printed over the illustration.'
      : NO_BORDER_BLOCK,
    SINGLE_PANEL,
    // 5. Dynamic layout zones (preview vs artwork-only)
    layoutZones,
    cd.titlePlacement ? `TITLE PLACEMENT — HARD RULE: Place the title text zone at "${cd.titlePlacement}". This is non-negotiable. The title zone MUST be at this exact position. Keep this area visually clean and lighter in tone.` : null,
    // 6. Project style lock (only when no template overrides it)
    conditionalStyleLock,
    // 7. Outfit + character identity
    outfitQuickRef,
    characterLockBlock,
    poseRefBlock,
    `Only ONE character may appear on the cover: ${protagonistOnly.map(c => c.name).join('') || 'the main protagonist only'}. Do NOT add siblings, babies, secondary characters, or any other people. ONE character only — the protagonist — as the sole focal point of the cover.`,
    defaultComposition,
    // 8. Atmosphere, background, motifs
    `Visual atmosphere: ${atmosphereNote}.`,
    defaultBackground,
    defaultIslamicMotifs,
    // 9. Age lock — injected last so it acts as a hard final override
    ageLock,
    // 10. Output rules
    finalRules,
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
  const effectiveTitle = cd.bookTitle || bookTitle;
  const bs = project?.bookStyle || {};

  const atmosphereNote = (ageMode === 'spreads-only' || ageMode === 'picture-book')
    ? (cd.atmosphere?.junior || cd.atmosphere?.middleGrade || 'Soft, bright, cheerful tones; warm and welcoming')
    : (cd.atmosphere?.middleGrade || cd.atmosphere?.junior || 'Warm cinematic tones; continuation of front cover mood');

  const styleNote = bs.artStyle
    ? `Match the exact same illustration style as the front cover: ${bs.artStyle}.`
    : 'Match the exact same illustration style as the front cover.';

  // Build back-cover KB directives
  const backKbLines = ['BACK COVER DESIGN — LOCKED DIRECTIVES (non-negotiable):'];

  // ── Back cover template (highest priority — overrides generic rules below) ──
  if (cd.selectedBackTemplate) {
    backKbLines.push(`• BACK COVER TEMPLATE ID: ${cd.selectedBackTemplate} — apply this template's full design system.`);
  }
  if (cd.backPromptDirective) {
    backKbLines.push(`• BACK COVER VISUAL TEMPLATE (primary directive): ${cd.backPromptDirective}`);
  }
  if (cd.backBackgroundStyle) {
    backKbLines.push(`• BACK COVER BACKGROUND STYLE: ${cd.backBackgroundStyle}`);
  }

  if (atmosphereNote) backKbLines.push(`• ATMOSPHERE LOCK: ${atmosphereNote}`);
  if (cd.colorStyle) backKbLines.push(`• COLOR STYLE: ${cd.colorStyle} — must match front cover exactly.`);
  else if (bs.colorPalette) backKbLines.push(`• COLOR PALETTE LOCK: ${bs.colorPalette} — must match front cover exactly.`);
  if (cd.lightingEffects) backKbLines.push(`• LIGHTING: ${cd.lightingEffects} — continuation of front cover lighting.`);
  else if (bs.lightingStyle) backKbLines.push(`• LIGHTING LOCK: ${bs.lightingStyle} — continuation of front cover lighting.`);
  if (cd.backgroundLayer) backKbLines.push(`• BACKGROUND ENVIRONMENT: ${cd.backgroundLayer}`);
  if (cd.islamicMotifs?.length) backKbLines.push(`• ISLAMIC MOTIFS (background/decorative only): ${cd.islamicMotifs.join(', ')}.`);
  if (cd.brandingRules?.length) backKbLines.push(`• BRANDING RULES: ${cd.brandingRules.join('. ')}.`);
  if (cd.avoidCover?.length) backKbLines.push(`• HARD NEVER — MUST AVOID: ${cd.avoidCover.join(', ')}.`);
  if (cd.publisherName) backKbLines.push(`• PUBLISHER: ${cd.publisherName} — reserve bottom-left zone for publisher details.`);
  if (cd.isbn) backKbLines.push(`• BARCODE ZONE: Reserve a clean white 2×1 inch rectangle at bottom-right corner for barcode — do NOT render any numbers or barcode lines, keep this zone pure white.`);
  if (cd.blurb) backKbLines.push(`• BLURB TEXT ZONE: The center 60% must stay clean and light enough for this synopsis text overlay: "${cd.blurb.substring(0, 120)}..."`);
  if (cd.extraNotes) backKbLines.push(`• EXTRA NOTES: ${cd.extraNotes}`);
  const backKbBlock = backKbLines.length > 1 ? backKbLines.join('\n') : null;

  return [
    `PROFESSIONAL PUBLISHED BOOK BACK COVER — Islamic children\'s book "${effectiveTitle}".`,
    `Design standard: Clean, editorial back cover matching premium Islamic children\'s book publishers. NO characters, NO people, NO figures of any kind.`,
    NO_BORDER_BLOCK,
    SINGLE_PANEL,
    backKbBlock,
    `BACK COVER LAYOUT — REQUIRED (artwork zones only — NO rendered text of any kind):
• TOP SECTION (top 15%): Keep completely clean — subtle Islamic ornamental header divider or crescent motif only. NO publisher name text rendered. NO logo text. Just clean decorative element.
• CENTER SECTION (middle 60%): Large clean lighter-toned panel — this entire zone must be a solid or very lightly textured surface with NO text, NO labels, NO placeholder text boxes visible. The panel must be BLANK and clean — synopsis text will be added in post-production.
• BOTTOM SECTION (bottom 25%): Keep completely clean. Bottom-left: a small dark rectangular zone — NO text rendered inside it. Bottom-right corner: a clean white 2×1 inch rectangular area — NO barcode numbers rendered, NO text. These are clean artwork zones only.
• ABSOLUTE RULE: Do NOT render any words, labels, placeholder text, fake text, lorem ipsum, or any readable or unreadable text anywhere on this image.`,
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

/**
 * Builds the spine prompt.
 *
 * A book spine is a narrow vertical strip (~0.5–1 inch wide, full book height).
 * It carries the title, author name, and optionally a publisher logo zone.
 * No characters — pure typographic + decorative design.
 *
 * previewMode=true  → render visible title + author text on the image
 * previewMode=false → clean artwork-only; text added in post-production
 */
function buildSpinePrompt({ project, bookTitle, authorName, kb, ageMode, previewMode = false }) {
  const cd = kb?.coverDesign || {};
  const bs = project?.bookStyle || {};

  const effectiveTitle = safeStr(cd.spineTitle) || safeStr(cd.bookTitle) || safeStr(bookTitle) || 'Book Title';
  const effectiveAuthor = safeStr(cd.spineAuthor) || safeStr(cd.authorName) || safeStr(authorName) || '';

  const colorScheme = safeStr(cd.spineColorBackground) || safeStr(cd.colorStyle) || safeStr(bs.colorPalette) || 'matching front cover palette';
  const lightingStyle = safeStr(cd.lightingEffects) || safeStr(bs.lightingStyle) || 'warm consistent lighting';

  // ── Spine KB directives (highest priority) ──────────────────────────────────
  const spineKbLines = ['SPINE DESIGN — LOCKED DIRECTIVES FROM KNOWLEDGE BASE:'];

  if (cd.spinePromptDirective) {
    spineKbLines.push(`• PRIMARY SPINE TEMPLATE (FOLLOW EXACTLY): ${cd.spinePromptDirective}`);
  }
  if (cd.spineColorBackground) {
    spineKbLines.push(`• SPINE BACKGROUND COLOR (locked — apply to entire spine): ${cd.spineColorBackground}`);
  } else if (cd.colorStyle) {
    spineKbLines.push(`• SPINE BACKGROUND COLOR: Derived from front cover — ${cd.colorStyle}. Must coordinate exactly.`);
  }
  if (cd.spineTypographyStyle) {
    spineKbLines.push(`• SPINE TYPOGRAPHY STYLE (locked): ${cd.spineTypographyStyle}`);
  }
  if (cd.islamicMotifs?.length) {
    spineKbLines.push(`• ISLAMIC MOTIFS (very subtle accent only — crescent, star, or geometric dot at spine endpoints): ${cd.islamicMotifs.slice(0, 2).join(', ')}.`);
  }
  if (cd.avoidCover?.length) {
    spineKbLines.push(`• HARD NEVER — MUST AVOID: ${cd.avoidCover.join(', ')}.`);
  }
  const spineKbBlock = spineKbLines.length > 1 ? spineKbLines.join('\n') : null;

  // ── Atmosphere per age group ─────────────────────────────────────────────────
  const atmosphereNote = (ageMode === 'spreads-only' || ageMode === 'picture-book')
    ? (safeStr(cd.atmosphere?.junior) || safeStr(cd.atmosphere?.middleGrade) || 'Warm, bright, cheerful tones matching front cover')
    : (safeStr(cd.atmosphere?.middleGrade) || safeStr(cd.atmosphere?.junior) || 'Rich warm tones matching front cover palette');

  // ── Typography block ─────────────────────────────────────────────────────────
  const typographyNote = safeStr(cd.spineTypographyStyle) || safeStr(cd.typographyTitle) ||
    ((ageMode === 'spreads-only' || ageMode === 'picture-book')
      ? (safeStr(cd.typography?.junior) || 'Bold rounded, clear and readable')
      : (safeStr(cd.typography?.middleGrade) || 'Elegant serif, clearly legible'));

  // ── Text zones: preview vs artwork-only ──────────────────────────────────────
  const textSection = previewMode
    ? `SPINE TEXT (PREVIEW MODE — render visible typography):
• TITLE: Render "${effectiveTitle}" reading from top to bottom (rotated 90° clockwise). Bold, styled typography matching "${typographyNote}". Clear, professional, high legibility.
• AUTHOR: Render "${effectiveAuthor || 'Author Name'}" in smaller complementary typography, positioned near the bottom of the spine.
• PUBLISHER ZONE: Reserve the very bottom 8% of the spine for a small publisher logo — keep clean.
• Text color must contrast clearly against the spine background.`
    : `SPINE TEXT ZONES (ARTWORK-ONLY — no text rendered):
• TITLE ZONE (top 10% to bottom 20%): Keep this vertical band clean — book title will be overlaid in post-production.
• AUTHOR ZONE (bottom 20%): Clean strip — author name added in post-production.
• PUBLISHER ZONE (very bottom 8%): Reserve clean space for publisher logo.
• Background must be clean enough for text overlay in contrasting color.`;

  return [
    // 1. KB directives FIRST
    spineKbBlock,
    // 2. Identity
    `PROFESSIONAL PUBLISHED BOOK SPINE — Islamic children's book "${effectiveTitle}"${effectiveAuthor ? ` by ${effectiveAuthor}` : ''}.`,
    `Design standard: Match the spine quality of premium Islamic children's publishers (Kube Publishing, Prolance, Day of Difference level).`,
    // 3. Format — spine specific
    `SPINE FORMAT REQUIREMENTS:
• NARROW VERTICAL FORMAT — this is the book spine (narrow strip, full book height)
• Background: Solid color or simple gradient — EXACTLY matching front cover palette: ${colorScheme}
• NO characters, NO people, NO figures, NO portraits — purely typographic and minimally decorative
• NO complex illustrations — a spine is a typographic design element, not an illustration panel
• Very subtle Islamic geometric texture may be used as background (optional, must be barely visible)
• NO borders, NO frames, NO heavy patterns that compete with the text zone
• Full-bleed — no white margins`,
    // 4. Text placement instructions
    textSection,
    // 5. Style rules
    `DESIGN RULES:
• Background color: ${colorScheme} — solid or 2-stop gradient, simple and clean
• Lighting: ${lightingStyle} — consistent with front and back covers
• Atmosphere: ${atmosphereNote}
• Typography personality: ${typographyNote}
• Accent motifs: Only at the very top or bottom of the spine — a single small crescent, star, or geometric shape. Nothing in the middle zone.
• The spine must look like it belongs with the front cover — same color family, same mood, same quality.`,
    // 6. Final quality
    `FINAL QUALITY RULES:
• Full-bleed portrait illustration, no white margins
• Professional print-ready quality at 300 DPI
• Background clean enough for high-contrast text overlay
• NO rendered text (unless previewMode was requested above)
• NO watermarks, NO borders, NO frames`,
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
  kb,
}) {
  const bs = project.bookStyle || {};
  const kbBg = kb?.backgroundSettings?.middleGrade;
  const sceneOverrides = buildScenePromptOverrides(sceneCharacters);

  // 1. Style anchor — FIRST for maximum CLIP weight
  const styleAnchor = ['FULL-BLEED DIGITAL ILLUSTRATION — no borders, no frames, no card edges, no decorative outline', universeStyle || bs.artStyle || 'Pixar 3D animation style', bs.colorPalette || kbBg?.colorStyle || 'warm pastels', 'Islamic children\'s chapter book interior illustration, professional quality'].join(', ') + '.';

  // 2. Scene — what is happening
  const scene = `Scene: ${moment.illustrationHint || moment.momentTitle}`;

  // 3. Environment — compact (scene-level values take priority; KB fills gaps)
  const lighting = bs.lightingStyle || kbBg?.lightingStyle || 'warm golden';
  const timeOfDay = moment.timeOfDay || kbBg?.timeOfDay || 'afternoon';
  const cameraHint = moment.cameraHint || kbBg?.cameraHint || 'medium';
  const envParts = ['SCENE LOCATION LOCK — this scene is ' + (moment.sceneEnvironment || 'indoor') + ' environment. Keep this location consistent. Do NOT switch rooms or settings.', 'Time: ' + timeOfDay, 'Lighting: ' + lighting, 'Camera: ' + cameraHint + ' shot'];
  if (kbBg?.tone) envParts.push(`Tone: ${kbBg.tone}`);
  const environment = envParts.join('. ') + '.';

  // 4. KB background directives — locations, keyFeatures, avoidBackgrounds,
  //    additionalNotes, universalRules (previously missing from chapter prompts)
  const kbBackgroundBlock = buildKbBackgroundBlock(kb, 'chapter-book');

  // 5. Contrast anchor — prevents identity blending between 2 characters
  const contrastAnchor = buildContrastAnchor(sceneCharacters);

  // 6. Format — one line
  const format = ['Full-bleed single illustration. No text, no borders, no frames, no extra characters.', 'Consistent ' + (universeStyle || 'Pixar 3D') + ' render style — match the shading, line quality, color saturation, and rendering quality of all other illustrations in this book exactly.'].join(' ');

  return [
    styleAnchor,          // style anchor FIRST — max CLIP weight
    scene,                // what is happening
    characterLockBlock,   // who they are (compact: name + color locks)
    poseLockBlock,        // pose descriptor per character
    contrastAnchor,       // visual distinction between 2 chars
    outfitQuickRef,       // outfit color quick reference
    poseRefBlock,         // portrait reference note
    crossPageAnchor,      // consistency note (1 line)
    environment,          // setting, lighting, time, camera, tone
    kbBackgroundBlock,    // locations, keyFeatures, avoidBackgrounds, universalRules
    sceneOverrides || null,
    format,
  ].filter(Boolean).join('\n');
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
  // IDENTITY FIX: portraits only — no pose sheets (multi-character sheets contaminate identity)
  const refs = [];
  for (const c of characters) {
    refs.push(...getPortraitRefs(c));
  }
  return uniqueStrings(refs);
}

function buildReferences(sceneCharacters, _selectedPoses = []) {
  // IDENTITY FIX: one portrait per character only.
  // Pose images and pose sheets are NEVER passed as references — they carry
  // identity information from a secondary (potentially inconsistent) source,
  // which causes the model to blend identities and drift from the master portrait.
  const refs = [];
  for (const c of sceneCharacters) {
    refs.push(...getPortraitRefs(c));
  }
  return uniqueStrings(refs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider wrapper
// ─────────────────────────────────────────────────────────────────────────────

function generateImageSafe(project, params, kb) {
  const extraNeg = safeStr(project?.bookStyle?.negativePrompt);
  const kbAvoid = (kb?.avoidTopics || []).join(', ');
  const negative_prompt = [BASE_NEGATIVE_PROMPT, extraNeg, kbAvoid]
    .filter(Boolean).join(', ');
  return generateImage({
    ...params,
    negative_prompt,
    guidance_scale: project?.bookStyle?.guidanceScale ?? 7.5,
    steps: project?.bookStyle?.inferenceSteps ?? 40,
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
      const { sceneCharacters, referenceCharacters, selectedPoses } = buildSceneSelection(allCharacters, {
        spread,
        names: spread.charactersInScene || [],
      });

      // const refs = uniqueStrings([
      //   ...buildReferences(sceneCharacters, selectedPoses),
      //   ...stableIdentityRefs,
      // ]);
      const refs = buildReferences(referenceCharacters, selectedPoses);

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
        kb,
        sceneEnvironment: spread.sceneEnvironment || 'indoor',
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

        const { sceneCharacters, referenceCharacters, selectedPoses } = buildSceneSelection(allCharacters, {
          spread,
          chapterData,
          names: spread.charactersInScene || chapterData.charactersInScene || [],
        });

        const refs = buildReferences(referenceCharacters, selectedPoses);

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
          kb,
          sceneEnvironment: spread.sceneEnvironment || 'indoor',
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

        const { sceneCharacters, referenceCharacters, selectedPoses } = buildSceneSelection(allCharacters, {
          moment,
          chapterData,
          names: moment.charactersInScene || chapterData.charactersInScene || [],
        });

        const refs = buildReferences(referenceCharacters, selectedPoses);
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
          kb,
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
  previewMode = false,
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
  let prompt;
  let refs = [];
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
      const referenceCharacters = sceneSelection.referenceCharacters;
      selectedPoses = sceneSelection.selectedPoses;
      refs = buildReferences(referenceCharacters, selectedPoses);

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
        kb,
        sceneEnvironment: spread.sceneEnvironment || 'indoor',
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
        const referenceCharacters = sceneSelection.referenceCharacters;
        selectedPoses = sceneSelection.selectedPoses;
        refs = buildReferences(referenceCharacters, selectedPoses);


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
          kb,
          sceneEnvironment: spread.sceneEnvironment || 'indoor',
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
        const referenceCharacters = sceneSelection.referenceCharacters;
        selectedPoses = sceneSelection.selectedPoses;
        refs = buildReferences(referenceCharacters, selectedPoses);

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
          kb,
        });
      }
    }
  } else if (task === 'cover') {
    // Story-aware cover character selection (respects characterMustInclude,
    // characterComposition role hints, and story/outline theme relevance)
    sceneCharacters = selectCoverCharacters(allCharacters, kb, project);

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
      previewMode,
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
  } else if (task === 'spine') {
    refs = [];

    prompt = buildSpinePrompt({
      project,
      bookTitle,
      authorName: safeStr(kb?.coverDesign?.authorName) || safeStr(project.authorName) || '',
      kb,
      ageMode: getAgeMode(project.ageRange),
      previewMode,
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
      new Error(`Unknown image task: "${task}". Valid tasks: illustration, illustrations, cover, back-cover, spine, character-style`),
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
  } else if (task === 'spine') {
    setFields['artifacts.cover'] = {
      ...(project.artifacts?.cover || {}),
      spineUrl: result.imageUrl,
      spinePrompt: prompt,
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