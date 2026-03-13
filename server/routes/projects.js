import { Router } from 'express';
import { randomBytes } from 'crypto';
import { Project } from '../models/Project.js';
import { Universe } from '../models/Universe.js';
import { Character } from '../models/Character.js';
import { Export } from '../models/Export.js';
import { KnowledgeBase } from '../models/KnowledgeBase.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';

const router = Router();
const ARTIFACT_STAGES = ['outline', 'dedication', 'themePage', 'chapters', 'humanized', 'illustrations', 'cover', 'layout', 'export'];

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

/**
 * Safely extract a string from a value — trims whitespace, returns '' for nullish.
 */
function str(val) {
  if (val == null) return '';
  return String(val).trim();
}

/**
 * Resolve themePage fields robustly — handles both old and new field naming.
 * Old save format:  { title, arabicPhrase, transliteration, meaning, reference, referenceText, whyWeDoIt, dailyPractice }
 * New save format:  { sectionTitle, arabicPhrase, transliteration, meaning, referenceType, referenceSource, referenceText, explanation, dailyPractice }
 */
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

/**
 * Resolve dedication fields robustly.
 */
function resolveDedication(d) {
  if (!d) return null;
  return {
    greeting:             str(d.greeting),
    message:              str(d.message),
    closing:              str(d.closing),
    includeQrPlaceholder: d.includeQrPlaceholder ?? true,
  };
}

/**
 * Extract the best text content from a chapter object.
 * Handles both raw chapters and humanized chapters.
 */
function resolveChapterText(ch) {
  if (!ch) return '';
  return str(ch.text || ch.edited_text || ch.content || ch.body || '');
}

/**
 * Extract spreads from a chapter — from textContent and illustration chapter.
 * Returns a merged array of spread objects with all fields populated.
 */
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
    });
  }
  return merged;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const projects = await Project.find({ userId: req.user._id })
      .select('-artifacts').sort({ updatedAt: -1 });
    res.json(projects);
  } catch (e) { next(e); }
});

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

router.get('/:id', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id).populate('universeId').populate('characterIds');
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();
    res.json(p);
  } catch (e) { next(e); }
});

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

// ─── Layout ───────────────────────────────────────────────────────────────────

