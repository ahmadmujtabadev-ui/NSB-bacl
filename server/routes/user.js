import { Router } from 'express';
import { Project } from '../models/Project.js';

const router = Router();

// ─── Plan limits (mirrors frontend constants) ─────────────────────────────────
const PLAN_BOOK_LIMITS = {
  free:    1,
  creator: 5,
  author:  -1,   // unlimited — cap display at 10
  studio:  -1,
};

const DISPLAY_CAP = 10; // max slots to show for unlimited plans

// ─── Stage order for every book production slot ───────────────────────────────
// Edit this array to add / remove / reorder stages globally.
const STAGE_ORDER = ['universe', 'characters', 'kb', 'book', 'editor'];

const STAGE_META = {
  universe:   { label: 'Universe',       icon: 'Globe'    },
  characters: { label: 'Characters',     icon: 'Users'    },
  kb:         { label: 'Knowledge Base', icon: 'Library'  },
  book:       { label: 'Book',           icon: 'BookOpen' },
  editor:     { label: 'Editor',         icon: 'Rocket'   },
};

/**
 * Given a Project document, determine which stages are complete.
 * - universe:   universeId is set
 * - characters: at least one character linked
 * - kb:         knowledgeBaseId is set
 * - book:       story stage was completed in the book builder
 * - editor:     editor stage was reached or book was exported
 */
function computeStages(project) {
  const wStages = project.workflow?.stages || {};
  const steps   = project.stepsComplete  || {};

  const raw = {
    universe:   !!project.universeId,
    characters: (project.characterIds || []).length > 0,
    kb:         !!project.knowledgeBaseId,
    book:       !!(wStages.story  || steps.story  || project.artifacts?.review?.story?.status),
    editor:     !!(wStages.editor || steps.editor || project.status === 'exported'),
  };

  // Forward inference: if a later stage is done, all prior stages must also be done.
  // This handles projects where earlier fields weren't explicitly set.
  if (raw.editor)     { raw.book = raw.kb = raw.characters = raw.universe = true; }
  else if (raw.book)  { raw.kb   = raw.characters = raw.universe = true; }
  else if (raw.kb)    { raw.characters = raw.universe = true; }
  else if (raw.characters) { raw.universe = true; }

  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/user/journey
// Returns every book-production slot (filled + empty) with per-slot stage data.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/journey', async (req, res, next) => {
  try {
    const plan    = req.user.plan || 'free';
    const rawLimit = PLAN_BOOK_LIMITS[plan] ?? 1;
    const slotCap  = rawLimit === -1 ? DISPLAY_CAP : rawLimit;

    // Fetch projects newest-first, capped at slotCap
    const projects = await Project.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .limit(slotCap)
      .select('title universeId characterIds knowledgeBaseId workflow stepsComplete status artifacts.review.story createdAt updatedAt');

    const slots = projects.map((p, i) => {
      const doneMap   = computeStages(p);
      const doneCount = STAGE_ORDER.filter((s) => doneMap[s]).length;
      const currentStage = STAGE_ORDER.find((s) => !doneMap[s]) || 'editor';
      const isComplete   = doneCount === STAGE_ORDER.length;

      return {
        slotIndex:       i,
        projectId:       p._id.toString(),
        title:           p.title || null,
        currentStage,
        isComplete,
        percentComplete: Math.round((doneCount / STAGE_ORDER.length) * 100),
        doneMap,
        stageOrder:      STAGE_ORDER,
        stageMeta:       STAGE_META,
        updatedAt:       p.updatedAt,
      };
    });

    // Pad with empty slots up to the cap
    for (let i = projects.length; i < slotCap; i++) {
      const emptyDone = { universe: false, characters: false, kb: false, book: false, editor: false };
      slots.push({
        slotIndex:       i,
        projectId:       null,
        title:           null,
        currentStage:    null,
        isComplete:      false,
        percentComplete: 0,
        doneMap:         emptyDone,
        stageOrder:      STAGE_ORDER,
        stageMeta:       STAGE_META,
        updatedAt:       null,
      });
    }

    // Active slot = most-recently-updated incomplete book
    const activeSlotIdx = slots.findIndex(
      (s) => s.projectId && !s.isComplete
    );

    res.json({
      plan,
      planLimit:      rawLimit,
      slotCap,
      activeSlotIdx:  activeSlotIdx === -1 ? 0 : activeSlotIdx,
      stageOrder:     STAGE_ORDER,
      stageMeta:      STAGE_META,
      slots,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
