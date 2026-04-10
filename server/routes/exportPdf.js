// server/routes/exportPdf.js
// GET /api/projects/:projectId/export/pdf
//
// 1. Loads the project from MongoDB and verifies ownership.
// 2. Reads artifacts.editorPages (saved by the canvas editor via PATCH /:id/editor/pages).
// 3. Converts each page's fabricJson → HTML via renderPageHtml().
// 4. Screenshots each page with Puppeteer (fonts + images loaded).
// 5. Assembles screenshots into a single PDF with pdf-lib.
// 6. Streams the PDF back as a file download.
//
// Requires: puppeteer, pdf-lib (both in package.json)
// Mount in index.js:  app.use('/api/projects', authenticate, exportPdfRoutes);

import { Router } from 'express';
import { Project } from '../models/Project.js';
import { NotFoundError, ForbiddenError } from '../errors.js';
import { renderPageHtml } from '../lib/renderPageHtml.js';
import { renderHtmlPagesToPdf } from '../lib/puppeteerPdf.js';

const router = Router();

/** Re-uses the same normArr helper used in project-review.js */
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
 * GET /api/projects/:projectId/export/pdf
 *
 * Response: application/pdf  (streamed as attachment)
 * Errors:
 *   404 — project not found
 *   403 — not owned by requesting user
 *   422 — no editor pages saved yet
 *   500 — Puppeteer / PDF assembly error
 */
router.get('/:projectId/export/pdf', async (req, res, next) => {
  console.log('[exportPdf] hit — projectId:', req.params.projectId, 'user:', req.user?._id);
  try {
    const { projectId } = req.params;

    // ── 1. Fetch & authorise ─────────────────────────────────────────────────
    const project = await Project.findById(projectId).lean();
    console.log('[exportPdf] project found:', !!project, '— pages:', project?.artifacts?.editorPages?.length ?? 0);
    if (!project) throw new NotFoundError('Project not found');
    if (project.userId.toString() !== req.user._id.toString()) throw new ForbiddenError();

    // ── 2. Load editor pages ─────────────────────────────────────────────────
    const editorPages = normArr(project.artifacts?.editorPages ?? []);

    if (editorPages.length === 0) {
      return res.status(422).json({
        error: 'No editor pages have been saved yet. Open the editor, make any change, and save before exporting.',
      });
    }

    // ── 3. Render HTML per page ──────────────────────────────────────────────
    const htmlPages = editorPages.map((page) => renderPageHtml(page));

    // ── 4 & 5. Screenshot + assemble PDF ────────────────────────────────────
    console.log('[exportPdf] launching Puppeteer for', htmlPages.length, 'pages...');
    const pdfBuffer = await renderHtmlPagesToPdf(htmlPages);
    console.log('[exportPdf] PDF ready, bytes:', pdfBuffer.length);

    // ── 6. Stream back ───────────────────────────────────────────────────────
    const safeName = (project.title || 'book')
      .replace(/[^a-z0-9_\-\s]/gi, '')
      .trim() || 'book';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    // Allow frontend to read the blob even behind CORS
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(pdfBuffer);

  } catch (err) {
    console.error('[exportPdf] ERROR:', err.message, err.stack);
    next(err);
  }
});

export default router;
