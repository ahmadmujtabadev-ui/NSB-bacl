import { Router } from 'express';
import { generateImage } from '../../services/ai/image/image.providers.js';
import { generateBookIllustrations, generateStageImage, getImagesPerChapter, getSafeChapterCount } from '../../services/ai/image/image.service.js';
import { checkImageLimit } from '../../services/ai/policies/imageLimits.js';
import { STAGE_CREDIT_COSTS } from '../../services/ai/ai.billing.js';
import { deductCredits } from '../../middleware/credits.js';
import { logAIUsage } from '../../services/ai/ai.telemetry.js';
import { ValidationError } from '../../errors.js';
import { estimateTokens } from '../../services/ai/policies/tokenBudget.js';
import { Project } from '../../models/Project.js';
import { generateStageText } from '../../services/ai/text/text.service.js';

const router = Router();

const STAGE_MAP = { illustration: 'illustrations', cover: 'cover', portrait: 'portrait', 'pose-sheet': 'poseSheet' };

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/image/generate
// Server-side — auto-fetches character refs from MongoDB
// ─────────────────────────────────────────────────────────────────────────────
// router.post('/generate', async (req, res, next) => {
//   const { task, chapterIndex = 0, projectId, customPrompt, seed, style, traceId } = req.body;
//   console.log(`\n[ImageRoute /generate] task=${task} chapterIndex=${chapterIndex} projectId=${projectId}`);

//   if (!task)      return next(new ValidationError('task is required'));
//   if (!projectId) return next(new ValidationError('projectId is required'));

//   const creditStage = STAGE_MAP[task] || 'illustrations';
//   const cost        = STAGE_CREDIT_COSTS[creditStage] ?? 4;
//   console.log(`[ImageRoute /generate] creditStage=${creditStage} cost=${cost} userCredits=${req.user.credits}`);

//   if (req.user.credits < cost) {
//     return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits, have ${req.user.credits}` } });
//   }

//   const start = Date.now();
//   try {
//     const result = await generateStageImage({
//       task, chapterIndex: parseInt(chapterIndex, 10), projectId,
//       userId: req.user._id.toString(), customPrompt, seed, style, traceId,
//     });

//     console.log(`[ImageRoute /generate] ✓ Success in ${Date.now() - start}ms — provider: ${result.provider}`);

//     await deductCredits(req.user._id, cost, `AI Image: ${task}`, 'project', projectId);

//     logAIUsage({
//       userId: req.user._id, projectId, provider: result.provider, stage: creditStage,
//       requestType: 'image', creditsCharged: cost, success: true, durationMs: Date.now() - start,
//     });

//     res.json(result);
//   } catch (err) {
//     console.error(`[ImageRoute /generate] ✗ Error: ${err.message}`);
//     console.error(err.stack);
//     logAIUsage({
//       userId: req.user._id, projectId, provider: 'unknown', stage: task,
//       requestType: 'image', creditsCharged: 0, success: false, errorCode: err.code,
//     });
//     next(err);
//   }
// });

// server/routes/ai/text.generate.router.js
// ── Text generation router ────────────────────────────────────────────────────
// Stages:
//   outline     → full book outline (chapters array + dedication + islamicTheme)
//   dedication  → page 2 — warm author message to parents/children
//   theme       → page 3 — Islamic reference / hadees / Quran page
//   chapters    → generate ALL chapters (picture-book: spreads; chapter-book: prose)
//   chapter     → generate SINGLE chapter (chapterIndex required)
//   humanize    → polish ALL chapters
// ─────────────────────────────────────────────────────────────────────────────

