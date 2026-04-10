// server/routes/projects.routes.js
// PRODUCTION-READY — Full CRUD + layout + publish
// Supports both old and new 5-step flow

import { Router }    from 'express';
import { randomBytes } from 'crypto';
import { Project }   from '../models/Project.js';
import { Universe }  from '../models/Universe.js';
import { Character } from '../models/Character.js';
import { Export }    from '../models/Export.js';
import { KnowledgeBase } from '../models/KnowledgeBase.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';

const router = Router();

const ARTIFACT_STAGES = [
  'outline', 'storyText', 'storyIdea',
  'dedication', 'themePage',
  'chapters', 'humanized', 'spreads', 'spreadOnly',
  'illustrations', 'spreadIllustrations',
  'cover', 'layout', 'export',
  'bookEditorStyle', 'pageEdits',
  'promptHistory', 'imagePromptHistory',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(v => v != null);
  const numericKeys = Object.keys(val).map(Number).filter(n => !isNaN(n));
  if (!numericKeys.length) return [];
  const arr = [];
  numericKeys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr.filter(v => v != null);
}

function isPictureBook(ageRange) {
  if (!ageRange) return true;
  const first = String(ageRange).match(/\d+/)?.[0];
  return first ? Number(first) <= 8 : true;
}

function isSpreadOnly(ageRange) {
  if (!ageRange) return false;
  const first = String(ageRange).match(/\d+/)?.[0];
  return first ? Number(first) < 6 : false;
}

function str(val) {
  if (val == null) return '';
  return String(val).trim();
}

function resolveThemePage(tp) {
  if (!tp) return null;
  return {
    sectionTitle:    str(tp.sectionTitle    || tp.title),
    arabicPhrase:    str(tp.arabicPhrase),
    transliteration: str(tp.transliteration),
    meaning:         str(tp.meaning),
    referenceType:   str(tp.referenceType   || 'quran'),
    referenceSource: str(tp.referenceSource || tp.reference),
    referenceText:   str(tp.referenceText),
    explanation:     str(tp.explanation     || tp.whyWeDoIt),
    dailyPractice:   str(tp.dailyPractice),
  };
}

function resolveDedication(d) {
  if (!d) return null;
  return {
    greeting:             str(d.greeting),
    message:              str(d.message),
    closing:              str(d.closing),
    includeQrPlaceholder: d.includeQrPlaceholder ?? true,
  };
}

function resolveChapterText(ch) {
  if (!ch) return '';
  return str(ch.text || ch.edited_text || ch.content || ch.body || '');
}

function mergeSpreads(textCh, illCh) {
  const textSpreads = toArray(textCh?.spreads);
  const illSpreads  = toArray(illCh?.spreads);
  const count       = Math.max(textSpreads.length, illSpreads.length, 1);
  const merged = [];
  for (let si = 0; si < count; si++) {
    const t = textSpreads[si] || {};
    const i = illSpreads[si]  || {};
    merged.push({
      spreadIndex:      si,
      text:             str(t.text             || i.text),
      textPosition:     str(t.textPosition     || i.textPosition     || 'bottom'),
      illustrationHint: str(t.illustrationHint || i.illustrationHint),
      imageUrl:         str(i.imageUrl         || ''),
      hasImage:         !!(i.imageUrl),
      seed:             i.seed || null,
      selectedVariantIndex: i.selectedVariantIndex ?? 0,
      variants:         toArray(i.variants),
    });
  }
  return merged;
}

function getEffectiveTextContent(arts) {
  const humanized   = toArray(arts.humanized);
  const rawChapters = toArray(arts.chapters);
  return humanized.length ? humanized : rawChapters;
}

// ─── GET /api/projects — list all ────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = { userId: req.user._id };
    if (status) query.status = status;

    const total    = await Project.countDocuments(query);
    const projects = await Project.find(query)
      .select('-artifacts')
      .sort({ updatedAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));

    res.json({
      projects,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (e) { next(e); }
});

