import { Router } from 'express';
import { Character } from '../models/Character.js';
import { Universe } from '../models/Universe.js';
import { generateImage } from '../services/ai/image/image.providers.js';
import { deductCredits } from '../middleware/credits.js';
import { STAGE_CREDIT_COSTS } from '../services/ai/ai.billing.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';
import { v2 as cloudinary } from 'cloudinary';

const router = Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const DEFAULT_POSES = [
  { poseKey: 'standing', label: 'Standing', useForScenes: ['intro', 'neutral'] },
  { poseKey: 'sitting', label: 'Sitting', useForScenes: ['reading', 'thinking'] },
  { poseKey: 'walking', label: 'Walking', useForScenes: ['journey', 'hallway'] },
  { poseKey: 'running', label: 'Running', useForScenes: ['action', 'chase'] },
  { poseKey: 'waving', label: 'Waving', useForScenes: ['greeting'] },
  { poseKey: 'thinking', label: 'Thinking', useForScenes: ['reflection', 'decision'] },
  { poseKey: 'reading-quran', label: 'Reading Quran', useForScenes: ['learning', 'faith'] },
  { poseKey: 'praying-salah', label: 'Praying Salah', useForScenes: ['prayer'] },
  { poseKey: 'laughing', label: 'Laughing', useForScenes: ['joy'] },
  { poseKey: 'sad', label: 'Sad', useForScenes: ['mistake', 'loss'] },
  { poseKey: 'surprised', label: 'Surprised', useForScenes: ['discovery'] },
  { poseKey: 'kneeling', label: 'Kneeling', useForScenes: ['gentle-action'] },
];

const IMAGE_NEGATIVE_PROMPT =
  'text, letters, numbers, watermark, logo, extra fingers, extra hands, extra arms, duplicate character, ' +
  'wrong gender, wrong age, extra people, crowd, background people, distorted face, mismatched outfit, ' +
  'different clothing, different hijab, inconsistent colors, border, frame, card layout, collage, multi-panel, comic panel';

