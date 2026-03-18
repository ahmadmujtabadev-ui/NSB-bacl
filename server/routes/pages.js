// server/routes/pages.routes.js
// NEW FILE — page-level editing, approval flow, version history, migration
// Register in server.js: app.use('/api/projects', authMiddleware, pagesRouter);

import { Router }          from 'express';
import { Project }         from '../models/Project.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../errors.js';
import { generateStageText }  from '../services/ai/text/text.service.js';
import { generateStageImage } from '../services/ai/image/image.service.js';
import { deductCredits }      from '../middleware/credits.js';
import { STAGE_CREDIT_COSTS } from '../services/ai/ai.billing.js';
import { logAIUsage }         from '../services/ai/ai.telemetry.js';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  const keys = Object.keys(val).map(Number).filter(n => !isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr.filter(Boolean);
}

/** Page key scheme:
 *  spreadOnly mode  → "s0", "s1", "s2" ...
 *  chapter mode     → "ch0_s0", "ch0_s1", "ch1_s0" ...
 *  cover / specials → "cover_front", "cover_back", "dedication", "theme"
 */
function makePageKey(spreadOnly, chapterIndex, spreadIndex) {
  return spreadOnly ? `s${spreadIndex}` : `ch${chapterIndex}_s${spreadIndex}`;
}

function parsePageKey(key) {
  if (key === 'cover_front') return { type: 'cover', side: 'front' };
  if (key === 'cover_back')  return { type: 'cover', side: 'back'  };
  if (key === 'dedication')  return { type: 'dedication' };
  if (key === 'theme')       return { type: 'theme' };

  const spreadOnly = /^s\d+$/.test(key);
  if (spreadOnly) {
    const si = parseInt(key.slice(1), 10);
    return { type: 'spread', spreadOnly: true,  chapterIndex: 0, spreadIndex: si };
  }
  const m = key.match(/^ch(\d+)_s(\d+)$/);
  if (!m) throw new ValidationError(`Invalid page key: "${key}"`);
  return {
    type: 'spread', spreadOnly: false,
    chapterIndex: parseInt(m[1], 10),
    spreadIndex:  parseInt(m[2], 10),
  };
}

function getEffectiveTextContent(arts) {
  const humanized = normArr(arts.humanized);
  return humanized.length ? humanized : normArr(arts.chapters);
}

function buildPageEntry(key, spread, illustration, edit) {
  return {
    key,
    text:               spread?.text              || null,
    textPrompt:         spread?.prompt            || null,
    illustrationHint:   spread?.illustrationHint  || null,
    textPosition:       spread?.textPosition      || 'bottom',
    imageUrl:           illustration?.imageUrl    || null,
    imagePrompt:        illustration?.prompt      || null,
    status:             edit?.status              || 'draft',
    notes:              edit?.notes               || '',
    textVersionCount:   edit?.textVersions?.length  || 0,
    imageVersionCount:  edit?.imageVersions?.length || 0,
    approvedAt:         edit?.approvedAt          || null,
    rejectionReason:    edit?.rejectionReason     || null,
    updatedAt:          edit?.updatedAt           || null,
  };
}

// ─── GET /api/projects/:id/pages ─────────────────────────────────────────────
// Returns flat list of all pages with current status (no heavy version history)

router.get('/:id/pages', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError('Project not found');
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const arts       = project.artifacts || {};
    const spreadOnly = !!arts.spreadOnly;
    const pages      = [];

    if (spreadOnly) {
      const spreads    = normArr(arts.spreads);
      const illSpreads = normArr(arts.spreadIllustrations);
      spreads.forEach((s, i) => {
        const key  = `s${i}`;
        const edit = arts.pageEdits?.[key] || {};
        pages.push({
          ...buildPageEntry(key, s, illSpreads[i], edit),
          label:  `Spread ${i + 1}`,
          chapterIndex: 0,
          spreadIndex:  i,
        });
      });
    } else {
      const textContent = getEffectiveTextContent(arts);
      const illustrations = normArr(arts.illustrations);

      textContent.forEach((ch, ci) => {
        if (!ch) return;
        const chSpreads = normArr(ch.spreads);
        const illCh     = illustrations[ci] || {};
        const illSpreads = normArr(illCh.spreads);

        chSpreads.forEach((s, si) => {
          const key  = `ch${ci}_s${si}`;
          const edit = arts.pageEdits?.[key] || {};
          pages.push({
            ...buildPageEntry(key, s, illSpreads[si], edit),
            label:        `Ch.${ci + 1} P${si + 1}`,
            chapterIndex: ci,
            spreadIndex:  si,
            chapterTitle: ch.chapterTitle || `Chapter ${ci + 1}`,
          });
        });

        // Chapter-book with no spreads — treat as single page per chapter
        if (!chSpreads.length && ch.text) {
          const key  = `ch${ci}_s0`;
          const edit = arts.pageEdits?.[key] || {};
          const illVariant = illCh.variants?.[illCh.selectedVariantIndex ?? 0] || {};
          pages.push({
            ...buildPageEntry(key, { text: ch.text, prompt: ch.prompt }, illVariant, edit),
            label:        `Ch.${ci + 1}`,
            chapterIndex: ci,
            spreadIndex:  0,
            chapterTitle: ch.chapterTitle || `Chapter ${ci + 1}`,
          });
        }
      });
    }

    // Approval summary
    const summary = {
      total:       pages.length,
      draft:       pages.filter(p => p.status === 'draft').length,
      regenerated: pages.filter(p => p.status === 'regenerated').length,
      edited:      pages.filter(p => p.status === 'edited').length,
      approved:    pages.filter(p => p.status === 'approved').length,
      rejected:    pages.filter(p => p.status === 'rejected').length,
    };

    res.json({ pages, spreadOnly, summary });
  } catch (e) { next(e); }
});

