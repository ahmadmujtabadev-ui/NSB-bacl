import { Router } from 'express';
import { randomBytes } from 'crypto';
import { Project } from '../models/Project.js';
import { Universe } from '../models/Universe.js';
import { Character } from '../models/Character.js';
import { Export } from '../models/Export.js';
import { KnowledgeBase } from '../models/KnowledgeBase.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';

const router = Router();
const ARTIFACT_STAGES = ['outline', 'chapters', 'humanized', 'illustrations', 'cover', 'layout', 'export'];

// ─── Helper ───────────────────────────────────────────────────────────────────
// Mongoose Mixed stores dot-notation "arrays" as { '0': v, '1': v, '2': v }.
// This normalises either format to a real JS array so .forEach / .length work.
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(v => v != null);
  // Object with numeric string keys
  const numericKeys = Object.keys(val).map(Number).filter(n => !isNaN(n));
  if (!numericKeys.length) return [];
  const arr = [];
  numericKeys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr.filter(v => v != null);
}

// GET /api/projects
router.get('/', async (req, res, next) => {
  try {
    const projects = await Project.find({ userId: req.user._id })
      .select('-artifacts').sort({ updatedAt: -1 });
    res.json(projects);
  } catch (e) { next(e); }
});

// POST /api/projects
router.post('/', async (req, res, next) => {
  try {
    const { universeId, characterIds = [], title, ageRange, chapterCount, template, learningObjective, authorName, trimSize } = req.body;
    if (!title?.trim()) throw new ValidationError('title is required');

    if (universeId) {
      const u = await Universe.findById(universeId);
      if (!u) throw new NotFoundError('Universe not found');
      if (!u.userId.equals(req.user._id)) throw new ForbiddenError();
    }

    if (characterIds.length) {
      const chars = await Character.find({ _id: { $in: characterIds }, userId: req.user._id });
      if (chars.length !== characterIds.length) throw new ValidationError('One or more characters not found');
      const unapproved = chars.find(c => c.status !== 'approved');
      if (unapproved) throw new ValidationError(`Character "${unapproved.name}" must be approved before creating a book`);
    }

    const project = await Project.create({
      userId: req.user._id, universeId, characterIds, title: title.trim(),
      ageRange, chapterCount: chapterCount || 4, template: template || 'moral',
      learningObjective, authorName, trimSize, status: 'draft', artifacts: {},
    });
    res.status(201).json(project);
  } catch (e) { next(e); }
});

// GET /api/projects/:id
router.get('/:id', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id).populate('universeId').populate('characterIds');
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();
    res.json(p);
  } catch (e) { next(e); }
});

// PUT /api/projects/:id — auto-save, merges artifacts stage by stage
router.put('/:id', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    const topFields = ['title', 'ageRange', 'chapterCount', 'template', 'learningObjective', 'authorName', 'status', 'currentStage', 'trimSize', 'characterIds'];
    topFields.forEach(f => { if (req.body[f] !== undefined) p[f] = req.body[f]; });

    if (req.body.artifacts) {
      ARTIFACT_STAGES.forEach(s => {
        if (req.body.artifacts[s] !== undefined) p.artifacts[s] = req.body.artifacts[s];
      });
      p.markModified('artifacts');
    }

    await p.save();
    res.json({ message: 'Saved', updatedAt: p.updatedAt });
  } catch (e) { next(e); }
});

// DELETE /api/projects/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();
    await Export.deleteMany({ projectId: p._id });
    await p.deleteOne();
    res.json({ message: 'Project deleted' });
  } catch (e) { next(e); }
});

// POST /api/projects/:id/layout
// Normalises artifacts from either array or object-key format before processing.
router.post('/:id/layout', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    const illustrations = toArray(p.artifacts?.illustrations);
    const humanized = toArray(p.artifacts?.humanized);
    const chapters = toArray(p.artifacts?.chapters);

    // Prefer humanized text, otherwise raw chapters
    const textContent = humanized.length ? humanized : chapters;

    if (!textContent.length) {
      throw new ValidationError('Chapters or humanized content must be completed before layout');
    }

    const kb = p.universeId
      ? await KnowledgeBase.findOne({
        universeId: p.universeId,
        userId: req.user._id,
      })
      : null;

    const vocab = kb?.vocabulary || [];

    const frontCoverUrl =
      p.artifacts?.cover?.frontUrl ||
      p.artifacts?.cover?.frontCoverUrl ||
      p.artifacts?.cover?.imageUrl ||
      null;

    const backCoverUrl =
      p.artifacts?.cover?.backUrl ||
      p.artifacts?.cover?.backCoverUrl ||
      null;

    const spreads = [
      {
        page: 1,
        type: 'cover',
        content: {
          imageUrl: frontCoverUrl,
        },
      },
      {
        page: 2,
        type: 'title-page',
        content: {
          title: p.title,
          author: p.authorName || '',
        },
      },
    ];

    // Build pages strictly from existing generated content
    textContent.forEach((ch, i) => {
      if (!ch) return;

      const ill = illustrations[i];

      const selectedVariant =
        ill?.variants?.[ill.selectedVariantIndex ?? 0] ||
        ill?.variants?.find((v) => v?.selected) ||
        ill?.variants?.[0] ||
        null;

      spreads.push({
        page: 3 + i * 2,
        type: 'illustration',
        content: {
          imageUrl: selectedVariant?.imageUrl || null,
          chapterNumber: ch.chapterNumber || i + 1,
        },
      });

      spreads.push({
        page: 4 + i * 2,
        type: 'text',
        content: {
          chapterTitle: ch.chapterTitle || ch.title || `Chapter ${i + 1}`,
          text: ch.text || ch.edited_text || ch.content || '',
          chapterNumber: ch.chapterNumber || i + 1,
        },
      });
    });

    let nextPage = 3 + textContent.length * 2;

    if (vocab.length) {
      spreads.push({
        page: nextPage,
        type: 'glossary',
        content: {
          vocabulary: vocab,
        },
      });
      nextPage += 1;
    }

    spreads.push({
      page: nextPage,
      type: 'back-cover',
      content: {
        imageUrl: backCoverUrl,
      },
    });

    const layout = {
      spreads,
      pageCount: nextPage,
      trimSize: p.trimSize || '6x9',
    };

    p.artifacts.layout = layout;
    p.currentStage = 'layout';
    p.markModified('artifacts');
    await p.save();

    res.json({ layout });
  } catch (e) {
    next(e);
  }
});

// POST /api/projects/:id/publish
router.post('/:id/publish', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();
    if (!p.shareToken) p.shareToken = randomBytes(16).toString('hex');
    p.publishedAt = new Date();
    p.status = 'complete';
    await p.save();
    res.json({ shareUrl: `/shared/${p.shareToken}`, shareToken: p.shareToken });
  } catch (e) { next(e); }
});

export default router;