async function ensureCloudinaryUrl(imageUrl, folder, publicId) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('https://') || imageUrl.startsWith('http://')) return imageUrl;

  const dataUri = imageUrl.startsWith('data:')
    ? imageUrl
    : `data:image/png;base64,${imageUrl}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder,
    public_id: publicId,
    resource_type: 'image',
    overwrite: true,
  });

  return result.secure_url;
}

function deriveWeightCategory(heightCm, weightKg) {
  if (!heightCm || !weightKg || heightCm < 50 || weightKg < 5) return '';
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  if (bmi < 16.5) return 'slim';
  if (bmi < 21) return 'average';
  if (bmi < 25) return 'stocky';
  return 'heavy';
}

function normalizeVisualDNA(visualDNA = {}, modestyRules = {}) {
  const hijabAlways = !!modestyRules?.hijabAlways;
  const hairOrHijab = visualDNA.hairOrHijab || '';

  return {
    style: visualDNA.style || 'pixar-3d',
    gender: visualDNA.gender || '',
    ageLook: visualDNA.ageLook || '',

    skinTone: visualDNA.skinTone || '',
    eyeColor: visualDNA.eyeColor || '',
    faceShape: visualDNA.faceShape || '',
    eyebrowStyle: visualDNA.eyebrowStyle || '',
    noseStyle: visualDNA.noseStyle || '',
    cheekStyle: visualDNA.cheekStyle || '',

    hairStyle: visualDNA.hairStyle || (!hijabAlways ? hairOrHijab : ''),
    hairColor: visualDNA.hairColor || '',
    hairVisibility: visualDNA.hairVisibility || (hijabAlways ? 'hidden' : 'visible'),

    hijabStyle: visualDNA.hijabStyle || (hijabAlways ? 'neatly wrapped' : ''),
    hijabColor: visualDNA.hijabColor || '',

    topGarmentType: visualDNA.topGarmentType || '',
    topGarmentColor: visualDNA.topGarmentColor || '',
    topGarmentDetails: visualDNA.topGarmentDetails || '',

    bottomGarmentType: visualDNA.bottomGarmentType || '',
    bottomGarmentColor: visualDNA.bottomGarmentColor || '',

    shoeType: visualDNA.shoeType || '',
    shoeColor: visualDNA.shoeColor || '',

    bodyBuild: visualDNA.bodyBuild || '',
    heightFeel: visualDNA.heightFeel || '',
    heightCm: typeof visualDNA.heightCm === 'number' ? visualDNA.heightCm : 0,
    heightFeet: typeof visualDNA.heightFeet === 'number' ? visualDNA.heightFeet : 0,
    weightKg: typeof visualDNA.weightKg === 'number' ? visualDNA.weightKg : 0,
    weightCategory: deriveWeightCategory(
      typeof visualDNA.heightCm === 'number' ? visualDNA.heightCm : 0,
      typeof visualDNA.weightKg === 'number' ? visualDNA.weightKg : 0
    ),

    // Facial feature locks — critical for elder/adult character consistency
    facialHair: visualDNA.facialHair || '',
    glasses: visualDNA.glasses || '',

    accessories: Array.isArray(visualDNA.accessories) ? visualDNA.accessories : [],
    paletteNotes: visualDNA.paletteNotes || '',

    // legacy compatibility
    hairOrHijab,
    outfitRules: visualDNA.outfitRules || '',
  };
}

function mergePromptParts(...parts) {
  return parts.filter(Boolean).join('\n\n').trim();
}

function buildStrictCharacterDescription(c) {
  if (!c) return '';

  const vd = c.visualDNA || {};
  const mod = c.modestyRules || {};

  const gender = mod.hijabAlways
    ? 'girl'
    : (vd.gender ||
      (c.name?.toLowerCase().match(/^(ahmed|omar|ali|hassan|yusuf|ibrahim|adam|zaid|bilal)/)
        ? 'boy'
        : 'girl'));

  // Determine if this is an elder/adult character — they drift more between poses
  const ageNum = parseInt(c.ageRange) || 0;
  const isElder = ageNum >= 40 || (c.role || '').toLowerCase() === 'elder';

  // Build an explicit one-line skin tone anchor used at the TOP of every elder prompt
  const skinToneLine = vd.skinTone
    ? `⚠️ SKIN TONE LOCKED: "${vd.skinTone}" — this exact skin tone MUST appear on EVERY SINGLE POSE. DO NOT lighten, darken, or alter the skin tone between poses under any circumstances.`
    : '';

  return [
    `CHARACTER IDENTITY — STRICT LOCK`,
    `- Name: ${c.name}`,
    `- Gender: ${gender}`,
    `- Age range: ${c.ageRange || 'child'}`,
    vd.ageLook ? `- Age look: ${vd.ageLook}` : '',
    `- Role: ${c.role}`,

    // For elder characters, repeat skin tone at the very top before anything else
    isElder && skinToneLine ? `\n${skinToneLine}` : '',

    ``,
    `FACE LOCK — DO NOT CHANGE BETWEEN POSES:`,
    vd.skinTone
      ? `- Skin tone: ${vd.skinTone} — IDENTICAL in every pose, never lighter or darker`
      : '',
    vd.eyeColor ? `- Eye color: ${vd.eyeColor}` : '',
    vd.faceShape ? `- Face shape: ${vd.faceShape}` : '',
    vd.eyebrowStyle ? `- Eyebrow style: ${vd.eyebrowStyle}` : '',
    vd.noseStyle ? `- Nose style: ${vd.noseStyle}` : '',
    vd.cheekStyle ? `- Cheek style: ${vd.cheekStyle}` : '',
    // For elder characters, reinforce aging details explicitly
    isElder ? `- ELDER CHARACTER: preserve all aging cues (wrinkles, grey hair/beard, aged skin tone) in EVERY pose` : '',
    isElder && vd.facialHair ? `- ELDER FACIAL HAIR ANCHOR: the "${vd.facialHair}" MUST appear in EVERY single pose — same colour, same style, same density` : '',

    ``,
    `HAIR / HIJAB LOCK:`,
    mod.hijabAlways ? `- Hijab: ALWAYS visible` : `- Hijab: not required`,
    vd.hijabStyle ? `- Hijab style: ${vd.hijabStyle}` : '',
    vd.hijabColor ? `- Hijab color: ${vd.hijabColor}` : '',
    vd.hairStyle ? `- Hair style: ${vd.hairStyle}` : '',
    vd.hairColor ? `- Hair color: ${vd.hairColor}` : '',
    vd.hairVisibility ? `- Hair visibility: ${vd.hairVisibility}` : '',

    ``,
    `FACIAL FEATURE LOCKS — NEVER CHANGE BETWEEN IMAGES:`,
    vd.facialHair
      ? `- FACIAL HAIR: ALWAYS SHOW — ${vd.facialHair} (never remove, never change style or color between poses)`
      : `- FACIAL HAIR: NONE — completely clean-shaven, NO beard, NO mustache, NO stubble — NEVER add any facial hair`,
    vd.glasses
      ? `- GLASSES: ALWAYS WEARING — ${vd.glasses} (never remove glasses from this character)`
      : `- GLASSES: NONE — this character does NOT wear glasses — NEVER add glasses or spectacles`,

    ``,
    `OUTFIT LOCK:`,
    vd.topGarmentType ? `- Top garment: ${vd.topGarmentType}` : '',
    vd.topGarmentColor ? `- Top garment color: ${vd.topGarmentColor}` : '',
    vd.topGarmentDetails ? `- Top garment details: ${vd.topGarmentDetails}` : '',
    vd.bottomGarmentType ? `- Bottom garment: ${vd.bottomGarmentType}` : '',
    vd.bottomGarmentColor ? `- Bottom garment color: ${vd.bottomGarmentColor}` : '',
    vd.shoeType ? `- Shoes: ${vd.shoeType}` : '',
    vd.shoeColor ? `- Shoe color: ${vd.shoeColor}` : '',
    vd.outfitRules ? `- Outfit rules: ${vd.outfitRules}` : '',

    ``,
    `BODY LOCK — MUST BE ENFORCED IN EVERY IMAGE:`,
    vd.heightCm > 0
      ? `- Height: EXACTLY ${vd.heightCm}cm — enforce this relative to all other characters and objects in the scene`
      : (vd.heightFeel ? `- Height feel: ${vd.heightFeel}` : ''),
    vd.weightKg > 0 ? `- Weight: EXACTLY ${vd.weightKg}kg` : '',
    vd.heightFeet > 0 ? `- Height in feet: approx ${vd.heightFeet} ft` : '',
    vd.weightCategory ? `- Body build category: ${vd.weightCategory}` : '',
    vd.bodyBuild ? `- Build notes: ${vd.bodyBuild}` : '',

    ``,
    `MODESTY RULES:`,
    mod.hijabAlways ? `- Hijab always` : '',
    mod.longSleeves ? `- Long sleeves always` : '',
    mod.looseClothing ? `- Loose clothing always` : '',
    mod.notes ? `- Notes: ${mod.notes}` : '',

    ``,
    `ACCESSORIES / PALETTE:`,
    (vd.accessories || []).length ? `- Accessories: ${vd.accessories.join(', ')}` : '',
    vd.paletteNotes ? `- Palette notes: ${vd.paletteNotes}` : '',

    ``,
    `PERSONALITY: ${(c.traits || []).join(', ')}`,

    ``,
    `CONSISTENCY LAW: identical face, skin tone, outfit, colors, hijab/hair, body build, and height in EVERY SINGLE POSE. The portrait reference image attached is the GROUND TRUTH — match it exactly. Height must stay locked — do NOT change the character's size across scenes.`,
    isElder ? `ELDER CONSISTENCY LAW: elderly characters are the hardest to keep consistent. Pay extra attention to: (1) skin tone exact match, (2) facial hair exact match, (3) wrinkles/aging preserved, (4) hair colour exact match. DO NOT make the character look younger in any pose.` : '',
  ].filter(Boolean).join('\n');
}

