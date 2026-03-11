import { Router } from 'express';
import { generateText } from '../../services/ai/text/text.providers.js';
import { generateStageText } from '../../services/ai/text/text.service.js';
import { AI_TOKEN_BUDGETS, estimateTokens } from '../../services/ai/policies/tokenBudget.js';
import { requireCredits, deductCredits } from '../../middleware/credits.js';
import { logAIUsage } from '../../services/ai/ai.telemetry.js';
import { STAGE_CREDIT_COSTS } from '../../services/ai/ai.billing.js';
import { ValidationError } from '../../errors.js';
import { Project } from '../../models/Project.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/generate
// Server-side context builder — recommended for all production use.
// Fetches Universe + Characters + KnowledgeBase from MongoDB, builds prompts,
// calls AI, and saves artifacts atomically.
// ─────────────────────────────────────────────────────────────────────────────
// router.post('/generate', async (req, res, next) => {
//   const { stage, projectId, chapterIndex = 0 } = req.body;

//   if (!stage || !projectId) {
//     return next(new ValidationError('stage and projectId are required'));
//   }

//   const cost = STAGE_CREDIT_COSTS[stage] ?? 1;
//   if (req.user.credits < cost) {
//     return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits, have ${req.user.credits}` } });
//   }

//   const start = Date.now();
//   try {
//     const { result, usage, provider } = await generateStageText({
//       stage, projectId, userId: req.user._id.toString(), chapterIndex: parseInt(chapterIndex, 10),
//     });

//     await deductCredits(req.user._id, cost, `AI Stage: ${stage}`, 'project', projectId);

//     logAIUsage({
//       userId: req.user._id, projectId, provider, stage,
//       requestType: 'text',
//       tokensIn:  usage?.inputTokens,
//       tokensOut: usage?.outputTokens,
//       creditsCharged: cost,
//       success: true,
//       durationMs: Date.now() - start,
//     });

//     res.json({ result, usage, provider, creditsCharged: cost });
//   } catch (err) {
//     logAIUsage({
//       userId: req.user._id, projectId, provider: 'unknown', stage,
//       requestType: 'text', creditsCharged: 0, success: false,
//       errorCode: err.code || 'GENERATE_FAILED',
//     });
//     next(err);
//   }
// });

