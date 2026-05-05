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

// ─── Server-side image fetching (converts external URLs → base64 data URIs) ──
// Puppeteer headless Chrome can be blocked by CORS/CDN policies when loading
// external images from injected HTML.  Fetching in Node.js has no such limits.

async function fetchAsDataUri(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'image/*,*/*', 'User-Agent': 'NoorStudio-Export/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.warn('[exportPdf] img fetch failed', res.status, url.slice(0, 80)); return null; }
    const ct  = res.headers.get('content-type') || 'image/jpeg';
    const buf = await res.arrayBuffer();
    return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
  } catch (err) {
    console.warn('[exportPdf] img fetch error:', err.message, url.slice(0, 80));
    return null;
  }
}

async function buildDataUriMap(pages) {
  // Collect every unique external image URL referenced by any page
  const urls = new Set();
  for (const p of pages) {
    if (p.imageUrl)        urls.add(p.imageUrl);
    if (p.chapterImageUrl) urls.add(p.chapterImageUrl);
    const raw = p.fabricJson;
    if (raw) {
      try {
        const fj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (fj?.backgroundImage?.src) urls.add(fj.backgroundImage.src);
        if (Array.isArray(fj?.objects)) {
          for (const o of fj.objects) { if (o?.src) urls.add(o.src); }
        }
      } catch { /* ignore */ }
    }
  }

  const list = [...urls].filter(u => u && u.startsWith('http'));
  console.log(`[exportPdf] Pre-fetching ${list.length} images server-side…`);

  const map = {};
  // Fetch in batches of 6 in parallel
  for (let i = 0; i < list.length; i += 6) {
    const batch   = list.slice(i, i + 6);
    const results = await Promise.all(batch.map(fetchAsDataUri));
    batch.forEach((url, idx) => {
      if (results[idx]) {
        map[url] = results[idx];
        console.log(`[exportPdf] ✓ cached (${Math.round(results[idx].length / 1024)} KB) ${url.slice(0, 70)}`);
      }
    });
  }
  console.log(`[exportPdf] ${Object.keys(map).length}/${list.length} images cached as data URIs`);
  return map;
}

function inlineImages(html, map) {
  let out = html;
  for (const [url, dataUri] of Object.entries(map)) {
    // Replace every occurrence of the URL in src="..." or url(...)
    const safe = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(safe, 'g'), dataUri);
  }
  return out;
}

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

// Mirrors frontend illusUrl() in useBookEditor.ts exactly
function pickUrl(node) {
  if (!node) return null;
  // Try node.current first (the normal structure)
  const cur = node.current;
  if (cur) {
    const variants = normArr(cur.variants ?? []);
    const selIdx = cur.selectedVariantIndex ?? 0;
    const fromVariant = variants[selIdx]?.imageUrl;
    if (fromVariant) return fromVariant;
    // Try any variant that has an imageUrl
    for (const v of variants) { if (v?.imageUrl) return v.imageUrl; }
    if (cur.imageUrl) return cur.imageUrl;
  }
  // Fallback: treat the node itself as the data object
  const variants = normArr(node.variants ?? node.frontVariants ?? []);
  const selIdx = node.selectedVariantIndex ?? node.frontSelectedVariantIndex ?? 0;
  const fromVariant = variants[selIdx]?.imageUrl;
  if (fromVariant) return fromVariant;
  for (const v of variants) { if (v?.imageUrl) return v.imageUrl; }
  return node.imageUrl || node.frontUrl || null;
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

  const illustrations = normArr(r.illustrations  ?? []);
  const structures    = normArr(r.structure?.items ?? []);
  const humanized     = normArr(r.humanized       ?? []);
  const prose         = normArr(r.prose           ?? []);

  // Cover URLs — mirrors useBookEditor.ts cover extraction exactly
  const frontUrl = pickUrl(cov.front) || pickUrl(cov) || cov.frontUrl || '';
  const backUrl  = pickUrl(cov.back)  || cov.backUrl  || '';

  console.log('[exportPdf] cover frontUrl:', frontUrl ? frontUrl.slice(0, 80) : '(empty)');
  console.log('[exportPdf] cover backUrl:', backUrl ? backUrl.slice(0, 80) : '(empty)');
  if (illustrations[0]) {
    console.log('[exportPdf] sample ill keys:', Object.keys(illustrations[0]).join(', '));
    console.log('[exportPdf] sample ill.current keys:', illustrations[0].current ? Object.keys(illustrations[0].current).join(', ') : '(no current)');
    console.log('[exportPdf] sample ill pickUrl:', pickUrl(illustrations[0])?.slice(0, 80) ?? '(empty)');
  }

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

    // Pre-fetch every external image as a base64 data URI so Puppeteer never
    // needs to make outbound HTTP requests (CORS/CDN policies block those).
    const imageMap = await buildDataUriMap(pagesForRender);

    const htmlPages = pagesForRender.map((page) => {
      const html = renderPageHtml(page, templateId, platformId);
      return inlineImages(html, imageMap);
    });

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