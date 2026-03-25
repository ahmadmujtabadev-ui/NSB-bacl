// server/routes/pages.routes.js
// PRODUCTION-READY — Per-page editing, approval, version history, variants
// Updated to work cleanly with review-first workflow

import { Router } from 'express';
import { Project } from '../models/Project.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';
import { generateStageText } from '../services/ai/text/text.service.js';
import { generateStageImage } from '../services/ai/image/image.service.js';
import { deductCredits } from '../middleware/credits.js';
import { STAGE_CREDIT_COSTS } from '../services/ai/ai.billing.js';
import { logAIUsage } from '../services/ai/ai.telemetry.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(v => v != null);
  const keys = Object.keys(val).map(Number).filter(n => !Number.isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr.filter(v => v != null);
}

function clone(v) {
  return JSON.parse(JSON.stringify(v ?? null));
}

function nowIso() {
  return new Date().toISOString();
}

function getEffectiveTextContent(arts) {
  const humanized = normArr(arts.humanized);
  return humanized.length ? humanized : normArr(arts.chapters);
}

function parsePageKey(key) {
  if (key === 'cover_front') return { type: 'cover', side: 'front' };
  if (key === 'cover_back') return { type: 'cover', side: 'back' };
  if (key === 'dedication') return { type: 'dedication' };
  if (key === 'theme') return { type: 'theme' };

  if (/^s\d+$/.test(key)) {
    return {
      type: 'spread',
      spreadOnly: true,
      chapterIndex: 0,
      spreadIndex: parseInt(key.slice(1), 10),
    };
  }

  const m = key.match(/^ch(\d+)_s(\d+)$/);
  if (!m) throw new ValidationError(`Invalid page key: "${key}"`);

  return {
    type: 'spread',
    spreadOnly: false,
    chapterIndex: parseInt(m[1], 10),
    spreadIndex: parseInt(m[2], 10),
  };
}

function ensurePageEdit(arts, key) {
  if (!arts.pageEdits) arts.pageEdits = {};
  if (!arts.pageEdits[key]) {
    arts.pageEdits[key] = {
      status: 'draft',
      notes: '',
      approvedAt: null,
      rejectionReason: '',
      updatedAt: nowIso(),
      textStyle: {},
      imageStyle: {},
      layout: 'text-bottom',
      textVersions: [],
      imageVersions: [],
      currentTextVersion: 0,
      currentImageVersion: 0,
    };
  }
  return arts.pageEdits[key];
}

function buildPageEntry(key, spread, illustration, edit) {
  return {
    key,
    text: spread?.text || null,
    textPrompt: spread?.prompt || null,
    illustrationHint: spread?.illustrationHint || null,
    textPosition: spread?.textPosition || 'bottom',
    charactersInScene: spread?.charactersInScene || spread?.charactersInSpread || [],
    characterEmotion: spread?.characterEmotion || {},
    sceneEnvironment: spread?.sceneEnvironment || null,
    timeOfDay: spread?.timeOfDay || null,

    imageUrl: illustration?.imageUrl || null,
    imagePrompt: illustration?.prompt || null,
    seed: illustration?.seed || null,
    variants: normArr(illustration?.variants),
    selectedVariantIndex: illustration?.selectedVariantIndex ?? 0,

    status: edit?.status || 'draft',
    notes: edit?.notes || '',
    approvedAt: edit?.approvedAt || null,
    rejectionReason: edit?.rejectionReason || '',
    updatedAt: edit?.updatedAt || null,
    textStyle: clone(edit?.textStyle || {}),
    imageStyle: clone(edit?.imageStyle || {}),
    layout: edit?.layout || 'text-bottom',
    textVersions: normArr(edit?.textVersions),
    imageVersions: normArr(edit?.imageVersions),
    currentTextVersion: edit?.currentTextVersion ?? 0,
    currentImageVersion: edit?.currentImageVersion ?? 0,
  };
}

function buildSpecialPageEntry(key, data, edit) {
  return {
    key,
    data: clone(data || {}),
    status: edit?.status || 'draft',
    notes: edit?.notes || '',
    approvedAt: edit?.approvedAt || null,
    rejectionReason: edit?.rejectionReason || '',
    updatedAt: edit?.updatedAt || null,
    textStyle: clone(edit?.textStyle || {}),
    imageStyle: clone(edit?.imageStyle || {}),
    layout: edit?.layout || 'text-bottom',
    textVersions: normArr(edit?.textVersions),
    imageVersions: normArr(edit?.imageVersions),
    currentTextVersion: edit?.currentTextVersion ?? 0,
    currentImageVersion: edit?.currentImageVersion ?? 0,
  };
}

