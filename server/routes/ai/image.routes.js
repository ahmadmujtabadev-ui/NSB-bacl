import { Router } from 'express';
import {
  generateBookIllustrations,
  generateStageImage,
  normArr,
  getSafeChapterCount,
  getImagesPerChapter,
  isSpreadOnlyProject,
  getAgeMode,
} from '../../services/ai/image/image.service.js';
import { deductCredits } from '../../middleware/credits.js';
import { logAIUsage } from '../../services/ai/ai.telemetry.js';
import { STAGE_CREDIT_COSTS } from '../../services/ai/ai.billing.js';
import { ValidationError, NotFoundError } from '../../errors.js';
import { Project } from '../../models/Project.js';
import { Character } from '../../models/Character.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function countSpreadsToBill(project) {
  const allSpreads = normArr(project.artifacts?.spreads || []);
  const existing = normArr(project.artifacts?.spreadIllustrations || []);
  const done = existing.filter((s) => s?.imageUrl).length;
  return Math.max(0, allSpreads.length - done);
}

function countChapterIllustrationsToBill(project) {
  const chapterCount = getSafeChapterCount(project);
  const imagesPerChapter = getImagesPerChapter(project.ageRange);
  const illustrations = normArr(project.artifacts?.illustrations || []);

  let total = 0;

  for (let ci = 0; ci < chapterCount; ci++) {
    const ch = illustrations[ci];

    if (!ch) {
      total += imagesPerChapter;
      continue;
    }

    const done = normArr(ch.spreads).filter((s) => s?.imageUrl).length;
    total += Math.max(0, imagesPerChapter - done);
  }

  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/image/generate
// ─────────────────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res, next) => {
  const {
    task,
    chapterIndex,
    spreadIndex,
    projectId,
    customPrompt,
    seed,
    style,
    variantCount = 1,
    force = false,
    traceId: clientTraceId,
  } = req.body;

  const traceId =
    clientTraceId || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (!task) return next(new ValidationError('task is required'));
  if (!projectId) return next(new ValidationError('projectId is required'));

  const safeVariantCount = Math.min(Math.max(parseInt(variantCount, 10) || 1, 1), 5);

  try {
    const project = await Project.findOne({ _id: projectId, userId: req.user._id });
    if (!project) throw new NotFoundError('Project not found');

    const start = Date.now();
    let result;
    let totalCost = 0;

    // ── FULL BOOK ILLUSTRATIONS ──────────────────────────────────────────────
    if (task === 'illustrations') {
      const toGenerate = isSpreadOnlyProject(project)
        ? countSpreadsToBill(project)
        : countChapterIllustrationsToBill(project);

      totalCost = Math.max(toGenerate * (STAGE_CREDIT_COSTS.illustration ?? 4), STAGE_CREDIT_COSTS.illustration ?? 4);

      if (req.user.credits < totalCost) {
        return res.status(402).json({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: `Need ${totalCost} credits`,
            required: totalCost,
            available: req.user.credits,
          },
        });
      }

      result = await generateBookIllustrations({
        projectId,
        userId: req.user._id.toString(),
        style,
        seed,
        traceId,
        force: !!force,
      });
    }

    // ── STEP 4: VARIANTS FOR ONE SLOT ────────────────────────────────────────
    else if (task === 'illustration-variants') {
      const ci = parseInt(chapterIndex ?? 0, 10);
      const si = parseInt(spreadIndex ?? 0, 10);

      if (Number.isNaN(ci) || ci < 0) {
        throw new ValidationError('chapterIndex must be a valid non-negative number');
      }

      if (Number.isNaN(si) || si < 0) {
        throw new ValidationError('spreadIndex must be a valid non-negative number');
      }

      if (!isSpreadOnlyProject(project)) {
        const maxSlots = getImagesPerChapter(project.ageRange);
        if (si >= maxSlots) {
          throw new ValidationError(
            `spreadIndex out of range for ${getAgeMode(project.ageRange)}. Allowed 0-${maxSlots - 1}`
          );
        }
      }

      totalCost = (STAGE_CREDIT_COSTS.illustration ?? 4) * safeVariantCount;

      if (req.user.credits < totalCost) {
        return res.status(402).json({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: `Need ${totalCost} credits for ${safeVariantCount} variants`,
            required: totalCost,
            available: req.user.credits,
          },
        });
      }

      const variants = [];

      for (let vi = 0; vi < safeVariantCount; vi++) {
        const variantSeed = seed ? Number(seed) + vi * 1000 : Date.now() + vi * 1000;

        const r = await generateStageImage({
          task: 'illustration',
          chapterIndex: ci,
          spreadIndex: si,
          projectId,
          userId: req.user._id.toString(),
          customPrompt,
          seed: variantSeed,
          style,
          traceId: `${traceId}_v${vi}`,
        });

        variants.push({
          variantIndex: vi,
          imageUrl: r.imageUrl,
          prompt: r.prompt,
          seed: variantSeed,
          provider: r.provider,
          sceneCharacters: r.sceneCharacters || [],
          poseSelection: r.poseSelection || [],
          momentTitle: r.momentTitle || '',
          illustrationHint: r.illustrationHint || '',
          sceneEnvironment: r.sceneEnvironment || '',
          timeOfDay: r.timeOfDay || '',
        });
      }

      const freshProject = await Project.findById(projectId);
      if (!freshProject) throw new NotFoundError('Project not found after variant generation');

      const arts = freshProject.artifacts || {};
      const setFields = {};
      const spreadOnlyMode = isSpreadOnlyProject(freshProject);

      if (spreadOnlyMode) {
        const ills = normArr(arts.spreadIllustrations || []);
        ills[si] = {
          ...(ills[si] || {}),
          spreadIndex: si,
          variants,
          selectedVariantIndex: 0,
          imageUrl: variants[0].imageUrl,
          prompt: variants[0].prompt,
          sceneCharacters: variants[0].sceneCharacters || [],
          poseSelection: variants[0].poseSelection || [],
          momentTitle: variants[0].momentTitle || '',
          illustrationHint: variants[0].illustrationHint || '',
          sceneEnvironment: variants[0].sceneEnvironment || '',
          timeOfDay: variants[0].timeOfDay || '',
          createdAt: new Date().toISOString(),
        };
        setFields['artifacts.spreadIllustrations'] = ills;
      } else {
        const illustrations = normArr(arts.illustrations || []);
        const illCh = illustrations[ci] || {
          chapterNumber: ci + 1,
          spreads: [],
          selectedVariantIndex: 0,
        };

        const illSpreads = normArr(illCh.spreads);
        illSpreads[si] = {
          ...(illSpreads[si] || {}),
          spreadIndex: si,
          variants,
          selectedVariantIndex: 0,
          imageUrl: variants[0].imageUrl,
          prompt: variants[0].prompt,
          sceneCharacters: variants[0].sceneCharacters || [],
          poseSelection: variants[0].poseSelection || [],
          momentTitle: variants[0].momentTitle || '',
          illustrationHint: variants[0].illustrationHint || '',
          sceneEnvironment: variants[0].sceneEnvironment || '',
          timeOfDay: variants[0].timeOfDay || '',
          createdAt: new Date().toISOString(),
        };

        illCh.spreads = illSpreads;
        illustrations[ci] = illCh;
        setFields['artifacts.illustrations'] = illustrations;
      }

      await Project.findByIdAndUpdate(projectId, { $set: setFields });

      result = {
        variants,
        selectedVariantIndex: 0,
        imageUrl: variants[0].imageUrl,
        provider: variants[0].provider,
      };
    }

    // ── STEP 3: CHARACTER STYLE ──────────────────────────────────────────────
    else if (task === 'character-style') {
      const { characterId, selectedStyle } = req.body;

      if (!characterId) {
        throw new ValidationError('characterId required for character-style task');
      }

      totalCost = STAGE_CREDIT_COSTS.illustration ?? 4;

      if (req.user.credits < totalCost) {
        return res.status(402).json({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: `Need ${totalCost} credits`,
            required: totalCost,
            available: req.user.credits,
          },
        });
      }

      const char = await Character.findOne({ _id: characterId, userId: req.user._id });
      if (!char) throw new NotFoundError('Character not found');

      result = await generateStageImage({
        task: 'character-style',
        projectId,
        userId: req.user._id.toString(),
        customPrompt,
        seed,
        style: selectedStyle || style,
        traceId,
        characterId,
      });

      if (result.imageUrl) {
        await Character.findByIdAndUpdate(characterId, {
          $set: {
            masterReferenceUrl: result.imageUrl,
            selectedStyle: selectedStyle || style || 'pixar-3d',
            styleApprovedAt: new Date().toISOString(),
            status: 'generated',
          },
        });
        result.masterReferenceUrl = result.imageUrl;
      }
    }

    // ── SINGLE IMAGE TASKS ───────────────────────────────────────────────────
    else {
      totalCost = STAGE_CREDIT_COSTS.illustration ?? 4;

      if (req.user.credits < totalCost) {
        return res.status(402).json({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: `Need ${totalCost} credits`,
            required: totalCost,
            available: req.user.credits,
          },
        });
      }

      result = await generateStageImage({
        task,
        chapterIndex: parseInt(chapterIndex ?? 0, 10),
        spreadIndex: parseInt(spreadIndex ?? 0, 10),
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
      provider: result.provider || result.variants?.[0]?.provider || 'mixed',
      stage: task,
      requestType: 'image',
      creditsCharged: totalCost,
      success: true,
      durationMs: Date.now() - start,
      traceId,
    });

    res.json({ ...result, creditsCharged: totalCost, traceId });
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
      traceId,
    });
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ai/image/cost-estimate
// ─────────────────────────────────────────────────────────────────────────────

