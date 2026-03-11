import { Router } from 'express';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { Project } from '../models/Project.js';
import { Export } from '../models/Export.js';
import { deductCredits } from '../middleware/credits.js';
import { STAGE_CREDIT_COSTS } from '../services/ai/ai.billing.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';

const router = Router();

// GET /api/exports/:projectId
router.get('/:projectId', async (req, res, next) => {
  try {
    const p = await Project.findOne({ _id: req.params.projectId, userId: req.user._id });
    if (!p) throw new NotFoundError('Project not found');
    const exports = await Export.find({ projectId: p._id }).sort({ createdAt: -1 });
    res.json({ exports });
  } catch (e) { next(e); }
});

// POST /api/exports — Generate PDF export
router.post('/', async (req, res, next) => {
  try {
    const { projectId } = req.body;
    if (!projectId) throw new ValidationError('projectId is required');

    const p = await Project.findOne({ _id: projectId, userId: req.user._id });
    if (!p) throw new NotFoundError('Project not found');

    if (!p.artifacts?.layout) throw new ValidationError('Run layout stage before exporting');

    const cost = STAGE_CREDIT_COSTS.export;
    if (req.user.credits < cost) {
      return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` } });
    }

    // Create pending export record
    const exportDoc = await Export.create({
      projectId: p._id,
      userId: req.user._id,
      status: 'processing',
      trimSize: p.trimSize,
    });

    // Build PDF using pdf-lib
    let pdfBytes;
    try {
      pdfBytes = await buildPDF(p);
    } catch (err) {
      exportDoc.status = 'failed';
      exportDoc.error = err.message;
      await exportDoc.save();
      throw err;
    }

    // For now return as binary — in production, upload to Cloudinary first
    const expiresAt = new Date(Date.now() + 48 * 3600 * 1000);

    exportDoc.status = 'complete';
    exportDoc.pageCount = p.artifacts.layout?.pageCount || 12;
    exportDoc.expiresAt = expiresAt;
    // exportDoc.pdfUrl = cloudinaryUrl; // set after upload
    await exportDoc.save();

    await deductCredits(req.user._id, cost, `Export: ${p.title}`, 'project', p._id);

    p.status = 'exported';
    await p.save();

    // Return PDF as download
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${p.title.replace(/[^a-z0-9]/gi, '_')}.pdf"`,
      'X-Export-Id': exportDoc._id.toString(),
      'X-Credits-Charged': cost,
    });
    res.send(Buffer.from(pdfBytes));
  } catch (e) { next(e); }
});

// DELETE /api/exports/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const exp = await Export.findById(req.params.id);
    if (!exp) throw new NotFoundError('Export not found');
    if (!exp.userId.equals(req.user._id)) throw new ForbiddenError();
    await exp.deleteOne();
    res.json({ message: 'Export deleted' });
  } catch (e) { next(e); }
});

// ─── PDF Builder ─────────────────────────────────────────────────────────────

async function buildPDF(project) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  const layout = project.artifacts.layout || {};
  const spreads = layout.spreads || [];

  for (const spread of spreads) {
    const page = pdfDoc.addPage([612, 792]); // US Letter
    const { width, height } = page.getSize();

    if (spread.type === 'title-page') {
      page.drawText(project.title || 'Untitled', {
        x: width / 2 - 150,
        y: height / 2 + 50,
        size: 28, font: boldFont, color: rgb(0.1, 0.2, 0.4),
      });
      if (project.authorName) {
        page.drawText(`by ${project.authorName}`, {
          x: width / 2 - 60,
          y: height / 2,
          size: 16, font, color: rgb(0.3, 0.3, 0.3),
        });
      }
    } else if (spread.type === 'text' && spread.content?.text) {
      page.drawText(`Chapter ${spread.content.chapterNumber || ''}`, {
        x: 60, y: height - 80, size: 14, font: boldFont, color: rgb(0.1, 0.2, 0.4),
      });
      const lines = wrapText(spread.content.text, 70);
      let y = height - 110;
      for (const line of lines) {
        if (y < 60) break;
        page.drawText(line, { x: 60, y, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
        y -= 18;
      }
    } else if (spread.type === 'glossary' && spread.content?.vocabulary?.length) {
      page.drawText('Glossary', { x: 60, y: height - 80, size: 18, font: boldFont, color: rgb(0.1, 0.2, 0.4) });
      let y = height - 120;
      for (const item of spread.content.vocabulary) {
        if (y < 60) break;
        page.drawText(`${item.word}: ${item.definition}`, { x: 60, y, size: 11, font, color: rgb(0.15, 0.15, 0.15) });
        y -= 20;
      }
    } else {
      // Placeholder for illustration / cover pages
      page.drawRectangle({ x: 40, y: 40, width: width - 80, height: height - 80, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 });
      const label = spread.type === 'cover' ? project.title : `[${spread.type}]`;
      page.drawText(label || '', { x: width / 2 - 80, y: height / 2, size: 14, font, color: rgb(0.5, 0.5, 0.5) });
    }
  }

  return pdfDoc.save();
}

function wrapText(text, maxChars) {
  const words = text.replace(/\n/g, ' ').split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars) {
      lines.push(current.trim());
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

export default router;