async function getProjectForUser(projectId, userId) {
  const project = await Project.findById(projectId);
  if (!project) throw new NotFoundError('Project not found');
  if (!project.userId.equals(userId)) throw new ForbiddenError();
  return project;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET all pages
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/pages', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const pages = [];

    // Special pages
    if (arts.cover?.frontUrl || arts.cover?.frontPrompt) {
      pages.push(buildSpecialPageEntry(
        'cover_front',
        {
          imageUrl: arts.cover?.frontUrl || '',
          prompt: arts.cover?.frontPrompt || '',
          seed: arts.cover?.frontSeed || null,
          variants: normArr(arts.cover?.frontVariants),
          selectedVariantIndex: arts.cover?.frontSelectedVariantIndex ?? 0,
        },
        arts.pageEdits?.cover_front,
      ));
    }

    if (arts.cover?.backUrl || arts.cover?.backPrompt) {
      pages.push(buildSpecialPageEntry(
        'cover_back',
        {
          imageUrl: arts.cover?.backUrl || '',
          prompt: arts.cover?.backPrompt || '',
          seed: arts.cover?.backSeed || null,
          variants: normArr(arts.cover?.backVariants),
          selectedVariantIndex: arts.cover?.backSelectedVariantIndex ?? 0,
        },
        arts.pageEdits?.cover_back,
      ));
    }

    if (arts.dedication) {
      pages.push(buildSpecialPageEntry('dedication', arts.dedication, arts.pageEdits?.dedication));
    }

    if (arts.themePage) {
      pages.push(buildSpecialPageEntry('theme', arts.themePage, arts.pageEdits?.theme));
    }

    // Story pages
    if (arts.spreadOnly) {
      const spreads = normArr(arts.spreads);
      const illustrations = normArr(arts.spreadIllustrations);

      spreads.forEach((spread, si) => {
        const key = `s${si}`;
        pages.push(buildPageEntry(key, spread, illustrations[si], arts.pageEdits?.[key]));
      });
    } else {
      const textContent = getEffectiveTextContent(arts);
      const illustrations = normArr(arts.illustrations);

      textContent.forEach((chapter, ci) => {
        const chSpreads = normArr(chapter?.spreads);
        const illCh = illustrations[ci] || {};
        const illSpreads = normArr(illCh.spreads);

        if (chSpreads.length) {
          chSpreads.forEach((spread, si) => {
            const key = `ch${ci}_s${si}`;
            pages.push(buildPageEntry(key, spread, illSpreads[si], arts.pageEdits?.[key]));
          });
        } else {
          // chapter-book prose fallback
          const key = `ch${ci}_s0`;
          const proseFallback = {
            text: chapter?.chapterText || chapter?.text || '',
            prompt: chapter?.prompt || '',
            illustrationHint:
              normArr(chapter?.illustrationMoments)?.[0]?.illustrationHint ||
              chapter?.chapterIllustrationHint ||
              chapter?.chapterSummary ||
              '',
            textPosition: 'bottom',
            charactersInScene:
              normArr(chapter?.illustrationMoments)?.[0]?.charactersInScene || [],
            sceneEnvironment:
              normArr(chapter?.illustrationMoments)?.[0]?.sceneEnvironment || 'mixed',
            timeOfDay:
              normArr(chapter?.illustrationMoments)?.[0]?.timeOfDay || 'day',
          };
          pages.push(buildPageEntry(key, proseFallback, illSpreads[0], arts.pageEdits?.[key]));
        }
      });
    }

    res.json({ pages });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET single page
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/pages/:key', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const parsed = parsePageKey(req.params.key);

    if (parsed.type === 'cover') {
      const side = parsed.side;
      const data = side === 'front'
        ? {
            imageUrl: arts.cover?.frontUrl || '',
            prompt: arts.cover?.frontPrompt || '',
            seed: arts.cover?.frontSeed || null,
            variants: normArr(arts.cover?.frontVariants),
            selectedVariantIndex: arts.cover?.frontSelectedVariantIndex ?? 0,
          }
        : {
            imageUrl: arts.cover?.backUrl || '',
            prompt: arts.cover?.backPrompt || '',
            seed: arts.cover?.backSeed || null,
            variants: normArr(arts.cover?.backVariants),
            selectedVariantIndex: arts.cover?.backSelectedVariantIndex ?? 0,
          };

      return res.json(buildSpecialPageEntry(req.params.key, data, arts.pageEdits?.[req.params.key]));
    }

    if (parsed.type === 'dedication') {
      return res.json(buildSpecialPageEntry(req.params.key, arts.dedication, arts.pageEdits?.[req.params.key]));
    }

    if (parsed.type === 'theme') {
      return res.json(buildSpecialPageEntry(req.params.key, arts.themePage, arts.pageEdits?.[req.params.key]));
    }

    let spread = null;
    let illustration = null;

    if (parsed.spreadOnly || arts.spreadOnly) {
      spread = normArr(arts.spreads)[parsed.spreadIndex] || null;
      illustration = normArr(arts.spreadIllustrations)[parsed.spreadIndex] || null;
    } else {
      const textContent = getEffectiveTextContent(arts);
      const chapter = textContent[parsed.chapterIndex] || {};
      const chSpreads = normArr(chapter?.spreads);

      if (chSpreads.length) {
        spread = chSpreads[parsed.spreadIndex] || null;
      } else {
        spread = {
          text: chapter?.chapterText || chapter?.text || '',
          prompt: chapter?.prompt || '',
          illustrationHint:
            normArr(chapter?.illustrationMoments)?.[parsed.spreadIndex]?.illustrationHint ||
            normArr(chapter?.illustrationMoments)?.[0]?.illustrationHint ||
            chapter?.chapterIllustrationHint ||
            chapter?.chapterSummary ||
            '',
          textPosition: 'bottom',
          charactersInScene:
            normArr(chapter?.illustrationMoments)?.[parsed.spreadIndex]?.charactersInScene ||
            normArr(chapter?.illustrationMoments)?.[0]?.charactersInScene ||
            [],
          sceneEnvironment:
            normArr(chapter?.illustrationMoments)?.[parsed.spreadIndex]?.sceneEnvironment ||
            normArr(chapter?.illustrationMoments)?.[0]?.sceneEnvironment ||
            'mixed',
          timeOfDay:
            normArr(chapter?.illustrationMoments)?.[parsed.spreadIndex]?.timeOfDay ||
            normArr(chapter?.illustrationMoments)?.[0]?.timeOfDay ||
            'day',
        };
      }

      const illCh = normArr(arts.illustrations)[parsed.chapterIndex] || {};
      illustration = normArr(illCh.spreads)[parsed.spreadIndex] || null;
    }

    res.json(buildPageEntry(req.params.key, spread, illustration, arts.pageEdits?.[req.params.key]));
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH page content / style
// ─────────────────────────────────────────────────────────────────────────────

router.patch('/:id/pages/:key', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const key = req.params.key;
    const parsed = parsePageKey(key);
    const edit = ensurePageEdit(arts, key);

    const now = nowIso();
    edit.updatedAt = now;
    edit.status = req.body.status || 'edited';

    if (req.body.notes !== undefined) edit.notes = req.body.notes;
    if (req.body.layout !== undefined) edit.layout = req.body.layout;
    if (req.body.textStyle !== undefined) edit.textStyle = clone(req.body.textStyle || {});
    if (req.body.imageStyle !== undefined) edit.imageStyle = clone(req.body.imageStyle || {});
    if (req.body.rejectionReason !== undefined) edit.rejectionReason = req.body.rejectionReason || '';

    if (parsed.type === 'cover') {
      if (!arts.cover) arts.cover = {};
      const side = parsed.side;

      if (req.body.imagePrompt !== undefined) {
        if (side === 'front') arts.cover.frontPrompt = req.body.imagePrompt;
        else arts.cover.backPrompt = req.body.imagePrompt;
      }

      if (req.body.imageUrl !== undefined) {
        if (side === 'front') arts.cover.frontUrl = req.body.imageUrl;
        else arts.cover.backUrl = req.body.imageUrl;
      }

      project.markModified('artifacts');
      await project.save();
      return res.json({ message: 'Page updated', key });
    }

    if (parsed.type === 'dedication') {
      arts.dedication = { ...(arts.dedication || {}), ...(req.body.data || {}) };
      project.markModified('artifacts');
      await project.save();
      return res.json({ message: 'Page updated', key });
    }

    if (parsed.type === 'theme') {
      arts.themePage = { ...(arts.themePage || {}), ...(req.body.data || {}) };
      project.markModified('artifacts');
      await project.save();
      return res.json({ message: 'Page updated', key });
    }

    if (parsed.spreadOnly || arts.spreadOnly) {
      const spreads = normArr(arts.spreads);
      const si = parsed.spreadIndex;
      const prev = spreads[si] || {};

      if (req.body.text !== undefined && req.body.text !== prev.text) {
        edit.textVersions = [
          ...normArr(edit.textVersions),
          {
            version: normArr(edit.textVersions).length + 1,
            text: prev.text || '',
            prompt: prev.prompt || '',
            source: 'manual-before-edit',
            createdAt: now,
          },
        ].slice(-20);
        edit.currentTextVersion = edit.textVersions.length;
      }

      spreads[si] = {
        ...prev,
        ...(req.body.text !== undefined ? { text: req.body.text } : {}),
        ...(req.body.textPrompt !== undefined ? { prompt: req.body.textPrompt } : {}),
        ...(req.body.illustrationHint !== undefined ? { illustrationHint: req.body.illustrationHint } : {}),
        ...(req.body.textPosition !== undefined ? { textPosition: req.body.textPosition } : {}),
        ...(req.body.charactersInScene !== undefined ? { charactersInScene: req.body.charactersInScene } : {}),
        ...(req.body.characterEmotion !== undefined ? { characterEmotion: clone(req.body.characterEmotion) } : {}),
        ...(req.body.sceneEnvironment !== undefined ? { sceneEnvironment: req.body.sceneEnvironment } : {}),
        ...(req.body.timeOfDay !== undefined ? { timeOfDay: req.body.timeOfDay } : {}),
      };

      arts.spreads = spreads;
    } else {
      const sourceKey = normArr(arts.humanized).length ? 'humanized' : 'chapters';
      const chapters = normArr(arts[sourceKey]);
      const ci = parsed.chapterIndex;
      const si = parsed.spreadIndex;

      if (!chapters[ci]) {
        chapters[ci] = {
          chapterNumber: ci + 1,
          chapterTitle: `Chapter ${ci + 1}`,
          spreads: [],
        };
      }

      const spreads = normArr(chapters[ci].spreads);
      const prev = spreads[si] || {};

      if (req.body.text !== undefined && req.body.text !== prev.text) {
        edit.textVersions = [
          ...normArr(edit.textVersions),
          {
            version: normArr(edit.textVersions).length + 1,
            text: prev.text || '',
            prompt: prev.prompt || '',
            source: 'manual-before-edit',
            createdAt: now,
          },
        ].slice(-20);
        edit.currentTextVersion = edit.textVersions.length;
      }

      spreads[si] = {
        ...prev,
        spreadIndex: si,
        ...(req.body.text !== undefined ? { text: req.body.text } : {}),
        ...(req.body.textPrompt !== undefined ? { prompt: req.body.textPrompt } : {}),
        ...(req.body.illustrationHint !== undefined ? { illustrationHint: req.body.illustrationHint } : {}),
        ...(req.body.textPosition !== undefined ? { textPosition: req.body.textPosition } : {}),
        ...(req.body.charactersInScene !== undefined ? { charactersInScene: req.body.charactersInScene } : {}),
        ...(req.body.characterEmotion !== undefined ? { characterEmotion: clone(req.body.characterEmotion) } : {}),
        ...(req.body.sceneEnvironment !== undefined ? { sceneEnvironment: req.body.sceneEnvironment } : {}),
        ...(req.body.timeOfDay !== undefined ? { timeOfDay: req.body.timeOfDay } : {}),
      };

      chapters[ci].spreads = spreads;
      arts[sourceKey] = chapters;
    }

    project.markModified('artifacts');
    await project.save();
    res.json({ message: 'Page updated', key });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Approve / reject page
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/pages/:key/approve', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const edit = ensurePageEdit(arts, req.params.key);

    edit.status = 'approved';
    edit.approvedAt = nowIso();
    edit.updatedAt = nowIso();

    project.markModified('artifacts');
    await project.save();

    res.json({ message: 'Page approved', key: req.params.key });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/pages/:key/reject', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const edit = ensurePageEdit(arts, req.params.key);

    edit.status = 'rejected';
    edit.rejectionReason = req.body.reason || '';
    edit.updatedAt = nowIso();

    project.markModified('artifacts');
    await project.save();

    res.json({ message: 'Page rejected', key: req.params.key });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Select image variant
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/pages/:key/select-variant', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const key = req.params.key;
    const { variantIndex } = req.body;

    if (variantIndex === undefined) throw new ValidationError('variantIndex is required');

    const parsed = parsePageKey(key);
    const edit = ensurePageEdit(arts, key);

    if (parsed.type === 'cover') {
      const side = parsed.side;
      const variants = side === 'front'
        ? normArr(arts.cover?.frontVariants)
        : normArr(arts.cover?.backVariants);

      const chosen = variants[variantIndex];
      if (!chosen) throw new ValidationError(`Variant ${variantIndex} not found`);

      if (!arts.cover) arts.cover = {};
      if (side === 'front') {
        arts.cover.frontSelectedVariantIndex = variantIndex;
        arts.cover.frontUrl = chosen.imageUrl;
        arts.cover.frontPrompt = chosen.prompt || arts.cover.frontPrompt || '';
        arts.cover.frontSeed = chosen.seed || arts.cover.frontSeed || null;
      } else {
        arts.cover.backSelectedVariantIndex = variantIndex;
        arts.cover.backUrl = chosen.imageUrl;
        arts.cover.backPrompt = chosen.prompt || arts.cover.backPrompt || '';
        arts.cover.backSeed = chosen.seed || arts.cover.backSeed || null;
      }

      edit.status = 'edited';
      edit.updatedAt = nowIso();

      project.markModified('artifacts');
      await project.save();
      return res.json({ message: 'Variant selected', key, variantIndex });
    }

    if (parsed.spreadOnly || arts.spreadOnly) {
      const ills = normArr(arts.spreadIllustrations);
      if (!ills[parsed.spreadIndex]) throw new ValidationError('No illustrations found for this spread');

      const variants = normArr(ills[parsed.spreadIndex].variants);
      const chosen = variants[variantIndex];
      if (!chosen) throw new ValidationError(`Variant ${variantIndex} not found`);

      ills[parsed.spreadIndex] = {
        ...ills[parsed.spreadIndex],
        selectedVariantIndex: variantIndex,
        imageUrl: chosen.imageUrl,
        prompt: chosen.prompt || ills[parsed.spreadIndex].prompt || '',
        seed: chosen.seed || ills[parsed.spreadIndex].seed || null,
      };
      arts.spreadIllustrations = ills;
    } else {
      const illustrations = normArr(arts.illustrations);
      const illCh = illustrations[parsed.chapterIndex] || { chapterNumber: parsed.chapterIndex + 1, spreads: [] };
      const illSpreads = normArr(illCh.spreads);

      if (!illSpreads[parsed.spreadIndex]) throw new ValidationError('No illustrations found');

      const variants = normArr(illSpreads[parsed.spreadIndex].variants);
      const chosen = variants[variantIndex];
      if (!chosen) throw new ValidationError(`Variant ${variantIndex} not found`);

      illSpreads[parsed.spreadIndex] = {
        ...illSpreads[parsed.spreadIndex],
        selectedVariantIndex: variantIndex,
        imageUrl: chosen.imageUrl,
        prompt: chosen.prompt || illSpreads[parsed.spreadIndex].prompt || '',
        seed: chosen.seed || illSpreads[parsed.spreadIndex].seed || null,
      };

      illCh.spreads = illSpreads;
      illustrations[parsed.chapterIndex] = illCh;
      arts.illustrations = illustrations;
    }

    edit.status = 'edited';
    edit.updatedAt = nowIso();

    project.markModified('artifacts');
    await project.save();

    res.json({ message: 'Variant selected', key, variantIndex });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Regenerate page text / image / both
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/pages/:key/regenerate', async (req, res, next) => {
  const start = Date.now();
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const key = req.params.key;
    const parsed = parsePageKey(key);
    const edit = ensurePageEdit(arts, key);

    const {
      textPrompt,
      imagePrompt,
      type = 'both',
      variantCount = 1,
      style,
    } = req.body;

    if (!['text', 'image', 'both'].includes(type)) {
      throw new ValidationError('type must be text, image, or both');
    }

    // Text regenerate
    if ((type === 'text' || type === 'both') && parsed.type === 'spread') {
      if (!textPrompt) throw new ValidationError('textPrompt required for text regenerate');

      const stage = 'spreadRerun';
      const result = await generateStageText({
        stage,
        projectId: project._id.toString(),
        userId: req.user._id.toString(),
        chapterIndex: parsed.chapterIndex,
        spreadIndex: parsed.spreadIndex,
        customPrompt: textPrompt,
      });

      if (parsed.spreadOnly || arts.spreadOnly) {
        const spreads = normArr(arts.spreads);
        const prev = spreads[parsed.spreadIndex] || {};

        edit.textVersions = [
          ...normArr(edit.textVersions),
          {
            version: normArr(edit.textVersions).length + 1,
            text: prev.text || '',
            prompt: prev.prompt || '',
            source: 'rerun',
            createdAt: nowIso(),
          },
        ].slice(-20);
        edit.currentTextVersion = edit.textVersions.length;

        spreads[parsed.spreadIndex] = { ...prev, ...result.result };
        arts.spreads = spreads;
      } else {
        const sourceKey = normArr(arts.humanized).length ? 'humanized' : 'chapters';
        const chapters = normArr(arts[sourceKey]);
        const chapter = chapters[parsed.chapterIndex] || {};
        const spreads = normArr(chapter.spreads);
        const prev = spreads[parsed.spreadIndex] || {};

        edit.textVersions = [
          ...normArr(edit.textVersions),
          {
            version: normArr(edit.textVersions).length + 1,
            text: prev.text || '',
            prompt: prev.prompt || '',
            source: 'rerun',
            createdAt: nowIso(),
          },
        ].slice(-20);
        edit.currentTextVersion = edit.textVersions.length;

        spreads[parsed.spreadIndex] = { ...prev, ...result.result };
        chapters[parsed.chapterIndex] = { ...chapter, spreads };
        arts[sourceKey] = chapters;
      }
    }

    // Image regenerate
    if ((type === 'image' || type === 'both')) {
      if (parsed.type === 'cover') {
        const side = parsed.side;
        const safeVariantCount = Math.min(Math.max(parseInt(variantCount, 10) || 1, 1), 5);
        const totalCost = (STAGE_CREDIT_COSTS.illustration ?? 4) * safeVariantCount;

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

        const variants = [];
        for (let vi = 0; vi < safeVariantCount; vi++) {
          const result = await generateStageImage({
            task: side === 'front' ? 'cover' : 'back-cover',
            projectId: project._id.toString(),
            userId: req.user._id.toString(),
            customPrompt: imagePrompt,
            traceId: `page_cover_${side}_${project._id}_${Date.now()}_${vi}`,
            style,
          });

          variants.push({
            variantIndex: vi,
            imageUrl: result.imageUrl,
            prompt: result.prompt || imagePrompt || '',
            seed: result.seed || null,
            selected: vi === 0,
          });
        }

        if (!arts.cover) arts.cover = {};
        if (side === 'front') {
          arts.cover.frontVariants = variants;
          arts.cover.frontSelectedVariantIndex = 0;
          arts.cover.frontUrl = variants[0]?.imageUrl || '';
          arts.cover.frontPrompt = variants[0]?.prompt || '';
          arts.cover.frontSeed = variants[0]?.seed || null;
        } else {
          arts.cover.backVariants = variants;
          arts.cover.backSelectedVariantIndex = 0;
          arts.cover.backUrl = variants[0]?.imageUrl || '';
          arts.cover.backPrompt = variants[0]?.prompt || '';
          arts.cover.backSeed = variants[0]?.seed || null;
        }

        edit.imageVersions = [
          ...normArr(edit.imageVersions),
          {
            version: normArr(edit.imageVersions).length + 1,
            imageUrl: side === 'front' ? arts.cover.frontUrl : arts.cover.backUrl,
            prompt: imagePrompt || '',
            source: 'rerun',
            createdAt: nowIso(),
          },
        ].slice(-20);
        edit.currentImageVersion = edit.imageVersions.length;

        await deductCredits(req.user._id, totalCost, `Page cover regenerate: ${side}`, 'project', project._id);
      } else if (parsed.type === 'spread') {
        const safeVariantCount = Math.min(Math.max(parseInt(variantCount, 10) || 1, 1), 5);
        const totalCost = (STAGE_CREDIT_COSTS.illustration ?? 4) * safeVariantCount;

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

        const variants = [];
        for (let vi = 0; vi < safeVariantCount; vi++) {
          const result = await generateStageImage({
            task: 'illustration',
            chapterIndex: parsed.chapterIndex,
            spreadIndex: parsed.spreadIndex,
            projectId: project._id.toString(),
            userId: req.user._id.toString(),
            customPrompt: imagePrompt,
            traceId: `page_img_${project._id}_${key}_${Date.now()}_${vi}`,
            style,
          });

          variants.push({
            variantIndex: vi,
            imageUrl: result.imageUrl,
            prompt: result.prompt || imagePrompt || '',
            seed: result.seed || null,
            selected: vi === 0,
          });
        }

        edit.imageVersions = [
          ...normArr(edit.imageVersions),
          {
            version: normArr(edit.imageVersions).length + 1,
            imageUrl: variants[0]?.imageUrl || '',
            prompt: variants[0]?.prompt || imagePrompt || '',
            source: 'rerun',
            createdAt: nowIso(),
          },
        ].slice(-20);
        edit.currentImageVersion = edit.imageVersions.length;

        if (parsed.spreadOnly || arts.spreadOnly) {
          const ills = normArr(arts.spreadIllustrations);
          ills[parsed.spreadIndex] = {
            ...(ills[parsed.spreadIndex] || {}),
            spreadIndex: parsed.spreadIndex,
            imageUrl: variants[0]?.imageUrl || '',
            prompt: variants[0]?.prompt || '',
            seed: variants[0]?.seed || null,
            variants,
            selectedVariantIndex: 0,
            createdAt: ills[parsed.spreadIndex]?.createdAt || nowIso(),
          };
          arts.spreadIllustrations = ills;
        } else {
          const illustrations = normArr(arts.illustrations);
          const illCh = illustrations[parsed.chapterIndex] || {
            chapterNumber: parsed.chapterIndex + 1,
            spreads: [],
            selectedVariantIndex: 0,
          };
          const illSpreads = normArr(illCh.spreads);

          illSpreads[parsed.spreadIndex] = {
            ...(illSpreads[parsed.spreadIndex] || {}),
            spreadIndex: parsed.spreadIndex,
            imageUrl: variants[0]?.imageUrl || '',
            prompt: variants[0]?.prompt || '',
            seed: variants[0]?.seed || null,
            variants,
            selectedVariantIndex: 0,
            createdAt: illSpreads[parsed.spreadIndex]?.createdAt || nowIso(),
          };

          illCh.spreads = illSpreads;
          illustrations[parsed.chapterIndex] = illCh;
          arts.illustrations = illustrations;
        }

        await deductCredits(req.user._id, totalCost, `Page image regenerate: ${key}`, 'project', project._id);
      }
    }

    edit.status = 'regenerated';
    edit.updatedAt = nowIso();

    project.markModified('artifacts');
    await project.save();

    logAIUsage({
      userId: req.user._id,
      projectId: project._id,
      provider: 'mixed',
      stage: 'pages-regenerate',
      requestType: 'mixed',
      creditsCharged: 0,
      success: true,
      durationMs: Date.now() - start,
      metadata: { key, type },
    });

    res.json({ message: 'Page regenerated', key, type });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Restore older version
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/pages/:key/restore-version', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const key = req.params.key;
    const { type, version } = req.body;

    if (!['text', 'image'].includes(type)) {
      throw new ValidationError('type must be text or image');
    }

    const edit = ensurePageEdit(arts, key);
    const versions = type === 'text' ? normArr(edit.textVersions) : normArr(edit.imageVersions);
    const vNum = Number(version);
    const found = versions.find(v => Number(v.version) === vNum);

    if (!found) throw new ValidationError(`Version ${vNum} not found`);

    const parsed = parsePageKey(key);

    if (type === 'text' && parsed.type === 'spread') {
      if (parsed.spreadOnly || arts.spreadOnly) {
        const spreads = normArr(arts.spreads);
        spreads[parsed.spreadIndex] = {
          ...(spreads[parsed.spreadIndex] || {}),
          text: found.text || '',
          prompt: found.prompt || '',
        };
        arts.spreads = spreads;
      } else {
        const sourceKey = normArr(arts.humanized).length ? 'humanized' : 'chapters';
        const chapters = normArr(arts[sourceKey]);
        const chapter = chapters[parsed.chapterIndex] || {};
        const spreads = normArr(chapter.spreads);
        spreads[parsed.spreadIndex] = {
          ...(spreads[parsed.spreadIndex] || {}),
          text: found.text || '',
          prompt: found.prompt || '',
        };
        chapters[parsed.chapterIndex] = { ...chapter, spreads };
        arts[sourceKey] = chapters;
      }
      edit.currentTextVersion = vNum;
    }

    if (type === 'image') {
      if (parsed.type === 'cover') {
        if (!arts.cover) arts.cover = {};
        if (parsed.side === 'front') {
          arts.cover.frontUrl = found.imageUrl || '';
          arts.cover.frontPrompt = found.prompt || '';
        } else {
          arts.cover.backUrl = found.imageUrl || '';
          arts.cover.backPrompt = found.prompt || '';
        }
      } else if (parsed.spreadOnly || arts.spreadOnly) {
        const ills = normArr(arts.spreadIllustrations);
        ills[parsed.spreadIndex] = {
          ...(ills[parsed.spreadIndex] || {}),
          imageUrl: found.imageUrl || '',
          prompt: found.prompt || '',
        };
        arts.spreadIllustrations = ills;
      } else {
        const illustrations = normArr(arts.illustrations);
        const illCh = illustrations[parsed.chapterIndex] || { chapterNumber: parsed.chapterIndex + 1, spreads: [] };
        const illSpreads = normArr(illCh.spreads);
        illSpreads[parsed.spreadIndex] = {
          ...(illSpreads[parsed.spreadIndex] || {}),
          imageUrl: found.imageUrl || '',
          prompt: found.prompt || '',
        };
        illCh.spreads = illSpreads;
        illustrations[parsed.chapterIndex] = illCh;
        arts.illustrations = illustrations;
      }
      edit.currentImageVersion = vNum;
    }

    edit.updatedAt = nowIso();
    edit.status = 'edited';

    project.markModified('artifacts');
    await project.save();

    res.json({ message: 'Version restored', key, type, version: vNum });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Approve all story pages
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/pages/approve-all', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const now = nowIso();
    const keys = [];

    if (arts.spreadOnly) {
      normArr(arts.spreads).forEach((_, i) => keys.push(`s${i}`));
    } else {
      const textContent = getEffectiveTextContent(arts);
      textContent.forEach((ch, ci) => {
        const chSpreads = normArr(ch?.spreads);
        if (chSpreads.length) {
          chSpreads.forEach((_, si) => keys.push(`ch${ci}_s${si}`));
        } else {
          keys.push(`ch${ci}_s0`);
        }
      });
    }

    if (!arts.pageEdits) arts.pageEdits = {};
    keys.forEach(k => {
      if (!arts.pageEdits[k]) {
        arts.pageEdits[k] = {
          status: 'approved',
          approvedAt: now,
          updatedAt: now,
          textStyle: {},
          imageStyle: {},
          layout: 'text-bottom',
          textVersions: [],
          imageVersions: [],
          currentTextVersion: 0,
          currentImageVersion: 0,
        };
      } else if (arts.pageEdits[k].status !== 'rejected') {
        arts.pageEdits[k].status = 'approved';
        arts.pageEdits[k].approvedAt = now;
        arts.pageEdits[k].updatedAt = now;
      }
    });

    project.markModified('artifacts');
    await project.save();
    res.json({ message: 'All pages approved', count: keys.length });
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Save global editor style
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/pages/book-style', async (req, res, next) => {
  try {
    const project = await getProjectForUser(req.params.id, req.user._id);
    const arts = project.artifacts || {};
    const { bookEditorStyle, applyToAll = false } = req.body;

    if (!bookEditorStyle) throw new ValidationError('bookEditorStyle is required');

    arts.bookEditorStyle = clone(bookEditorStyle);

    if (applyToAll) {
      const keys = [];

      if (arts.spreadOnly) {
        normArr(arts.spreads).forEach((_, i) => keys.push(`s${i}`));
      } else {
        const textContent = getEffectiveTextContent(arts);
        textContent.forEach((ch, ci) => {
          const spreads = normArr(ch?.spreads);
          if (spreads.length) {
            spreads.forEach((_, si) => keys.push(`ch${ci}_s${si}`));
          } else {
            keys.push(`ch${ci}_s0`);
          }
        });
      }

      keys.forEach(k => {
        const edit = ensurePageEdit(arts, k);
        edit.textStyle = {
          ...(edit.textStyle || {}),
          fontFamily: bookEditorStyle.globalFont,
          fontSize: bookEditorStyle.globalFontSize,
          color: bookEditorStyle.globalFontColor,
          bgColor: bookEditorStyle.globalBgColor,
          bgOpacity: bookEditorStyle.globalBgOpacity,
          textAlign: bookEditorStyle.globalTextAlign,
        };
        edit.layout = bookEditorStyle.globalLayout;
        edit.updatedAt = nowIso();
      });
    }

    project.markModified('artifacts');
    await project.save();

    res.json({ message: 'Book style saved', applied: applyToAll });
  } catch (e) {
    next(e);
  }
});

export default router;