function buildPortraitPrompt(c, style) {
  const cfg = c.promptConfig || {};

  const core = [
    `Master character portrait for Islamic children's book.`,
    buildStrictCharacterDescription(c),
    `PORTRAIT REQUIREMENTS:`,
    `- full body`,
    `- front-facing`,
    `- plain warm background`,
    `- expression: warm, friendly, calm`,
    `- render style: ${style} children’s illustration, polished and clean`,
    `- warm golden lighting`,
    `- no text, no watermark, no other characters`,
    `- this is the MASTER REFERENCE for all chapters and spreads`,
  ].join('\n');

  return mergePromptParts(
    cfg.masterSystemNote,
    cfg.portraitPromptPrefix,
    core,
    cfg.portraitPromptSuffix
  );
}

/**
 * Build the full prompt for a single pose image.
 * @param {object} c - Character document
 * @param {object} pose - Pose object from poseLibrary
 * @param {string} style - Art style string
 * @param {string|null} coreOverride - When set, replaces the auto-generated core with the
 *   user's custom text. The master note + prefix/suffix are ALWAYS applied regardless.
 */
function buildPosePromptForSinglePose(c, pose, style, coreOverride = null) {
  const cfg = c.promptConfig || {};
  const vd = c.visualDNA || {};
  const ageNum = parseInt(c.ageRange) || 0;
  const isElder = ageNum >= 40 || (c.role || '').toLowerCase() === 'elder';

  // Hard skin-tone anchor repeated at start and end — prevents AI drift
  const skinAnchor = vd.skinTone
    ? `SKIN TONE ANCHOR: ${c.name}'s skin tone is "${vd.skinTone}" — DO NOT change it from the attached portrait reference under any circumstances.`
    : '';

  const elderAnchor = isElder && vd.facialHair
    ? `ELDER ANCHOR: ${c.name} is an elder. Preserve ALL aging: "${vd.facialHair}" beard, aged skin, grey hair/beard colours — identical to the portrait reference attached.`
    : '';

  // Auto-generated core — used when user hasn't supplied a custom core
  const autoCore = [
    skinAnchor,
    elderAnchor,
    `Single character pose reference for Islamic children's book.`,
    buildStrictCharacterDescription(c),
    `POSE REQUIREMENTS:`,
    `- Pose key: ${pose.poseKey}`,
    `- Pose label: ${pose.label}`,
    `- Usage context: ${(pose.useForScenes || []).join(', ') || 'general'}`,
    `- Full body visible`,
    `- Plain light neutral background (light grey or off-white)`,
    `- MATCH PORTRAIT REFERENCE IMAGE ATTACHED — same exact skin tone, face, outfit, colors, hijab/hair, and body proportions`,
    `- ${style} style`,
    `- no text, no extra characters, no background scene`,
    skinAnchor ? `FINAL CHECK: ${skinAnchor}` : '',
  ].filter(Boolean).join('\n');

  // Master note + prefix/suffix are ALWAYS applied — core can be overridden by user
  return mergePromptParts(
    cfg.masterSystemNote,
    cfg.posePromptPrefix,
    coreOverride || autoCore,
    cfg.posePromptSuffix
  );
}

