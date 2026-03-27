import { Router } from 'express';
import { Universe } from '../models/Universe.js';
import { Project } from '../models/Project.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const list = await Universe.find({ userId: req.user._id })
      .populate('characterCount').populate('bookCount').sort({ updatedAt: -1 });
    res.json(list);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, description, seriesBible, artStyle, ageRange, tone, colorPalette, islamicRules, tags } = req.body;
    if (!name?.trim()) throw new ValidationError('name is required');
    const universe = await Universe.create({ userId: req.user._id, name: name.trim(), description, seriesBible, artStyle, ageRange, tone, colorPalette, islamicRules, tags });
    res.status(201).json(universe);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const u = await Universe.findById(req.params.id).populate('characterCount').populate('bookCount');
    if (!u) throw new NotFoundError('Universe not found');
    if (!u.userId.equals(req.user._id)) throw new ForbiddenError();
    res.json(u);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const u = await Universe.findById(req.params.id);
    if (!u) throw new NotFoundError('Universe not found');
    if (!u.userId.equals(req.user._id)) throw new ForbiddenError();
    const fields = ['name', 'description', 'seriesBible', 'artStyle', 'ageRange', 'tone', 'colorPalette', 'islamicRules', 'tags'];
    fields.forEach(f => { if (req.body[f] !== undefined) u[f] = req.body[f]; });
    await u.save();
    res.json(u);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const u = await Universe.findById(req.params.id);
    if (!u) throw new NotFoundError('Universe not found');
    if (!u.userId.equals(req.user._id)) throw new ForbiddenError();
    await Project.updateMany({ universeId: u._id }, { $unset: { universeId: 1 } });
    await u.deleteOne();
    res.json({ message: 'Universe deleted' });
  } catch (e) { next(e); }
});

export default router;
