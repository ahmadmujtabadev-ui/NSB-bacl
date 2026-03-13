import { Router }        from 'express';
import { Character }     from '../models/Character.js';
import { Universe }      from '../models/Universe.js';
import { generateImage } from '../services/ai/image/image.providers.js';
import { deductCredits } from '../middleware/credits.js';
import { STAGE_CREDIT_COSTS } from '../services/ai/ai.billing.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';
import { v2 as cloudinary } from 'cloudinary';

const router = Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// ─── Helper: migrate base64 → Cloudinary URL ──────────────────────────────────
async function ensureCloudinaryUrl(imageUrl, folder, publicId) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('https://') || imageUrl.startsWith('http://')) return imageUrl;
  const dataUri = imageUrl.startsWith('data:') ? imageUrl : `data:image/png;base64,${imageUrl}`;
  console.log(`[Characters] Uploading to Cloudinary: ${folder}/${publicId}`);
  const result = await cloudinary.uploader.upload(dataUri, {
    folder, public_id: publicId, resource_type: 'image', overwrite: true,
  });
  console.log(`[Characters] Cloudinary OK: ${result.secure_url}`);
  return result.secure_url;
}

// ─── Strict character description (exported for image.service.js) ─────────────
export function buildStrictCharacterDescription(c) {
  if (!c) return '';
  const vd  = c.visualDNA    || {};
  const mod = c.modestyRules || {};
  const gender = mod.hijabAlways
    ? 'girl'
    : (vd.gender || (c.name?.toLowerCase().match(/^(ahmed|omar|ali|hassan|yusuf|ibrahim|adam|zaid|bilal)/) ? 'boy' : 'girl'));

  return [
    `CHARACTER IDENTITY (follow strictly in every image):`,
    `- Name: ${c.name}`,
    `- Gender: ${gender} — ALWAYS draw as a ${gender}, never switch gender`,
    `- Age range: ${c.ageRange || 'child'}`,
    `- Role: ${c.role}`,
    ``,
    `VISUAL DNA (must match exactly — no deviations):`,
    vd.skinTone    ? `- Skin tone: ${vd.skinTone}`     : '',
    vd.eyeColor    ? `- Eyes: ${vd.eyeColor}`           : '',
    vd.faceShape   ? `- Face shape: ${vd.faceShape}`    : '',
    vd.hairOrHijab ? `- Hair/Hijab: ${vd.hairOrHijab}` : '',
    vd.outfitRules ? `- Outfit: ${vd.outfitRules}`      : '',
    vd.accessories ? `- Accessories: ${vd.accessories}` : '',
    ``,
    `MODESTY RULES (non-negotiable, always enforce):`,
    mod.hijabAlways   ? `- Hijab: ALWAYS visible, never remove under any circumstance` : `- No hijab required`,
    mod.longSleeves   ? `- Long sleeves: always`   : '',
    mod.looseClothing ? `- Loose clothing: always` : '',
    ``,
    `PERSONALITY: ${(c.traits || []).join(', ')}`,
    `Speaking style: ${c.speakingStyle || 'warm and friendly'}`,
    ``,
    `CONSISTENCY RULE: This character must look IDENTICAL in every single spread.`,
    `Same face shape, same skin tone, same outfit, same hair/hijab. Never alter appearance.`,
  ].filter(Boolean).join('\n');
}

// ─── Portrait prompt ──────────────────────────────────────────────────────────
function buildPortraitPrompt(c, style) {
  return [
    `Master character portrait for a children's Islamic book.`,
    buildStrictCharacterDescription(c),
    `PORTRAIT REQUIREMENTS:`,
    `- Full body, front-facing, plain warm background`,
    `- Expression: warm, friendly smile`,
    `- ${style} illustration style, Pixar-quality 3D render`,
    `- Warm golden lighting, child-friendly`,
    `- No text, no watermark, no other characters`,
    `- This is the MASTER REFERENCE used for all book illustrations`,
  ].join('\n');
}