function buildPoseSheetPrompt(c, poseCount, style) {
  const cfg = c.promptConfig || {};

  const core = [
    `Character pose reference sheet for Islamic children's book.`,
    buildStrictCharacterDescription(c),
    `POSE SHEET REQUIREMENTS:`,
    `- ${poseCount} poses in a clean simple grid`,
    `- same exact face, outfit, colors, hijab/hair in every pose`,
    `- plain light background`,
    `- ${style} style`,
    `- no background scenes, no extra characters`,
    `- no labels required inside image`,
    `- this sheet is a visual consistency sheet only`,
  ].join('\n');

  return mergePromptParts(
    cfg.masterSystemNote,
    cfg.posePromptPrefix,
    core,
    cfg.posePromptSuffix
  );
}

async function getCharacterForUser(characterId, userId) {
  const c = await Character.findById(characterId);
  if (!c) throw new NotFoundError('Character not found');
  if (!c.userId.equals(userId)) throw new ForbiddenError();
  return c;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const filter = { userId: req.user._id };
    if (req.query.universeId) filter.universeId = req.query.universeId;
    res.json(await Character.find(filter).sort({ updatedAt: -1 }));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      universeId,
      name,
      role,
      ageRange,
      traits,
      visualDNA,
      modestyRules,
    } = req.body;

    if (!name?.trim() || !universeId) {
      throw new ValidationError('name and universeId are required');
    }

    const universe = await Universe.findById(universeId);
    if (!universe) throw new NotFoundError('Universe not found');
    if (!universe.userId.equals(req.user._id)) throw new ForbiddenError();

    const normalizedVisualDNA = normalizeVisualDNA(visualDNA, modestyRules);

    const char = await Character.create({
      userId: req.user._id,
      universeId,
      name: name.trim(),
      role,
      ageRange,
      traits,
      visualDNA: normalizedVisualDNA,
      modestyRules,
      poseLibrary: DEFAULT_POSES.map((p, i) => ({
        ...p,
        priority: i,
        approved: true,
        prompt: '',
        sourceSheetUrl: '',
      })),
      approvedPoseKeys: DEFAULT_POSES.map((p) => p.poseKey),
      promptConfig: {
        masterSystemNote: '',
        portraitPromptPrefix: '',
        portraitPromptSuffix: '',
        posePromptPrefix: '',
        posePromptSuffix: '',
        scenePromptPrefix: '',
        scenePromptSuffix: '',
      },
    });

    res.status(201).json(char);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);
    res.json(c);
  } catch (e) {
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    if (req.body.name !== undefined) c.name = req.body.name;
    if (req.body.role !== undefined) c.role = req.body.role;
    if (req.body.ageRange !== undefined) c.ageRange = req.body.ageRange;
    if (req.body.traits !== undefined) c.traits = req.body.traits;
    if (req.body.modestyRules !== undefined) c.modestyRules = req.body.modestyRules;
    if (req.body.status !== undefined) c.status = req.body.status;
    if (req.body.poseLibrary !== undefined) c.poseLibrary = req.body.poseLibrary;
    if (req.body.approvedPoseKeys !== undefined) c.approvedPoseKeys = req.body.approvedPoseKeys;
    if (req.body.promptConfig !== undefined) {
      c.promptConfig = {
        ...(c.promptConfig || {}),
        ...req.body.promptConfig,
      };
    }

    if (req.body.visualDNA !== undefined) {
      c.visualDNA = normalizeVisualDNA(req.body.visualDNA, c.modestyRules);
    }

    await c.save();
    res.json(c);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);
    await c.deleteOne();
    res.json({ message: 'Character deleted' });
  } catch (e) {
    next(e);
  }
});