// ─── GET /api/projects/:id/pages/:key ────────────────────────────────────────
// Returns full detail for one page, including version history

router.get('/:id/pages/:key', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError('Project not found');
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const { key } = req.params;
    const arts     = project.artifacts || {};
    const parsed   = parsePageKey(key);
    const edit     = arts.pageEdits?.[key] || {};

    let spread       = null;
    let illustration = null;

    if (parsed.type === 'spread') {
      const { spreadOnly, chapterIndex, spreadIndex } = parsed;
      if (spreadOnly || arts.spreadOnly) {
        spread       = normArr(arts.spreads)[spreadIndex];
        illustration = normArr(arts.spreadIllustrations)[spreadIndex];
      } else {
        const textContent = getEffectiveTextContent(arts);
        const ch          = textContent[chapterIndex] || {};
        spread            = normArr(ch.spreads)[spreadIndex] || { text: ch.text, prompt: ch.prompt };
        const illCh       = normArr(arts.illustrations)[chapterIndex] || {};
        illustration      = normArr(illCh.spreads)[spreadIndex] || illCh.variants?.[0];
      }
    } else if (parsed.type === 'cover') {
      illustration = {
        imageUrl: parsed.side === 'front' ? arts.cover?.frontUrl : arts.cover?.backUrl,
        prompt:   parsed.side === 'front' ? arts.cover?.frontPrompt : arts.cover?.backPrompt,
      };
    } else if (parsed.type === 'dedication') {
      spread = arts.dedication;
    } else if (parsed.type === 'theme') {
      spread = arts.themePage;
    }

    res.json({
      key,
      parsed,
      spread,
      illustration,
      status:             edit.status              || 'draft',
      notes:              edit.notes               || '',
      approvedAt:         edit.approvedAt          || null,
      rejectionReason:    edit.rejectionReason     || null,
      textVersions:       edit.textVersions        || [],
      imageVersions:      edit.imageVersions       || [],
      currentTextVersion: edit.currentTextVersion  || 0,
      currentImageVersion:edit.currentImageVersion || 0,
      updatedAt:          edit.updatedAt           || null,
    });
  } catch (e) { next(e); }
});

// ─── PATCH /api/projects/:id/pages/:key ──────────────────────────────────────
// Manual text edit — saves new version, marks status = 'edited'

