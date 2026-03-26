// server/routes/project-review.routes.js
// PRODUCTION-READY — Review-first workflow routes for story, structure,
// prose, humanize, illustrations, and cover.
// This route syncs review nodes with your existing artifacts so current
// pages/layout/export routes keep working.

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
    const numericKeys = Object.keys(val).map(Number).filter(n => !Number.isNaN(n));
    if (!numericKeys.length) return [];
    const arr = [];
    numericKeys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
    return arr.filter(v => v != null);
}

function clone(v) {
    return JSON.parse(JSON.stringify(v ?? null));
}

function nowIso() {
    return new Date().toISOString();
}

function str(v) {
    return v == null ? '' : String(v).trim();
}

function mergeProseNode(existingArr, freshNode, chapterIndex) {
    const arr = normArr(existingArr);
    const idx = arr.findIndex(n => Number(n.chapterIndex) === Number(chapterIndex));

    if (idx === -1) {
        arr.push(freshNode);
        return arr;
    }

    const existing = arr[idx];
    arr[idx] = {
        ...freshNode,
        status: freshNode.current.chapterText ? 'generated' : existing.status,
        versions: existing.versions,
        current: {
            ...freshNode.current,
            chapterSummary: existing.current.chapterSummary || freshNode.current.chapterSummary,
            islamicMoment: existing.current.islamicMoment || freshNode.current.islamicMoment,
            chapterText: freshNode.current.chapterText || existing.current.chapterText,
        },
    };

    return arr;
}

function getAgeMode(ageRange) {
    if (!ageRange) return 'picture-book';
    const nums = String(ageRange).match(/\d+/g) || [];
    const first = Number(nums[0] || 8);
    const last = Number(nums[1] || first);
    const avg = (first + last) / 2;

    if (first <= 5) return 'spreads-only';
    if (avg <= 8) return 'picture-book';
    return 'chapter-book';
}

async function getProjectForUser(projectId, userId) {
    const project = await Project.findById(projectId);
    if (!project) throw new NotFoundError('Project not found');
    if (!project.userId.equals(userId)) throw new ForbiddenError();
    return project;
}

function pushVersion(node, current) {
    const versions = normArr(node?.versions);
    versions.push({
        version: versions.length + 1,
        snapshot: clone(current),
        createdAt: nowIso(),
    });
    return versions.slice(-30);
}

function normalizeArtifacts(project) {
    const arts = project.artifacts || {};

    // ── Ensure outline object ──────────────────────────────────────────────────
    if (!arts.outline) arts.outline = {};

    // ── Lift flat scalar fields into outline ──────────────────────────────────
    const flatToOutline = ['bookTitle', 'synopsis', 'moral', 'islamicTheme', 'dedicationMessage'];
    for (const key of flatToOutline) {
        // Only copy flat → nested when nested is missing/empty
        if (arts[key] !== undefined && !arts.outline[key]) {
            arts.outline[key] = arts[key];
        }
    }

    // ── Lift chapterOutline[] → outline.chapters[] ────────────────────────────
    const flatChapters = normArr(arts.chapterOutline);
    if (flatChapters.length && !normArr(arts.outline.chapters).length) {
        arts.outline.chapters = flatChapters.map((ch, i) => ({
            chapterNumber: ch.chapterNumber || i + 1,
            title: ch.title || ch.chapterTitle || `Chapter ${i + 1}`,
            goal: ch.goal || '',
            keyScene: ch.keyScene || '',
            duaHint: ch.duaHint || ch.islamicMoment || '',
            endingBeat: ch.endingBeat || '',
            charactersInScene: normArr(ch.charactersInScene),
            illustrationMoments: normArr(ch.illustrationMoments),
        }));
    }

    // ── storyText: may live flat on artifacts ────────────────────────────────
    if (arts.storyText === undefined && arts.outline?.storyText) {
        arts.storyText = arts.outline.storyText;
    }

    // ── Sync project title from bookTitle ─────────────────────────────────────
    const detectedTitle = str(arts.outline.bookTitle || arts.bookTitle);
    if (detectedTitle && detectedTitle !== project.title) {
        project.title = detectedTitle;
    }

    project.artifacts = arts;
}


function buildStoryReview(project) {
    normalizeArtifacts(project);          // ← ensure outline is populated first
    const arts = project.artifacts || {};
    const outline = arts.outline || {};

    return {
        status: 'generated',
        current: {
            bookTitle: str(outline.bookTitle || arts.bookTitle || project.title || ''),
            synopsis: str(outline.synopsis || arts.synopsis || ''),
            moral: str(outline.moral || arts.moral || ''),
            storyText: str(arts.storyText || outline.storyText || ''),
            islamicTheme: clone(outline.islamicTheme || arts.islamicTheme || {}),
            dedicationMessage: str(outline.dedicationMessage || arts.dedicationMessage || ''),
        },
        versions: [],
        promptHistory: [],
        approvedAt: null,
        updatedAt: nowIso(),
    };
}

function buildStructureReview(project) {
    normalizeArtifacts(project);          // ← ensure outline.chapters is populated
    const arts = project.artifacts || {};
    const mode = getAgeMode(project.ageRange);

    // ── chapter-book ──────────────────────────────────────────────────────────
    if (mode === 'chapter-book') {
        const chapters = normArr(arts.outline?.chapters);
        return {
            mode,
            items: chapters.map((ch, ci) => ({
                key: `ch${ci}`,
                unitType: 'chapter-outline',
                status: 'generated',
                current: {
                    chapterNumber: ch.chapterNumber || ci + 1,
                    title: ch.title || ch.chapterTitle || `Chapter ${ci + 1}`,
                    goal: ch.goal || '',
                    keyScene: ch.keyScene || '',
                    duaHint: ch.duaHint || ch.islamicMoment || '',
                    endingBeat: ch.endingBeat || '',
                    charactersInScene: normArr(ch.charactersInScene),
                    illustrationMoments: normArr(ch.illustrationMoments),
                },
                versions: [],
                approvedAt: null,
                updatedAt: nowIso(),
            })),
        };
    }

    // ── spreads-only ──────────────────────────────────────────────────────────
    if (arts.spreadOnly) {
        const spreads = normArr(arts.spreads);
        return {
            mode: 'spreads-only',
            items: spreads.map((s, si) => ({
                key: `s${si}`,
                unitType: 'spread',
                status: 'generated',
                current: {
                    spreadIndex: si,
                    text: s.text || '',
                    prompt: s.prompt || '',
                    illustrationHint: s.illustrationHint || '',
                    charactersInScene: normArr(s.charactersInScene),
                    characterEmotion: clone(s.characterEmotion || {}),
                    sceneEnvironment: s.sceneEnvironment || 'indoor',
                    timeOfDay: s.timeOfDay || 'day',
                    textPosition: s.textPosition || 'bottom',
                    islamicElement: s.islamicElement || null,
                },
                versions: [],
                approvedAt: null,
                updatedAt: nowIso(),
            })),
        };
    }

    // ── picture-book ──────────────────────────────────────────────────────────
    const chapters = normArr(arts.humanized).length ? normArr(arts.humanized) : normArr(arts.chapters);
    const items = [];

    chapters.forEach((ch, ci) => {
        normArr(ch?.spreads).forEach((s, si) => {
            items.push({
                key: `ch${ci}_s${si}`,
                unitType: 'spread',
                status: 'generated',
                current: {
                    spreadIndex: si,
                    chapterIndex: ci,
                    text: s.text || '',
                    prompt: s.prompt || '',
                    illustrationHint: s.illustrationHint || '',
                    charactersInScene: normArr(s.charactersInScene || s.charactersInSpread),
                    characterEmotion: clone(s.characterEmotion || {}),
                    sceneEnvironment: s.sceneEnvironment || 'indoor',
                    timeOfDay: s.timeOfDay || 'day',
                    textPosition: s.textPosition || 'bottom',
                    islamicElement: s.islamicElement || null,
                },
                versions: [],
                approvedAt: null,
                updatedAt: nowIso(),
            });
        });
    });

    return { mode: 'picture-book', items };
}