// ─── NEW: update prompt config ───────────────────────────────────────────────

router.put('/:id/prompt-config', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    const allowed = [
      'masterSystemNote',
      'portraitPromptPrefix',
      'portraitPromptSuffix',
      'posePromptPrefix',
      'posePromptSuffix',
      'scenePromptPrefix',
      'scenePromptSuffix',
    ];

    const nextConfig = { ...(c.promptConfig || {}) };
    for (const key of allowed) {
      if (req.body[key] !== undefined) nextConfig[key] = req.body[key];
    }

    c.promptConfig = nextConfig;

    // When masterSystemNote changes, clear any pose.prompt values that are old
    // auto-generated assembled prompts (they contain system markers). This forces
    // the next "Regen All" to rebuild fresh with the current master note.
    const masterChanged = req.body.masterSystemNote !== undefined;
    if (masterChanged && Array.isArray(c.poseLibrary)) {
      const AUTO_MARKERS = [
        'POSE REQUIREMENTS:',
        'CHARACTER IDENTITY',
        'Single character pose reference',
        'CONSISTENCY LAW:',
      ];
      c.poseLibrary = c.poseLibrary.map((pose) => {
        const isAutoGenerated = AUTO_MARKERS.some((marker) =>
          (pose.prompt || '').includes(marker)
        );
        if (isAutoGenerated) {
          return { ...pose.toObject ? pose.toObject() : pose, prompt: '' };
        }
        return pose;
      });
      c.markModified('poseLibrary');
    }

    await c.save();

    res.json(c);
  } catch (e) {
    next(e);
  }
});

// ─── Generate portrait ────────────────────────────────────────────────────────