router.patch('/:id/pages/:key', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError('Project not found');
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const { key } = req.params;
    const { text, notes } = req.body;
    const arts   = project.artifacts || {};
    const parsed = parsePageKey(key);
    const now    = new Date().toISOString();
    const set    = {};

    if (text !== undefined && parsed.type === 'spread') {
      const { spreadOnly, chapterIndex, spreadIndex } = parsed;

      if (spreadOnly || arts.spreadOnly) {
        const spreads = normArr(arts.spreads);
        if (!spreads[spreadIndex]) throw new ValidationError('Spread index out of range');
        spreads[spreadIndex] = { ...spreads[spreadIndex], text };
        set['artifacts.spreads'] = spreads;
      } else {
        const isHumanized = normArr(arts.humanized).length > 0;
        const dbKey       = isHumanized ? 'artifacts.humanized' : 'artifacts.chapters';
        const chapters    = getEffectiveTextContent(arts);
        const ch          = chapters[chapterIndex];
        if (!ch) throw new ValidationError('Chapter index out of range');

        if (ch.spreads && normArr(ch.spreads)[spreadIndex] !== undefined) {
          const chSpreads = normArr(ch.spreads);
          chSpreads[spreadIndex] = { ...chSpreads[spreadIndex], text };
          chapters[chapterIndex] = { ...ch, spreads: chSpreads };
        } else {
          chapters[chapterIndex] = { ...ch, text };
        }
        set[dbKey] = chapters;
      }

      // Snapshot version
      const existingVersions = arts.pageEdits?.[key]?.textVersions || [];
      const newVersion = {
        version:   existingVersions.length + 1,
        text,
        prompt:    null,   // manual edit has no prompt
        source:    'manual',
        createdAt: now,
      };
      set[`artifacts.pageEdits.${key}.textVersions`] = [...existingVersions, newVersion];
      set[`artifacts.pageEdits.${key}.currentTextVersion`] = newVersion.version;
    }

    if (notes !== undefined) {
      set[`artifacts.pageEdits.${key}.notes`] = notes;
    }

    set[`artifacts.pageEdits.${key}.status`]    = 'edited';
    set[`artifacts.pageEdits.${key}.updatedAt`] = now;

    await Project.findByIdAndUpdate(req.params.id, { $set: set });
    res.json({ message: 'Page updated', key, status: 'edited' });
  } catch (e) { next(e); }
});

// ─── POST /api/projects/:id/pages/:key/approve ───────────────────────────────

router.post('/:id/pages/:key/approve', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError();
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const { key } = req.params;
    const now      = new Date().toISOString();

    await Project.findByIdAndUpdate(req.params.id, {
      $set: {
        [`artifacts.pageEdits.${key}.status`]:     'approved',
        [`artifacts.pageEdits.${key}.approvedAt`]: now,
        [`artifacts.pageEdits.${key}.updatedAt`]:  now,
      },
    });

    res.json({ message: 'Page approved', key, status: 'approved', approvedAt: now });
  } catch (e) { next(e); }
});

// ─── POST /api/projects/:id/pages/:key/reject ────────────────────────────────

router.post('/:id/pages/:key/reject', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError();
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const { key } = req.params;
    const { reason = '' } = req.body;
    const now = new Date().toISOString();

    await Project.findByIdAndUpdate(req.params.id, {
      $set: {
        [`artifacts.pageEdits.${key}.status`]:          'rejected',
        [`artifacts.pageEdits.${key}.rejectionReason`]: reason,
        [`artifacts.pageEdits.${key}.updatedAt`]:       now,
      },
    });

    res.json({ message: 'Page rejected', key, status: 'rejected', reason });
  } catch (e) { next(e); }
});

// ─── POST /api/projects/:id/pages/:key/regenerate ────────────────────────────
// Edit prompt → regenerate output → snapshot version → set status = 'regenerated'