function buildProseReview(project) {
    normalizeArtifacts(project); // ensure outline.chapters is populated
    const arts = project.artifacts || {};

    // Source of truth for chapter metadata = outline.chapters
    const outlineChapters = normArr(arts.outline?.chapters);
    // Source of truth for generated prose text = arts.chapters
    const proseChapters = normArr(arts.chapters);

    // Use whichever array is longer so we always get all chapters
    const count = Math.max(outlineChapters.length, proseChapters.length);
    if (count === 0) return [];

    return Array.from({ length: count }, (_, ci) => {
        const outline = outlineChapters[ci] || {};
        const prose = proseChapters[ci] || {};

        return {
            key: `ch${ci}`,
            chapterIndex: ci,
            status: prose.chapterText || prose.text ? 'generated' : 'draft',
            current: {
                chapterNumber: outline.chapterNumber || prose.chapterNumber || ci + 1,
                chapterTitle: outline.title || prose.chapterTitle || `Chapter ${ci + 1}`,
                chapterSummary: prose.chapterSummary || outline.goal || '',
                chapterText: prose.chapterText || prose.text || '',
                islamicMoment: prose.islamicMoment || outline.duaHint || '',
                illustrationMoments: normArr(prose.illustrationMoments || outline.illustrationMoments),
            },
            versions: [],
            approvedAt: null,
            updatedAt: nowIso(),
        };
    });
}

function buildHumanizedReview(project) {
    const arts = project.artifacts || {};
    return normArr(arts.humanized).map((ch, ci) => ({
        key: `ch${ci}`,
        chapterIndex: ci,
        status: 'generated',
        current: {
            chapterNumber: ch.chapterNumber || ci + 1,
            chapterTitle: ch.chapterTitle || `Chapter ${ci + 1}`,
            chapterSummary: ch.chapterSummary || '',
            chapterText: ch.chapterText || ch.text || '',
            changesMade: normArr(ch.changesMade),
        },
        versions: [],
        approvedAt: null,
        updatedAt: nowIso(),
    }));
}

function buildIllustrationReview(project) {
    const arts = project.artifacts || {};
    const mode = getAgeMode(project.ageRange);
    const nodes = [];

    if (mode === 'spreads-only') {
        const spreads = normArr(arts.spreads);
        const ills = normArr(arts.spreadIllustrations);
        spreads.forEach((s, si) => {
            const ill = ills[si] || {};
            nodes.push({
                key: `s${si}`,
                chapterIndex: 0,
                spreadIndex: si,
                sourceType: 'spread',
                status: ill.imageUrl ? 'generated' : 'draft',
                current: {
                    imageUrl: ill.imageUrl || '',
                    prompt: ill.prompt || '',
                    seed: ill.seed || null,
                    selectedVariantIndex: ill.selectedVariantIndex ?? 0,
                    variants: normArr(ill.variants),
                    text: s.text || '',
                    illustrationHint: s.illustrationHint || '',
                },
                versions: [],
                approvedAt: ill.approvedAt || null,
                updatedAt: nowIso(),
            });
        });
        return nodes;
    }

    if (mode === 'picture-book') {
        const textContent = normArr(arts.humanized).length ? normArr(arts.humanized) : normArr(arts.chapters);
        const illustrations = normArr(arts.illustrations);

        textContent.forEach((ch, ci) => {
            const textSpreads = normArr(ch?.spreads);
            const illCh = illustrations[ci] || {};
            const illSpreads = normArr(illCh.spreads);

            textSpreads.forEach((s, si) => {
                const ill = illSpreads[si] || {};
                nodes.push({
                    key: `ch${ci}_s${si}`,
                    chapterIndex: ci,
                    spreadIndex: si,
                    sourceType: 'spread',
                    status: ill.imageUrl ? 'generated' : 'draft',
                    current: {
                        imageUrl: ill.imageUrl || '',
                        prompt: ill.prompt || '',
                        seed: ill.seed || null,
                        selectedVariantIndex: ill.selectedVariantIndex ?? 0,
                        variants: normArr(ill.variants),
                        text: s.text || '',
                        illustrationHint: s.illustrationHint || '',
                    },
                    versions: [],
                    approvedAt: ill.approvedAt || null,
                    updatedAt: nowIso(),
                });
            });
        });

        return nodes;
    }

    // chapter-book → use whichever source has more chapters so all slots are shown
    // arts.chapters contains illustrationMoments; arts.humanized contains polished text
    const rawChapters       = normArr(arts.chapters);
    const humanizedChapters = normArr(arts.humanized);
    // Prefer the source with more chapters to avoid truncating the illustration list
    const sourceChapters = rawChapters.length >= humanizedChapters.length
        ? rawChapters
        : humanizedChapters;
    const illustrations = normArr(arts.illustrations);

    sourceChapters.forEach((ch, ci) => {
        // Always prefer illustrationMoments from rawChapters — they are generated by the AI outline
        // and may not be present in humanizedChapters
        const rawCh = rawChapters[ci] || ch;
        const moments = normArr(rawCh?.illustrationMoments).length
            ? normArr(rawCh.illustrationMoments)
            : normArr(ch?.illustrationMoments);
        const illCh = illustrations[ci] || {};
        const illSpreads = normArr(illCh.spreads);

        const usableMoments = moments.length
            ? moments
            : [
                {
                    momentTitle: 'Key moment',
                    illustrationHint: rawCh?.chapterIllustrationHint || rawCh?.chapterSummary
                        || ch?.chapterIllustrationHint || ch?.chapterSummary || '',
                    charactersInScene: [],
                    sceneEnvironment: 'mixed',
                    timeOfDay: 'day',
                },
            ];

        usableMoments.forEach((m, mi) => {
            const ill = illSpreads[mi] || {};
            nodes.push({
                key: `ch${ci}_img${mi}`,
                chapterIndex: ci,
                spreadIndex: mi,
                sourceType: 'chapter-moment',
                status: ill.imageUrl ? 'generated' : 'draft',
                current: {
                    imageUrl: ill.imageUrl || '',
                    prompt: ill.prompt || '',
                    seed: ill.seed || null,
                    selectedVariantIndex: ill.selectedVariantIndex ?? 0,
                    variants: normArr(ill.variants),
                    momentTitle: m.momentTitle || `Moment ${mi + 1}`,
                    illustrationHint: m.illustrationHint || '',
                    charactersInScene: normArr(m.charactersInScene),
                    sceneEnvironment: m.sceneEnvironment || 'mixed',
                    timeOfDay: m.timeOfDay || 'day',
                },
                versions: [],
                approvedAt: ill.approvedAt || null,
                updatedAt: nowIso(),
            });
        });
    });

    return nodes;
}