router.post('/:id/generate-portrait', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    const style = req.body.style || c.visualDNA?.style || 'pixar-3d';
    const cost = STAGE_CREDIT_COSTS.portrait ?? 4;

    if (req.user.credits < cost) {
      return res.status(402).json({
        error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` },
      });
    }

    const prompt = buildPortraitPrompt(c, style);

    const result = await generateImage({
      task: 'portrait',
      prompt,
      negative_prompt: IMAGE_NEGATIVE_PROMPT,
      projectId: c.universeId?.toString(),
      traceId: `portrait_${c._id}_${Date.now()}`,
      style,
    });

    c.imageUrl = await ensureCloudinaryUrl(
      result.imageUrl,
      `noorstudio/characters/${c._id}`,
      `portrait_${Date.now()}`
    );
    c.selectedStyle = style;
    c.styleApprovedAt = new Date();
    c.status = 'generated';
    c.generationMeta = {
      ...(c.generationMeta || {}),
      portraitPrompt: prompt,
    };

    await c.save();
    await deductCredits(req.user._id, cost, `Portrait: ${c.name}`, 'project');

    res.json({
      character: c,
      imageUrl: c.imageUrl,
      prompt,
      provider: result.provider,
    });
  } catch (e) {
    next(e);
  }
});

// ─── NEW: apply master prompt rules to all pose prompts ──────────────────────

router.post('/:id/apply-master-to-poses', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    const style = req.body.style || c.selectedStyle || c.visualDNA?.style || 'pixar-3d';

    c.poseLibrary = (c.poseLibrary || []).map((pose) => ({
      ...pose.toObject?.() || pose,
      prompt: buildPosePromptForSinglePose(c, pose, style),
    }));

    c.approvedPoseKeys = c.poseLibrary.filter((p) => p.approved).map((p) => p.poseKey);

    await c.save();
    res.json(c);
  } catch (e) {
    next(e);
  }
});

// ─── Generate pose sheet ──────────────────────────────────────────────────────

router.post('/:id/generate-pose-sheet', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    if (!c.imageUrl) {
      throw new ValidationError('Generate a portrait first before creating a pose sheet');
    }

    if (!c.imageUrl.startsWith('https://')) {
      c.imageUrl = await ensureCloudinaryUrl(
        c.imageUrl,
        `noorstudio/characters/${c._id}`,
        `portrait_migrated_${Date.now()}`
      );
      await c.save();
    }

    const style = req.body.style || c.selectedStyle || c.visualDNA?.style || 'pixar-3d';
    const cost = STAGE_CREDIT_COSTS.poseSheet ?? 6;

    if (req.user.credits < cost) {
      return res.status(402).json({
        error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` },
      });
    }

    const approvedPoses =
      Array.isArray(req.body.poses) && req.body.poses.length
        ? req.body.poses
        : (c.poseLibrary?.length ? c.poseLibrary : DEFAULT_POSES);

    const poseCount = approvedPoses.length;
    const prompt = buildPoseSheetPrompt(c, poseCount, style);

    const result = await generateImage({
      task: 'pose-sheet',
      prompt,
      references: [c.imageUrl],
      negative_prompt: IMAGE_NEGATIVE_PROMPT,
      projectId: c.universeId?.toString(),
      traceId: `posesheet_${c._id}_${Date.now()}`,
      style,
    });

    c.poseLibrary = approvedPoses.map((pose, i) => ({
      poseKey: pose.poseKey,
      label: pose.label,
      approved: pose.approved !== false,
      priority: pose.priority ?? i,
      useForScenes: Array.isArray(pose.useForScenes) ? pose.useForScenes : [],
      notes: pose.notes || '',
      prompt: pose.prompt || buildPosePromptForSinglePose(c, pose, style),
      sourceSheetUrl: '',
      imageUrl: pose.imageUrl || '',
    }));

    c.approvedPoseKeys = c.poseLibrary
      .filter((p) => p.approved)
      .map((p) => p.poseKey);

    c.status = 'generated';
    c.generationMeta = {
      ...(c.generationMeta || {}),
      poseSheetPrompt: prompt,
      poseCount,
    };

    await c.save();
    await deductCredits(req.user._id, cost, `Pose sheet: ${c.name}`, 'project');

    res.json({
      character: c,
      poseLibrary: c.poseLibrary,
      prompt,
      provider: result.provider,
    });
  } catch (e) {
    next(e);
  }
});

