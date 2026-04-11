// server/routes/exportPdf.js
//
// GET /api/projects/:projectId/export/pdf?template=classic|modern|editorial
// GET /api/projects/:projectId/export/templates
//
// KEY FIX: editorPages are stored in MongoDB in insertion order (when each
// page was first saved/modified), NOT in canonical book order.  Pages added
// later (scene/moment illustrations) pile up at the end of the array.
// sortPagesCanonically() reorders them to match the editor's display order:
//   cover-front → chapter N opener → chapter N text-0..K → chapter N moment-1..M → … → cover-back

import { Router } from 'express';
import { Project } from '../models/Project.js';
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

/**
 * Converts a page id into a numeric sort key tuple so pages render in the
 * same order the editor displays them.
 *
 * Canonical order:
 *   [0] cover-front
 *   [chN+1, 0, idx]  chapter-N-opener
 *   [chN+1, 1, idx]  chapter-N-text-0 .. chapter-N-text-K   (sorted by idx)
 *   [chN+1, 2, idx]  chapter-N-moment-1 / chapter-N-scene-1 (after text)
 *   [chN+1, 3, idx]  anything else in that chapter
 *   [99999] cover-back
 *
 * Unknown ids sort just before cover-back.
 */
function pageOrder(id = '') {
  if (id === 'cover-front') return [0, 0, 0];
  if (id === 'cover-back')  return [99999, 0, 0];

  // chapter-N-type  OR  chapter-N-type-index
  const m = id.match(/^chapter-(\d+)-([a-z]+)(?:-(\d+))?$/i);
  if (!m) return [98000, 0, 0]; // unknown → near end

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
    const templateId  = VALID_TEMPLATES.has(rawTemplate) ? rawTemplate : 'classic';
    console.log('[exportPdf] template:', templateId);

    // ── 1. Fetch & authorise ──────────────────────────────────────────────
    const project = await Project.findById(projectId).lean();
    if (!project) throw new NotFoundError('Project not found');
    if (project.userId.toString() !== req.user._id.toString()) throw new ForbiddenError();

    // ── 2. Load + sort editor pages into canonical book order ─────────────
    const rawPages    = normArr(project.artifacts?.editorPages ?? []);
    const editorPages = sortPagesCanonically(rawPages);

    // ── Full page manifest (one line per page for easy diagnosis) ─────────
    console.log(`[exportPdf] ── Page manifest (${editorPages.length} pages) ──`);
    editorPages.forEach((p, i) => {
      const dbIdx  = rawPages.findIndex(r => r.id === p.id);
      const moved  = dbIdx !== i ? ` ← was DB[${dbIdx + 1}]` : '';
      const fj     = p.fabricJson ?? {};
      const parsed = typeof fj === 'string' ? (() => { try { return JSON.parse(fj); } catch { return {}; } })() : fj;
      const objCount  = Array.isArray(parsed.objects) ? parsed.objects.length : 0;
      const hasBgImg  = !!(parsed.backgroundImage?.src);
      const hasBgClr  = !!parsed.background;
      const hasThumb  = !!p.thumbnail;
      const isEmpty   = objCount === 0 && !hasBgImg && !hasBgClr;
      const status    = isEmpty
        ? (hasThumb ? 'THUMBNAIL'   : 'PLACEHOLDER')
        : `objects:${objCount}${hasBgImg ? '+bgImg' : ''}${hasBgClr ? '+bgClr' : ''}`;
      console.log(`  PDF[${String(i + 1).padStart(2, '0')}] "${p.id}"${moved} → ${status}`);
    });
    console.log('[exportPdf] ─────────────────────────────────────────────────');

    if (editorPages.length === 0) {
      return res.status(422).json({
        error: 'No editor pages saved yet. Open the editor, make a change, and save before exporting.',
      });
    }

    // ── 3a. Build per-chapter illustration URL map ────────────────────────
    // For layout templates (stacked / sidebyside) text pages need the chapter's
    // illustration.  Extract the primary image URL from each chapter's
    // opener → scene → moment page (first found wins) and store it keyed by
    // chapter index so we can inject it into text pages below.
    const chapterImageMap = {};  // chN (number) → imageUrl (string)

    editorPages.forEach((p) => {
      const m = (p.id ?? '').match(/^chapter-(\d+)-(opener|scene|moment)/i);
      if (!m) return;
      const chN = parseInt(m[1], 10);
      if (chapterImageMap[chN]) return; // opener already wins over scene/moment

      const fj = (() => {
        const raw = p.fabricJson;
        if (!raw) return {};
        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch { return {}; }
      })();

      const url =
        fj.backgroundImage?.src ||
        (Array.isArray(fj.objects) ? fj.objects.find(o => o?.type === 'image' && o.src)?.src : null) ||
        null;

      if (url) {
        chapterImageMap[chN] = url;
        console.log(`[exportPdf] chapter ${chN} illustration: ${url.slice(0, 60)}…`);
      }
    });

    // Attach chapterImageUrl to each text page so layout strategies can use it
    const pagesForRender = editorPages.map((p) => {
      const m = (p.id ?? '').match(/^chapter-(\d+)-text/i);
      if (!m) return p;
      const chN = parseInt(m[1], 10);
      const chapterImageUrl = chapterImageMap[chN] ?? null;
      return chapterImageUrl ? { ...p, chapterImageUrl } : p;
    });

    // ── 3b. Render HTML per page ──────────────────────────────────────────
    const htmlPages = pagesForRender.map((page) => renderPageHtml(page, templateId));

    // ── 4 & 5. Screenshot + assemble PDF ─────────────────────────────────
    console.log('[exportPdf] launching Puppeteer for', htmlPages.length, 'pages...');
    const pdfBuffer = await renderHtmlPagesToPdf(htmlPages, templateId);
    console.log('[exportPdf] PDF ready, bytes:', pdfBuffer.length);

    // ── 6. Stream back ────────────────────────────────────────────────────
    const safeName = (project.title || 'book')
      .replace(/[^a-z0-9_\-\s]/gi, '')
      .trim() || 'book';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${templateId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(pdfBuffer);

  } catch (err) {
    console.error('[exportPdf] ERROR:', err.message, err.stack);
    next(err);
  }
});

export default router;