function buildCoverReview(project) {
    const cover = project.artifacts?.cover || {};
    return {
        front: {
            status: cover.frontUrl ? 'generated' : 'draft',
            current: {
                imageUrl: cover.frontUrl || '',
                prompt: cover.frontPrompt || '',
                seed: cover.frontSeed || null,
                selectedVariantIndex: cover.frontSelectedVariantIndex ?? 0,
                variants: normArr(cover.frontVariants),
            },
            versions: [],
            approvedAt: cover.frontApprovedAt || null,
            updatedAt: nowIso(),
        },
        back: {
            status: cover.backUrl ? 'generated' : 'draft',
            current: {
                imageUrl: cover.backUrl || '',
                prompt: cover.backPrompt || '',
                seed: cover.backSeed || null,
                selectedVariantIndex: cover.backSelectedVariantIndex ?? 0,
                variants: normArr(cover.backVariants),
            },
            versions: [],
            approvedAt: cover.backApprovedAt || null,
            updatedAt: nowIso(),
        },
    };
}

function syncReviewFromArtifacts(project) {
    normalizeArtifacts(project);          // ← NEW: always normalize first

    const arts = project.artifacts || {};
    if (!arts.review) arts.review = {};

    if (!arts.review.story) {
        arts.review.story = buildStoryReview(project);
    } else {
        const base = buildStoryReview(project);
        // Only back-fill fields that are still empty in the existing review node
        const existing = arts.review.story.current || {};
        arts.review.story.current = {
            ...base.current,
            ...Object.fromEntries(
                Object.entries(existing).filter(([, v]) => v !== '' && v !== null && v !== undefined)
            ),
        };
    }

    if (!arts.review.structure || !normArr(arts.review.structure.items).length) {
        arts.review.structure = buildStructureReview(project);
    } else {
        arts.review.structure.mode = getAgeMode(project.ageRange);
    }

    if (!arts.review.prose || !normArr(arts.review.prose).length) {
        arts.review.prose = buildProseReview(project);
    }

    if (!arts.review.humanized || !normArr(arts.review.humanized).length) {
        arts.review.humanized = buildHumanizedReview(project);
    }

    if (!arts.review.illustrations || !normArr(arts.review.illustrations).length) {
        arts.review.illustrations = buildIllustrationReview(project);
    }

    if (!arts.review.cover) {
        arts.review.cover = buildCoverReview(project);
    }

    if (!project.workflow) {
        project.workflow = {
            mode: getAgeMode(project.ageRange),
            currentStage: 'story',
            stages: {},
        };
    } else {
        project.workflow.mode = getAgeMode(project.ageRange);
    }

    return arts.review;
}

function findReviewStructureItem(review, key) {
    const items = normArr(review?.structure?.items);
    const idx = items.findIndex(x => x.key === key);
    if (idx === -1) throw new NotFoundError(`Review structure item not found: ${key}`);
    return { items, idx, item: items[idx] };
}

function findReviewChapterNode(list, chapterIndex) {
    const arr = normArr(list);
    const idx = arr.findIndex(x => Number(x.chapterIndex) === Number(chapterIndex));
    if (idx === -1) throw new NotFoundError(`Chapter review node not found: ${chapterIndex}`);
    return { arr, idx, node: arr[idx] };
}

function findIllustrationNode(review, key) {
    const nodes = normArr(review?.illustrations);
    const idx = nodes.findIndex(x => x.key === key);
    if (idx === -1) throw new NotFoundError(`Illustration slot not found: ${key}`);
    return { nodes, idx, node: nodes[idx] };
}

function ensureCoreSpreadStructures(project, chapterIndex = 0) {
    const arts = project.artifacts || {};
    if (arts.spreadOnly) {
        if (!Array.isArray(arts.spreadIllustrations)) arts.spreadIllustrations = [];
        return arts.spreadIllustrations;
    }

    if (!Array.isArray(arts.illustrations)) arts.illustrations = [];
    if (!arts.illustrations[chapterIndex]) {
        arts.illustrations[chapterIndex] = {
            chapterNumber: chapterIndex + 1,
            spreads: [],
            selectedVariantIndex: 0,
        };
    }
    if (!Array.isArray(arts.illustrations[chapterIndex].spreads)) {
        arts.illustrations[chapterIndex].spreads = [];
    }
    return arts.illustrations[chapterIndex].spreads;
}

function syncStructureItemToCore(project, item) {
    const arts = project.artifacts || {};
    const mode = getAgeMode(project.ageRange);

    if (item.unitType === 'chapter-outline' && mode === 'chapter-book') {
        if (!arts.outline) arts.outline = {};
        const chapters = normArr(arts.outline.chapters);
        const ci = Number(item.current.chapterNumber || 1) - 1;
        chapters[ci] = {
            chapterNumber: ci + 1,
            title: item.current.title || `Chapter ${ci + 1}`,
            goal: item.current.goal || '',
            keyScene: item.current.keyScene || '',
            duaHint: item.current.duaHint || '',
            endingBeat: item.current.endingBeat || '',
            charactersInScene: normArr(item.current.charactersInScene),
            illustrationMoments: normArr(item.current.illustrationMoments),
        };
        arts.outline.chapters = chapters;
        return;
    }

    if (arts.spreadOnly) {
        const spreads = normArr(arts.spreads);
        const si = Number(item.current.spreadIndex || 0);
        spreads[si] = {
            ...(spreads[si] || {}),
            spreadIndex: si,
            text: item.current.text || '',
            prompt: item.current.prompt || '',
            illustrationHint: item.current.illustrationHint || '',
            charactersInScene: normArr(item.current.charactersInScene),
            characterEmotion: clone(item.current.characterEmotion || {}),
            sceneEnvironment: item.current.sceneEnvironment || 'indoor',
            timeOfDay: item.current.timeOfDay || 'day',
            textPosition: item.current.textPosition || 'bottom',
            islamicElement: item.current.islamicElement || null,
        };
        arts.spreads = spreads;
        arts.spreadOnly = true;
        return;
    }

    const m = item.key.match(/^ch(\d+)_s(\d+)$/);
    if (!m) throw new ValidationError(`Invalid structure spread key: ${item.key}`);
    const ci = Number(m[1]);
    const si = Number(m[2]);

    const sourceKey = normArr(arts.humanized).length ? 'humanized' : 'chapters';
    const chapters = normArr(arts[sourceKey]);

    if (!chapters[ci]) {
        chapters[ci] = {
            chapterNumber: ci + 1,
            chapterTitle: `Chapter ${ci + 1}`,
            spreads: [],
        };
    }

    const spreads = normArr(chapters[ci].spreads);
    spreads[si] = {
        ...(spreads[si] || {}),
        spreadIndex: si,
        text: item.current.text || '',
        prompt: item.current.prompt || '',
        illustrationHint: item.current.illustrationHint || '',
        charactersInScene: normArr(item.current.charactersInScene),
        characterEmotion: clone(item.current.characterEmotion || {}),
        sceneEnvironment: item.current.sceneEnvironment || 'indoor',
        timeOfDay: item.current.timeOfDay || 'day',
        textPosition: item.current.textPosition || 'bottom',
        islamicElement: item.current.islamicElement || null,
    };

    chapters[ci].spreads = spreads;
    arts[sourceKey] = chapters;
}