// ─── NEW: update one pose prompt ─────────────────────────────────────────────

router.put('/:id/poses/:poseKey/prompt', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    const { prompt, approved, notes, useForScenes, label, priority } = req.body;
    const poseKey = req.params.poseKey;

    const idx = (c.poseLibrary || []).findIndex((p) => p.poseKey === poseKey);
    if (idx === -1) throw new NotFoundError('Pose not found');

    // Save only the user's custom core (empty string = clear, auto-generate on next regen)
    if (prompt !== undefined) c.poseLibrary[idx].prompt = prompt.trim();
    if (approved !== undefined) c.poseLibrary[idx].approved = !!approved;
    if (notes !== undefined) c.poseLibrary[idx].notes = notes;
    if (label !== undefined) c.poseLibrary[idx].label = label;
    if (priority !== undefined) c.poseLibrary[idx].priority = Number(priority) || 0;
    if (useForScenes !== undefined) {
      c.poseLibrary[idx].useForScenes = Array.isArray(useForScenes) ? useForScenes : [];
    }

    c.approvedPoseKeys = c.poseLibrary.filter((p) => p.approved).map((p) => p.poseKey);

    await c.save();
    res.json(c);
  } catch (e) {
    next(e);
  }
});

// ─── Batch: generate images for all (or missing) poses at once ───────────────

router.post('/:id/poses/generate-all-images', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    if (!c.imageUrl) {
      throw new ValidationError('Generate a portrait first before generating pose images');
    }     

    const style = req.body.style || c.selectedStyle || c.visualDNA?.style || 'pixar-3d';
    const forceAll = req.body.force === true; // regenerate even if imageUrl already exists

    const posesToGenerate = (c.poseLibrary || []).filter(
      (p) => p.approved !== false && (forceAll || !p.imageUrl)
    );

    if (posesToGenerate.length === 0) {
      return res.json({ character: c, generated: 0, message: 'All poses already have images' });
    }

    const costPerPose = STAGE_CREDIT_COSTS.illustration ?? 4;
    const totalCost = posesToGenerate.length * costPerPose;

    if (req.user.credits < totalCost) {
      return res.status(402).json({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: `Need ${totalCost} credits for ${posesToGenerate.length} poses (${costPerPose} cr each)`,
        },
      });
    }

    // Deduct all credits upfront
    await deductCredits(req.user._id, totalCost, `Batch pose images: ${c.name} (${posesToGenerate.length} poses)`, 'project');

    // Generate sequentially to avoid rate limits
    let generated = 0;
    for (const poseRef of posesToGenerate) {
      const idx = c.poseLibrary.findIndex((p) => p.poseKey === poseRef.poseKey);
      if (idx === -1) continue;
      try {
        const pose = c.poseLibrary[idx];
        // pose.prompt is the user's custom core (not the assembled prompt).
        // Always rebuild through the builder so masterSystemNote is applied fresh.
        // Guard against old data: if pose.prompt is the old full assembled prompt,
        // ignore it so the builder generates a clean prompt from current master note.
        const AUTO_MARKERS = ['POSE REQUIREMENTS:', 'CHARACTER IDENTITY', 'Single character pose reference', 'CONSISTENCY LAW:'];
        const isOldAssembled = AUTO_MARKERS.some((m) => (pose.prompt || '').includes(m));
        const customCore = isOldAssembled ? null : (pose.prompt || null);
        const prompt = buildPosePromptForSinglePose(c, pose, style, customCore);
        const result = await generateImage({
          task: 'portrait',
          prompt,
          references: [c.imageUrl].filter(Boolean),
          negative_prompt: IMAGE_NEGATIVE_PROMPT,
          projectId: c.universeId?.toString(),
          traceId: `pose_${c._id}_${pose.poseKey}_${Date.now()}`,
          style,
        });
        const uploaded = await ensureCloudinaryUrl(
          result.imageUrl,
          `noorstudio/characters/${c._id}/poses`,
          `${pose.poseKey}_${Date.now()}`
        );
        // Only update imageUrl — do NOT overwrite pose.prompt (user's custom core)
        c.poseLibrary[idx].imageUrl = uploaded;
        generated++;
      } catch (poseErr) {
        console.error(`Failed to generate pose ${poseRef.poseKey}:`, poseErr.message);
        // Continue with remaining poses
      }
    }

    await c.save();

    res.json({ character: c, generated, total: posesToGenerate.length });
  } catch (e) {
    next(e);
  }
});