// server/routes/ai/image.generate.router.js
// ── Image generation router ───────────────────────────────────────────────────
// Tasks:
//   illustrations  → generate ALL chapter spreads (picture-book) or chapter images
//   illustration   → single spread / chapter image rerun  (chapterIndex + spreadIndex)
//   cover          → front cover
//   back-cover     → back cover
//   pose-sheet     → character pose sheet
// ─────────────────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res, next) => {
  const {
    task,
    chapterIndex,
    spreadIndex,      // ← NEW: which spread within the chapter (picture-book only)
    projectId,
    customPrompt,
    seed,
    style,
    traceId,
  } = req.body;

  if (!task) return next(new ValidationError('task is required'));
  if (!projectId) return next(new ValidationError('projectId is required'));

  try {
    const project = await Project.findOne({ _id: projectId, userId: req.user._id });
    if (!project) throw new NotFoundError('Project not found');

    const start = Date.now();
    let result;
    let totalCost = 0;

    if (task === 'illustrations') {
      // Full-book illustration run
      const chapterCount = getSafeChapterCount(project);
      const imagesPerChapter = getImagesPerChapter(project.ageRange);

      totalCost = chapterCount * imagesPerChapter * 4;

      if (req.user.credits < totalCost) {
        return res.status(402).json({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: `Need ${totalCost} credits, have ${req.user.credits}`,
          },
        });
      }

      result = await generateBookIllustrations({
        projectId,
        userId: req.user._id.toString(),
        style,
        seed,
        traceId,
      });

    } else {
      // Single image task
      totalCost = 4;

      if (req.user.credits < totalCost) {
        return res.status(402).json({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: `Need ${totalCost} credits, have ${req.user.credits}`,
          },
        });
      }

      result = await generateStageImage({
        task,
        chapterIndex: parseInt(chapterIndex ?? 0, 10),
        spreadIndex: parseInt(spreadIndex ?? 0, 10),   // ← passed through
        projectId,
        userId: req.user._id.toString(),
        customPrompt,
        seed,
        style,
        traceId,
      });
    }

    await deductCredits(req.user._id, totalCost, `AI Image: ${task}`, 'project', projectId);

    logAIUsage({
      userId: req.user._id,
      projectId,
      provider: result.provider || 'mixed',
      stage: task,
      requestType: 'image',
      creditsCharged: totalCost,
      success: true,
      durationMs: Date.now() - start,
    });

    res.json({ ...result, creditsCharged: totalCost });

  } catch (err) {
    logAIUsage({
      userId: req.user._id,
      projectId,
      provider: 'unknown',
      stage: task,
      requestType: 'image',
      creditsCharged: 0,
      success: false,
      errorCode: err.code,
    });
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/image
// Raw endpoint — caller supplies all params including references
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  const { task, prompt, references, style, width, height, count = 1, seed, referenceStrength, projectId, attemptId, traceId } = req.body;
  console.log(`\n[ImageRoute /] task=${task} prompt="${prompt?.slice(0, 60)}" refs=${references?.length || 0}`);

  if (!prompt) return next(new ValidationError('prompt is required'));
  if (!task) return next(new ValidationError('task is required'));

  const { ok, limit } = checkImageLimit(task, count);
  if (!ok) {
    return res.status(400).json({ error: { code: 'IMAGE_LIMIT_EXCEEDED', message: `Max ${limit} images for ${task}` } });
  }

  const creditStage = STAGE_MAP[task] || 'illustrations';
  const cost = STAGE_CREDIT_COSTS[creditStage] ?? 4;
  console.log(`[ImageRoute /] creditStage=${creditStage} cost=${cost} userCredits=${req.user.credits}`);

  if (req.user.credits < cost) {
    return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` } });
  }

  const trId = traceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();

  try {
    const result = await generateImage({ task, prompt, references, style, width, height, count, seed, referenceStrength, projectId, traceId: trId });
    console.log(`[ImageRoute /] ✓ Success in ${Date.now() - start}ms — provider: ${result.provider}`);

    await deductCredits(req.user._id, cost, `AI Image: ${task}`, 'project', projectId);

    logAIUsage({
      userId: req.user._id, projectId, provider: result.provider, stage: creditStage,
      requestType: 'image', tokensIn: estimateTokens(prompt),
      creditsCharged: cost, success: true, durationMs: Date.now() - start,
      metadata: { attemptId, task, traceId: trId },
    });

    res.json(result);
  } catch (err) {
    console.error(`[ImageRoute /] ✗ Error: ${err.message}`);
    console.error(err.stack);
    logAIUsage({
      userId: req.user._id, projectId, provider: 'unknown', stage: task,
      requestType: 'image', creditsCharged: 0, success: false, errorCode: err.code,
      metadata: { attemptId },
    });
    next(err);
  }
});

export default router;