// ─── Pose sheet prompt ────────────────────────────────────────────────────────
function buildPoseSheetPrompt(c, poseCount) {
  return [
    `Character pose reference sheet for children's Islamic book.`,
    buildStrictCharacterDescription(c),
    `POSE SHEET REQUIREMENTS:`,
    `- ${poseCount} poses in a clean labelled grid`,
    `- Poses: standing, sitting, running, waving, thinking, reading Quran,`,
    `  praying (salah), laughing, sad, surprised, walking, kneeling`,
    `- IDENTICAL character appearance across all poses — same face, outfit, hair/hijab`,
    `- Plain light grey background per cell, Pixar 3D style, consistent lighting`,
    `- No background scenes, no extra characters`,
    `- This sheet is the REFERENCE for all book illustration consistency`,
  ].join('\n');
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const filter = { userId: req.user._id };
    if (req.query.universeId) filter.universeId = req.query.universeId;
    res.json(await Character.find(filter).sort({ updatedAt: -1 }));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { universeId, name, role, ageRange, traits, speakingStyle, visualDNA, modestyRules } = req.body;
    if (!name?.trim() || !universeId) throw new ValidationError('name and universeId are required');
    const universe = await Universe.findById(universeId);
    if (!universe) throw new NotFoundError('Universe not found');
    if (!universe.userId.equals(req.user._id)) throw new ForbiddenError();
    const char = await Character.create({
      userId: req.user._id, universeId, name: name.trim(),
      role, ageRange, traits, speakingStyle, visualDNA, modestyRules,
    });
    res.status(201).json(char);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError();
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    res.json(c);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError();
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    ['name','role','ageRange','traits','speakingStyle','visualDNA','modestyRules','status']
      .forEach(f => { if (req.body[f] !== undefined) c[f] = req.body[f]; });
    await c.save();
    res.json(c);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError();
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    await c.deleteOne();
    res.json({ message: 'Character deleted' });
  } catch (e) { next(e); }
});

// ─── Portrait Generation ──────────────────────────────────────────────────────

router.post('/:id/generate-portrait', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError();
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();

    const cost = STAGE_CREDIT_COSTS.portrait ?? 4;
    if (req.user.credits < cost) {
      return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` } });
    }

    const result = await generateImage({
      task:      'portrait',
      prompt:    buildPortraitPrompt(c, req.body.style || 'pixar-3d'),
      projectId: c.universeId?.toString(),
      traceId:   `portrait_${c._id}_${Date.now()}`,
      style:     req.body.style || 'pixar-3d',
    });

    // Double-safety: ensure it's a Cloudinary URL, not base64
    c.imageUrl = await ensureCloudinaryUrl(
      result.imageUrl,
      `noorstudio/characters/${c._id}`,
      `portrait_${Date.now()}`
    );
    c.status = 'generated';
    await c.save();
    await deductCredits(req.user._id, cost, `Portrait: ${c.name}`, 'project');

    res.json({ character: c, imageUrl: c.imageUrl, provider: result.provider });
  } catch (e) { next(e); }
});

// ─── Pose Sheet Generation ───────────────────────────────────────────────────

router.post('/:id/generate-pose-sheet', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError();
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    if (!c.imageUrl) throw new ValidationError('Generate a portrait first before creating a pose sheet');

    // Ensure portrait is a real URL before using as reference
    if (!c.imageUrl.startsWith('https://')) {
      c.imageUrl = await ensureCloudinaryUrl(
        c.imageUrl, `noorstudio/characters/${c._id}`, `portrait_migrated_${Date.now()}`
      );
      await c.save();
    }

    const cost = STAGE_CREDIT_COSTS.poseSheet ?? 6;
    if (req.user.credits < cost) {
      return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` } });
    }

    const poseCount = req.body.poseCount || 12;

    const result = await generateImage({
      task:       'pose-sheet',
      prompt:     buildPoseSheetPrompt(c, poseCount),
      references: [c.imageUrl],          // portrait as identity anchor
      projectId:  c.universeId?.toString(),
      traceId:    `posesheet_${c._id}_${Date.now()}`,
      style:      req.body.style || 'pixar-3d',
    });

    c.poseSheetUrl = await ensureCloudinaryUrl(
      result.imageUrl,
      `noorstudio/characters/${c._id}`,
      `posesheet_${Date.now()}`
    );
    c.status = 'generated';
    await c.save();
    await deductCredits(req.user._id, cost, `Pose sheet: ${c.name}`, 'project');

    res.json({ character: c, poseSheetUrl: c.poseSheetUrl, provider: result.provider });
  } catch (e) { next(e); }
});

// ─── Migrate base64 → Cloudinary (one-time fix for existing characters) ───────
router.post('/:id/fix-storage', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError();
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();

    let changed = false;
    if (c.imageUrl && !c.imageUrl.startsWith('https://')) {
      c.imageUrl = await ensureCloudinaryUrl(c.imageUrl, `noorstudio/characters/${c._id}`, `portrait_migrated`);
      changed = true;
    }
    if (c.poseSheetUrl && !c.poseSheetUrl.startsWith('https://')) {
      c.poseSheetUrl = await ensureCloudinaryUrl(c.poseSheetUrl, `noorstudio/characters/${c._id}`, `posesheet_migrated`);
      changed = true;
    }
    if (changed) await c.save();

    res.json({ character: c, migrated: changed });
  } catch (e) { next(e); }
});

// ─── Approve ──────────────────────────────────────────────────────────────────

router.post('/:id/approve', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError();
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    if (!c.imageUrl) throw new ValidationError('Character must have a portrait before approval');
    c.status = 'approved';
    await c.save();
    res.json(c);
  } catch (e) { next(e); }
});

export default router;