router.get('/cost-estimate', async (req, res, next) => {
  try {
    const { projectId, task, variantCount = 1 } = req.query;

    if (!projectId || !task) {
      throw new ValidationError('projectId and task required');
    }

    const project = await Project.findOne({ _id: projectId, userId: req.user._id });
    if (!project) throw new NotFoundError('Project not found');

    let estimate = 0;
    let breakdown = [];

    if (task === 'illustrations') {
      const toGen = isSpreadOnlyProject(project)
        ? countSpreadsToBill(project)
        : countChapterIllustrationsToBill(project);

      estimate = Math.max(toGen * (STAGE_CREDIT_COSTS.illustration ?? 4), STAGE_CREDIT_COSTS.illustration ?? 4);
      breakdown = [{ label: `${toGen} images × ${STAGE_CREDIT_COSTS.illustration ?? 4} credits`, cost: estimate }];
    } else if (task === 'illustration-variants') {
      const vc = Math.min(parseInt(variantCount, 10) || 1, 5);
      estimate = vc * (STAGE_CREDIT_COSTS.illustration ?? 4);
      breakdown = [{ label: `${vc} variants × ${STAGE_CREDIT_COSTS.illustration ?? 4} credits per variant`, cost: estimate }];
    } else {
      estimate = STAGE_CREDIT_COSTS.illustration ?? 4;
      breakdown = [{ label: `1 image (${task})`, cost: estimate }];
    }

    res.json({
      task,
      estimatedCost: estimate,
      userCredits: req.user.credits,
      canAfford: req.user.credits >= estimate,
      breakdown,
    });
  } catch (e) {
    next(e);
  }
});

export default router;