router.post('/generate', async (req, res, next) => {
  const { stage, projectId, chapterIndex } = req.body;

  if (!stage || !projectId) {
    return next(new ValidationError('stage and projectId are required'));
  }

  try {
    const project = await Project.findOne({ _id: projectId, userId: req.user._id });
    if (!project) {
      return next(new NotFoundError('Project not found'));
    }

    let result;
    let usage;
    let provider;
    let totalCredits = 0;

    const chargeStage = async (stageName, count = 1) => {
      const singleCost = STAGE_CREDIT_COSTS[stageName] ?? 1;
      const totalCost = singleCost * count;

      if (req.user.credits < totalCredits + totalCost) {
        throw new ValidationError(
          `Insufficient credits. Need ${totalCredits + totalCost}, have ${req.user.credits}`
        );
      }

      totalCredits += totalCost;
      return singleCost;
    };

    // ── Outline ─────────────────────────────────────────
    if (stage === 'outline') {
      await chargeStage('outline', 1);

      const res1 = await generateStageText({
        stage: 'outline',
        projectId,
        userId: req.user._id.toString(),
      });

      result = res1.result;
      usage = res1.usage;
      provider = res1.provider;
    }

    // ── Chapters (generate all) ────────────────────────
    else if (stage === 'chapters') {
      const outline = project.artifacts?.outline;
      const chapterCount =
        outline?.chapters?.length || project.chapterCount || 4;

      await chargeStage('chapters', chapterCount);

      const results = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let lastProvider = 'unknown';

      for (let i = 0; i < chapterCount; i++) {
        const res1 = await generateStageText({
          stage: 'chapter',
          projectId,
          userId: req.user._id.toString(),
          chapterIndex: i,
        });

        results.push(res1.result);
        totalInputTokens += res1.usage?.inputTokens || 0;
        totalOutputTokens += res1.usage?.outputTokens || 0;
        lastProvider = res1.provider || lastProvider;
      }

      result = results;
      usage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
      provider = lastProvider;
    }

    // ── Humanize (generate all) ────────────────────────
    else if (stage === 'humanize') {
      const chapters = Array.isArray(project.artifacts?.chapters)
        ? project.artifacts.chapters
        : [];

      if (!chapters.length) {
        return next(new ValidationError('Generate chapters first'));
      }

      await chargeStage('humanize', chapters.length);

      const results = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let lastProvider = 'unknown';

      for (let i = 0; i < chapters.length; i++) {
        const res1 = await generateStageText({
          stage: 'humanize',
          projectId,
          userId: req.user._id.toString(),
          chapterIndex: i,
        });

        results.push(res1.result);
        totalInputTokens += res1.usage?.inputTokens || 0;
        totalOutputTokens += res1.usage?.outputTokens || 0;
        lastProvider = res1.provider || lastProvider;
      }

      result = results;
      usage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      };
      provider = lastProvider;
    }

    // ── Single chapter/manual rerun support ────────────
    else if (stage === 'chapter') {
      await chargeStage('chapters', 1);

      const res1 = await generateStageText({
        stage: 'chapter',
        projectId,
        userId: req.user._id.toString(),
        chapterIndex: parseInt(chapterIndex ?? 0, 10),
      });

      result = res1.result;
      usage = res1.usage;
      provider = res1.provider;
    }

    else {
      return next(new ValidationError(`Unsupported stage: ${stage}`));
    }

    await deductCredits(
      req.user._id,
      totalCredits,
      `AI Stage: ${stage}`,
      'project',
      projectId
    );

    logAIUsage({
      userId: req.user._id,
      projectId,
      provider,
      stage,
      requestType: 'text',
      tokensIn: usage?.inputTokens,
      tokensOut: usage?.outputTokens,
      creditsCharged: totalCredits,
      success: true,
      durationMs: 0,
    });

    res.json({
      result,
      usage,
      provider,
      creditsCharged: totalCredits,
    });
  } catch (err) {
    logAIUsage({
      userId: req.user._id,
      projectId,
      provider: 'unknown',
      stage,
      requestType: 'text',
      creditsCharged: 0,
      success: false,
      errorCode: err.code || 'GENERATE_FAILED',
    });
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/text
// Raw text endpoint — caller supplies system + prompt.
// Used by advanced flows or direct integrations.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/text', async (req, res, next) => {
  const { system, prompt, maxOutputTokens, stage = 'outline', projectId, attemptId } = req.body;

  if (!prompt || !system) return next(new ValidationError('prompt and system are required'));

  const budget = AI_TOKEN_BUDGETS[stage];
  const promptTokens = estimateTokens(system + prompt);

  if (budget && promptTokens > budget.maxPromptTokens) {
    return res.status(400).json({
      error: { code: 'AI_TOKEN_BUDGET_EXCEEDED', message: `Prompt too large for ${stage}: ${promptTokens} > ${budget.maxPromptTokens} tokens` },
    });
  }

  const maxOut = Math.min(maxOutputTokens || 1000, budget?.maxOutputTokens || 2000);
  const cost   = STAGE_CREDIT_COSTS[stage] ?? 1;

  if (req.user.credits < cost) {
    return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${cost} credits` } });
  }

  const start = Date.now();
  try {
    const aiRes = await generateText({ system, prompt, maxOutputTokens: maxOut, stage });

    await deductCredits(req.user._id, cost, `AI Text: ${stage}`, 'project', projectId);

    logAIUsage({
      userId: req.user._id, projectId, provider: aiRes.provider, stage,
      requestType: 'text',
      tokensIn:  aiRes.usage?.inputTokens  || promptTokens,
      tokensOut: aiRes.usage?.outputTokens,
      creditsCharged: cost,
      success: true,
      durationMs: Date.now() - start,
      metadata: { attemptId },
    });

    res.json(aiRes);
  } catch (err) {
    logAIUsage({
      userId: req.user._id, projectId, provider: 'unknown', stage,
      requestType: 'text', creditsCharged: 0, success: false,
      errorCode: err.code || 'TEXT_GENERATION_FAILED',
      metadata: { attemptId },
    });
    next(err);
  }
});

export default router;
