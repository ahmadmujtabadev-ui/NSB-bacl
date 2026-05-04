// server/routes/exportPdf.js
//
// GET /api/projects/:projectId/export/pdf?template=classic|modern|editorial
// GET /api/projects/:projectId/export/templates
//
// ──────────────────────────────────────────────────────────────────────────────
// CRITICAL FIX — Full page list is now rebuilt from project.artifacts.review
// (illustrations, humanized prose, structure) — the same source useBookEditor
// uses on the frontend.  This means every spread/chapter page gets its
// imageUrl from artifacts directly, NOT from the sparse editorPages list that
// only contains pages the user manually visited in the editor.
// ──────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { Project } from '../models/Project.js';
import PageContent from '../models/PageContent.js';
import { NotFoundError, ForbiddenError } from '../errors.js';
import { renderPageHtml, PDF_TEMPLATES } from '../lib/renderPageHtml.js';
import { renderHtmlPagesToPdf } from '../lib/puppeteerPdf.js';

const router = Router();
const VALID_TEMPLATES  = new Set(Object.keys(PDF_TEMPLATES));
const VALID_PLATFORMS  = new Set(['kdp', 'apple', 'ingram']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter((v) => v != null);
  const numericKeys = Object.keys(val).map(Number).filter((n) => !Number.isNaN(n));
  if (!numericKeys.length) return [];
  const arr = [];
  numericKeys.sort((a, b) => a - b).forEach((k) => { arr[k] = val[k]; });
  return arr.filter((v) => v != null);
}

function pageOrder(id = '') {
  if (id === 'cover-front') return [0, 0, 0];
  if (id === 'cover-back')  return [99999, 0, 0];

  // spread pages: sort between cover-front (0) and chapter pages (chN+1)
  const sp = id.match(/^spread-(.+)$/i);
  if (sp) {
    // extract numeric part if key like "s0", "s1"; otherwise use string compare
    const n = parseInt(sp[1].replace(/\D/g, '') || '0', 10);
    return [1, n, 0];
  }

  const m = id.match(/^chapter-(\d+)-([a-z]+)(?:-(\d+))?$/i);
  if (!m) return [98000, 0, 0];

  const chN   = parseInt(m[1], 10);
  const type  = m[2].toLowerCase();
  const idx   = parseInt(m[3] ?? '0', 10);

  const typeRank =
    type === 'opener' ? 0 :
    type === 'text'   ? 1 :
    type === 'moment' ? 2 :
    type === 'scene'  ? 2 : 3;

  return [chN + 2, typeRank, idx];
}

function sortPagesCanonically(pages) {
  return [...pages].sort((a, b) => {
    const oa = pageOrder(a.id);
    const ob = pageOrder(b.id);
    for (let i = 0; i < 3; i++) {
      if (oa[i] !== ob[i]) return oa[i] - ob[i];
    }
    return 0;
  });
}

function pickUrl(node) {
  if (!node) return null;
  const cur = node.current ?? node;
  const variants = normArr(cur.variants ?? cur.frontVariants ?? []);
  const selIdx = cur.selectedVariantIndex ?? cur.frontSelectedVariantIndex ?? 0;
  return variants[selIdx]?.imageUrl || cur.imageUrl || cur.frontUrl || null;
}

// ─── splitProse — mirrors useBookEditor.ts ────────────────────────────────────

function splitProse(text, wordsPerPage = 150) {
  if (!text || !text.trim()) return [];
  const sentences = text
    .replace(/([.?!])\s+/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = [];
  let wordCount = 0;

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).length;
    if (wordCount + words > wordsPerPage && current.length > 0) {
      chunks.push(current.join(' '));
      current = [];
      wordCount = 0;
    }
    current.push(sentence);
    wordCount += words;
  }
  if (current.length > 0) chunks.push(current.join(' '));

  if (chunks.length > 1) {
    const lastWordCount = chunks[chunks.length - 1].split(/\s+/).length;
    if (lastWordCount <= 100) {
      const merged = chunks.splice(chunks.length - 2, 2).join(' ');
      chunks.push(merged);
    }
  }
  return chunks.length ? chunks : [text];
}

// ─── Page builders — mirror useBookEditor.ts buildSpreadPages / buildChapterPages

function buildSpreadPagesForExport(illustrations, structures) {
  return illustrations
    .filter((ill) => ill.sourceType === 'spread')
    .sort((a, b) => (a.spreadIndex ?? 0) - (b.spreadIndex ?? 0))
    .map((ill, idx) => {
      const struct = structures.find((s) => s.current?.spreadIndex === ill.spreadIndex);
      const text  = struct?.current?.text || ill.current?.text || '';
      const title = `Spread ${(ill.spreadIndex ?? idx) + 1}`;
      return {
        id:       `spread-${ill.key}`,
        label:    title,
        title,
        text,
        imageUrl: pickUrl(ill) || '',
      };
    });
}

