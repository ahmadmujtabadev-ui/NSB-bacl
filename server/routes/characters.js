import { Router } from 'express';
import { Character } from '../models/Character.js';
import { Universe } from '../models/Universe.js';
import { generateImage } from '../services/ai/image/image.providers.js';
import { deductCredits } from '../middleware/credits.js';
import { STAGE_CREDIT_COSTS } from '../services/ai/ai.billing.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';

const router = Router();

// ─── CRUD ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { universeId } = req.query;
    const filter = { userId: req.user._id };
    if (universeId) filter.universeId = universeId;
    const chars = await Character.find(filter).sort({ updatedAt: -1 });
    res.json(chars);
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
    if (!c) throw new NotFoundError('Character not found');
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    res.json(c);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError('Character not found');
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    const fields = ['name', 'role', 'ageRange', 'traits', 'speakingStyle', 'visualDNA', 'modestyRules', 'status'];
    fields.forEach(f => { if (req.body[f] !== undefined) c[f] = req.body[f]; });
    await c.save();
    res.json(c);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError('Character not found');
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    await c.deleteOne();
    res.json({ message: 'Character deleted' });
  } catch (e) { next(e); }
});

// ─── Portrait Generation ──────────────────────────────────────────────────────

router.post('/:id/generate-portrait', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError('Character not found');
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();

    const cost = STAGE_CREDIT_COSTS.portrait;
    if (req.user.credits < cost) {
      return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` } });
    }

    const vd = c.visualDNA || {};
    const modesty = c.modestyRules || {};
    const prompt = buildPortraitPrompt(c, vd, modesty, req.body.style);
    const traceId = `portrait_${c._id}_${Date.now()}`;

    const result = await generateImage({ task: 'portrait', prompt, style: req.body.style || 'pixar-3d', traceId });

    c.imageUrl = result.imageUrl;
    c.status = 'generated';
    await c.save();

    await deductCredits(req.user._id, cost, `Portrait: ${c.name}`, 'project');

    res.json({ character: c, imageUrl: result.imageUrl, provider: result.provider });
  } catch (e) { next(e); }
});

// ─── Pose Sheet Generation ───────────────────────────────────────────────────

router.post('/:id/generate-pose-sheet', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError('Character not found');
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    if (!c.imageUrl) throw new ValidationError('Generate a portrait first before creating a pose sheet');

    const cost = STAGE_CREDIT_COSTS.poseSheet;
    if (req.user.credits < cost) {
      return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` } });
    }

    const poseCount = req.body.poseCount || 12;
    const prompt = `${poseCount}-pose reference sheet of ${c.name}, ${c.ageRange || 'child'}, ${(c.traits || []).join(', ')}. ` +
      `Pixar 3D style. Grid layout showing: standing, sitting, running, waving, thinking, reading, praying, laughing, sad, surprised, walking, kneeling. ` +
      `Consistent character appearance across all poses. Consistent clothing and hijab.`;

    const result = await generateImage({
      task: 'pose-sheet',
      prompt,
      references: [c.imageUrl],
      style: req.body.style || 'pixar-3d',
      poseCount,
      traceId: `posesheet_${c._id}_${Date.now()}`,
    });

    c.poseSheetUrl = result.imageUrl;
    c.status = 'generated';
    await c.save();

    await deductCredits(req.user._id, cost, `Pose sheet: ${c.name}`, 'project');

    res.json({ character: c, poseSheetUrl: result.imageUrl, provider: result.provider });
  } catch (e) { next(e); }
});

// ─── Approve Character ───────────────────────────────────────────────────────

router.post('/:id/approve', async (req, res, next) => {
  try {
    const c = await Character.findById(req.params.id);
    if (!c) throw new NotFoundError('Character not found');
    if (!c.userId.equals(req.user._id)) throw new ForbiddenError();
    if (!c.imageUrl) throw new ValidationError('Character must have a portrait before approval');

    c.status = 'approved';
    await c.save();
    res.json(c);
  } catch (e) { next(e); }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildPortraitPrompt(c, vd, modesty, style = 'pixar-3d') {
  return [
    `Portrait of ${c.name}, ${c.ageRange || 'young child'}.`,
    `Personality: ${(c.traits || []).join(', ')}.`,
    vd.skinTone    ? `Skin tone: ${vd.skinTone}.` : '',
    vd.eyeColor    ? `Eyes: ${vd.eyeColor}.` : '',
    vd.faceShape   ? `Face: ${vd.faceShape}.` : '',
    vd.hairOrHijab ? `Hair/hijab: ${vd.hairOrHijab}.` : '',
    vd.outfitRules ? `Outfit: ${vd.outfitRules}.` : '',
    modesty.hijabAlways   ? 'Hijab always visible.' : '',
    modesty.longSleeves   ? 'Long sleeves.' : '',
    modesty.looseClothing ? 'Loose clothing.' : '',
    `${style} children's book illustration style. Warm, child-friendly.`,
  ].filter(Boolean).join(' ');
}

export default router;
