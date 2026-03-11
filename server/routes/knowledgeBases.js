import { Router } from 'express';
import { KnowledgeBase } from '../models/KnowledgeBase.js';
import { Universe } from '../models/Universe.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { universeId } = req.query;
    const filter = { userId: req.user._id };
    if (universeId) filter.universeId = universeId;
    const kbs = await KnowledgeBase.find(filter).sort({ updatedAt: -1 });
    res.json(kbs);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { universeId, name, islamicValues, duas, vocabulary, illustrationRules, avoidTopics, customRules } = req.body;
    if (!name?.trim() || !universeId) throw new ValidationError('name and universeId are required');

    const universe = await Universe.findById(universeId);
    if (!universe) throw new NotFoundError('Universe not found');
    if (!universe.userId.equals(req.user._id)) throw new ForbiddenError();

    const kb = await KnowledgeBase.create({
      userId: req.user._id, universeId, name: name.trim(),
      islamicValues, duas, vocabulary, illustrationRules, avoidTopics, customRules,
    });
    res.status(201).json(kb);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findById(req.params.id);
    if (!kb) throw new NotFoundError('Knowledge base not found');
    if (!kb.userId.equals(req.user._id)) throw new ForbiddenError();
    res.json(kb);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findById(req.params.id);
    if (!kb) throw new NotFoundError('Knowledge base not found');
    if (!kb.userId.equals(req.user._id)) throw new ForbiddenError();

    const fields = ['name', 'islamicValues', 'duas', 'vocabulary', 'illustrationRules', 'avoidTopics', 'customRules'];
    fields.forEach(f => { if (req.body[f] !== undefined) kb[f] = req.body[f]; });
    await kb.save();
    res.json(kb);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findById(req.params.id);
    if (!kb) throw new NotFoundError('Knowledge base not found');
    if (!kb.userId.equals(req.user._id)) throw new ForbiddenError();
    await kb.deleteOne();
    res.json({ message: 'Knowledge base deleted' });
  } catch (e) { next(e); }
});

export default router;