function buildChapterPagesForExport(illustrations, humanized, prose) {
  const moments = illustrations.filter((ill) => ill.sourceType === 'chapter-moment');

  const allChapterIdxs = [...new Set([
    ...moments.map((m) => Number(m.chapterIndex ?? 0)),
    ...humanized.map((h) => Number(h.chapterIndex ?? 0)),
    ...prose.map((p)    => Number(p.chapterIndex ?? 0)),
  ])].sort((a, b) => a - b);

  const pages = [];
  let runningPageNum = 1;

  for (const chIdx of allChapterIdxs) {
    const chNum      = chIdx + 1;
    const humanNode  = humanized.find((h) => Number(h.chapterIndex) === chIdx);
    const proseNode  = prose.find((p)    => Number(p.chapterIndex) === chIdx);
    const chNode     = humanNode || proseNode;
    const chTitle    = chNode?.current?.chapterTitle || `Chapter ${chNum}`;
    const chText     = chNode?.current?.chapterText  || '';

    const chMoments = moments
      .filter((m) => Number(m.chapterIndex) === chIdx)
      .sort((a, b)  => (a.spreadIndex ?? 0) - (b.spreadIndex ?? 0));

    pages.push({
      id:       `chapter-${chIdx}-opener`,
      label:    `Ch.${chNum} — ${chTitle}`,
      subTitle: `Chapter ${chNum}`,
      title:    chTitle,
      imageUrl: chMoments[0] ? (pickUrl(chMoments[0]) || '') : '',
    });

    if (chText) {
      splitProse(chText).forEach((chunk, ci) => {
        pages.push({
          id:       `chapter-${chIdx}-text-${ci}`,
          label:    `Ch.${chNum} — Page ${ci + 1}`,
          subTitle: chTitle,
          text:     chunk,
          pageNum:  runningPageNum++,
          imageUrl: '',
        });
      });
    }

    if (chMoments[1]) {
      pages.push({
        id:       `chapter-${chIdx}-moment-1`,
        label:    `Ch.${chNum} — Scene 2`,
        imageUrl: pickUrl(chMoments[1]) || '',
        text:     chMoments[1].current?.momentTitle || '',
      });
    }

    chMoments.slice(2).forEach((moment, mi) => {
      pages.push({
        id:       `chapter-${chIdx}-moment-${mi + 2}`,
        label:    `Ch.${chNum} — Scene ${mi + 3}`,
        imageUrl: pickUrl(moment) || '',
        text:     moment.current?.momentTitle || '',
      });
    });
  }

  return pages;
}

// ─── buildAllPages — full page list from project artifacts ────────────────────
// Mirrors the exact logic in useBookEditor.ts so the export always includes
// every page — even ones the user never opened in the editor.

function buildAllPages(project) {
  const arts     = project.artifacts || {};
  const r        = arts.review       || {};
  const cov      = arts.cover        || {};

  const bookTitle  = r.story?.current?.bookTitle || project.title || 'Untitled Book';
  const authorName = project.authorName || '';
  const synopsis   = r.story?.current?.synopsis  || '';
  const mode       = project.workflow?.mode       || 'picture-book';
  const isChapter  = mode === 'chapter-book';

  // Cover URLs — current model: cover.front.current.variants[sel].imageUrl
  const frontUrl =
    cov.front?.current?.imageUrl ||
    normArr(cov.front?.current?.variants ?? [])[cov.front?.current?.selectedVariantIndex ?? 0]?.imageUrl ||
    normArr(cov.frontVariants ?? [])[cov.frontSelectedVariantIndex ?? 0]?.imageUrl ||
    cov.frontUrl || '';

  const backUrl =
    cov.back?.current?.imageUrl ||
    normArr(cov.back?.current?.variants ?? [])[cov.back?.current?.selectedVariantIndex ?? 0]?.imageUrl ||
    normArr(cov.backVariants ?? [])[cov.backSelectedVariantIndex ?? 0]?.imageUrl ||
    cov.backUrl || '';

  const illustrations = normArr(r.illustrations  ?? []);
  const structures    = normArr(r.structure?.items ?? []);
  const humanized     = normArr(r.humanized       ?? []);
  const prose         = normArr(r.prose           ?? []);

  const bookPages = [];

  bookPages.push({
    id:       'cover-front',
    label:    'Front Cover',
    imageUrl: frontUrl,
    title:    bookTitle,
    text:     authorName ? `By ${authorName}` : '',
  });

  if (isChapter) {
    bookPages.push(...buildChapterPagesForExport(illustrations, humanized, prose));
  } else {
    bookPages.push(...buildSpreadPagesForExport(illustrations, structures));
  }

  bookPages.push({
    id:       'cover-back',
    label:    'Back Cover',
    imageUrl: backUrl,
    text:     synopsis,
  });

  // Merge in any saved editor overrides (text edits, title edits, thumbnail,
  // explicit imageUrl overrides the user applied in the editor).
  const savedById = {};
  normArr(arts.editorPages ?? []).forEach((sp) => {
    if (sp?.id) savedById[sp.id] = sp;
  });

  return bookPages.map((page) => {
    const saved = savedById[page.id];
    if (!saved) return page;
    return {
      ...page,
      ...(saved.thumbnail  !== undefined && { thumbnail:  saved.thumbnail  }),
      ...(saved.text       && { text:  saved.text  }),
      ...(saved.title      && { title: saved.title }),
      // Only override imageUrl from saved data if the artifact source was empty
      ...(!page.imageUrl && saved.imageUrl && { imageUrl: saved.imageUrl }),
    };
  });
}