router.post('/:id/layout', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();

    const pictureBook   = isPictureBook(p.ageRange);
    const illustrations = toArray(p.artifacts?.illustrations);

    // ── Resolve text content: prefer humanized, fall back to chapters ─────────
    const humanized  = toArray(p.artifacts?.humanized);
    const rawChapters = toArray(p.artifacts?.chapters);
    const textContent = humanized.length ? humanized : rawChapters;

    if (!textContent.length) {
      throw new ValidationError('Chapters must be completed before layout');
    }

    // ── Resolve support data ──────────────────────────────────────────────────
    const kb    = p.universeId ? await KnowledgeBase.findOne({ universeId: p.universeId, userId: req.user._id }) : null;
    const vocab = toArray(kb?.vocabulary);
    const duas  = toArray(kb?.duas);

    // ── Resolve artifact sections ─────────────────────────────────────────────
    const dedication  = resolveDedication(p.artifacts?.dedication);
    const themePage   = resolveThemePage(p.artifacts?.themePage);
    const outline     = p.artifacts?.outline || {};

    const bookTitle = str(outline.bookTitle || p.title);
    const bookMoral = str(outline.moral);
    const author    = str(p.authorName);

    // ── Cover image URLs ──────────────────────────────────────────────────────
    const frontCoverUrl = str(
      p.artifacts?.cover?.frontUrl ||
      p.artifacts?.cover?.imageUrl ||
      ''
    );
    const backCoverUrl = str(
      p.artifacts?.cover?.backUrl || ''
    );

    const spreads = [];
    let pageNum   = 1;

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 1: Front Cover
    // ════════════════════════════════════════════════════════════════════════
    spreads.push({
      page:    pageNum++,
      type:    'cover',
      content: {
        imageUrl:  frontCoverUrl  || null,
        title:     bookTitle,
        author,
        hasImage:  !!frontCoverUrl,
      },
    });

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 2: Title Page
    // ════════════════════════════════════════════════════════════════════════
    spreads.push({
      page:    pageNum++,
      type:    'title-page',
      content: {
        title:    bookTitle,
        author,
        moral:    bookMoral,
        ageRange: str(p.ageRange),
      },
    });

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 3: Dedication (if exists and has content)
    // ════════════════════════════════════════════════════════════════════════
    if (dedication && (dedication.greeting || dedication.message || dedication.closing)) {
      spreads.push({
        page:    pageNum++,
        type:    'dedication',
        content: {
          greeting:             dedication.greeting,
          message:              dedication.message,
          closing:              dedication.closing,
          includeQrPlaceholder: dedication.includeQrPlaceholder,
          author,
        },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // PAGE 4: Islamic Theme Page (if exists and has content)
    // ════════════════════════════════════════════════════════════════════════
    if (themePage && (themePage.sectionTitle || themePage.arabicPhrase || themePage.meaning)) {
      spreads.push({
        page:    pageNum++,
        type:    'theme-page',
        content: {
          sectionTitle:    themePage.sectionTitle,
          arabicPhrase:    themePage.arabicPhrase,
          transliteration: themePage.transliteration,
          meaning:         themePage.meaning,
          referenceType:   themePage.referenceType,
          referenceSource: themePage.referenceSource,
          referenceText:   themePage.referenceText,
          explanation:     themePage.explanation,
          dailyPractice:   themePage.dailyPractice,
        },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // STORY PAGES
    // ════════════════════════════════════════════════════════════════════════

    if (pictureBook) {
      // ── PICTURE BOOK ───────────────────────────────────────────────────────
      // Each spread = one full-bleed illustration + text overlay on the same page.
      // Data lives in: textContent[ci].spreads[si] + illustrations[ci].spreads[si]

      textContent.forEach((ch, ci) => {
        if (!ch) return;

        const illChapter   = illustrations[ci] || {};
        const chapterNum   = ch.chapterNumber  || ci + 1;
        const chapterTitle = str(ch.chapterTitle || `Chapter ${chapterNum}`);

        // Chapter divider — only when there is more than one chapter
        if (textContent.length > 1) {
          spreads.push({
            page:    pageNum++,
            type:    'chapter-divider',
            content: { chapterNumber: chapterNum, chapterTitle },
          });
        }

        // Merge text spreads + illustration spreads
        const mergedSpreads = mergeSpreads(ch, illChapter);

        mergedSpreads.forEach(spread => {
          spreads.push({
            page:    pageNum++,
            type:    'picture-spread',
            content: {
              chapterNumber:    chapterNum,
              chapterIndex:     ci,
              chapterTitle,
              spreadIndex:      spread.spreadIndex,
              // Text
              text:             spread.text,
              textPosition:     spread.textPosition,
              // Illustration
              imageUrl:         spread.imageUrl  || null,
              hasImage:         spread.hasImage,
              illustrationHint: spread.illustrationHint,
            },
          });
        });
      });

    } else {
      // ── CHAPTER BOOK ───────────────────────────────────────────────────────
      // Each chapter = 1 illustration page + 1 text page.

      textContent.forEach((ch, ci) => {
        if (!ch) return;

        const illChapter      = illustrations[ci] || {};
        const chapterNum      = ch.chapterNumber  || ci + 1;
        const chapterTitle    = str(ch.chapterTitle || `Chapter ${chapterNum}`);
        const selectedIdx     = illChapter.selectedVariantIndex ?? 0;
        const variants        = toArray(illChapter.variants);
        const selectedVariant = variants[selectedIdx] || variants[0] || null;
        const imageUrl        = str(selectedVariant?.imageUrl || '');

        // Chapter opening illustration
        spreads.push({
          page:    pageNum++,
          type:    'chapter-illustration',
          content: {
            imageUrl:      imageUrl || null,
            chapterNumber: chapterNum,
            chapterTitle,
            chapterIndex:  ci,
            variantIndex:  selectedIdx,
            hasImage:      !!imageUrl,
          },
        });

        // Chapter text
        spreads.push({
          page:    pageNum++,
          type:    'chapter-text',
          content: {
            chapterNumber: chapterNum,
            chapterIndex:  ci,
            chapterTitle,
            text:          resolveChapterText(ch),
          },
        });
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // GLOSSARY (if vocabulary exists)
    // ════════════════════════════════════════════════════════════════════════
    if (vocab.length) {
      spreads.push({
        page:    pageNum++,
        type:    'glossary',
        content: { vocabulary: vocab },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // DUA PAGE (if duas exist)
    // ════════════════════════════════════════════════════════════════════════
    if (duas.length) {
      spreads.push({
        page:    pageNum++,
        type:    'duas-page',
        content: { duas },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // BACK COVER (always last)
    // ════════════════════════════════════════════════════════════════════════
    spreads.push({
      page:    pageNum++,
      type:    'back-cover',
      content: {
        imageUrl: backCoverUrl || null,
        moral:    bookMoral,
        hasImage: !!backCoverUrl,
      },
    });

    // ════════════════════════════════════════════════════════════════════════
    // BUILD FINAL LAYOUT OBJECT
    // ════════════════════════════════════════════════════════════════════════
    const totalPages    = pageNum - 1;
    const storyPages    = spreads.filter(s => s.type === 'picture-spread' || s.type === 'chapter-illustration');
    const missingImages = storyPages.filter(s => !s.content.hasImage).length;

    const layout = {
      spreads,
      pageCount:     totalPages,
      trimSize:      str(p.trimSize || '8.5x8.5'),
      format:        pictureBook ? 'picture-book' : 'chapter-book',
      ageRange:      str(p.ageRange),
      title:         bookTitle,
      author,
      moral:         bookMoral,
      // Section flags (used by PDF renderer to know what to render)
      hasCover:      true,
      hasDedication: !!(dedication && (dedication.greeting || dedication.message)),
      hasThemePage:  !!(themePage && (themePage.sectionTitle || themePage.arabicPhrase)),
      hasGlossary:   vocab.length > 0,
      hasDuas:       duas.length > 0,
      hasBackCover:  true,
      // Debug info
      storyPageCount: storyPages.length,
      missingImages,
      generatedAt:   new Date().toISOString(),
    };

    p.artifacts.layout = layout;
    p.currentStage     = 'layout';
    p.markModified('artifacts');
    await p.save();

    console.log(`[Layout] ✓ ${layout.format} | ${totalPages} pages | ${spreads.length} spreads`);
    console.log(`[Layout] Sections: cover${layout.hasDedication ? ', dedication' : ''}${layout.hasThemePage ? ', theme' : ''}, ${storyPages.length} story pages${layout.hasGlossary ? ', glossary' : ''}${layout.hasDuas ? ', duas' : ''}, back-cover`);
    if (missingImages > 0) {
      console.warn(`[Layout] ⚠ ${missingImages} story page(s) have no illustration yet`);
    }

    res.json({ layout });
  } catch (e) { next(e); }
});

// ─── Publish ──────────────────────────────────────────────────────────────────

router.post('/:id/publish', async (req, res, next) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) throw new NotFoundError('Project not found');
    if (!p.userId.equals(req.user._id)) throw new ForbiddenError();
    if (!p.shareToken) p.shareToken = randomBytes(16).toString('hex');
    p.publishedAt = new Date();
    p.status      = 'complete';
    await p.save();
    res.json({ shareUrl: `/shared/${p.shareToken}`, shareToken: p.shareToken });
  } catch (e) { next(e); }
});

export default router;