// ─── POST /api/projects — create ─────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const {
      universeId, knowledgeBaseId, characterIds = [], title, ageRange, chapterCount,
      template, learningObjective, authorName, trimSize, language,
      bookStyle, storyIdea,
    } = req.body;

    if (!title?.trim()) throw new ValidationError('title is required');

    if (universeId) {
      const u = await Universe.findById(universeId);
      if (!u) throw new NotFoundError('Universe not found');
      if (!u.userId.equals(req.user._id)) throw new ForbiddenError();
    }

    if (characterIds.length) {
      const chars = await Character.find({ _id: { $in: characterIds }, userId: req.user._id });
      if (chars.length !== characterIds.length) {
        throw new ValidationError('One or more characters not found');
      }
      const unapproved = chars.find(c => c.status !== 'approved');
      if (unapproved) {
        throw new ValidationError(`Character "${unapproved.name}" must be approved before creating a book`);
      }
    }

    const artifacts = {};
    if (storyIdea) artifacts.storyIdea = storyIdea;

    const project = await Project.create({
      userId: req.user._id,
      universeId,
      knowledgeBaseId: knowledgeBaseId || undefined,
      characterIds,
      title:             title.trim(),
      ageRange,
      chapterCount:      chapterCount || 4,
      template:          template     || 'moral',
      learningObjective,
      authorName,
      trimSize:          trimSize     || '8.5x8.5',
      language:          language     || 'english',
      bookStyle:         bookStyle    || {},
      status:            'draft',
      currentStep:       1,
      artifacts,
    });

    res.status(201).json(project);
  } catch (e) { next(e); }
});

// ─── GET /api/projects/:id — get one ─────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id)
      .populate('universeId', 'name artStyle colorPalette islamicRules')
      .populate('characterIds', 'name role ageRange visualDNA modestyRules traits imageUrl poseSheetUrl masterReferenceUrl selectedStyle status');

    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();
    res.json(p);
  } catch (e) { next(e); }
});

// ─── PUT /api/projects/:id — update ──────────────────────────────────────────

router.put('/:id', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    const topFields = [
      'title', 'ageRange', 'chapterCount', 'template', 'learningObjective',
      'authorName', 'status', 'currentStage', 'currentStep', 'trimSize',
      'characterIds', 'language', 'bookStyle', 'imageWidth', 'imageHeight',
    ];
    topFields.forEach(f => {
      if (req.body[f] !== undefined) p[f] = req.body[f];
    });

    // Step completion tracking
    if (req.body.stepsComplete) {
      p.stepsComplete = { ...p.stepsComplete, ...req.body.stepsComplete };
    }

    // Artifact stage updates
    if (req.body.artifacts) {
      if (!p.artifacts) p.artifacts = {};
      ARTIFACT_STAGES.forEach(s => {
        if (req.body.artifacts[s] !== undefined) {
          p.artifacts[s] = req.body.artifacts[s];
        }
      });
      // Also allow arbitrary artifact keys not in the list
      Object.keys(req.body.artifacts).forEach(key => {
        if (!ARTIFACT_STAGES.includes(key)) {
          p.artifacts[key] = req.body.artifacts[key];
        }
      });
      p.markModified('artifacts');
    }

    await p.save();
    res.json({ message: 'Saved', updatedAt: p.updatedAt, currentStep: p.currentStep });
  } catch (e) { next(e); }
});

// ─── PATCH /api/projects/:id/step — advance step ─────────────────────────────

router.patch('/:id/step', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    const { step, complete } = req.body;
    if (!step || step < 1 || step > 5) throw new ValidationError('step must be 1-5');

    // Mark the step complete
    const stepMap = { 1: 'story', 2: 'spreads', 3: 'style', 4: 'images', 5: 'editor' };
    if (complete && stepMap[step]) {
      if (!p.stepsComplete) p.stepsComplete = {};
      p.stepsComplete[stepMap[step]] = true;
      p.markModified('stepsComplete');
    }

    // Advance current step
    if (step >= p.currentStep) {
      p.currentStep = Math.min(step + 1, 5);
    }

    await p.save();
    res.json({ message: 'Step updated', currentStep: p.currentStep, stepsComplete: p.stepsComplete });
  } catch (e) { next(e); }
});