// ─── Template list ────────────────────────────────────────────────────────────

router.get('/:projectId/export/templates', (req, res) => {
  const templates = Object.entries(PDF_TEMPLATES).map(([id, t]) => ({
    id,
    name:           t.name,
    pageBackground: t.pageBackground,
    accentColor:    t.accentColor,
  }));
  res.json({ templates });
});

// ─── PDF export ───────────────────────────────────────────────────────────────

router.get('/:projectId/export/pdf', async (req, res, next) => {
  console.log('[exportPdf] hit — projectId:', req.params.projectId, 'user:', req.user?._id);

  try {
    const { projectId } = req.params;
    const rawTemplate  = req.query.template;
    const rawPlatform  = req.query.platform;
    const templateId   = VALID_TEMPLATES.has(rawTemplate) ? rawTemplate : 'classic';
    const platformId   = VALID_PLATFORMS.has(rawPlatform) ? rawPlatform : 'kdp';

    console.log('[exportPdf] template:', templateId, 'platform:', platformId);

    const project = await Project.findById(projectId).lean();
    if (!project) throw new NotFoundError('Project not found');
    if (project.userId.toString() !== req.user._id.toString()) {
      throw new ForbiddenError();
    }

    // Build the complete page list from project artifacts — every page gets its
    // imageUrl from illustrations/cover data even if the user never opened it.
    const rawPages    = buildAllPages(project);
    const sortedPages = sortPagesCanonically(rawPages);

    if (sortedPages.length === 0) {
      return res.status(422).json({
        error: 'No book content found. Please complete the book creation steps before exporting.',
      });
    }

    // Load saved fabricJson for pages the user did edit in the canvas.
    const pageContents = await PageContent.find({
      projectId: project._id,
      pageId: { $in: sortedPages.map((p) => p.id) },
    }).lean();

    const contentMap = {};
    pageContents.forEach((c) => {
      contentMap[c.pageId] = c.fabricJson;
    });

    const editorPages = sortedPages.map((p) => ({
      ...p,
      fabricJson: contentMap[p.id] ?? null,
      // imageUrl already set from buildAllPages; keep it unless fabricJson overrides below
    }));

    // chapterImageMap — maps chapterIndex → imageUrl for use on text pages.
    // Step 1: seed from editorPages.imageUrl (set by buildAllPages from artifacts).
    // Step 2: override with any image the user explicitly set in the canvas editor.
    const chapterImageMap = {};

    editorPages.forEach((p) => {
      if (!p.imageUrl) return;
      const m = (p.id ?? '').match(/^chapter-(\d+)-(opener|scene|moment)/i);
      if (!m) return;
      const chN = parseInt(m[1], 10);
      if (!chapterImageMap[chN]) chapterImageMap[chN] = p.imageUrl;
    });

    editorPages.forEach((p) => {
      const m = (p.id ?? '').match(/^chapter-(\d+)-(opener|scene|moment)/i);
      if (!m) return;
      const chN = parseInt(m[1], 10);

      const fj = (() => {
        const raw = p.fabricJson;
        if (!raw) return {};
        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch { return {}; }
      })();

      const url =
        fj.backgroundImage?.src ||
        (Array.isArray(fj.objects)
          ? fj.objects.find((o) => o?.type === 'image' && o.src)?.src
          : null) || null;

      if (url && fj.backgroundImage?.src) {
        chapterImageMap[chN] = url;
      } else if (url && !chapterImageMap[chN]) {
        chapterImageMap[chN] = url;
      }
    });

    const pagesForRender = editorPages.map((p) => {
      const m = (p.id ?? '').match(/^chapter-(\d+)-text/i);
      if (!m) return p;

      const chN = parseInt(m[1], 10);
      const chapterImageUrl = chapterImageMap[chN] ?? null;

      return chapterImageUrl ? { ...p, chapterImageUrl } : p;
    });

    const htmlPages = pagesForRender.map((page) => renderPageHtml(page, templateId, platformId));

    console.log('[exportPdf] launching Puppeteer for', htmlPages.length, 'pages, platform:', platformId);
    const pdfBuffer = await renderHtmlPagesToPdf(htmlPages, templateId, platformId);
    console.log('[exportPdf] PDF ready, bytes:', pdfBuffer.length);

    const safeName =
      (project.title || 'book').replace(/[^a-z0-9_\-\s]/gi, '').trim() || 'book';

    res.status(200);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}-${platformId}.pdf"`,
      'Content-Length': pdfBuffer.length,
      'Access-Control-Expose-Headers': 'Content-Disposition',
      'Cache-Control': 'no-store',
    });

    return res.end(pdfBuffer);
  } catch (err) {
    console.error('[exportPdf] ERROR:', err.message, err.stack);
    next(err);
  }
});

export default router;