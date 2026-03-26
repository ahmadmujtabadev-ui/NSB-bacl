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
    weightCategory: visualDNA.weightCategory || '',

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

  return [
    `CHARACTER IDENTITY — STRICT LOCK`,
    `- Name: ${c.name}`,
    `- Gender: ${gender}`,
    `- Age range: ${c.ageRange || 'child'}`,
    vd.ageLook ? `- Age look: ${vd.ageLook}` : '',
    `- Role: ${c.role}`,

    ``,
    `FACE LOCK:`,
    vd.skinTone ? `- Skin tone: ${vd.skinTone}` : '',
    vd.eyeColor ? `- Eye color: ${vd.eyeColor}` : '',
    vd.faceShape ? `- Face shape: ${vd.faceShape}` : '',
    vd.eyebrowStyle ? `- Eyebrow style: ${vd.eyebrowStyle}` : '',
    vd.noseStyle ? `- Nose style: ${vd.noseStyle}` : '',
    vd.cheekStyle ? `- Cheek style: ${vd.cheekStyle}` : '',

    ``,
    `HAIR / HIJAB LOCK:`,
    mod.hijabAlways ? `- Hijab: ALWAYS visible` : `- Hijab: not required`,
    vd.hijabStyle ? `- Hijab style: ${vd.hijabStyle}` : '',
    vd.hijabColor ? `- Hijab color: ${vd.hijabColor}` : '',
    vd.hairStyle ? `- Hair style: ${vd.hairStyle}` : '',
    vd.hairColor ? `- Hair color: ${vd.hairColor}` : '',
    vd.hairVisibility ? `- Hair visibility: ${vd.hairVisibility}` : '',

    ``,
    `OUTFIT LOCK:`,
    vd.topGarmentType ? `- Top garment: ${vd.topGarmentType}` : '',
    vd.topGarmentColor ? `- Top garment color: ${vd.topGarmentColor}` : '',
    vd.topGarmentDetails ? `- Top garment details: ${vd.topGarmentDetails}` : '',
    vd.bottomGarmentType ? `- Bottom garment: ${vd.bottomGarmentType}` : '',
    vd.bottomGarmentColor ? `- Bottom garment color: ${vd.bottomGarmentColor}` : '',
    vd.shoeType ? `- Shoes: ${vd.shoeType}` : '',
    vd.shoeColor ? `- Shoe color: ${vd.shoeColor}` : '',
    vd.outfitRules ? `- Legacy outfit rules: ${vd.outfitRules}` : '',

    ``,
    `BODY LOCK — MUST BE ENFORCED IN EVERY IMAGE:`,
    vd.heightCm > 0
      ? `- Height: EXACTLY ${vd.heightCm}cm — enforce this relative to all other characters and objects in the scene`
      : (vd.heightFeel ? `- Height feel: ${vd.heightFeel}` : ''),
    vd.weightCategory ? `- Weight/body category: ${vd.weightCategory}` : '',
    vd.bodyBuild ? `- Build: ${vd.bodyBuild}` : '',

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
    `Speaking style: ${c.speakingStyle || 'warm and friendly'}`,

    ``,
    `CONSISTENCY LAW: identical face, outfit, colors, hijab/hair, body build, and height in every image. Height must stay locked — do NOT change the character's size across scenes.`,
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

function buildPosePromptForSinglePose(c, pose, style) {
  const cfg = c.promptConfig || {};

  const core = [
    `Single character pose reference for Islamic children's book.`,
    buildStrictCharacterDescription(c),
    `POSE REQUIREMENTS:`,
    `- Pose key: ${pose.poseKey}`,
    `- Pose label: ${pose.label}`,
    `- Usage context: ${(pose.useForScenes || []).join(', ') || 'general'}`,
    `- Full body visible`,
    `- Plain light neutral background`,
    `- Same exact face, outfit, colors, hijab/hair, and body proportions as portrait`,
    `- ${style} style`,
    `- no text, no extra characters, no background scene`,
  ].join('\n');

  return mergePromptParts(
    cfg.masterSystemNote,
    cfg.posePromptPrefix,
    core,
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
      speakingStyle,
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
      speakingStyle,
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
    if (req.body.speakingStyle !== undefined) c.speakingStyle = req.body.speakingStyle;
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
    c.masterReferenceUrl = c.imageUrl;
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
      masterReferenceUrl: c.masterReferenceUrl,
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
      c.masterReferenceUrl = c.imageUrl;
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
      references: [c.masterReferenceUrl || c.imageUrl],
      negative_prompt: IMAGE_NEGATIVE_PROMPT,
      projectId: c.universeId?.toString(),
      traceId: `posesheet_${c._id}_${Date.now()}`,
      style,
    });

    c.poseSheetUrl = await ensureCloudinaryUrl(
      result.imageUrl,
      `noorstudio/characters/${c._id}`,
      `posesheet_${Date.now()}`
    );

    c.poseLibrary = approvedPoses.map((pose, i) => ({
      poseKey: pose.poseKey,
      label: pose.label,
      approved: pose.approved !== false,
      priority: pose.priority ?? i,
      useForScenes: Array.isArray(pose.useForScenes) ? pose.useForScenes : [],
      notes: pose.notes || '',
      prompt: pose.prompt || buildPosePromptForSinglePose(c, pose, style),
      sourceSheetUrl: c.poseSheetUrl,
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
      poseSheetUrl: c.poseSheetUrl,
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

    if (prompt !== undefined) c.poseLibrary[idx].prompt = prompt;
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

    const prompt = req.body.prompt || pose.prompt || buildPosePromptForSinglePose(c, pose, style);
    console.log("prompt", prompt)
    const result = await generateImage({
      task: 'portrait',
      prompt,
      references: [c.masterReferenceUrl || c.imageUrl].filter(Boolean),
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

    c.poseLibrary[idx].prompt = prompt;
    c.poseLibrary[idx].imageUrl = uploaded;
    c.poseLibrary[idx].sourceSheetUrl = c.poseSheetUrl || '';

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
      c.masterReferenceUrl = c.imageUrl;
      changed = true;
    }

    if (c.poseSheetUrl && !c.poseSheetUrl.startsWith('https://')) {
      c.poseSheetUrl = await ensureCloudinaryUrl(
        c.poseSheetUrl,
        `noorstudio/characters/${c._id}`,
        'posesheet_migrated'
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
    c.masterReferenceUrl = c.imageUrl; // always sync to latest portrait on approve

    await c.save();
    res.json(c);
  } catch (e) {
    next(e);
  }
});

export default router;