function syncProseNodeToCore(project, node, target = 'chapters') {
    const arts = project.artifacts || {};
    const arr = normArr(arts[target]);
    const ci = Number(node.chapterIndex);

    arr[ci] = {
        ...(arr[ci] || {}),
        chapterNumber: node.current.chapterNumber || ci + 1,
        chapterTitle: node.current.chapterTitle || `Chapter ${ci + 1}`,
        chapterSummary: node.current.chapterSummary || '',
        chapterText: node.current.chapterText || '',
        text: node.current.chapterText || '',
        islamicMoment: node.current.islamicMoment || '',
        illustrationMoments: normArr(node.current.illustrationMoments),
    };

    arts[target] = arr;
}

function syncIllustrationNodeToCore(project, node) {
    const arts = project.artifacts || {};
    const current = node.current || {};

    if (arts.spreadOnly) {
        const arr = normArr(arts.spreadIllustrations);
        arr[node.spreadIndex] = {
            ...(arr[node.spreadIndex] || {}),
            spreadIndex: node.spreadIndex,
            imageUrl: current.imageUrl || '',
            prompt: current.prompt || '',
            seed: current.seed || null,
            variants: normArr(current.variants),
            selectedVariantIndex: current.selectedVariantIndex ?? 0,
            approvedAt: node.approvedAt || null,
            createdAt: arr[node.spreadIndex]?.createdAt || nowIso(),
        };
        arts.spreadIllustrations = arr;
        return;
    }

    const spreads = ensureCoreSpreadStructures(project, node.chapterIndex);
    spreads[node.spreadIndex] = {
        ...(spreads[node.spreadIndex] || {}),
        spreadIndex: node.spreadIndex,
        imageUrl: current.imageUrl || '',
        prompt: current.prompt || '',
        seed: current.seed || null,
        variants: normArr(current.variants),
        selectedVariantIndex: current.selectedVariantIndex ?? 0,
        approvedAt: node.approvedAt || null,
        createdAt: spreads[node.spreadIndex]?.createdAt || nowIso(),
        illustrationHint: current.illustrationHint || spreads[node.spreadIndex]?.illustrationHint || '',
        text: current.text || spreads[node.spreadIndex]?.text || '',
    };
}

function syncCoverNodeToCore(project, side, node) {
    const arts = project.artifacts || {};
    if (!arts.cover) arts.cover = {};
    const current = node.current || {};

    if (side === 'front') {
        arts.cover.frontUrl = current.imageUrl || '';
        arts.cover.frontPrompt = current.prompt || '';
        arts.cover.frontSeed = current.seed || null;
        arts.cover.frontVariants = normArr(current.variants);
        arts.cover.frontSelectedVariantIndex = current.selectedVariantIndex ?? 0;
        arts.cover.frontApprovedAt = node.approvedAt || null;
    } else {
        arts.cover.backUrl = current.imageUrl || '';
        arts.cover.backPrompt = current.prompt || '';
        arts.cover.backSeed = current.seed || null;
        arts.cover.backVariants = normArr(current.variants);
        arts.cover.backSelectedVariantIndex = current.selectedVariantIndex ?? 0;
        arts.cover.backApprovedAt = node.approvedAt || null;
    }
}

async function persistProject(project) {
    project.markModified('artifacts');
    project.markModified('workflow');
    await project.save();
    return project;
}

