// server/routes/ai/text.routes.js
// PRODUCTION-READY — story, spread planning, outline, chapter generation, spreads, humanize, reruns

import { Router } from 'express';
import { generateText } from '../../services/ai/text/text.providers.js';
import { generateStageText, getAgeProfile, resolveChapterCount } from '../../services/ai/text/text.service.js';
import { KnowledgeBase } from '../../models/KnowledgeBase.js';
import { AI_TOKEN_BUDGETS, estimateTokens } from '../../services/ai/policies/tokenBudget.js';
import { deductCredits } from '../../middleware/credits.js';
import { logAIUsage } from '../../services/ai/ai.telemetry.js';
import { STAGE_CREDIT_COSTS } from '../../services/ai/ai.billing.js';
import { ValidationError, NotFoundError } from '../../errors.js';
import { Project } from '../../models/Project.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/text/generate
// ─────────────────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res, next) => {
  const {
    stage,
    projectId,
    chapterIndex,
    spreadIndex,
    customPrompt,
    storyIdea,
  } = req.body;

  if (!stage) return next(new ValidationError('stage is required'));
  if (!projectId) return next(new ValidationError('projectId is required'));

  const start = Date.now();

  try {
    const project = await Project.findOne({ _id: projectId, userId: req.user._id });
    if (!project) throw new NotFoundError('Project not found');

    let result;
    let usage;
    let provider;
    let totalCredits = 0;

    const charge = (stageName, count = 1) => {
      const cost = (STAGE_CREDIT_COSTS[stageName] ?? 1) * count;
      const required = totalCredits + cost;

      if (req.user.credits < required) {
        throw Object.assign(
          new ValidationError(`Insufficient credits. Need ${required}, have ${req.user.credits}`),
          { code: 'INSUFFICIENT_CREDITS', required, available: req.user.credits }
        );
      }

      totalCredits += cost;
    };

    if (stage === 'story') {
      if (!storyIdea && !project.artifacts?.storyIdea && !project.title) {
        throw new ValidationError('storyIdea is required for story generation');
      }

      charge('story', 1);
      const r = await generateStageText({
        stage: 'story',
        projectId,
        userId: req.user._id.toString(),
        storyIdea: storyIdea || project.artifacts?.storyIdea,
      });
      ({ result, usage, provider } = r);

    } else if (stage === 'spreadPlanning') {
      const hasStoryContent =
        project.artifacts?.storyText ||
        project.artifacts?.outline?.synopsis ||
        project.artifacts?.storyIdea ||
        project.title;

      if (!hasStoryContent) {
        throw new ValidationError('Generate story (Step 1) before spread planning');
      }

      charge('spreadPlanning', 1);
      const r = await generateStageText({
        stage: 'spreadPlanning',
        projectId,
        userId: req.user._id.toString(),
      });
      ({ result, usage, provider } = r);

    } else if (stage === 'outline') {
      charge('outline', 1);
      const r = await generateStageText({
        stage: 'outline',
        projectId,
        userId: req.user._id.toString(),
      });
      ({ result, usage, provider } = r);

    } else if (stage === 'dedication') {
      charge('dedication', 1);
      const r = await generateStageText({
        stage: 'dedication',
        projectId,
        userId: req.user._id.toString(),
      });
      ({ result, usage, provider } = r);

    } else if (stage === 'theme') {
      charge('theme', 1);
      const r = await generateStageText({
        stage: 'theme',
        projectId,
        userId: req.user._id.toString(),
      });
      ({ result, usage, provider } = r);

    } else if (stage === 'chapters') {
      const chProfile = getAgeProfile(project.ageRange);

      if (chProfile.mode === 'spreads-only') {
        // Under 6 => no chapters, spreads only
        charge('chapters', 1);
        const r = await generateStageText({
          stage: 'spreads',
          projectId,
          userId: req.user._id.toString(),
        });
        ({ result, usage, provider } = r);

      } else {
        // 6–8 => picture-book chapters
        // 9+  => prose chapters
        // Load KB so chapterRange can be honoured
        const kb = project.knowledgeBaseId
          ? await KnowledgeBase.findById(project.knowledgeBaseId).lean()
          : null;

        const chapterCount = resolveChapterCount(project, kb, { fromOutline: true });

        charge('chapters', chapterCount);

        const results = [];
        let totalIn = 0;
        let totalOut = 0;
        let lastProv = 'unknown';

        for (let i = 0; i < chapterCount; i++) {
          const r = await generateStageText({
            stage: 'chapter',
            projectId,
            userId: req.user._id.toString(),
            chapterIndex: i,
          });

          results.push(r.result);
          totalIn += r.usage?.inputTokens || 0;
          totalOut += r.usage?.outputTokens || 0;
          lastProv = r.provider || lastProv;
        }

        result = results;
        usage = { inputTokens: totalIn, outputTokens: totalOut };
        provider = lastProv;
      }

    } else if (stage === 'chapter') {
      const singleProfile = getAgeProfile(project.ageRange);

      if (singleProfile.mode === 'spreads-only') {
        throw new ValidationError('Single chapter generation is not supported for books under age 6. Use spreads instead.');
      }

      charge('chapters', 1);
      const r = await generateStageText({
        stage: 'chapter',
        projectId,
        userId: req.user._id.toString(),
        chapterIndex: parseInt(chapterIndex ?? 0, 10),
      });
      ({ result, usage, provider } = r);

    } else if (stage === 'spreads') {
      charge('chapters', 1);
      const r = await generateStageText({
        stage: 'spreads',
        projectId,
        userId: req.user._id.toString(),
      });
      ({ result, usage, provider } = r);

    } else if (stage === 'humanize') {
      const arts = project.artifacts || {};
      const chapters = Array.isArray(arts.chapters) ? arts.chapters : [];
      const spreads = Array.isArray(arts.spreads) ? arts.spreads : [];

      if (!chapters.length && !spreads.length) {
        throw new ValidationError('Generate chapters or spreads before humanizing');
      }

      if (arts.spreadOnly) {
        charge('humanize', 1);
        const r = await generateStageText({
          stage: 'humanize',
          projectId,
          userId: req.user._id.toString(),
          chapterIndex: 0,
        });
        ({ result, usage, provider } = r);
      } else {
        charge('humanize', chapters.length);

        const results = [];
        let totalIn = 0;
        let totalOut = 0;
        let lastProv = 'unknown';

        for (let i = 0; i < chapters.length; i++) {
          const r = await generateStageText({
            stage: 'humanize',
            projectId,
            userId: req.user._id.toString(),
            chapterIndex: i,
          });

          results.push(r.result);
          totalIn += r.usage?.inputTokens || 0;
          totalOut += r.usage?.outputTokens || 0;
          lastProv = r.provider || lastProv;
        }

        result = results;
        usage = { inputTokens: totalIn, outputTokens: totalOut };
        provider = lastProv;
      }

    } else if (stage === 'spreadRerun') {
      const rerunProfile = getAgeProfile(project.ageRange);

      if (rerunProfile.mode === 'chapter-book') {
        throw new ValidationError('spreadRerun is not supported for chapter-book prose mode. Re-run the full chapter instead.');
      }

      if (!customPrompt) throw new ValidationError('customPrompt required for spreadRerun');

      charge('chapter', 1);
      const r = await generateStageText({
        stage: 'spreadRerun',
        projectId,
        userId: req.user._id.toString(),
        chapterIndex: parseInt(chapterIndex ?? 0, 10),
        spreadIndex: parseInt(spreadIndex ?? 0, 10),
        customPrompt,
      });
      ({ result, usage, provider } = r);

    } else {
      throw new ValidationError('Unsupported stage: "story, spreadPlanning, outline, dedication, theme, chapters, chapter, spreads, humanize, spreadRerun"');
    }

    await deductCredits(req.user._id, totalCredits, `AI Text: ${stage}`, 'project', projectId);

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
      durationMs: Date.now() - start,
    });

    res.json({ result, usage, provider, creditsCharged: totalCredits, stage });

  } catch (err) {
    if (err.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: err.message,
          required: err.required,
          available: err.available,
        },
      });
    }

    logAIUsage({
      userId: req.user._id,
      projectId,
      provider: 'unknown',
      stage: req.body.stage,
      requestType: 'text',
      creditsCharged: 0,
      success: false,
      errorCode: err.code || 'GENERATE_FAILED',
      durationMs: Date.now() - start,
    });

    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/text/raw