router.post('/:id/pages/:key/regenerate', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError();
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const { key } = req.params;
    const { textPrompt, imagePrompt, type = 'both' } = req.body;
    const parsed = parsePageKey(key);
    const { chapterIndex = 0, spreadIndex = 0 } = parsed;
    const start  = Date.now();

    // ── Credit check ─────────────────────────────────────────────────────────
    let totalCost = 0;
    if ((type === 'text' || type === 'both') && textPrompt) totalCost += STAGE_CREDIT_COSTS.chapter ?? 1;
    if ((type === 'image' || type === 'both') && imagePrompt) totalCost += STAGE_CREDIT_COSTS.illustration ?? 4;

    if (req.user.credits < totalCost) {
      return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: `Need ${totalCost} credits, have ${req.user.credits}` } });
    }

    const now = new Date().toISOString();
    let textResult  = null;
    let imageResult = null;

    // ── Text regeneration ─────────────────────────────────────────────────────
    if ((type === 'text' || type === 'both') && textPrompt) {
      const r = await generateStageText({
        stage: 'spreadRerun',
        projectId: req.params.id,
        userId: req.user._id.toString(),
        chapterIndex,
        spreadIndex,
        customPrompt: textPrompt,
      });
      textResult = r.result;
    }

    // ── Image regeneration ────────────────────────────────────────────────────
    if ((type === 'image' || type === 'both') && imagePrompt) {
      imageResult = await generateStageImage({
        task:         'illustration',
        chapterIndex,
        spreadIndex,
        projectId:    req.params.id,
        userId:       req.user._id.toString(),
        customPrompt: imagePrompt,
      });
    }

    // ── Save version snapshots ────────────────────────────────────────────────
    const freshProject = await Project.findById(req.params.id);
    const arts         = freshProject.artifacts || {};
    const editState    = arts.pageEdits?.[key] || {};
    const setFields    = {};

    if (textResult) {
      const resolvedText = typeof textResult === 'object'
        ? (textResult.text || textResult.spreads?.[0]?.text || JSON.stringify(textResult))
        : textResult;

      const versions = editState.textVersions || [];
      setFields[`artifacts.pageEdits.${key}.textVersions`] = [
        ...versions,
        { version: versions.length + 1, text: resolvedText, prompt: textPrompt, source: 'ai-regenerated', createdAt: now },
      ];
      setFields[`artifacts.pageEdits.${key}.currentTextVersion`] = versions.length + 1;
    }

    if (imageResult) {
      const versions = editState.imageVersions || [];
      setFields[`artifacts.pageEdits.${key}.imageVersions`] = [
        ...versions,
        { version: versions.length + 1, imageUrl: imageResult.imageUrl, prompt: imagePrompt, source: 'ai-regenerated', createdAt: now },
      ];
      setFields[`artifacts.pageEdits.${key}.currentImageVersion`] = versions.length + 1;
    }

    setFields[`artifacts.pageEdits.${key}.status`]    = 'regenerated';
    setFields[`artifacts.pageEdits.${key}.updatedAt`] = now;

    await Project.findByIdAndUpdate(req.params.id, { $set: setFields });
    await deductCredits(req.user._id, totalCost, `Page regen: ${key}`, 'project', req.params.id);

    logAIUsage({
      userId: req.user._id, projectId: req.params.id, provider: imageResult?.provider || 'text-only',
      stage: 'pageRegenerate', requestType: 'mixed', creditsCharged: totalCost,
      success: true, durationMs: Date.now() - start,
    });

    res.json({ message: 'Regenerated', key, status: 'regenerated', textResult, imageResult, creditsCharged: totalCost });
  } catch (e) { next(e); }
});

// ─── POST /api/projects/:id/pages/:key/restore/:version ──────────────────────
// Restore a previous text or image version

router.post('/:id/pages/:key/restore/:versionNum', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError();
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const { key, versionNum } = req.params;
    const { type = 'text' } = req.body; // 'text' | 'image'
    const vNum   = parseInt(versionNum, 10);
    const arts   = project.artifacts || {};
    const edit   = arts.pageEdits?.[key];
    if (!edit) throw new NotFoundError('No edit history for this page');

    const versions = type === 'text' ? (edit.textVersions || []) : (edit.imageVersions || []);
    const snapshot = versions.find(v => v.version === vNum);
    if (!snapshot) throw new NotFoundError(`Version ${vNum} not found`);

    const parsed = parsePageKey(key);
    const { spreadOnly, chapterIndex, spreadIndex } = parsed;
    const now    = new Date().toISOString();
    const set    = {};

    if (type === 'text' && snapshot.text) {
      if (spreadOnly || arts.spreadOnly) {
        const spreads = normArr(arts.spreads);
        spreads[spreadIndex] = { ...spreads[spreadIndex], text: snapshot.text };
        set['artifacts.spreads'] = spreads;
      } else {
        const isHumanized = normArr(arts.humanized).length > 0;
        const dbKey       = isHumanized ? 'artifacts.humanized' : 'artifacts.chapters';
        const chapters    = getEffectiveTextContent(arts);
        const ch          = chapters[chapterIndex] || {};
        const chSpreads   = normArr(ch.spreads);
        if (chSpreads[spreadIndex]) {
          chSpreads[spreadIndex] = { ...chSpreads[spreadIndex], text: snapshot.text };
          chapters[chapterIndex] = { ...ch, spreads: chSpreads };
        } else {
          chapters[chapterIndex] = { ...ch, text: snapshot.text };
        }
        set[dbKey] = chapters;
      }
    } else if (type === 'image' && snapshot.imageUrl) {
      if (arts.spreadOnly) {
        const ills = normArr(arts.spreadIllustrations);
        ills[spreadIndex] = { ...ills[spreadIndex], imageUrl: snapshot.imageUrl };
        set['artifacts.spreadIllustrations'] = ills;
      } else {
        const illustrations = normArr(arts.illustrations);
        const illCh         = illustrations[chapterIndex] || {};
        const illSpreads    = normArr(illCh.spreads);
        illSpreads[spreadIndex] = { ...illSpreads[spreadIndex], imageUrl: snapshot.imageUrl };
        illCh.spreads           = illSpreads;
        illustrations[chapterIndex] = illCh;
        set['artifacts.illustrations'] = illustrations;
      }
    }

    set[`artifacts.pageEdits.${key}.status`]    = 'edited';
    set[`artifacts.pageEdits.${key}.updatedAt`] = now;

    await Project.findByIdAndUpdate(req.params.id, { $set: set });
    res.json({ message: 'Version restored', key, type, version: vNum });
  } catch (e) { next(e); }
});

