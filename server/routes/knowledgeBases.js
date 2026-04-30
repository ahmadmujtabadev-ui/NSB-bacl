import { Router } from 'express';
import { KnowledgeBase } from '../models/KnowledgeBase.js';
import { Universe } from '../models/Universe.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';
import { DEFAULT_COVER_TEMPLATES } from '../constants/coverTemplates.js';
import { DEFAULT_KB_TEMPLATES } from '../constants/knowledgeBaseTemplates.js';

const router = Router();

// ── Cover template catalogue ─────────────────────────────────────────────────
router.get('/cover-templates', (req, res) => {
  res.json(DEFAULT_COVER_TEMPLATES);
});

// ── KB starter template catalogue ────────────────────────────────────────────
router.get('/kb-templates', (req, res) => {
  res.json(DEFAULT_KB_TEMPLATES);
});

router.get('/', async (req, res, next) => {
  try {
    const { universeId } = req.query;
    const filter = { userId: req.user._id };
    if (universeId && /^[0-9a-fA-F]{24}$/.test(universeId)) filter.universeId = universeId;
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

    const fields = [
      'name', 'islamicValues', 'duas', 'vocabulary', 'illustrationRules', 'avoidTopics', 'customRules',
      // New sections
      'backgroundSettings', 'coverDesign', 'underSixDesign', 'characterGuides',
      'literaryDevices', 'bookFormatting', 'themes',
    ];
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

// ── Export KB as portable JSON ────────────────────────────────────────────────
router.get('/:id/export', async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findById(req.params.id).lean();
    if (!kb) throw new NotFoundError('Knowledge base not found');
    if (!kb.userId.equals(req.user._id)) throw new ForbiddenError();

    // Strip server-only fields; keep all content fields
    const { _id, userId, __v, createdAt, updatedAt, ...exportable } = kb;
    const payload = { _kbExportVersion: 1, exportedAt: new Date().toISOString(), ...exportable };

    const filename = `kb-${kb.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (e) { next(e); }
});

// ── Import KB from exported JSON ──────────────────────────────────────────────
router.post('/import', async (req, res, next) => {
  try {
    const { universeId, name, data } = req.body;
    if (!name?.trim() || !universeId) throw new ValidationError('name and universeId are required');
    if (!data || typeof data !== 'object') throw new ValidationError('data (exported KB JSON) is required');

    const universe = await Universe.findById(universeId);
    if (!universe) throw new NotFoundError('Universe not found');
    if (!universe.userId.equals(req.user._id)) throw new ForbiddenError();

    // Whitelist only safe content fields — ignore any server IDs from the export
    const allowed = [
      'islamicValues', 'duas', 'vocabulary', 'avoidTopics',
      'backgroundSettings', 'coverDesign', 'underSixDesign',
      'characterGuides', 'literaryDevices', 'bookFormatting', 'themes',
      'illustrationRules', 'customRules',
    ];
    const content = {};
    allowed.forEach(f => { if (data[f] !== undefined) content[f] = data[f]; });

    const kb = await KnowledgeBase.create({
      userId: req.user._id,
      universeId,
      name: name.trim(),
      ...content,
    });
    res.status(201).json(kb);
  } catch (e) { next(e); }
});

// ── Duplicate KB (same account, any universe) ─────────────────────────────────
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const source = await KnowledgeBase.findById(req.params.id).lean();
    if (!source) throw new NotFoundError('Knowledge base not found');
    if (!source.userId.equals(req.user._id)) throw new ForbiddenError();

    const { name, universeId } = req.body;
    const targetUniverseId = universeId || source.universeId;

    if (universeId) {
      const universe = await Universe.findById(universeId);
      if (!universe) throw new NotFoundError('Target universe not found');
      if (!universe.userId.equals(req.user._id)) throw new ForbiddenError();
    }

    const { _id, userId, __v, createdAt, updatedAt, ...rest } = source;
    const duplicate = await KnowledgeBase.create({
      ...rest,
      userId: req.user._id,
      universeId: targetUniverseId,
      name: name?.trim() || `${source.name} (copy)`,
    });
    res.status(201).json(duplicate);
  } catch (e) { next(e); }
});

export default router;