// ─── DELETE /api/projects/:id ─────────────────────────────────────────────────

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

// ─── POST /api/projects/:id/layout ────────────────────────────────────────────

router.post('/:id/layout', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    const arts        = p.artifacts || {};
    const pictureBook = isPictureBook(p.ageRange);
    const spreadOnlyMode = !!(arts.spreadOnly || isSpreadOnly(p.ageRange));

    // Resolve text content
    let textContent;
    if (spreadOnlyMode) {
      textContent = null; // uses spreads directly
    } else {
      textContent = getEffectiveTextContent(arts);
      if (!textContent.length) throw new ValidationError('Chapters must be completed before layout');
    }

    const illustrations = toArray(arts.illustrations);
    const kb    = p.universeId ? await KnowledgeBase.findOne({ universeId: p.universeId, userId: req.user._id }) : null;
    const vocab = toArray(kb?.vocabulary);
    const duas  = toArray(kb?.duas);

    const dedication = resolveDedication(arts.dedication);
    const themePage  = resolveThemePage(arts.themePage);
    const outline    = arts.outline || {};

    const bookTitle     = str(outline.bookTitle || p.title);
    const bookMoral     = str(outline.moral);
    const author        = str(p.authorName);
    const frontCoverUrl = str(arts.cover?.frontUrl || arts.cover?.imageUrl || '');
    const backCoverUrl  = str(arts.cover?.backUrl || '');

    const spreads = [];
    let pageNum   = 1;

    // PAGE: Front Cover
    spreads.push({
      page: pageNum++, type: 'cover',
      content: { imageUrl: frontCoverUrl || null, title: bookTitle, author, hasImage: !!frontCoverUrl },
    });

    // PAGE: Title Page
    spreads.push({
      page: pageNum++, type: 'title-page',
      content: { title: bookTitle, author, moral: bookMoral, ageRange: str(p.ageRange) },
    });

    // PAGE: Dedication
    if (dedication && (dedication.greeting || dedication.message || dedication.closing)) {
      spreads.push({
        page: pageNum++, type: 'dedication',
        content: { ...dedication, author },
      });
    }

    // PAGE: Islamic Theme
    if (themePage && (themePage.sectionTitle || themePage.arabicPhrase || themePage.meaning)) {
      spreads.push({
        page: pageNum++, type: 'theme-page',
        content: { ...themePage },
      });
    }

    // STORY PAGES
    if (spreadOnlyMode) {
      // Flat spreads (age < 6)
      const allSpreads    = toArray(arts.spreads);
      const illSpreads    = toArray(arts.spreadIllustrations);

      allSpreads.forEach((s, si) => {
        const ill = illSpreads[si] || {};
        spreads.push({
          page: pageNum++, type: 'picture-spread',
          content: {
            spreadIndex:      si,
            text:             str(s.text),
            textPosition:     str(s.textPosition || 'bottom'),
            illustrationHint: str(s.illustrationHint),
            imageUrl:         str(ill.imageUrl || ''),
            hasImage:         !!(ill.imageUrl),
            seed:             ill.seed || null,
            variants:         toArray(ill.variants),
            selectedVariantIndex: ill.selectedVariantIndex ?? 0,
          },
        });
      });

    } else if (pictureBook) {
      // Chapter-based picture book
      textContent.forEach((ch, ci) => {
        if (!ch) return;
        const illChapter   = illustrations[ci] || {};
        const chapterNum   = ch.chapterNumber  || ci + 1;
        const chapterTitle = str(ch.chapterTitle || `Chapter ${chapterNum}`);

        if (textContent.length > 1) {
          spreads.push({
            page: pageNum++, type: 'chapter-divider',
            content: { chapterNumber: chapterNum, chapterTitle },
          });
        }

        mergeSpreads(ch, illChapter).forEach(spread => {
          spreads.push({
            page: pageNum++, type: 'picture-spread',
            content: {
              chapterNumber: chapterNum, chapterIndex: ci, chapterTitle,
              spreadIndex:   spread.spreadIndex,
              text:          spread.text,
              textPosition:  spread.textPosition,
              illustrationHint: spread.illustrationHint,
              imageUrl:      spread.imageUrl || null,
              hasImage:      spread.hasImage,
              variants:      spread.variants,
              selectedVariantIndex: spread.selectedVariantIndex,
            },
          });
        });
      });

    } else {
      // Chapter book (age >= 9)
      textContent.forEach((ch, ci) => {
        if (!ch) return;
        const illChapter  = illustrations[ci] || {};
        const chapterNum  = ch.chapterNumber  || ci + 1;
        const chapterTitle = str(ch.chapterTitle || `Chapter ${chapterNum}`);
        const selectedIdx  = illChapter.selectedVariantIndex ?? 0;
        const variants     = toArray(illChapter.variants);
        const selected     = variants[selectedIdx] || variants[0] || null;
        const imageUrl     = str(selected?.imageUrl || '');

        spreads.push({
          page: pageNum++, type: 'chapter-illustration',
          content: {
            imageUrl: imageUrl || null, chapterNumber: chapterNum,
            chapterTitle, chapterIndex: ci, variantIndex: selectedIdx,
            hasImage: !!imageUrl, variants,
          },
        });
        spreads.push({
          page: pageNum++, type: 'chapter-text',
          content: { chapterNumber: chapterNum, chapterIndex: ci, chapterTitle, text: resolveChapterText(ch) },
        });
      });
    }

    // Glossary
    if (vocab.length) {
      spreads.push({ page: pageNum++, type: 'glossary', content: { vocabulary: vocab } });
    }

    // Duas
    if (duas.length) {
      spreads.push({ page: pageNum++, type: 'duas-page', content: { duas } });
    }

    // Back Cover
    spreads.push({
      page: pageNum++, type: 'back-cover',
      content: { imageUrl: backCoverUrl || null, moral: bookMoral, hasImage: !!backCoverUrl },
    });

    const totalPages    = pageNum - 1;
    const storyPages    = spreads.filter(s => ['picture-spread', 'chapter-illustration'].includes(s.type));
    const missingImages = storyPages.filter(s => !s.content.hasImage).length;
    const approvedCount = Object.values(arts.pageEdits || {}).filter(e => e?.status === 'approved').length;

    const layout = {
      spreads,
      pageCount:      totalPages,
      trimSize:       str(p.trimSize || '8.5x8.5'),
      format:         pictureBook ? 'picture-book' : (spreadOnlyMode ? 'spread-only' : 'chapter-book'),
      ageRange:       str(p.ageRange),
      title:          bookTitle,
      author,
      moral:          bookMoral,
      hasCover:       true,
      hasDedication:  !!(dedication && (dedication.greeting || dedication.message)),
      hasThemePage:   !!(themePage && (themePage.sectionTitle || themePage.arabicPhrase)),
      hasGlossary:    vocab.length > 0,
      hasDuas:        duas.length > 0,
      hasBackCover:   true,
      storyPageCount: storyPages.length,
      missingImages,
      approvedCount,
      generatedAt:    new Date().toISOString(),
    };

    p.artifacts       = { ...(p.artifacts || {}), layout };
    p.currentStage    = 'layout';
    p.markModified('artifacts');
    await p.save();

    console.log(`[Layout] ✓ ${layout.format} | ${totalPages} pages | missing: ${missingImages}`);
    res.json({ layout });
  } catch (e) { next(e); }
});

