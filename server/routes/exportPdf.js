// server/routes/exportPdf.js
//
// GET /api/projects/:projectId/export/pdf?template=classic|modern|editorial
// GET /api/projects/:projectId/export/templates
//
// ──────────────────────────────────────────────────────────────────────────────
// CRITICAL FIX — Chapter text pages now get their chapter's image from the
// imageUrlMap built from project artifacts, not from fabricJson (which may not
// exist for pages the user never opened in the editor).
//
// This ensures every page in the book renders with correct content in the
// downloaded PDF, regardless of whether the user clicked through every page.
// ──────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { Project } from '../models/Project.js';
import PageContent from '../models/PageContent.js';
import { NotFoundError, ForbiddenError } from '../errors.js';
import { renderPageHtml, PDF_TEMPLATES } from '../lib/renderPageHtml.js';
import { renderHtmlPagesToPdf } from '../lib/puppeteerPdf.js';

const router = Router();
const VALID_TEMPLATES = new Set(Object.keys(PDF_TEMPLATES));

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

  return [chN + 1, typeRank, idx];
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

function buildImageUrlMap(project) {
  const map  = {};
  const arts = project.artifacts || {};

  // Cover
  const cov = arts.cover || {};
  const frontVariants = normArr(cov.frontVariants ?? []);
  const frontSelIdx   = cov.frontSelectedVariantIndex ?? 0;
  const frontUrl      = frontVariants[frontSelIdx]?.imageUrl || cov.frontUrl || null;
  if (frontUrl) map['cover-front'] = frontUrl;

  const backVariants = normArr(cov.backVariants ?? []);
  const backSelIdx   = cov.backSelectedVariantIndex ?? 0;
  const backUrl      = backVariants[backSelIdx]?.imageUrl || cov.backUrl || null;
  if (backUrl) map['cover-back'] = backUrl;

  // Review illustrations
  const reviewIlls = normArr(arts.review?.illustrations ?? []);
  reviewIlls.forEach((ill) => {
    const url = pickUrl(ill);
    if (!url || !ill.key) return;

    if (ill.sourceType === 'spread') {
      map[`spread-${ill.key}`] = url;
    } else if (ill.sourceType === 'chapter-moment') {
      const ch = ill.chapterIndex ?? 0;
      const si = ill.spreadIndex  ?? 0;
      if (si === 0) map[`chapter-${ch}-opener`]   = url;
      map[`chapter-${ch}-moment-${si}`] = url;
    }
  });

  if (reviewIlls.length === 0) {
    normArr(arts.spreadIllustrations ?? []).forEach((ill, si) => {
      const url = pickUrl(ill);
      if (url) map[`spread-s${si}`] = url;
    });
  }

  return map;
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
    const rawTemplate = req.query.template;
    const templateId = VALID_TEMPLATES.has(rawTemplate) ? rawTemplate : 'classic';

    console.log('[exportPdf] template:', templateId);

    const project = await Project.findById(projectId).lean();
    if (!project) throw new NotFoundError('Project not found');
    if (project.userId.toString() !== req.user._id.toString()) {
      throw new ForbiddenError();
    }

    const rawPages = normArr(project.artifacts?.editorPages ?? []);
    const sortedPages = sortPagesCanonically(rawPages);

    const pageContents = await PageContent.find({
      projectId: project._id,
      pageId: { $in: sortedPages.map((p) => p.id) },
    }).lean();

    const contentMap = {};
    pageContents.forEach((c) => {
      contentMap[c.pageId] = c.fabricJson;
    });

    const imageUrlMap = buildImageUrlMap(project);

    const editorPages = sortedPages.map((p) => ({
      ...p,
      fabricJson: contentMap[p.id] ?? null,
      imageUrl: p.imageUrl || imageUrlMap[p.id] || null,
    }));

    if (editorPages.length === 0) {
      return res.status(422).json({
        error: 'No editor pages saved yet. Open the editor, make a change, and save before exporting.',
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Build chapterImageMap — each chapter's image URL to inherit on its text
    // pages. Previously only extracted from saved fabricJson (so unopened
    // chapter pages had no image). Now ALSO pulls from imageUrlMap which
    // always has the opener/moment URLs straight from project.artifacts.
    // ──────────────────────────────────────────────────────────────────────────
    const chapterImageMap = {};

    // Step 1: from imageUrlMap (reliable source — always populated)
    for (const [pageId, url] of Object.entries(imageUrlMap)) {
      if (!url) continue;
      const m = pageId.match(/^chapter-(\d+)-(opener|scene|moment)/i);
      if (!m) continue;
      const chN = parseInt(m[1], 10);
      if (!chapterImageMap[chN]) chapterImageMap[chN] = url;
    }

    // Step 2: from saved fabricJson (in case user edited an opener and changed image)
    editorPages.forEach((p) => {
      const m = (p.id ?? '').match(/^chapter-(\d+)-(opener|scene|moment)/i);
      if (!m) return;

      const chN = parseInt(m[1], 10);

      const fj = (() => {
        const raw = p.fabricJson;
        if (!raw) return {};
        try {
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          return {};
        }
      })();

      const url =
        fj.backgroundImage?.src ||
        (Array.isArray(fj.objects)
          ? fj.objects.find((o) => o?.type === 'image' && o.src)?.src
          : null) ||
        null;

      // Override only if the user actually edited the image — otherwise keep
      // the artifact-sourced URL which we set in step 1.
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

    const htmlPages = pagesForRender.map((page) => renderPageHtml(page, templateId));

    console.log('[exportPdf] launching Puppeteer for', htmlPages.length, 'pages...');
    const pdfBuffer = await renderHtmlPagesToPdf(htmlPages, templateId);
    console.log('[exportPdf] PDF ready, bytes:', pdfBuffer.length);

    const safeName =
      (project.title || 'book').replace(/[^a-z0-9_\-\s]/gi, '').trim() || 'book';

    res.status(200);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}-${templateId}.pdf"`,
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