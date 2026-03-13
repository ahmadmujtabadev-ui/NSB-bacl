// server/routes/exports.js
import { Router } from "express";
import { Project } from "../models/Project.js";
import { Export } from "../models/Export.js";
import { deductCredits } from "../middleware/credits.js";
import { STAGE_CREDIT_COSTS } from "../services/ai/ai.billing.js";
import { NotFoundError, ForbiddenError, ValidationError } from "../errors.js";
import { buildPDF } from "../utils/buildPDF.js";

const router = Router();

// GET /api/exports/:projectId
router.get("/:projectId", async (req, res, next) => {
  try {
    const p = await Project.findOne({
      _id: req.params.projectId,
      userId: req.user._id,
    }).lean(); // lean for consistency
    if (!p) throw new NotFoundError("Project not found");

    const exports = await Export.find({ projectId: p._id }).sort({ createdAt: -1 }).lean();
    return res.json({ exports });
  } catch (e) {
    next(e);
  }
});


router.post("/", async (req, res, next) => {
  let exportDoc = null;

  try {
    const { projectId } = req.body;
    if (!projectId) throw new ValidationError("projectId is required");

    // ── CRITICAL: .lean() returns a plain JS object ──────────────
    // Without this, Mongoose Mixed fields (artifacts with base64 images)
    // may not return their full data — causing all images to be null.
    const p = await Project.findOne({
      _id: projectId,
      userId: req.user._id,
    }).lean();

    if (!p) throw new NotFoundError("Project not found");

    console.log("[exports] Project loaded via .lean(). artifacts keys:", Object.keys(p.artifacts ?? {}));

    // Guard: need chapters or humanized to export
    const hasChapters  = Array.isArray(p.artifacts?.chapters)  && p.artifacts.chapters.length  > 0;
    const hasHumanized = Array.isArray(p.artifacts?.humanized) && p.artifacts.humanized.length > 0;

    if (!hasChapters && !hasHumanized) {
      throw new ValidationError("Run the Chapters stage before exporting.");
    }

    // Credit check
    const cost = STAGE_CREDIT_COSTS.export ?? 2;
    if (req.user.credits < cost) {
      return res.status(402).json({
        error: {
          code: "INSUFFICIENT_CREDITS",
          message: `Need ${cost} credits. You have ${req.user.credits}.`,
        },
      });
    }

    // Create export record
    exportDoc = await Export.create({
      projectId: p._id,
      userId: req.user._id,
      status: "processing",
      trimSize: p.trimSize,
    });

    // Build PDF — pass the plain object directly
    let pdfBytes;
    try {
      pdfBytes = await buildPDF(p); // p is already a plain object from .lean()
    } catch (err) {
      console.error("[exports] buildPDF threw:", err);
      exportDoc.status = "failed";
      exportDoc.error  = err?.message || "PDF build failed";
      await exportDoc.save();
      throw err;
    }

    // Validate it's actually a PDF
    const buffer = Buffer.from(pdfBytes);
    const header = buffer.slice(0, 5).toString();
    console.log("[exports] PDF header:", header, "size:", buffer.length, "bytes");

    if (!header.startsWith("%PDF")) {
      exportDoc.status = "failed";
      exportDoc.error  = "buildPDF returned non-PDF data";
      await exportDoc.save();
      return res.status(500).json({
        error: { code: "PDF_BUILD_ERROR", message: "PDF generation produced invalid output." },
      });
    }

    // Finalize
    exportDoc.status    = "complete";
    exportDoc.pageCount = p.artifacts?.layout?.pageCount || null;
    exportDoc.expiresAt = new Date(Date.now() + 48 * 3600 * 1000);
    await exportDoc.save();

    await deductCredits(req.user._id, cost, `Export: ${p.title}`, "project", p._id);

    // Update project status (use updateOne since p is a plain object from .lean())
    await Project.updateOne({ _id: p._id }, { $set: { status: "exported" } });

    // Send PDF
    const safeTitle = (p.title || "export")
      .replace(/[^a-z0-9\-_]/gi, "_")
      .replace(/_+/g, "_")
      .slice(0, 80);

    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.pdf"`);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("X-Export-Id", exportDoc._id.toString());
    res.setHeader("X-Credits-Charged", String(cost));
    res.setHeader("Cache-Control", "no-store");
    return res.end(buffer);

  } catch (e) {
    if (exportDoc && exportDoc.status === "processing") {
      exportDoc.status = "failed";
      exportDoc.error  = e?.message || "Unknown error";
      await exportDoc.save().catch(() => {});
    }
    next(e);
  }
});

// DELETE /api/exports/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const exp = await Export.findById(req.params.id);
    if (!exp) throw new NotFoundError("Export not found");
    if (!exp.userId.equals(req.user._id)) throw new ForbiddenError();
    await exp.deleteOne();
    return res.json({ message: "Export deleted" });
  } catch (e) {
    next(e);
  }
});

export default router;  