// ─── POST /api/projects/:id/publish ──────────────────────────────────────────

router.post('/:id/publish', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    if (!p.shareToken) p.shareToken = randomBytes(16).toString('hex');
    p.publishedAt = new Date();
    p.status      = 'complete';
    p.isPublic    = req.body.isPublic !== false;
    await p.save();

    res.json({
      shareUrl:   `/shared/${p.shareToken}`,
      shareToken: p.shareToken,
      publishedAt: p.publishedAt,
    });
  } catch (e) { next(e); }
});

// ─── POST /api/projects/:id/duplicate ─────────────────────────────────────────

router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    const copy = new Project({
      ...p.toObject(),
      _id:         new mongoose.Types.ObjectId(),
      title:       `${p.title} (Copy)`,
      status:      'draft',
      currentStep: 1,
      stepsComplete: {},
      publishedAt: null,
      shareToken:  null,
      artifacts:   { storyIdea: p.artifacts?.storyIdea, storyText: p.artifacts?.storyText },
      createdAt:   undefined,
      updatedAt:   undefined,
    });
    await copy.save();
    res.status(201).json(copy);
  } catch (e) { next(e); }
});

// ─── GET /api/projects/:id/layout-styles ──────────────────────────────────────

router.get('/:id/layout-styles', async (req, res, next) => {
  try {
    const p = await Project.findOne({ _id: req.params.id, userId: req.user._id })
      .select('layoutStyles').lean();
    if (!p) throw new NotFoundError('Project not found');
    res.json({ layoutStyles: p.layoutStyles ?? {} });
  } catch (e) { next(e); }
});