function reviewResponse(project) {
    return {
        review: project.artifacts?.review || {},
        workflow: project.workflow || {},
        currentStep: project.currentStep,
        stepsComplete: project.stepsComplete,
        updatedAt: project.updatedAt,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Review bootstrap / get
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/review', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        syncReviewFromArtifacts(project);
        await persistProject(project);
        res.json(reviewResponse(project));
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/bootstrap', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        project.artifacts.review = {
            story: buildStoryReview(project),
            structure: buildStructureReview(project),
            prose: buildProseReview(project),
            humanized: buildHumanizedReview(project),
            illustrations: buildIllustrationReview(project),
            cover: buildCoverReview(project),
        };
        project.workflow = {
            ...(project.workflow || {}),
            mode: getAgeMode(project.ageRange),
            currentStage: project.workflow?.currentStage || 'story',
            stages: {
                story: false,
                structure: false,
                style: false,
                prose: false,
                humanize: false,
                illustrations: false,
                cover: false,
                editor: false,
                layout: false,
                ...(project.workflow?.stages || {}),
            },
        };
        await persistProject(project);
        res.json(reviewResponse(project));
    } catch (e) {
        next(e);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Story review
// ─────────────────────────────────────────────────────────────────────────────

router.patch('/:id/review/story', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);

        const story = review.story || buildStoryReview(project);
        story.versions = pushVersion(story, story.current);

        story.current = {
            ...story.current,
            ...(req.body.current || {}),
            ...(req.body.bookTitle !== undefined ? { bookTitle: req.body.bookTitle } : {}),
            ...(req.body.synopsis !== undefined ? { synopsis: req.body.synopsis } : {}),
            ...(req.body.moral !== undefined ? { moral: req.body.moral } : {}),
            ...(req.body.storyText !== undefined ? { storyText: req.body.storyText } : {}),
            ...(req.body.islamicTheme !== undefined ? { islamicTheme: clone(req.body.islamicTheme) } : {}),
            ...(req.body.dedicationMessage !== undefined ? { dedicationMessage: req.body.dedicationMessage } : {}),
        };

        story.status = 'edited';
        story.updatedAt = nowIso();
        review.story = story;

        if (!project.artifacts.outline) project.artifacts.outline = {};
        project.artifacts.storyText = story.current.storyText || '';
        project.artifacts.outline.bookTitle = story.current.bookTitle || project.title || '';
        project.artifacts.outline.synopsis = story.current.synopsis || '';
        project.artifacts.outline.moral = story.current.moral || '';
        project.artifacts.outline.islamicTheme = clone(story.current.islamicTheme || {});
        project.artifacts.outline.dedicationMessage = story.current.dedicationMessage || '';

        if (story.current.bookTitle && story.current.bookTitle !== project.title) {
            project.title = story.current.bookTitle;
        }

        project.workflow.currentStage = 'story';
        await persistProject(project);

        res.json({ message: 'Story updated', story: review.story });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/story/regenerate', async (req, res, next) => {
    const start = Date.now();
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);

        if (req.body.storyIdea !== undefined) {
            project.artifacts.storyIdea = req.body.storyIdea;
            project.markModified('artifacts');
            await project.save();
        }

        const result = await generateStageText({
            stage: 'story',
            projectId: project._id.toString(),
            userId: req.user._id.toString(),
            storyIdea: req.body.storyIdea || project.artifacts?.storyIdea || project.title,
        });

        const refreshed = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(refreshed);
        review.story = buildStoryReview(refreshed);
        review.story.promptHistory = [
            ...normArr(review.story.promptHistory),
            {
                prompt: result.prompt?.slice(0, 4000) || '',
                provider: result.provider || 'unknown',
                createdAt: nowIso(),
            },
        ].slice(-20);

        refreshed.workflow.currentStage = 'story';
        await persistProject(refreshed);

        logAIUsage({
            userId: req.user._id,
            projectId: refreshed._id,
            provider: result.provider,
            stage: 'review-story-regenerate',
            requestType: 'text',
            tokensIn: result.usage?.inputTokens,
            tokensOut: result.usage?.outputTokens,
            creditsCharged: 0,
            success: true,
            durationMs: Date.now() - start,
        });

        res.json({ message: 'Story regenerated', story: review.story, provider: result.provider, usage: result.usage });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/story/approve', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);

        review.story.status = 'approved';
        review.story.approvedAt = nowIso();
        review.story.updatedAt = nowIso();

        project.workflow.currentStage = 'structure';
        project.workflow.stages.story = true;
        project.stepsComplete.story = true;
        project.currentStep = Math.max(project.currentStep || 1, 2);

        await persistProject(project);
        res.json({ message: 'Story approved', story: review.story, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Structure review
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/review/structure', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        review.structure = buildStructureReview(project);
        await persistProject(project);
        res.json({ structure: review.structure, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/structure/regenerate', async (req, res, next) => {
    const start = Date.now();
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const mode = getAgeMode(project.ageRange);

        const stage = mode === 'chapter-book' ? 'outline' : 'spreadPlanning';

        const result = await generateStageText({
            stage,
            projectId: project._id.toString(),
            userId: req.user._id.toString(),
        });

        const refreshed = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(refreshed);
        review.structure = buildStructureReview(refreshed);

        refreshed.workflow.currentStage = 'structure';
        await persistProject(refreshed);

        logAIUsage({
            userId: req.user._id,
            projectId: refreshed._id,
            provider: result.provider,
            stage: 'review-structure-regenerate',
            requestType: 'text',
            tokensIn: result.usage?.inputTokens,
            tokensOut: result.usage?.outputTokens,
            creditsCharged: 0,
            success: true,
            durationMs: Date.now() - start,
        });

        res.json({ message: 'Structure regenerated', structure: review.structure, provider: result.provider, usage: result.usage });
    } catch (e) {
        next(e);
    }
});

router.patch('/:id/review/structure/:key', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const { items, idx, item } = findReviewStructureItem(review, req.params.key);

        item.versions = pushVersion(item, item.current);
        item.current = {
            ...item.current,
            ...(req.body.current || {}),
        };
        item.status = 'edited';
        item.updatedAt = nowIso();

        items[idx] = item;
        review.structure.items = items;

        syncStructureItemToCore(project, item);
        project.workflow.currentStage = 'structure';

        await persistProject(project);
        res.json({ message: 'Structure item updated', item });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/structure/:key/approve', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const { items, idx, item } = findReviewStructureItem(review, req.params.key);

        item.status = 'approved';
        item.approvedAt = nowIso();
        item.updatedAt = nowIso();
        items[idx] = item;
        review.structure.items = items;

        syncStructureItemToCore(project, item);

        const allApproved = items.length > 0 && items.every(x => x.status === 'approved');
        if (allApproved) {
            project.workflow.stages.structure = true;
            project.stepsComplete.spreads = true;
            project.currentStep = Math.max(project.currentStep || 1, 3);
            project.workflow.currentStage = getAgeMode(project.ageRange) === 'chapter-book' ? 'style' : 'style';
        }

        await persistProject(project);
        res.json({ message: 'Structure item approved', item, allApproved, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Chapter prose review (chapter-book)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/review/chapters/:chapterIndex/prose', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);

        if (getAgeMode(project.ageRange) !== 'chapter-book') {
            throw new ValidationError('Prose review is only for chapter-book mode');
        }

        if (!normArr(review.prose).length) {
            review.prose = buildProseReview(project);
            await persistProject(project);
        }

        const { node } = findReviewChapterNode(review.prose, Number(req.params.chapterIndex));
        res.json({ prose: node, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/chapters/:chapterIndex/prose/regenerate', async (req, res, next) => {
    const start = Date.now();
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        if (getAgeMode(project.ageRange) !== 'chapter-book') {
            throw new ValidationError('Prose generation is only for chapter-book mode');
        }

        const chapterIndex = Number(req.params.chapterIndex);

        // Persist any in-flight edits the client sent before regenerating
        if (req.body.current) {
            const review = syncReviewFromArtifacts(project);
            const existing = normArr(review.prose);
            const eIdx = existing.findIndex(n => Number(n.chapterIndex) === chapterIndex);
            if (eIdx !== -1) {
                existing[eIdx].current = { ...existing[eIdx].current, ...req.body.current };
                existing[eIdx].status = 'edited';
                syncProseNodeToCore(project, existing[eIdx], 'chapters');
                await persistProject(project);
            }
        }

        const result = await generateStageText({
            stage: 'chapter',
            projectId: project._id.toString(),
            userId: req.user._id.toString(),
            chapterIndex,
        });

        const refreshed = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(refreshed);

        // Only update THIS chapter's node — preserve all others
        const freshAll = buildProseReview(refreshed);
        const freshNode = freshAll.find(n => Number(n.chapterIndex) === chapterIndex);
        if (freshNode) {
            review.prose = mergeProseNode(review.prose, freshNode, chapterIndex);
        }

        refreshed.workflow.currentStage = 'prose';
        await persistProject(refreshed);

        const { node } = findReviewChapterNode(review.prose, chapterIndex);

        logAIUsage({
            userId: req.user._id,
            projectId: refreshed._id,
            provider: result.provider,
            stage: 'review-prose-regenerate',
            requestType: 'text',
            tokensIn: result.usage?.inputTokens,
            tokensOut: result.usage?.outputTokens,
            creditsCharged: 0,
            success: true,
            durationMs: Date.now() - start,
        });

        res.json({ message: 'Chapter prose regenerated', prose: node, provider: result.provider, usage: result.usage });
    } catch (e) {
        next(e);
    }
});

router.patch('/:id/review/chapters/:chapterIndex/prose', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        if (getAgeMode(project.ageRange) !== 'chapter-book') {
            throw new ValidationError('Prose review is only for chapter-book mode');
        }

        const review = syncReviewFromArtifacts(project);
        const { arr, idx, node } = findReviewChapterNode(review.prose, Number(req.params.chapterIndex));

        node.versions = pushVersion(node, node.current);
        node.current = {
            ...node.current,
            ...(req.body.current || {}),
            ...(req.body.chapterTitle !== undefined ? { chapterTitle: req.body.chapterTitle } : {}),
            ...(req.body.chapterSummary !== undefined ? { chapterSummary: req.body.chapterSummary } : {}),
            ...(req.body.chapterText !== undefined ? { chapterText: req.body.chapterText } : {}),
            ...(req.body.islamicMoment !== undefined ? { islamicMoment: req.body.islamicMoment } : {}),
            ...(req.body.illustrationMoments !== undefined ? { illustrationMoments: normArr(req.body.illustrationMoments) } : {}),
        };
        node.status = 'edited';
        node.updatedAt = nowIso();

        arr[idx] = node;
        review.prose = arr;

        syncProseNodeToCore(project, node, 'chapters');
        project.workflow.currentStage = 'prose';

        await persistProject(project);
        res.json({ message: 'Chapter prose updated', prose: node });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/chapters/:chapterIndex/prose/humanize', async (req, res, next) => {
    const start = Date.now();
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        if (getAgeMode(project.ageRange) !== 'chapter-book') {
            throw new ValidationError('Humanize prose is only for chapter-book mode');
        }

        const chapterIndex = Number(req.params.chapterIndex);

        // ── Back-fill missing prose nodes before anything else ───────────────────
        const preReview = syncReviewFromArtifacts(project);
        const freshProse = buildProseReview(project);
        const existingProse = normArr(preReview.prose);
        freshProse.forEach(fn => {
            const exists = existingProse.some(n => Number(n.chapterIndex) === Number(fn.chapterIndex));
            if (!exists) existingProse.push(fn);
        });
        preReview.prose = existingProse.sort((a, b) => a.chapterIndex - b.chapterIndex);

        // ── Find the prose node for this chapter ─────────────────────────────────
        const proseNode = preReview.prose.find(n => Number(n.chapterIndex) === chapterIndex);

        if (!proseNode || !proseNode.current?.chapterText) {
            throw new ValidationError(
                `Chapter ${chapterIndex + 1} has no prose yet. Generate prose first before humanizing.`
            );
        }

        // ── Write ORIGINAL AI text (not user-edited) as humanize source ──────────
        // versions[0].snapshot is the raw AI output before any user edits.
        // This guarantees humanize output is meaningfully different from what the user sees.
        const versions = normArr(proseNode.versions);
        const originalText = versions.length > 0
            ? (versions[0].snapshot?.chapterText || proseNode.current.chapterText)
            : proseNode.current.chapterText;

        const arts = project.artifacts || {};
        const chapArr = normArr(arts.chapters);
        if (!chapArr[chapterIndex]) chapArr[chapterIndex] = { chapterNumber: chapterIndex + 1 };

        // Backup what's currently in arts.chapters so we can restore it after
        chapArr[chapterIndex]._editedTextBackup = chapArr[chapterIndex].chapterText;
        chapArr[chapterIndex].chapterText = originalText;
        chapArr[chapterIndex].text = originalText;
        arts.chapters = chapArr;
        project.artifacts = arts;
        project.markModified('artifacts');
        await project.save();

        // ── Run humanize against the original text ───────────────────────────────
        const result = await generateStageText({
            stage: 'humanize',
            projectId: project._id.toString(),
            userId: req.user._id.toString(),
            chapterIndex,
        });

        // ── Reload and sync ──────────────────────────────────────────────────────
        const refreshed = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(refreshed);

        // Back-fill prose nodes in refreshed project too
        const freshProse2 = buildProseReview(refreshed);
        const existingProse2 = normArr(review.prose);
        freshProse2.forEach(fn => {
            const exists = existingProse2.some(n => Number(n.chapterIndex) === Number(fn.chapterIndex));
            if (!exists) existingProse2.push(fn);
        });
        review.prose = existingProse2.sort((a, b) => a.chapterIndex - b.chapterIndex);

        // ── Merge humanized node for this chapter only ───────────────────────────
        const freshHuman = buildHumanizedReview(refreshed);
        const freshNode = freshHuman.find(n => Number(n.chapterIndex) === chapterIndex);
        const humanArr = normArr(review.humanized);

        if (freshNode) {
            const hIdx = humanArr.findIndex(n => Number(n.chapterIndex) === chapterIndex);
            if (hIdx === -1) {
                humanArr.push(freshNode);
            } else {
                humanArr[hIdx] = {
                    ...freshNode,
                    versions: humanArr[hIdx]?.versions || [],
                };
            }
            review.humanized = humanArr;
        }

        // ── Restore user-edited text back to arts.chapters ───────────────────────
        const arts2 = refreshed.artifacts || {};
        const chapArr2 = normArr(arts2.chapters);
        if (chapArr2[chapterIndex] !== undefined) {
            const backup = chapArr2[chapterIndex]._editedTextBackup;
            if (backup !== undefined) {
                chapArr2[chapterIndex].chapterText = backup;
                chapArr2[chapterIndex].text = backup;
            }
            delete chapArr2[chapterIndex]._editedTextBackup;
            arts2.chapters = chapArr2;
            refreshed.artifacts = arts2;
        }

        refreshed.workflow.currentStage = 'humanize';
        await persistProject(refreshed);

        const { node } = findReviewChapterNode(review.humanized, chapterIndex);

        logAIUsage({
            userId: req.user._id,
            projectId: refreshed._id,
            provider: result.provider,
            stage: 'review-prose-humanize',
            requestType: 'text',
            tokensIn: result.usage?.inputTokens,
            tokensOut: result.usage?.outputTokens,
            creditsCharged: 0,
            success: true,
            durationMs: Date.now() - start,
        });

        res.json({
            message: 'Chapter humanized',
            humanized: node,
            provider: result.provider,
            usage: result.usage,
        });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/chapters/:chapterIndex/prose/approve', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);

        const chapterIndex = Number(req.params.chapterIndex);
        const humanizedArr = normArr(review.humanized);
        const hasHumanizedForThisChapter = humanizedArr.some(
            n => Number(n.chapterIndex) === chapterIndex && n.current?.chapterText
        );
        const listKey = hasHumanizedForThisChapter ? 'humanized' : 'prose'; const { arr, idx, node } = findReviewChapterNode(review[listKey], chapterIndex);

        node.status = 'approved';
        node.approvedAt = nowIso();
        node.updatedAt = nowIso();
        arr[idx] = node;
        review[listKey] = arr;

        if (listKey === 'humanized') {
            syncProseNodeToCore(project, {
                ...node,
                current: {
                    chapterNumber: node.current.chapterNumber,
                    chapterTitle: node.current.chapterTitle,
                    chapterSummary: node.current.chapterSummary,
                    chapterText: node.current.chapterText,
                    illustrationMoments: normArr(project.artifacts?.chapters?.[chapterIndex]?.illustrationMoments),
                },
            }, 'humanized');
        } else {
            syncProseNodeToCore(project, node, 'chapters');
        }

        const allApproved = arr.length > 0 && arr.every(x => x.status === 'approved');
        if (allApproved) {
            project.workflow.stages.prose = true;
            project.workflow.currentStage = 'illustrations';
        }

        await persistProject(project);
        res.json({ message: 'Chapter prose approved', prose: node, allApproved, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Illustrations review
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/review/illustrations', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        review.illustrations = buildIllustrationReview(project);
        await persistProject(project);
        res.json({ illustrations: review.illustrations, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

router.patch('/:id/review/illustrations/:key/prompt', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const { nodes, idx, node } = findIllustrationNode(review, req.params.key);

        node.versions = pushVersion(node, node.current);
        node.current = {
            ...node.current,
            ...(req.body.current || {}),
            ...(req.body.prompt !== undefined ? { prompt: req.body.prompt } : {}),
            ...(req.body.illustrationHint !== undefined ? { illustrationHint: req.body.illustrationHint } : {}),
        };
        node.status = 'edited';
        node.updatedAt = nowIso();

        nodes[idx] = node;
        review.illustrations = nodes;
        syncIllustrationNodeToCore(project, node);

        project.workflow.currentStage = 'illustrations';
        await persistProject(project);

        res.json({ message: 'Illustration prompt updated', illustration: node });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/illustrations/:key/regenerate', async (req, res, next) => {
    const start = Date.now();

    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const { nodes, idx, node } = findIllustrationNode(review, req.params.key);

        const variantCount = Math.min(Math.max(Number(req.body.variantCount || 1), 1), 5);
        const costPer = STAGE_CREDIT_COSTS.illustration ?? 4;
        const totalCost = costPer * variantCount;

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

        const ci = Number(node.chapterIndex ?? 0);
        const si = Number(node.spreadIndex ?? 0);
        const basePrompt = str(req.body.prompt || node.current?.prompt || '');

        const arts = project.artifacts || {};
        const humanizedArr = normArr(arts.humanized);
        const chaptersArr = normArr(arts.chapters);
        const illustrationsArr = normArr(arts.illustrations);

        const sourceChapter =
            (humanizedArr[ci]?.chapterText ? humanizedArr[ci] : null) ||
            chaptersArr[ci] ||
            {};

        const sourceMoment =
            normArr(sourceChapter.illustrationMoments)[si] ||
            normArr(sourceChapter.spreads)[si] ||
            {};

        const fallbackProjectCharacters = Array.isArray(project.characterIds)
            ? project.characterIds
                .map((c) => {
                    if (!c) return null;
                    if (typeof c === 'string') return null;
                    return c.name || null;
                })
                .filter(Boolean)
            : [];

        const resolvedCharactersInScene = [
            ...new Set(
                normArr(node.current?.charactersInScene).length
                    ? normArr(node.current.charactersInScene)
                    : normArr(sourceMoment.charactersInScene).length
                        ? normArr(sourceMoment.charactersInScene)
                        : fallbackProjectCharacters
            ),
        ];

        if (!arts.illustrations) arts.illustrations = [];
        if (!illustrationsArr[ci]) {
            illustrationsArr[ci] = {
                chapterNumber: ci + 1,
                spreads: [],
                selectedVariantIndex: 0,
            };
        }

        const illSpreads = normArr(illustrationsArr[ci].spreads);
        illSpreads[si] = {
            ...(illSpreads[si] || {}),
            spreadIndex: si,
            momentTitle: str(node.current?.momentTitle || sourceMoment.momentTitle || `Moment ${si + 1}`),
            illustrationHint: str(node.current?.illustrationHint || sourceMoment.illustrationHint || ''),
            charactersInScene: resolvedCharactersInScene,
            sceneEnvironment: str(node.current?.sceneEnvironment || sourceMoment.sceneEnvironment || 'mixed'),
            timeOfDay: str(node.current?.timeOfDay || sourceMoment.timeOfDay || 'day'),
            prompt: basePrompt || illSpreads[si]?.prompt || '',
        };

        illustrationsArr[ci].spreads = illSpreads;
        arts.illustrations = illustrationsArr;

        const nextIllustrationMoments = normArr(sourceChapter.illustrationMoments);
        nextIllustrationMoments[si] = {
            ...(nextIllustrationMoments[si] || {}),
            momentTitle: str(node.current?.momentTitle || sourceMoment.momentTitle || `Moment ${si + 1}`),
            illustrationHint: str(node.current?.illustrationHint || sourceMoment.illustrationHint || ''),
            charactersInScene: resolvedCharactersInScene,
            sceneEnvironment: str(node.current?.sceneEnvironment || sourceMoment.sceneEnvironment || 'mixed'),
            timeOfDay: str(node.current?.timeOfDay || sourceMoment.timeOfDay || 'day'),
        };

        if (humanizedArr[ci]?.chapterText) {
            humanizedArr[ci] = {
                ...humanizedArr[ci],
                illustrationMoments: nextIllustrationMoments,
            };
            arts.humanized = humanizedArr;
        } else {
            const nextChapter = chaptersArr[ci] || {
                chapterNumber: ci + 1,
                chapterTitle: `Chapter ${ci + 1}`,
            };

            chaptersArr[ci] = {
                ...nextChapter,
                illustrationMoments: nextIllustrationMoments,
            };
            arts.chapters = chaptersArr;
        }

        project.artifacts = arts;
        project.markModified('artifacts');

        // CRITICAL FIX:
        // persist BEFORE generateStageImage so the service reads the correct
        // charactersInScene / illustrationMoment / prompt from DB
        await persistProject(project);

        // Different scene compositions for each variant so users can pick the best one
        const SCENE_COMPOSITIONS = [
            '',  // V0: default — wide establishing shot
            'COMPOSITION VARIANT: Medium shot. Frame the characters at mid-body. Slightly different camera angle from default. Emphasise interaction between characters.',
            'COMPOSITION VARIANT: Close-up emotional shot. Focus tightly on the main character\'s face and upper body. Capture expression and emotion. Warm intimate framing.',
            'COMPOSITION VARIANT: Dynamic perspective. Low-angle or three-quarter dramatic angle. Convey energy, movement, or tension. Full scene depth visible.',
            'COMPOSITION VARIANT: Over-the-shoulder or environmental shot. Show characters small against a rich environment. Emphasise setting and atmosphere.',
        ];

        const variants = [];

        for (let i = 0; i < variantCount; i++) {
            const seed = req.body.seed
                ? Number(req.body.seed) + i * 1000
                : Date.now() + i * 1000;

            const compositionDirective = SCENE_COMPOSITIONS[i] || '';

            const result = await generateStageImage({
                task: 'illustration',
                chapterIndex: ci,
                spreadIndex: si,
                projectId: project._id.toString(),
                userId: req.user._id.toString(),
                customPrompt: basePrompt || undefined,
                seed,
                style: req.body.style,
                compositionDirective,
                traceId: `review_ill_${project._id}_${req.params.key}_v${i}_${Date.now()}`,
            });

            variants.push({
                variantIndex: i,
                imageUrl: result.imageUrl,
                prompt: result.prompt || basePrompt,
                seed,
                selected: i === 0,
                provider: result.provider || 'unknown',
            });
        }

        node.versions = pushVersion(node, node.current);
        node.current = {
            ...node.current,
            momentTitle: str(node.current?.momentTitle || sourceMoment.momentTitle || `Moment ${si + 1}`),
            illustrationHint: str(node.current?.illustrationHint || sourceMoment.illustrationHint || ''),
            charactersInScene: resolvedCharactersInScene,
            sceneEnvironment: str(node.current?.sceneEnvironment || sourceMoment.sceneEnvironment || 'mixed'),
            timeOfDay: str(node.current?.timeOfDay || sourceMoment.timeOfDay || 'day'),
            imageUrl: variants[0]?.imageUrl || '',
            prompt: variants[0]?.prompt || basePrompt || '',
            seed: variants[0]?.seed || null,
            variants,
            selectedVariantIndex: 0,
        };
        node.status = 'generated';
        node.updatedAt = nowIso();

        nodes[idx] = node;
        review.illustrations = nodes;

        syncIllustrationNodeToCore(project, node);

        await persistProject(project);
        await deductCredits(
            req.user._id,
            totalCost,
            `Review illustration: ${req.params.key}`,
            'project',
            project._id
        );

        logAIUsage({
            userId: req.user._id,
            projectId: project._id,
            provider: variants[0]?.provider || 'unknown',
            stage: 'review-illustration-regenerate',
            requestType: 'image',
            creditsCharged: totalCost,
            success: true,
            durationMs: Date.now() - start,
        });

        res.json({
            message: 'Illustration variants generated',
            illustration: node,
            variants,
            creditsCharged: totalCost,
            charactersInScene: resolvedCharactersInScene,
        });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/illustrations/:key/select-variant', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const { nodes, idx, node } = findIllustrationNode(review, req.params.key);

        const variantIndex = Number(req.body.variantIndex);
        const variants = normArr(node.current?.variants);
        const chosen = variants[variantIndex];

        if (!chosen) throw new ValidationError(`Variant ${variantIndex} not found`);

        node.current = {
            ...node.current,
            selectedVariantIndex: variantIndex,
            imageUrl: chosen.imageUrl,
            prompt: chosen.prompt || node.current.prompt || '',
            seed: chosen.seed || node.current.seed || null,
            variants: variants.map((v, i) => ({ ...v, selected: i === variantIndex })),
        };
        node.status = 'edited';
        node.updatedAt = nowIso();

        nodes[idx] = node;
        review.illustrations = nodes;
        syncIllustrationNodeToCore(project, node);

        await persistProject(project);
        res.json({ message: 'Illustration variant selected', illustration: node });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/illustrations/:key/approve', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const { nodes, idx, node } = findIllustrationNode(review, req.params.key);

        node.status = 'approved';
        node.approvedAt = nowIso();
        node.updatedAt = nowIso();

        nodes[idx] = node;
        review.illustrations = nodes;
        syncIllustrationNodeToCore(project, node);

        const allApproved = nodes.length > 0 && nodes.every(x => x.status === 'approved');
        if (allApproved) {
            project.workflow.stages.illustrations = true;
            project.workflow.currentStage = 'cover';
            project.stepsComplete.images = true;
            project.currentStep = Math.max(project.currentStep || 1, 5);
        }

        await persistProject(project);
        res.json({ message: 'Illustration approved', illustration: node, allApproved, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cover review
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/review/cover', async (req, res, next) => {
    try {
        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        review.cover = buildCoverReview(project);
        await persistProject(project);
        res.json({ cover: review.cover, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

router.patch('/:id/review/cover/:side/prompt', async (req, res, next) => {
    try {
        const side = req.params.side;
        if (!['front', 'back'].includes(side)) throw new ValidationError('side must be front or back');

        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const node = review.cover?.[side];

        if (!node) throw new NotFoundError(`Cover review not found for ${side}`);

        node.versions = pushVersion(node, node.current);
        node.current = {
            ...node.current,
            ...(req.body.current || {}),
            ...(req.body.prompt !== undefined ? { prompt: req.body.prompt } : {}),
        };
        node.status = 'edited';
        node.updatedAt = nowIso();

        syncCoverNodeToCore(project, side, node);
        project.workflow.currentStage = 'cover';

        await persistProject(project);
        res.json({ message: 'Cover prompt updated', cover: node });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/cover/:side/regenerate', async (req, res, next) => {
    const start = Date.now();
    try {
        const side = req.params.side;
        if (!['front', 'back'].includes(side)) throw new ValidationError('side must be front or back');

        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const node = review.cover?.[side];

        if (!node) throw new NotFoundError(`Cover review not found for ${side}`);

        const variantCount = Math.min(Math.max(Number(req.body.variantCount || 1), 1), 5);
        const costPer = STAGE_CREDIT_COSTS.illustration ?? 4;
        const totalCost = costPer * variantCount;

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

        const task = side === 'front' ? 'cover' : 'back-cover';

        const variants = [];

        for (let i = 0; i < variantCount; i++) {
            const seed = req.body.seed ? Number(req.body.seed) + i * 1000 : Date.now() + i * 1000;

            const result = await generateStageImage({
                task,
                projectId: project._id.toString(),
                userId: req.user._id.toString(),
                customPrompt: basePrompt || undefined,
                seed,
                style: req.body.style,
                traceId: `review_cover_${side}_${project._id}_v${i}_${Date.now()}`,
            });

            variants.push({
                variantIndex: i,
                imageUrl: result.imageUrl,
                prompt: result.prompt || basePrompt,
                seed,
                selected: i === 0,
                provider: result.provider || 'unknown',
            });
        }

        node.versions = pushVersion(node, node.current);
        node.current = {
            ...node.current,
            imageUrl: variants[0]?.imageUrl || '',
            prompt: variants[0]?.prompt || basePrompt || '',
            seed: variants[0]?.seed || null,
            variants,
            selectedVariantIndex: 0,
        };
        node.status = 'generated';
        node.updatedAt = nowIso();

        syncCoverNodeToCore(project, side, node);
        project.workflow.currentStage = 'cover';

        await persistProject(project);
        await deductCredits(req.user._id, totalCost, `Review cover: ${side}`, 'project', project._id);

        logAIUsage({
            userId: req.user._id,
            projectId: project._id,
            provider: variants[0]?.provider || 'unknown',
            stage: `review-cover-${side}-regenerate`,
            requestType: 'image',
            creditsCharged: totalCost,
            success: true,
            durationMs: Date.now() - start,
        });

        res.json({ message: 'Cover variants generated', cover: node, variants, creditsCharged: totalCost });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/cover/:side/select-variant', async (req, res, next) => {
    try {
        const side = req.params.side;
        if (!['front', 'back'].includes(side)) throw new ValidationError('side must be front or back');

        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const node = review.cover?.[side];

        if (!node) throw new NotFoundError(`Cover review not found for ${side}`);

        const variantIndex = Number(req.body.variantIndex);
        const variants = normArr(node.current?.variants);
        const chosen = variants[variantIndex];
        if (!chosen) throw new ValidationError(`Variant ${variantIndex} not found`);

        node.current = {
            ...node.current,
            selectedVariantIndex: variantIndex,
            imageUrl: chosen.imageUrl,
            prompt: chosen.prompt || node.current.prompt || '',
            seed: chosen.seed || node.current.seed || null,
            variants: variants.map((v, i) => ({ ...v, selected: i === variantIndex })),
        };
        node.status = 'edited';
        node.updatedAt = nowIso();

        syncCoverNodeToCore(project, side, node);
        await persistProject(project);

        res.json({ message: 'Cover variant selected', cover: node });
    } catch (e) {
        next(e);
    }
});

router.post('/:id/review/cover/:side/approve', async (req, res, next) => {
    try {
        const side = req.params.side;
        if (!['front', 'back'].includes(side)) throw new ValidationError('side must be front or back');

        const project = await getProjectForUser(req.params.id, req.user._id);
        const review = syncReviewFromArtifacts(project);
        const node = review.cover?.[side];

        if (!node) throw new NotFoundError(`Cover review not found for ${side}`);

        node.status = 'approved';
        node.approvedAt = nowIso();
        node.updatedAt = nowIso();

        syncCoverNodeToCore(project, side, node);

        const frontApproved = review.cover?.front?.status === 'approved' || (side === 'front' && node.status === 'approved');
        const backApproved = review.cover?.back?.status === 'approved' || (side === 'back' && node.status === 'approved');

        if (frontApproved && backApproved) {
            project.workflow.stages.cover = true;
            project.workflow.currentStage = 'editor';
        }

        await persistProject(project);
        res.json({ message: 'Cover approved', cover: node, workflow: project.workflow });
    } catch (e) {
        next(e);
    }
});

export default router;