// ─── NEW: regenerate one pose image using its own prompt ─────────────────────

router.post('/:id/poses/:poseKey/regenerate', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    if (!c.masterReferenceUrl && !c.imageUrl) {
      throw new ValidationError('Generate portrait first before regenerating a pose');
    }

    const poseKey = req.params.poseKey;
    const idx = (c.poseLibrary || []).findIndex((p) => p.poseKey === poseKey);
    if (idx === -1) throw new NotFoundError('Pose not found');

    const pose = c.poseLibrary[idx];
    const style = req.body.style || c.selectedStyle || c.visualDNA?.style || 'pixar-3d';
    const cost = STAGE_CREDIT_COSTS.illustration ?? 4;

    if (req.user.credits < cost) {
      return res.status(402).json({
        error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` },
      });
    }

    // User's custom core: from request body (dialog edit) or previously saved custom core.
    // masterSystemNote + posePromptPrefix/Suffix are ALWAYS injected by buildPosePromptForSinglePose.
    const customCore = req.body.prompt !== undefined ? req.body.prompt : (pose.prompt || null);
    const prompt = buildPosePromptForSinglePose(c, pose, style, customCore || null);
    console.log("pose regenerate prompt", prompt);

    const result = await generateImage({
      task: 'portrait',
      prompt,
      references: [c.imageUrl].filter(Boolean),
      negative_prompt: IMAGE_NEGATIVE_PROMPT,
      projectId: c.universeId?.toString(),
      traceId: `pose_${c._id}_${pose.poseKey}_${Date.now()}`,
      style,
    });

    const uploaded = await ensureCloudinaryUrl(
      result.imageUrl,
      `noorstudio/characters/${c._id}/poses`,
      `${pose.poseKey}_${Date.now()}`
    );

    // Save only the user's custom core (not the assembled prompt) so that
    // future regenerations always pick up the latest masterSystemNote freshly.
    if (req.body.prompt !== undefined) {
      c.poseLibrary[idx].prompt = req.body.prompt;
    }
    c.poseLibrary[idx].imageUrl = uploaded;
    c.poseLibrary[idx].sourceSheetUrl = '';

    await c.save();
    await deductCredits(req.user._id, cost, `Pose regenerate: ${c.name}/${pose.poseKey}`, 'project');

    res.json({
      character: c,
      pose: c.poseLibrary[idx],
      imageUrl: uploaded,
      prompt,
      provider: result.provider,
    });
  } catch (e) {
    next(e);
  }
});

// ─── Update entire pose library ──────────────────────────────────────────────

router.put('/:id/poses', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    const { poseLibrary } = req.body;
    if (!Array.isArray(poseLibrary)) {
      throw new ValidationError('poseLibrary must be an array');
    }

    c.poseLibrary = poseLibrary;
    c.approvedPoseKeys = poseLibrary.filter((p) => p.approved).map((p) => p.poseKey);

    await c.save();
    res.json(c);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/fix-storage', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    let changed = false;

    if (c.imageUrl && !c.imageUrl.startsWith('https://')) {
      c.imageUrl = await ensureCloudinaryUrl(
        c.imageUrl,
        `noorstudio/characters/${c._id}`,
        'portrait_migrated'
      );
      changed = true;
    }

    if (changed) await c.save();

    res.json({ character: c, migrated: changed });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    const c = await getCharacterForUser(req.params.id, req.user._id);

    if (!c.imageUrl) {
      throw new ValidationError('Character must have a portrait before approval');
    }

    c.status = 'approved';

    await c.save();
    res.json(c);
  } catch (e) {
    next(e);
  }
});

export default router;