// ─── PUT /api/projects/:id/layout-styles ──────────────────────────────────────

router.put('/:id/layout-styles', async (req, res, next) => {
  try {
    const { fontFamily, textColor, fontSize, bold, italic, textAlign, bgColor } = req.body;
    const update = {};
    if (fontFamily !== undefined) update['layoutStyles.fontFamily'] = fontFamily;
    if (textColor  !== undefined) update['layoutStyles.textColor']  = textColor;
    if (fontSize   !== undefined) update['layoutStyles.fontSize']   = Number(fontSize);
    if (bold       !== undefined) update['layoutStyles.bold']       = Boolean(bold);
    if (italic     !== undefined) update['layoutStyles.italic']     = Boolean(italic);
    if (textAlign  !== undefined) update['layoutStyles.textAlign']  = textAlign;
    if (bgColor    !== undefined) update['layoutStyles.bgColor']    = bgColor;

    const p = await Project.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: update },
      { new: true, select: 'layoutStyles' },
    ).lean();
    if (!p) throw new NotFoundError('Project not found');
    res.json({ layoutStyles: p.layoutStyles });
  } catch (e) { next(e); }
});

// ─── GET /api/projects/:id/summary ────────────────────────────────────────────

router.get('/:id/summary', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id)
      .populate('characterIds', 'name role ageRange visualDNA masterReferenceUrl selectedStyle status');
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    const arts = p.artifacts || {};
    const spreadOnlyMode = !!(arts.spreadOnly || isSpreadOnly(p.ageRange));
    const spreads = spreadOnlyMode ? toArray(arts.spreads) : [];
    const chapters = getEffectiveTextContent(arts);
    const illSpreads = toArray(arts.spreadIllustrations);
    const illustrations = toArray(arts.illustrations);
    const pageEdits = arts.pageEdits || {};

    const totalPages    = spreads.length || chapters.reduce((acc, ch) => acc + toArray(ch?.spreads).length, 0);
    const imagesReady   = spreadOnlyMode
      ? illSpreads.filter(i => i?.imageUrl).length
      : illustrations.reduce((acc, ch) => acc + toArray(ch?.spreads).filter(s => s?.imageUrl).length, 0);
    const pagesApproved = Object.values(pageEdits).filter(e => e?.status === 'approved').length;

    res.json({
      id:          p._id,
      title:       p.title,
      ageRange:    p.ageRange,
      status:      p.status,
      currentStep: p.currentStep,
      stepsComplete: p.stepsComplete,
      spreadOnly:  spreadOnlyMode,
      stats: {
        totalPages,
        imagesReady,
        pagesApproved,
        hasStory:      !!(arts.storyText || arts.outline?.bookTitle),
        hasSpreads:    !!(spreads.length || chapters.length),
        hasCharStyle:  p.characterIds?.some(c => c.masterReferenceUrl),
        hasCover:      !!(arts.cover?.frontUrl),
        hasLayout:     !!(arts.layout?.spreads?.length),
      },
      characters:  p.characterIds,
      updatedAt:   p.updatedAt,
    });
  } catch (e) { next(e); }
});

export default router;