// ─────────────────────────────────────────────────────────────────────────────

router.post('/raw', async (req, res, next) => {
  const {
    system,
    prompt,
    maxOutputTokens,
    stage = 'outline',
    projectId,
    attemptId,
  } = req.body;

  if (!prompt || !system) return next(new ValidationError('prompt and system are required'));

  const budget = AI_TOKEN_BUDGETS[stage];
  const promptTokens = estimateTokens(system + prompt);

  if (budget && promptTokens > budget.maxPromptTokens) {
    return res.status(400).json({
      error: {
        code: 'AI_TOKEN_BUDGET_EXCEEDED',
        message: `Prompt too large for ${stage}: ${promptTokens} > ${budget.maxPromptTokens} tokens`,
      },
    });
  }

  const maxOut = Math.min(maxOutputTokens || 1000, budget?.maxOutputTokens || 2000);
  const cost = STAGE_CREDIT_COSTS[stage] ?? 1;

  if (req.user.credits < cost) {
    return res.status(402).json({
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: `Need ${cost} credits, have ${req.user.credits}`,
      },
    });
  }

  const start = Date.now();

  try {
    const aiRes = await generateText({ system, prompt, maxOutputTokens: maxOut, stage });

    await deductCredits(req.user._id, cost, `AI Text Raw: ${stage}`, 'project', projectId);

    logAIUsage({
      userId: req.user._id,
      projectId,
      provider: aiRes.provider,
      stage,
      requestType: 'text',
      tokensIn: aiRes.usage?.inputTokens || promptTokens,
      tokensOut: aiRes.usage?.outputTokens,
      creditsCharged: cost,
      success: true,
      durationMs: Date.now() - start,
      metadata: { attemptId },
    });

    res.json(aiRes);
  } catch (err) {
    logAIUsage({
      userId: req.user._id,
      projectId,
      provider: 'unknown',
      stage,
      requestType: 'text',
      creditsCharged: 0,
      success: false,
      errorCode: err.code || 'TEXT_GENERATION_FAILED',
      metadata: { attemptId },
    });

    next(err);
  }
});

export default router;