// ─── POST /api/projects/:id/pages/approve-all ────────────────────────────────
// Bulk-approve all pages that are NOT already rejected

router.post('/:id/pages/approve-all', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError();
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const arts = project.artifacts || {};
    const now  = new Date().toISOString();
    const set  = {};

    // Build list of all page keys
    const keys = [];
    if (arts.spreadOnly) {
      normArr(arts.spreads).forEach((_, i) => keys.push(`s${i}`));
    } else {
      getEffectiveTextContent(arts).forEach((ch, ci) => {
        const chSpreads = normArr(ch?.spreads);
        if (chSpreads.length) {
          chSpreads.forEach((_, si) => keys.push(`ch${ci}_s${si}`));
        } else {
          keys.push(`ch${ci}_s0`);
        }
      });
    }

    for (const k of keys) {
      const existingStatus = arts.pageEdits?.[k]?.status;
      if (existingStatus !== 'rejected') {
        set[`artifacts.pageEdits.${k}.status`]     = 'approved';
        set[`artifacts.pageEdits.${k}.approvedAt`] = now;
        set[`artifacts.pageEdits.${k}.updatedAt`]  = now;
      }
    }

    await Project.findByIdAndUpdate(req.params.id, { $set: set });
    res.json({ message: 'All pages approved', count: keys.length });
  } catch (e) { next(e); }
});

// ─── POST /api/projects/:id/pages/migrate ────────────────────────────────────
// One-time: migrate old chapter-based data to spreads-only for age < 6

router.post('/:id/pages/migrate', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) throw new NotFoundError();
    if (!project.userId.equals(req.user._id)) throw new ForbiddenError();

    const ageFirst = String(project.ageRange || '').match(/\d+/)?.[0];
    const shouldBeSpreadsOnly = ageFirst ? Number(ageFirst) < 6 : false;
    const arts = project.artifacts || {};

    // Case 1: already spread-only, nothing to do
    if (arts.spreadOnly) {
      return res.json({ migrated: false, reason: 'Already in spreads-only mode' });
    }

    // Case 2: age ≥ 6, chapter mode is correct
    if (!shouldBeSpreadsOnly) {
      return res.json({ migrated: false, reason: `Age ${project.ageRange} uses chapter mode` });
    }

    // Case 3: age < 6 with old chapter data — flatten to spreads
    const textContent = getEffectiveTextContent(arts);
    const illustrations = normArr(arts.illustrations);

    const allSpreads = [];
    const allSpreadIllustrations = [];

    textContent.forEach((ch, ci) => {
      const chSpreads = normArr(ch?.spreads);
      const illCh     = illustrations[ci] || {};
      const illSpreads = normArr(illCh.spreads);

      if (chSpreads.length) {
        chSpreads.forEach((s, si) => {
          const idx = allSpreads.length;
          allSpreads.push({ spreadIndex: idx, text: s.text || '', prompt: s.prompt || '', illustrationHint: s.illustrationHint || '', textPosition: s.textPosition || 'bottom' });
          allSpreadIllustrations.push({ spreadIndex: idx, imageUrl: illSpreads[si]?.imageUrl || '', prompt: illSpreads[si]?.prompt || '' });
        });
      } else if (ch?.text) {
        const idx = allSpreads.length;
        allSpreads.push({ spreadIndex: idx, text: ch.text, prompt: ch.prompt || '', illustrationHint: '', textPosition: 'bottom' });
        const variant = illCh.variants?.[illCh.selectedVariantIndex ?? 0] || {};
        allSpreadIllustrations.push({ spreadIndex: idx, imageUrl: variant.imageUrl || '', prompt: variant.prompt || '' });
      }
    });

    await Project.findByIdAndUpdate(req.params.id, {
      $set: {
        'artifacts.spreads':              allSpreads,
        'artifacts.spreadIllustrations':  allSpreadIllustrations,
        'artifacts.spreadOnly':           true,
      },
    });

    res.json({ migrated: true, spreadCount: allSpreads.length, from: 'chapters', to: 'spreads', ageRange: project.ageRange });
  } catch (e) { next(e); }
});

export default router;