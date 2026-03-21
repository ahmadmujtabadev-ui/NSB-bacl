// server/services/ai/text/text.service.js
//
// PRODUCTION-READY
// Fixes:
// 1) Canonical character-name normalization against approved DB characters
// 2) Strict normalized spread/chapter/illustration-moment shapes
// 3) picture-book uses charactersInScene everywhere (not charactersInSpread)
// 4) humanize preserves chapter-book illustrationMoments and islamic metadata
// 5) spread rerun source selection fixed
// 6) outline/story output normalized before save
// 7) continuity metadata added for image stage
// 8) chapter-book illustration moments normalized to max 2 for age 9+
// 9) safer merge behavior during reruns/humanize
// 10) prompt contract aligned with image.service.js

import { Project } from '../../../models/Project.js';
import { Universe } from '../../../models/Universe.js';
import { Character } from '../../../models/Character.js';
import { KnowledgeBase } from '../../../models/KnowledgeBase.js';
import { NotFoundError } from '../../../errors.js';
import { generateText } from './text.providers.js';
import { AI_TOKEN_BUDGETS, estimateTokens } from '../policies/tokenBudget.js';

// ─── Age routing — single source of truth ─────────────────────────────────────

export function getAgeProfile(ageRange) {
  const nums = String(ageRange || '').match(/\d+/g) || [];
  const first = Number(nums[0] || 8);
  const last = Number(nums[1] || first);
  const avg = (first + last) / 2;

  if (first <= 5) {
    return {
      mode: 'spreads-only',
      spreadOnly: true,
      chapterProse: false,
      rhyme: true,
      maxWords: 10,
      minWords: 0,
      minChapterWords: 0,
      maxChapterWords: 0,
      illustrationsPerChapter: 0,
      spreadsPerChapter: 0,
      sentenceStyle: 'simple-complete',
    };
  }

  if (avg <= 8) {
    return {
      mode: 'picture-book',
      spreadOnly: false,
      chapterProse: false,
      rhyme: false,
      maxWords: 24,
      minWords: 0,
      minChapterWords: 0,
      maxChapterWords: 0,
      illustrationsPerChapter: 2,
      spreadsPerChapter: 2,
      sentenceStyle: 'simple-narrative',
    };
  }

  return {
    mode: 'chapter-book',
    spreadOnly: false,
    chapterProse: true,
    rhyme: false,
    maxWords: 0,
    minWords: 0,
    minChapterWords: 900,
    maxChapterWords: 1400,
    illustrationsPerChapter: 2,
    spreadsPerChapter: 0,
    sentenceStyle: 'rich-novelistic',
  };
}

export function isPictureBook(ageRange) {
  const p = getAgeProfile(ageRange);
  return p.mode === 'picture-book' || p.mode === 'spreads-only';
}

export function isSpreadOnlyMode(ageRange) {
  return getAgeProfile(ageRange).mode === 'spreads-only';
}

export function getTextLimit(ageRange) {
  const p = getAgeProfile(ageRange);
  return {
    maxWords: p.maxWords,
    minChapterWords: p.minChapterWords,
    maxChapterWords: p.maxChapterWords,
    sentences: p.chapterProse ? 0 : 2,
    rhyme: p.rhyme,
    spreadOnly: p.spreadOnly,
    chapterProse: p.chapterProse,
  };
}

// ─── Array helpers ────────────────────────────────────────────────────────────

export function normArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val].filter(v => v != null);
  const keys = Object.keys(val).map(Number).filter(n => !Number.isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = val[k]; });
  return arr.filter(v => v != null);
}

function str(val) {
  if (val == null) return '';
  return String(val).trim();
}

function lc(val) {
  return str(val).toLowerCase();
}

function clampTextWords(text, maxWords) {
  const clean = str(text).replace(/\s+/g, ' ').trim();
  if (!clean || !maxWords || maxWords <= 0) return clean;
  const words = clean.split(' ');
  if (words.length <= maxWords) return clean;
  return words.slice(0, maxWords).join(' ').replace(/[,:;-\s]+$/, '').trim() + '.';
}

function ensureSentence(text) {
  const t = str(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/[.!?]$/.test(t)) return t;
  return `${t}.`;
}

function pickEnum(value, allowed, fallback) {
  const v = str(value);
  return allowed.includes(v) ? v : fallback;
}

function uniqStrings(arr) {
  return [...new Set(normArr(arr).map(str).filter(Boolean))];
}

function stripFences(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function safeParse(text) {
  if (!text) return { ok: false, data: { raw: text } };

  const clean = stripFences(text);

  try {
    const parsed = JSON.parse(clean);
    return { ok: true, data: parsed };
  } catch (_) {}

  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const slice = clean.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(slice);
      console.warn('[TextService] JSON recovered via brace-slicing');
      return { ok: true, data: parsed };
    } catch (_) {}
  }

  if (firstBrace !== -1) {
    try {
      let partial = clean.slice(firstBrace);
      let openBraces = 0;
      let openBrackets = 0;
      let inString = false;
      let escaped = false;

      for (const ch of partial) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++;
        if (ch === ']') openBrackets--;
      }

      if (inString) partial += '"...(truncated)"';
      while (openBrackets > 0) { partial += ']'; openBrackets--; }
      while (openBraces > 0) { partial += '}'; openBraces--; }

      const parsed = JSON.parse(partial);
      console.warn('[TextService] JSON recovered by closing truncated structure');
      return { ok: true, data: parsed };
    } catch (_) {}
  }

  console.error('[TextService] All JSON parse attempts failed');
  console.error('[TextService] Raw preview:', text?.slice(0, 400));
  return { ok: false, data: { raw: text } };
}

// ─── Arabic safety block ──────────────────────────────────────────────────────

const ARABIC_PHRASES = {
  bismillah:        { arabic: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', transliteration: 'Bismillah ir-Rahman ir-Raheem', meaning: 'In the name of Allah, the Most Gracious, the Most Merciful' },
  alhamdulillah:    { arabic: 'الْحَمْدُ لِلَّهِ', transliteration: 'Alhamdulillah', meaning: 'All praise is for Allah' },
  subhanallah:      { arabic: 'سُبْحَانَ اللَّهِ', transliteration: 'SubhanAllah', meaning: 'Glory be to Allah' },
  allahu_akbar:     { arabic: 'اللَّهُ أَكْبَرُ', transliteration: 'Allahu Akbar', meaning: 'Allah is the Greatest' },
  inshallah:        { arabic: 'إِنْ شَاءَ اللَّهُ', transliteration: "In sha' Allah", meaning: 'If Allah wills' },
  mashallah:        { arabic: 'مَا شَاءَ اللَّهُ', transliteration: "Masha' Allah", meaning: 'What Allah has willed' },
  assalamu_alaykum: { arabic: 'السَّلَامُ عَلَيْكُمْ', transliteration: 'Assalamu Alaykum', meaning: 'Peace be upon you' },
  jazakallah_khair: { arabic: 'جَزَاكَ اللَّهُ خَيْرًا', transliteration: 'Jazakallah Khair', meaning: 'May Allah reward you with goodness' },
  astaghfirullah:   { arabic: 'أَسْتَغْفِرُ اللَّهَ', transliteration: 'Astaghfirullah', meaning: 'I seek forgiveness from Allah' },
  sabr:             { arabic: 'صَبْر', transliteration: 'Sabr', meaning: 'Patience' },
  tawakkul:         { arabic: 'تَوَكُّل', transliteration: 'Tawakkul', meaning: 'Trust in Allah' },
  shukr:            { arabic: 'شُكْر', transliteration: 'Shukr', meaning: 'Gratitude' },
};

function buildArabicBlock() {
  const list = Object.values(ARABIC_PHRASES)
    .map(p => `  • ${p.transliteration}: "${p.arabic}" — ${p.meaning}`)
    .join('\n');

  return `
ARABIC RULES (CRITICAL — violations break the book):
1. NEVER generate Arabic script yourself
2. ONLY use exact Unicode strings from this approved list:
${list}
3. If phrase is NOT in the list, use ONLY the transliteration
4. Always return: { arabic, transliteration, meaning } as separate fields`;
}

// ─── Context helpers ──────────────────────────────────────────────────────────

function universeBlock(universe) {
  if (!universe) return '';
  return `UNIVERSE: ${universe.name}
Description: ${universe.description || 'Islamic family stories'}
Art style: ${universe.artStyle || 'Pixar 3D animation'}`;
}

function kbBlock(kb) {
  if (!kb) return '';
  return `KNOWLEDGE BASE: ${kb.name}
Islamic Values: ${(kb.islamicValues || []).join(', ')}
Avoid Topics: ${(kb.avoidTopics || []).join(', ')}
Illustration Rules: ${(kb.illustrationRules || []).join('; ')}`;
}

function characterBlock(characters) {
  if (!characters?.length) return 'No specific approved characters defined.';
  return `APPROVED CHARACTERS (use ONLY these exact names):
${characters.map(c => {
  const vd = c.visualDNA || {};
  const mod = c.modestyRules || {};
  return `  • ${c.name} — ${c.role}, age ${c.ageRange}, ${vd.gender || 'child'}
    Traits: ${(c.traits || []).join(', ')}
    Speech: ${c.speakingStyle || c.speechStyle || 'warm and kind'}
    ${mod.hijabAlways ? 'ALWAYS wears hijab' : ''}
    ${mod.looseClothing ? 'Always modestly dressed' : ''}`;
}).join('\n')}
RULES:
- Use ONLY exact names from this list
- Do NOT invent new people
- Do NOT say "a friend", "mother", "grandma", "the girl", or "the boy" unless that exact label is an approved character name
- Always return character references using approved character names only`;
}

// ─── Context loader ───────────────────────────────────────────────────────────

export async function buildUniverseContext(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new NotFoundError('Project not found');

  const [universe, kb] = await Promise.all([
    project.universeId ? Universe.findById(project.universeId) : null,
    project.knowledgeBaseId ? KnowledgeBase.findById(project.knowledgeBaseId) : null,
  ]);

  let characters = [];
  if (project.characterIds?.length) {
    characters = await Character.find({ _id: { $in: project.characterIds } });
  } else if (project.universeId) {
    characters = await Character.find({ universeId: project.universeId });
  }

  return { project, universe, characters, kb };
}

// ─── Canonical character normalization ────────────────────────────────────────

function buildApprovedCharacterMaps(characters = []) {
  const byExact = new Map();
  const byLower = new Map();

  for (const c of characters) {
    const name = str(c.name);
    if (!name) continue;
    byExact.set(name, name);
    byLower.set(name.toLowerCase(), name);
  }

  return { byExact, byLower };
}

function canonicalizeCharacterName(name, characters = []) {
  const raw = str(name);
  if (!raw) return '';

  const { byExact, byLower } = buildApprovedCharacterMaps(characters);
  if (byExact.has(raw)) return byExact.get(raw);
  if (byLower.has(raw.toLowerCase())) return byLower.get(raw.toLowerCase());

  const normalized = raw
    .replace(/\b(the|a|an)\b/gi, '')
    .replace(/\bmother\b/gi, '')
    .replace(/\bgrandmother\b/gi, '')
    .replace(/\bgrandma\b/gi, '')
    .replace(/\bbrother\b/gi, '')
    .replace(/\bsister\b/gi, '')
    .replace(/\bfriend\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (byLower.has(normalized)) return byLower.get(normalized);

  return '';
}

function canonicalizeCharacterList(list, characters = []) {
  return uniqStrings(
    normArr(list)
      .map(name => canonicalizeCharacterName(name, characters))
      .filter(Boolean)
  );
}

function normalizeCharacterEmotionMap(map, sceneNames, characters = []) {
  const out = {};
  const raw = map && typeof map === 'object' ? map : {};
  for (const [k, v] of Object.entries(raw)) {
    const canon = canonicalizeCharacterName(k, characters);
    if (!canon || (sceneNames.length && !sceneNames.includes(canon))) continue;
    out[canon] = str(v) || 'neutral';
  }

  for (const n of sceneNames) {
    if (!out[n]) out[n] = 'neutral';
  }

  return out;
}

function chooseSceneCharactersFallback(characters = [], requested = []) {
  const names = canonicalizeCharacterList(requested, characters);
  if (names.length) return names;
  if (characters.length === 1) return [characters[0].name];
  return [];
}

// ─── Structured normalization helpers ─────────────────────────────────────────

const ENV_VALUES = ['indoor', 'outdoor', 'mixed'];
const TIME_VALUES = ['morning', 'afternoon', 'evening', 'night'];
const TEXT_POS_VALUES = ['bottom', 'top', 'overlay-bottom', 'overlay-top'];
const CAMERA_VALUES = ['wide', 'medium', 'close', 'over-shoulder', 'full-body'];

const DEFAULT_POSE_KEYS = [
  'standing',
  'sitting',
  'walking',
  'running',
  'waving',
  'thinking',
  'reading-quran',
  'praying-salah',
  'laughing',
  'sad',
  'surprised',
  'kneeling',
];

function normalizePoseKey(v) {
  const raw = lc(v).replace(/\s+/g, '-');
  if (!raw) return '';
  if (DEFAULT_POSE_KEYS.includes(raw)) return raw;
  if (raw.includes('read')) return 'reading-quran';
  if (raw.includes('pray')) return 'praying-salah';
  if (raw.includes('walk')) return 'walking';
  if (raw.includes('run')) return 'running';
  if (raw.includes('think')) return 'thinking';
  if (raw.includes('sit')) return 'sitting';
  if (raw.includes('stand')) return 'standing';
  if (raw.includes('wave')) return 'waving';
  if (raw.includes('laugh')) return 'laughing';
  if (raw.includes('sad')) return 'sad';
  if (raw.includes('surpris')) return 'surprised';
  if (raw.includes('kneel')) return 'kneeling';
  return '';
}

function normalizeIllustrationMoment(moment, idx, characters = [], fallback = {}) {
  const raw = typeof moment === 'string'
    ? { illustrationHint: moment }
    : (moment && typeof moment === 'object' ? moment : {});

  const chars = chooseSceneCharactersFallback(
    characters,
    raw.charactersInScene || raw.characters || fallback.charactersInScene || []
  );

  return {
    momentTitle: str(raw.momentTitle || raw.title || `Moment ${idx + 1}`),
    illustrationHint: str(raw.illustrationHint || raw.scene || raw.text || fallback.illustrationHint || 'Important emotional chapter moment'),
    charactersInScene: chars,
    poseKey: normalizePoseKey(raw.poseKey || raw.action || ''),
    characterEmotion: normalizeCharacterEmotionMap(raw.characterEmotion, chars, characters),
    sceneEnvironment: pickEnum(str(raw.sceneEnvironment || fallback.sceneEnvironment), ENV_VALUES, 'mixed'),
    timeOfDay: pickEnum(str(raw.timeOfDay || fallback.timeOfDay), TIME_VALUES, 'day'),
    continuityNotes: str(raw.continuityNotes || fallback.continuityNotes || ''),
    cameraHint: pickEnum(str(raw.cameraHint || fallback.cameraHint), CAMERA_VALUES, 'medium'),
  };
}

function normalizeSpread(spread, idx, profile, characters = [], fallback = {}) {
  const raw = spread && typeof spread === 'object' ? spread : {};
  const chars = chooseSceneCharactersFallback(
    characters,
    raw.charactersInScene ||
      raw.charactersInSpread ||
      raw.characters ||
      fallback.charactersInScene ||
      []
  );

  const maxWords = profile.maxWords || 24;
  const normalizedText = profile.chapterProse
    ? str(raw.text || fallback.text || '')
    : ensureSentence(clampTextWords(raw.text || fallback.text || '', maxWords));

  return {
    spreadIndex: Number.isFinite(Number(raw.spreadIndex)) ? Number(raw.spreadIndex) : idx,
    text: normalizedText,
    prompt: str(raw.prompt || fallback.prompt || ''),
    illustrationHint: str(raw.illustrationHint || raw.sceneDescription || fallback.illustrationHint || ''),
    charactersInScene: chars,
    poseKey: normalizePoseKey(raw.poseKey || raw.action || ''),
    characterEmotion: normalizeCharacterEmotionMap(raw.characterEmotion, chars, characters),
    sceneEnvironment: pickEnum(str(raw.sceneEnvironment || fallback.sceneEnvironment), ENV_VALUES, 'indoor'),
    timeOfDay: pickEnum(str(raw.timeOfDay || fallback.timeOfDay), TIME_VALUES, 'morning'),
    textPosition: pickEnum(str(raw.textPosition || fallback.textPosition), TEXT_POS_VALUES, 'bottom'),
    islamicElement: raw.islamicElement == null ? null : str(raw.islamicElement),
    continuityNotes: str(raw.continuityNotes || fallback.continuityNotes || ''),
    cameraHint: pickEnum(str(raw.cameraHint || fallback.cameraHint), CAMERA_VALUES, 'medium'),
  };
}

function normalizeOutlineChapter(ch, idx, characters = [], profile) {
  const raw = ch && typeof ch === 'object' ? ch : {};
  const chars = chooseSceneCharactersFallback(characters, raw.charactersInScene || raw.characters || []);
  const moments = normArr(raw.illustrationMoments).slice(0, profile.chapterProse ? 2 : 2)
    .map((m, i) => normalizeIllustrationMoment(m, i, characters, {
      charactersInScene: chars,
      sceneEnvironment: 'mixed',
      timeOfDay: i === 0 ? 'day' : 'evening',
    }));

  return {
    chapterNumber: Number(raw.chapterNumber) || idx + 1,
    title: str(raw.title || raw.chapterTitle || `Chapter ${idx + 1}`),
    goal: str(raw.goal || ''),
    keyScene: str(raw.keyScene || moments[0]?.illustrationHint || ''),
    duaHint: str(raw.duaHint || raw.islamicMoment || ''),
    endingBeat: str(raw.endingBeat || ''),
    charactersInScene: chars,
    illustrationMoments: moments,
  };
}

function normalizeStoryPayload(parsed, ctx) {
  const profile = getAgeProfile(ctx.project.ageRange);
  const chapterCount = Number(ctx.project.chapterCount) || (profile.mode === 'chapter-book' ? 4 : 3);

  const out = {
    bookTitle: str(parsed.bookTitle || ctx.project.title),
    synopsis: str(parsed.synopsis || ''),
    moral: str(parsed.moral || ctx.project.learningObjective || ''),
    storyText: str(parsed.storyText || ''),
    spreadOnly: !!parsed.spreadOnly || profile.spreadOnly,
    islamicTheme: parsed.islamicTheme && typeof parsed.islamicTheme === 'object'
      ? {
          concept: str(parsed.islamicTheme.concept || ''),
          arabicPhrase: str(parsed.islamicTheme.arabicPhrase || ''),
          transliteration: str(parsed.islamicTheme.transliteration || ''),
          meaning: str(parsed.islamicTheme.meaning || ''),
        }
      : null,
    dedicationMessage: str(parsed.dedicationMessage || ''),
    characters: normArr(parsed.characters).map((c, i) => {
      const name = canonicalizeCharacterName(c?.name, ctx.characters) || str(c?.name || `Character ${i + 1}`);
      return {
        name,
        role: str(c?.role || 'supporting'),
        ageRange: str(c?.ageRange || ''),
        gender: str(c?.gender || ''),
        keyTraits: uniqStrings(c?.keyTraits || []),
      };
    }),
    chapterOutline: [],
  };

  const rawChapters = normArr(parsed.chapterOutline || parsed.chapters);
  if (profile.mode === 'chapter-book' || profile.mode === 'picture-book') {
    const source = rawChapters.length
      ? rawChapters.slice(0, chapterCount)
      : Array.from({ length: chapterCount }, (_, i) => ({ chapterNumber: i + 1 }));

    out.chapterOutline = source.map((ch, i) => normalizeOutlineChapter(ch, i, ctx.characters, profile));
  }

  return out;
}

function normalizeOutlinePayload(parsed, ctx) {
  const profile = getAgeProfile(ctx.project.ageRange);
  const count = Number(ctx.project.chapterCount) || (profile.spreadOnly ? 10 : 4);

  if (profile.spreadOnly) {
    return {
      bookTitle: str(parsed.bookTitle || ctx.project.title),
      moral: str(parsed.moral || ctx.project.learningObjective || ''),
      synopsis: str(parsed.synopsis || ''),
      spreadOnly: true,
      totalSpreads: Number(parsed.totalSpreads) || count,
      dedicationMessage: str(parsed.dedicationMessage || ''),
      islamicTheme: parsed.islamicTheme && typeof parsed.islamicTheme === 'object'
        ? {
            title: str(parsed.islamicTheme.title || ''),
            arabicPhrase: str(parsed.islamicTheme.arabicPhrase || ''),
            transliteration: str(parsed.islamicTheme.transliteration || ''),
            meaning: str(parsed.islamicTheme.meaning || ''),
            reference: str(parsed.islamicTheme.reference || ''),
            referenceText: str(parsed.islamicTheme.referenceText || ''),
            whyWeDoIt: str(parsed.islamicTheme.whyWeDoIt || ''),
          }
        : null,
      spreads: normArr(parsed.spreads).slice(0, count).map((s, i) => ({
        spreadIndex: i,
        sceneDescription: str(s?.sceneDescription || s?.illustrationHint || ''),
        illustrationHint: str(s?.illustrationHint || s?.sceneDescription || ''),
        textHint: str(s?.textHint || ''),
        islamicValue: str(s?.islamicValue || ''),
      })),
    };
  }

  const chapterCount = Number(parsed.chapterCount) || Number(ctx.project.chapterCount) || 4;
  const rawChapters = normArr(parsed.chapters).slice(0, chapterCount);
  const padded = rawChapters.length
    ? rawChapters
    : Array.from({ length: chapterCount }, (_, i) => ({ chapterNumber: i + 1 }));

  return {
    bookTitle: str(parsed.bookTitle || ctx.project.title),
    moral: str(parsed.moral || ctx.project.learningObjective || ''),
    synopsis: str(parsed.synopsis || ''),
    spreadOnly: false,
    chapterCount,
    dedicationMessage: str(parsed.dedicationMessage || ''),
    islamicTheme: parsed.islamicTheme && typeof parsed.islamicTheme === 'object'
      ? {
          title: str(parsed.islamicTheme.title || ''),
          arabicPhrase: str(parsed.islamicTheme.arabicPhrase || ''),
          transliteration: str(parsed.islamicTheme.transliteration || ''),
          meaning: str(parsed.islamicTheme.meaning || ''),
          reference: str(parsed.islamicTheme.reference || ''),
          referenceText: str(parsed.islamicTheme.referenceText || ''),
          whyWeDoIt: str(parsed.islamicTheme.whyWeDoIt || ''),
        }
      : null,
    chapters: padded.map((ch, i) => normalizeOutlineChapter(ch, i, ctx.characters, profile)),
  };
}

function normalizeSpreadPlanningPayload(parsed, ctx) {
  const profile = getAgeProfile(ctx.project.ageRange);
  const spreadCount = Number(parsed.totalSpreads) || Number(ctx.project.chapterCount) || 10;
  const source = normArr(parsed.spreads).slice(0, spreadCount);
  const spreads = source.map((s, i) => normalizeSpread(s, i, profile, ctx.characters));

  return {
    spreadOnly: profile.spreadOnly,
    totalSpreads: spreadCount,
    spreads,
  };
}

function normalizePictureBookChapterPayload(parsed, ctx, chapterIndex) {
  const profile = getAgeProfile(ctx.project.ageRange);
  const spreads = normArr(parsed.spreads).slice(0, profile.spreadsPerChapter || 2)
    .map((s, i) => normalizeSpread(s, i, profile, ctx.characters));

  return {
    chapterNumber: Number(parsed.chapterNumber) || chapterIndex + 1,
    chapterTitle: str(parsed.chapterTitle || `Chapter ${chapterIndex + 1}`),
    islamicMoment: str(parsed.islamicMoment || ''),
    chapterSummary: str(parsed.chapterSummary || ''),
    prompt: str(parsed.prompt || ''),
    spreads,
    text: str(parsed.text || ''),
    chapterIllustrationHint: str(
      parsed.chapterIllustrationHint ||
      spreads[0]?.illustrationHint ||
      ''
    ),
  };
}

function normalizeChapterBookPayload(parsed, ctx, chapterIndex) {
  const profile = getAgeProfile(ctx.project.ageRange);
  const moments = normArr(parsed.illustrationMoments)
    .slice(0, profile.illustrationsPerChapter || 2)
    .map((m, i) => normalizeIllustrationMoment(m, i, ctx.characters));

  return {
    chapterNumber: Number(parsed.chapterNumber) || chapterIndex + 1,
    chapterTitle: str(parsed.chapterTitle || `Chapter ${chapterIndex + 1}`),
    islamicMoment: str(parsed.islamicMoment || ''),
    chapterSummary: str(parsed.chapterSummary || ''),
    chapterText: str(parsed.chapterText || ''),
    illustrationMoments: moments,
    prompt: str(parsed.prompt || ''),
    spreads: [],
    text: str(parsed.chapterText || ''),
    chapterIllustrationHint: str(
      parsed.chapterIllustrationHint ||
      moments[0]?.illustrationHint ||
      ''
    ),
  };
}

function normalizeHumanizedPictureBookPayload(parsed, ctx, chapterIndex, fallbackChapter = {}) {
  const profile = getAgeProfile(ctx.project.ageRange);
  const spreads = normArr(parsed.spreads).map((s, i) =>
    normalizeSpread(
      s,
      i,
      profile,
      ctx.characters,
      normArr(fallbackChapter.spreads)[i] || {}
    )
  );

  return {
    chapterNumber: Number(parsed.chapterNumber) || fallbackChapter.chapterNumber || chapterIndex + 1,
    chapterTitle: str(parsed.chapterTitle || fallbackChapter.chapterTitle || `Chapter ${chapterIndex + 1}`),
    spreads,
    text: str(parsed.text || fallbackChapter.text || ''),
    chapterSummary: str(parsed.chapterSummary || fallbackChapter.chapterSummary || ''),
    islamicMoment: str(parsed.islamicMoment || fallbackChapter.islamicMoment || ''),
    chapterIllustrationHint: str(
      parsed.chapterIllustrationHint ||
      fallbackChapter.chapterIllustrationHint ||
      spreads[0]?.illustrationHint ||
      ''
    ),
    changesMade: uniqStrings(parsed.changesMade || []),
  };
}

function normalizeHumanizedChapterBookPayload(parsed, ctx, chapterIndex, fallbackChapter = {}) {
  const profile = getAgeProfile(ctx.project.ageRange);
  const fallbackMoments = normArr(fallbackChapter.illustrationMoments);
  const sourceMoments = normArr(parsed.illustrationMoments);
  const moments = (sourceMoments.length ? sourceMoments : fallbackMoments)
    .slice(0, profile.illustrationsPerChapter || 2)
    .map((m, i) => normalizeIllustrationMoment(m, i, ctx.characters, fallbackMoments[i] || {}));

  return {
    chapterNumber: Number(parsed.chapterNumber) || fallbackChapter.chapterNumber || chapterIndex + 1,
    chapterTitle: str(parsed.chapterTitle || fallbackChapter.chapterTitle || `Chapter ${chapterIndex + 1}`),
    chapterText: str(parsed.chapterText || fallbackChapter.chapterText || ''),
    chapterSummary: str(parsed.chapterSummary || fallbackChapter.chapterSummary || ''),
    islamicMoment: str(parsed.islamicMoment || fallbackChapter.islamicMoment || ''),
    illustrationMoments: moments,
    chapterIllustrationHint: str(
      parsed.chapterIllustrationHint ||
      fallbackChapter.chapterIllustrationHint ||
      moments[0]?.illustrationHint ||
      ''
    ),
    changesMade: uniqStrings(parsed.changesMade || []),
  };
}

function getSpreadSourceForRerun(project, chapterIndex) {
  const humanized = normArr(project.artifacts?.humanized);
  const chapters = normArr(project.artifacts?.chapters);
  const flatSpreads = normArr(project.artifacts?.spreads);

  if (project.artifacts?.spreadOnly || flatSpreads.length) {
    return { kind: 'flat', spreads: flatSpreads };
  }

  if (humanized[chapterIndex]?.spreads?.length) {
    return { kind: 'humanized', spreads: normArr(humanized[chapterIndex].spreads) };
  }

  if (chapters[chapterIndex]?.spreads?.length) {
    return { kind: 'chapters', spreads: normArr(chapters[chapterIndex].spreads) };
  }

  return { kind: 'flat', spreads: [] };
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1: STORY GENERATION
// ══════════════════════════════════════════════════════════════════════════════

function buildStoryPrompt({ project, universe, characters, kb }, storyIdea) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const charBlock = characterBlock(characters);

  const formatDesc = profile.mode === 'spreads-only'
    ? `SPREADS-ONLY PICTURE BOOK for ages ${project.ageRange}:
  - NO chapters — just illustrated pages with short text
  - Max ${profile.maxWords} words/page
  - Simple, warm, complete sentences
  - Each page is one natural, complete thought
  - Story total: 300-500 words flowing narrative`
    : profile.mode === 'picture-book'
      ? `PICTURE BOOK for ages ${project.ageRange}:
  - Simple chapters with illustrated spreads
  - Max ${profile.maxWords} words per spread
  - Warm storytelling with clear scenes
  - Story total: 400-700 words`
      : `CHAPTER BOOK for ages ${project.ageRange}:
  - storyText must be a strong full-book synopsis, not full chapter prose
  - Full chapter prose is generated separately
  - Keep storyText 500-900 words
  - Return exact chapter outline with illustration moments`;

  const system = `You are an expert Islamic children's book author.
Book Format:
${formatDesc}

${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}
${arabic}

CRITICAL RULES:
- Use ONLY approved character names exactly as given
- Every chapter/spread/scene must use exact approved character names
- Do NOT invent unnamed family members or generic labels
- Output ONLY raw valid JSON. NO markdown fences. Start with { end with }`;

  const chapterBookExtra = profile.mode === 'chapter-book' ? `
This is a CHAPTER BOOK for ages ${project.ageRange}.
The "storyText" field must be a SYNOPSIS (500-900 words), NOT full chapter prose.
Also include "chapterOutline" with EXACTLY ${project.chapterCount || 4} chapters.
Each chapter must include:
- title
- goal
- keyScene
- islamicMoment
- endingBeat
- charactersInScene
- illustrationMoments (max 2, object format only)` : '';

  const prompt = `Write an Islamic children's story from this idea:

STORY IDEA: "${storyIdea || project.title}"
Age Range: ${project.ageRange}
Islamic Theme: ${project.learningObjective || 'Islamic values, character building'}
Language: ${project.language || 'english'}
Author: ${project.authorName || 'NoorStudio'}
${chapterBookExtra}

The story must:
- Be age-appropriate for ${project.ageRange}
- Teach Islamic values naturally
- Feature only approved characters
- Have a clear story arc
- Include natural Islamic moments
- End with a memorable moral

Respond ONLY with this JSON:
{
  "bookTitle": "string",
  "synopsis": "2-3 sentence summary",
  "moral": "specific Islamic lesson",
  "storyText": "${profile.mode === 'chapter-book' ? '500-900 word narrative synopsis of the full arc' : '300-600 word complete story'}",
  "suggestedPageCount": ${profile.mode === 'chapter-book' ? 0 : 10},
  "suggestedChapterCount": ${profile.mode === 'chapter-book' ? (project.chapterCount || 4) : 0},
  "spreadOnly": ${profile.spreadOnly},
  "islamicTheme": {
    "concept": "string",
    "arabicPhrase": "approved exact Arabic only",
    "transliteration": "string",
    "meaning": "string"
  },
  "dedicationMessage": "string",
  "characters": [
    {
      "name": "exact approved character name",
      "role": "protagonist|supporting|parent|elder",
      "ageRange": "string",
      "gender": "boy|girl",
      "keyTraits": ["trait1", "trait2"]
    }
  ]${profile.mode === 'chapter-book' ? `,
  "chapterOutline": [
    {
      "chapterNumber": 1,
      "title": "string",
      "goal": "string",
      "keyScene": "specific visual scene",
      "islamicMoment": "string",
      "endingBeat": "string",
      "charactersInScene": ["exact approved character names only"],
      "illustrationMoments": [
        {
          "momentTitle": "string",
          "illustrationHint": "clear visual beat",
          "charactersInScene": ["exact approved character names only"],
          "sceneEnvironment": "indoor|outdoor|mixed",
          "timeOfDay": "morning|afternoon|evening|night",
          "poseKey": "standing|walking|running|thinking|sitting|waving|reading-quran|praying-salah|laughing|sad|surprised|kneeling",
          "cameraHint": "wide|medium|close|over-shoulder|full-body"
        }
      ]
    }
  ]` : ''}
}`;
  return { system, prompt };
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2a: SPREAD PLANNING
// ══════════════════════════════════════════════════════════════════════════════

function buildSpreadPlanningPrompt({ project, universe, characters, kb }) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const charBlock = characterBlock(characters);
  const storyText = project.artifacts?.storyText || project.artifacts?.outline?.synopsis || '';
  const bookStyle = project.bookStyle || {};
  const pageCount = project.chapterCount || 10;

  const textRules = profile.mode === 'spreads-only'
    ? `TEXT RULES FOR AGE ${project.ageRange}:
- Each page gets EXACTLY ONE complete natural sentence
- Max ${profile.maxWords} words
- Must be grammatically complete
- Warm, gentle, clear`
    : `TEXT RULES FOR AGE ${project.ageRange}:
- 1-2 complete sentences per spread
- Max ${profile.maxWords} words
- Clear, warm narrative prose`;

  const system = `You are an expert Islamic children's picture book author and illustrator.
Age: ${project.ageRange} — Mode: ${profile.mode}

${textRules}

${universeBlock(universe)}
${kbBlock(kb)}
${charBlock}
${arabic}

CRITICAL RULES:
- Use only approved character names exactly
- Every spread must include charactersInScene using approved names
- Return strict structured JSON only
- Output ONLY raw valid JSON. Start with { end with }`;

  const prompt = `Break this story into ${pageCount} illustrated spreads.

STORY:
"${storyText}"

Book title: "${project.artifacts?.outline?.bookTitle || project.title}"
Art style: ${bookStyle.artStyle || 'Pixar 3D animation'}
Background: ${bookStyle.backgroundStyle || 'mixed indoor/outdoor'}
Indoor setting: ${bookStyle.indoorRoomDescription || 'warm cozy room with soft colors'}
Outdoor setting: ${bookStyle.outdoorDescription || 'sunny garden with green grass and flowers'}
Recurring props: ${bookStyle.bookProps || 'none specified'}

Respond ONLY with:
{
  "spreadOnly": ${profile.spreadOnly},
  "totalSpreads": ${pageCount},
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "${profile.mode === 'spreads-only' ? `ONE complete natural sentence, max ${profile.maxWords} words` : `1-2 sentences, max ${profile.maxWords} words`}",
      "prompt": "instruction that produced this page text",
      "illustrationHint": "clear visual scene",
      "charactersInScene": ["exact approved character names only"],
      "poseKey": "optional pose key",
      "characterEmotion": { "ExactName": "emotion" },
      "sceneEnvironment": "indoor|outdoor|mixed",
      "timeOfDay": "morning|afternoon|evening|night",
      "textPosition": "bottom|top",
      "islamicElement": "specific Islamic detail or null",
      "continuityNotes": "brief continuity note",
      "cameraHint": "wide|medium|close|over-shoulder|full-body"
    }
  ]
}`;
  return { system, prompt };
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2b: PICTURE BOOK CHAPTER GENERATION
// ══════════════════════════════════════════════════════════════════════════════

function buildPictureBookChapterPrompt({ project, universe, characters, kb }, chapterIndex) {
  const profile = getAgeProfile(project.ageRange);
  const outline = project.artifacts?.outline;
  const outlineChapters = normArr(outline?.chapters);
  const chapterOutline = outlineChapters[chapterIndex];
  const arabic = buildArabicBlock();
  const sceneChars = (chapterOutline?.charactersInScene || []).length
    ? characters.filter(c => chapterOutline.charactersInScene.includes(c.name))
    : characters;

  const system = `You are an expert Islamic children's picture book author.
PICTURE BOOK for ages ${project.ageRange}. MAX ${profile.maxWords} words per spread.
Each spread = one illustrated page with 1-2 short sentences.
${universeBlock(universe)}
${kbBlock(kb)}
${characterBlock(sceneChars)}
${arabic}

CRITICAL RULES:
- Use charactersInScene, not charactersInSpread
- Use only exact approved character names
- Return strict raw JSON only`;

  return {
    system,
    prompt: `Write Chapter ${chapterIndex + 1} of "${project.title}".
Chapter: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
Goal: ${chapterOutline?.goal || ''}
Key Scene: ${chapterOutline?.keyScene || ''}
Characters in this chapter: ${sceneChars.map(c => c.name).join(', ')}
MAX ${profile.maxWords} words per spread text.

Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "chapterSummary": "1-2 sentence summary",
  "islamicMoment": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "1-2 clear sentences, max ${profile.maxWords} words",
      "prompt": "instruction used to write this spread",
      "illustrationHint": "detailed scene",
      "charactersInScene": ["exact approved names only"],
      "poseKey": "optional pose key",
      "textPosition": "bottom|top",
      "characterEmotion": { "ExactName": "emotion" },
      "sceneEnvironment": "indoor|outdoor|mixed",
      "timeOfDay": "morning|afternoon|evening|night",
      "continuityNotes": "brief continuity note",
      "cameraHint": "wide|medium|close|over-shoulder|full-body"
    }
  ]
}`
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAPTER BOOK PROSE GENERATION
// ══════════════════════════════════════════════════════════════════════════════

function buildChapterBookProsePrompt({ project, universe, characters, kb }, chapterIndex) {
  const profile = getAgeProfile(project.ageRange);
  const outline = project.artifacts?.outline || {};
  const chapterOutline = normArr(outline?.chapters || [])[chapterIndex];
  const storyText = project.artifacts?.storyText || '';
  const arabic = buildArabicBlock();
  const bookStyle = project.bookStyle || {};

  const totalChapters = normArr(outline?.chapters || []).length || project.chapterCount || 4;

  const previousChapters = normArr(project.artifacts?.chapters)
    .slice(0, chapterIndex)
    .map((ch, i) => ({
      chapterNumber: i + 1,
      chapterTitle: ch.chapterTitle || ch.title || `Chapter ${i + 1}`,
      chapterSummary: ch.chapterSummary || '',
      chapterTextPreview: String(ch.chapterText || ch.text || '').slice(0, 500),
    }));

  const sceneChars = (chapterOutline?.charactersInScene || []).length
    ? characters.filter(c => chapterOutline.charactersInScene.includes(c.name))
    : characters;

  const system = `You are an expert Islamic children's chapter book author for ages ${project.ageRange}.

This is a REAL CHAPTER BOOK, not a spread-based picture book.

CRITICAL WRITING RULES:
- Write ONE full prose chapter
- Length: ${profile.minChapterWords}-${profile.maxChapterWords} words
- Third-person past tense
- Novel-like, immersive, warm, adventurous
- Preserve continuity with earlier chapters
- Use strong scene-setting, dialogue, emotion, atmosphere
- Integrate Islamic values naturally
- End with curiosity, suspense, discovery, or emotional shift

${universeBlock(universe)}
${kbBlock(kb)}
${characterBlock(sceneChars)}
${arabic}

CRITICAL STRUCTURE RULES:
- Return exactly 2 illustrationMoments max
- Each illustrationMoment must be an object, not a string
- Use exact approved character names only
- Output ONLY raw valid JSON`;

  const prompt = `Write Chapter ${chapterIndex + 1} of ${totalChapters} of "${project.title}".

BOOK SYNOPSIS:
${storyText.slice(0, 2200)}

CHAPTER DETAILS:
Number: ${chapterIndex + 1}
Title: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
Goal: ${chapterOutline?.goal || 'Advance the story meaningfully and deepen character growth'}
Key Scene: ${chapterOutline?.keyScene || 'A meaningful turning point'}
Islamic Moment: ${chapterOutline?.duaHint || 'A natural Islamic value or faith moment'}
Ending Beat: ${chapterOutline?.endingBeat || 'End with momentum or emotional resonance'}
Characters: ${sceneChars.map(c => c.name).join(', ') || 'Use approved characters only'}
Art Style Reference: ${bookStyle.artStyle || 'Pixar 3D animation'}
Setting Reference: ${
  bookStyle.backgroundStyle === 'indoor'
    ? (bookStyle.indoorRoomDescription || 'indoor setting')
    : bookStyle.backgroundStyle === 'outdoor'
      ? (bookStyle.outdoorDescription || 'outdoor setting')
      : 'mixed indoor/outdoor'
}

${previousChapters.length ? `PREVIOUS CHAPTER CONTEXT:
${JSON.stringify(previousChapters, null, 2)}` : 'This is the opening chapter.'}

Respond ONLY with this JSON:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}",
  "islamicMoment": "specific Islamic value or faith-based moment",
  "chapterSummary": "2-3 sentence summary",
  "chapterText": "Full prose chapter of ${profile.minChapterWords}-${profile.maxChapterWords} words",
  "illustrationMoments": [
    {
      "momentTitle": "string",
      "illustrationHint": "detailed visual scene",
      "charactersInScene": ["exact approved character names only"],
      "poseKey": "standing|walking|running|thinking|sitting|waving|reading-quran|praying-salah|laughing|sad|surprised|kneeling",
      "characterEmotion": { "ExactName": "emotion" },
      "sceneEnvironment": "indoor|outdoor|mixed",
      "timeOfDay": "morning|afternoon|evening|night",
      "continuityNotes": "brief continuity note",
      "cameraHint": "wide|medium|close|over-shoulder|full-body"
    }
  ]
}`;
  return { system, prompt };
}

// ══════════════════════════════════════════════════════════════════════════════
// SPREADS-ONLY PROMPT
// ══════════════════════════════════════════════════════════════════════════════

function buildSpreadsOnlyPrompt({ project, universe, characters, kb }) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const outline = project.artifacts?.outline;
  const count = normArr(outline?.spreads || []).length || project.chapterCount || 10;

  const system = `You are an expert Islamic picture book author for very young children (ages ${project.ageRange}).

SENTENCE RULES:
- Every "text" field MUST be one complete grammatical sentence
- Max ${profile.maxWords} words
- Each sentence should carry one clear warm emotional moment
- The ${count} sentences together should tell a complete story arc

${universeBlock(universe)}
${kbBlock(kb)}
${characterBlock(characters)}
${arabic}

CRITICAL RULES:
- Use only exact approved character names
- Return strict raw JSON only`;

  return {
    system,
    prompt: `Write all ${count} pages for "${project.title}".
Age: ${project.ageRange}
Islamic Objective: ${project.learningObjective || 'Islamic daily life and values'}
Outline: ${JSON.stringify(normArr(outline?.spreads || []).map(s => s.textHint || s.sceneDescription || ''), null, 2)}

Respond ONLY with:
{
  "spreadOnly": true,
  "totalSpreads": ${count},
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "ONE complete grammatical sentence, max ${profile.maxWords} words",
      "prompt": "instruction for this page",
      "illustrationHint": "detailed scene",
      "textPosition": "bottom|top",
      "charactersInScene": ["exact approved names only"],
      "poseKey": "optional pose key",
      "characterEmotion": { "ExactName": "emotion" },
      "sceneEnvironment": "indoor|outdoor|mixed",
      "timeOfDay": "morning|afternoon|evening|night",
      "continuityNotes": "brief continuity note",
      "cameraHint": "wide|medium|close|over-shoulder|full-body"
    }
  ]
}`
  };
}

// ─── Outline ──────────────────────────────────────────────────────────────────

function buildOutlinePrompt({ project, universe, characters, kb }) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();

  const system = `You are an expert Islamic children's book author.
${universeBlock(universe)}
${kbBlock(kb)}
${characterBlock(characters)}
${arabic}

CRITICAL RULES:
- Use exact approved character names only
- Return strict raw valid JSON only`;

  const prompt = profile.spreadOnly ? `
Create a spreads-only picture book outline for ages ${project.ageRange}.
Title: "${project.title}"
Learning Objective: ${project.learningObjective || 'Islamic values'}
NO chapters — just ${project.chapterCount || 10} illustrated spreads.

Respond ONLY with:
{
  "bookTitle": "string",
  "moral": "string",
  "synopsis": "string",
  "spreadOnly": true,
  "totalSpreads": ${project.chapterCount || 10},
  "dedicationMessage": "string",
  "islamicTheme": {
    "title": "string",
    "arabicPhrase": "approved exact Arabic only",
    "transliteration": "string",
    "meaning": "string",
    "reference": "string",
    "referenceText": "string",
    "whyWeDoIt": "string"
  },
  "spreads": [
    {
      "spreadIndex": 0,
      "sceneDescription": "vivid scene description",
      "illustrationHint": "string",
      "textHint": "one sentence idea",
      "islamicValue": "string"
    }
  ]
}` : `
Create EXACTLY ${project.chapterCount || 4} chapters for "${project.title}".
Age Range: ${project.ageRange}
Mode: ${profile.mode}

${profile.mode === 'chapter-book' ? `
CHAPTER BOOK RULES:
- Each chapter supports later full prose generation
- Include 1-2 illustration moments only
- Use exact approved character names only
- Each chapter ends with momentum
` : `
PICTURE BOOK RULES:
- Each chapter will later become short illustrated spreads
- Use exact approved character names only
`}

Respond ONLY with:
{
  "bookTitle": "string",
  "moral": "string",
  "synopsis": "string",
  "spreadOnly": false,
  "chapterCount": ${project.chapterCount || 4},
  "dedicationMessage": "string",
  "islamicTheme": {
    "title": "string",
    "arabicPhrase": "approved exact Arabic only",
    "transliteration": "string",
    "meaning": "string",
    "reference": "string",
    "referenceText": "string",
    "whyWeDoIt": "string"
  },
  "chapters": [
    {
      "title": "string",
      "goal": "string",
      "keyScene": "specific turning point",
      "duaHint": "natural Islamic moment",
      "endingBeat": "closing emotional note",
      "charactersInScene": ["exact approved character names only"],
      "chapterNumber": 1,
      "illustrationMoments": [
        {
          "momentTitle": "string",
          "illustrationHint": "string",
          "charactersInScene": ["exact approved names only"],
          "sceneEnvironment": "indoor|outdoor|mixed",
          "timeOfDay": "morning|afternoon|evening|night",
          "poseKey": "optional pose key",
          "cameraHint": "wide|medium|close|over-shoulder|full-body"
        }
      ]
    }
  ]
}
IMPORTANT: chapters array MUST have exactly ${project.chapterCount || 4} items.`;

  return { system, prompt };
}

// ─── Dedication ───────────────────────────────────────────────────────────────

function buildDedicationPrompt({ project }) {
  const arabic = buildArabicBlock();
  return {
    system: `You are a warm Islamic children's book author. Output ONLY raw valid JSON. ${arabic}`,
    prompt: `Write dedication for "${project.title}" by ${project.authorName || 'NoorStudio'}.
Respond ONLY with:
{
  "greeting": "Assalamu Alaikum, dear parents!",
  "message": "2-4 warm sentences about the book and Islamic parenting",
  "closing": "Jazakallah Khair — ${project.authorName || 'NoorStudio'}",
  "includeQrPlaceholder": true
}`
  };
}

// ─── Islamic Theme Page ───────────────────────────────────────────────────────

function buildThemePagePrompt({ project, kb }) {
  const arabic = buildArabicBlock();
  return {
    system: `You are an Islamic educator for children ages ${project.ageRange}. Output ONLY raw valid JSON. ${arabic}`,
    prompt: `Create Islamic theme reference page for "${project.title}".
Objective: ${project.learningObjective || 'Islamic values'}
${kb ? kbBlock(kb) : ''}
Respond ONLY with:
{
  "sectionTitle": "string",
  "arabicPhrase": "approved exact Arabic only",
  "transliteration": "string",
  "meaning": "string",
  "referenceType": "quran|hadith",
  "referenceSource": "string",
  "referenceText": "string",
  "explanation": "3-4 child-friendly sentences",
  "dailyPractice": "1 sentence"
}`
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HUMANIZE
// ══════════════════════════════════════════════════════════════════════════════

function buildHumanizePrompt({ project, kb, characters }, chapterIndex) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';
  const chaptersArr = normArr(project.artifacts?.chapters);
  const chapter = chaptersArr[chapterIndex];

  const system = `You are a children's book editor for Islamic content, ages ${project.ageRange}.
${characterBlock(characters)}
${arabic}
Output ONLY raw valid JSON.`;

  if (profile.mode === 'chapter-book') {
    const chapterText = String(chapter?.chapterText || chapter?.text || '');

    return {
      system,
      prompt: `Polish Chapter ${chapterIndex + 1} of "${project.title}".

Current chapter title: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}

Current chapter text:
${chapterText}

Editing rules:
- Keep plot and meaning intact
- Preserve approved characters exactly
- Preserve illustration intent
- Improve prose quality, atmosphere, dialogue, and flow
- Keep Islamic values natural
- Avoid: ${avoidTopics}

Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}",
  "chapterText": "improved full prose chapter",
  "chapterSummary": "improved 2-3 sentence summary",
  "islamicMoment": "${chapter?.islamicMoment || ''}",
  "illustrationMoments": [
    {
      "momentTitle": "string",
      "illustrationHint": "string",
      "charactersInScene": ["exact approved names only"],
      "poseKey": "optional pose key",
      "characterEmotion": { "ExactName": "emotion" },
      "sceneEnvironment": "indoor|outdoor|mixed",
      "timeOfDay": "morning|afternoon|evening|night",
      "continuityNotes": "brief continuity note",
      "cameraHint": "wide|medium|close|over-shoulder|full-body"
    }
  ],
  "changesMade": ["list of specific improvements"]
}`
    };
  }

  if (profile.mode === 'picture-book') {
    return {
      system,
      prompt: `Polish picture book chapter ${chapterIndex + 1} of "${project.title}".
Current spreads: ${JSON.stringify(chapter?.spreads || [], null, 2)}
Avoid: ${avoidTopics}
MAX ${profile.maxWords} words per spread.
Preserve approved character names and scene intent.

Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "chapterSummary": "1-2 sentence summary",
  "islamicMoment": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "improved text, max ${profile.maxWords} words",
      "prompt": "updated instruction",
      "illustrationHint": "string",
      "charactersInScene": ["exact approved names only"],
      "poseKey": "optional pose key",
      "textPosition": "bottom|top",
      "characterEmotion": { "ExactName": "emotion" },
      "sceneEnvironment": "indoor|outdoor|mixed",
      "timeOfDay": "morning|afternoon|evening|night",
      "continuityNotes": "brief continuity note",
      "cameraHint": "wide|medium|close|over-shoulder|full-body"
    }
  ],
  "changesMade": ["list of changes"]
}`
    };
  }

  return buildSpreadHumanizePrompt({ project, characters, kb });
}

// ─── Spread humanize ──────────────────────────────────────────────────────────

function buildSpreadHumanizePrompt({ project, characters, kb }) {
  const profile = getAgeProfile(project.ageRange);
  const spreads = normArr(project.artifacts?.spreads || []);
  const arabic = buildArabicBlock();
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';

  const system = `You are an expert Islamic picture book editor for ages ${project.ageRange}.
SPREADS-ONLY book — ${spreads.length} pages, NO chapters.
EACH "text" MUST BE one complete, grammatically correct sentence (max ${profile.maxWords} words).
Output ONLY raw valid JSON.
${characterBlock(characters)}
${arabic}`;

  return {
    system,
    prompt: `Polish all ${spreads.length} page texts for "${project.title}".
Avoid: ${avoidTopics}
Keep all structure and approved character names.
Improve text clarity without changing scene meaning.

Current spreads: ${JSON.stringify(spreads, null, 2)}

Respond ONLY with:
{
  "spreadOnly": true,
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "ONE complete grammatical sentence, max ${profile.maxWords} words",
      "prompt": "copy or refine original",
      "illustrationHint": "same scene intent",
      "textPosition": "bottom|top",
      "charactersInScene": ["exact approved names only"],
      "poseKey": "optional pose key",
      "characterEmotion": { "ExactName": "emotion" },
      "sceneEnvironment": "indoor|outdoor|mixed",
      "timeOfDay": "morning|afternoon|evening|night",
      "continuityNotes": "brief continuity note",
      "cameraHint": "wide|medium|close|over-shoulder|full-body"
    }
  ],
  "changesMade": ["what improved"]
}`
  };
}

// ─── Spread rerun ─────────────────────────────────────────────────────────────

function buildSpreadRerunPrompt({ project, characters }, chapterIndex, spreadIndex, customPrompt) {
  const profile = getAgeProfile(project.ageRange);
  const arabic = buildArabicBlock();
  const source = getSpreadSourceForRerun(project, chapterIndex);
  const current = source.spreads[spreadIndex] || {};

  const system = `You are an expert Islamic ${profile.mode === 'picture-book' ? 'picture book' : 'spreads-only picture book'} author for ages ${project.ageRange}.
${profile.mode === 'spreads-only'
  ? `CRITICAL: The "text" field must be ONE complete natural sentence, max ${profile.maxWords} words.`
  : `MAX ${profile.maxWords} words per page.`}
Output ONLY raw valid JSON.
${characterBlock(characters)}
${arabic}`;

  return {
    system,
    prompt: `Rewrite page ${spreadIndex + 1} of "${project.title}".

Current spread:
${JSON.stringify(current, null, 2)}

Editor instruction:
${customPrompt}

Rules:
- Preserve approved character names exactly
- Keep scene continuity coherent with adjacent pages
- Keep or improve illustrationHint
- Keep structured metadata

Respond ONLY with:
{
  "spreadIndex": ${spreadIndex},
  "text": "${profile.mode === 'spreads-only' ? 'ONE complete grammatical sentence' : 'improved spread text'}",
  "prompt": ${JSON.stringify(customPrompt)},
  "illustrationHint": "updated scene for approved characters",
  "charactersInScene": ["exact approved names only"],
  "poseKey": "optional pose key",
  "textPosition": "bottom|top",
  "characterEmotion": { "ExactName": "emotion" },
  "sceneEnvironment": "indoor|outdoor|mixed",
  "timeOfDay": "morning|afternoon|evening|night",
  "continuityNotes": "brief continuity note",
  "cameraHint": "wide|medium|close|over-shoulder|full-body"
}`
  };
}

// ─── Save prompt history ──────────────────────────────────────────────────────

async function savePromptHistory(projectId, stage, index, promptText, result, provider) {
  const entry = {
    stage,
    index,
    prompt: promptText?.slice(0, 2000),
    resultPreview: JSON.stringify(result)?.slice(0, 500),
    provider,
    createdAt: new Date().toISOString(),
  };

  await Project.findByIdAndUpdate(projectId, {
    $push: { 'artifacts.promptHistory': { $each: [entry], $slice: -100 } },
  });
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function generateStageText({
  stage,
  projectId,
  userId,
  chapterIndex = 0,
  spreadIndex = 0,
  customPrompt,
  storyIdea,
}) {
  console.log(`\n[TextService] stage=${stage} project=${projectId} ch=${chapterIndex} sp=${spreadIndex}`);

  const ctx = await buildUniverseContext(projectId, userId);
  const profile = getAgeProfile(ctx.project.ageRange);

  let effectiveStage = stage;

  if ((stage === 'chapter' || stage === 'chapters') && profile.mode === 'spreads-only') {
    console.log(`[TextService] Age ${ctx.project.ageRange} (spreads-only) → redirecting ${stage}→spreads`);
    effectiveStage = 'spreads';
  }

  if (stage === 'spreadPlanning' && profile.mode === 'chapter-book') {
    console.log(`[TextService] Age ${ctx.project.ageRange} (chapter-book) → spread planning generates chapter outline`);
  }

  if (stage === 'spreadRerun' && profile.mode === 'chapter-book') {
    throw Object.assign(
      new Error('spreadRerun is not supported for chapter-book prose mode. Use chapter rerun instead.'),
      { code: 'INVALID_STAGE_FOR_MODE' }
    );
  }

  let builtPrompt;
  switch (effectiveStage) {
    case 'story':
      builtPrompt = buildStoryPrompt(ctx, storyIdea || ctx.project.artifacts?.storyIdea);
      break;

    case 'spreadPlanning':
      builtPrompt = profile.mode === 'chapter-book'
        ? buildOutlinePrompt(ctx)
        : buildSpreadPlanningPrompt(ctx);
      break;

    case 'outline':
      builtPrompt = buildOutlinePrompt(ctx);
      break;

    case 'dedication':
      builtPrompt = buildDedicationPrompt(ctx);
      break;

    case 'theme':
      builtPrompt = buildThemePagePrompt(ctx);
      break;

    case 'chapter':
    case 'chapters':
      if (profile.mode === 'chapter-book') {
        builtPrompt = buildChapterBookProsePrompt(ctx, chapterIndex);
      } else if (profile.mode === 'picture-book') {
        builtPrompt = buildPictureBookChapterPrompt(ctx, chapterIndex);
      } else {
        builtPrompt = buildSpreadsOnlyPrompt(ctx);
      }
      break;

    case 'spreads':
      builtPrompt = buildSpreadsOnlyPrompt(ctx);
      break;

    case 'humanize':
      builtPrompt = profile.spreadOnly
        ? buildSpreadHumanizePrompt(ctx)
        : buildHumanizePrompt(ctx, chapterIndex);
      break;

    case 'spreadRerun':
      if (!customPrompt) {
        throw Object.assign(new Error('customPrompt required for spreadRerun'), { code: 'MISSING_PROMPT' });
      }
      builtPrompt = buildSpreadRerunPrompt(ctx, chapterIndex, spreadIndex, customPrompt);
      break;

    default:
      throw Object.assign(new Error(`Unknown stage: ${effectiveStage}`), { code: 'UNKNOWN_STAGE' });
  }

  const { system, prompt } = builtPrompt;

  const budget = AI_TOKEN_BUDGETS[effectiveStage] || AI_TOKEN_BUDGETS.chapter || {
    maxPromptTokens: 8000,
    maxOutputTokens: 4000,
  };

  let outputTokens;
  if (effectiveStage === 'story' && profile.mode === 'chapter-book') {
    outputTokens = Math.max(budget.maxOutputTokens || 0, 6000);
  } else if ((effectiveStage === 'chapter' || effectiveStage === 'chapters') && profile.mode === 'chapter-book') {
    outputTokens = Math.max(budget.maxOutputTokens || 0, 7000);
  } else if (effectiveStage === 'chapter' || effectiveStage === 'chapters') {
    outputTokens = Math.max(budget.maxOutputTokens || 0, 4000);
  } else {
    outputTokens = budget.maxOutputTokens || 2000;
  }

  const promptTokens = estimateTokens(system + prompt);
  console.log(`[TextService] ~${promptTokens} prompt tokens, ${outputTokens} max output`);

  if (promptTokens > (budget.maxPromptTokens || 12000)) {
    throw Object.assign(
      new Error(`Prompt too large for ${effectiveStage}: ${promptTokens} > ${budget.maxPromptTokens}`),
      { code: 'AI_TOKEN_BUDGET_EXCEEDED' }
    );
  }

  const aiRes = await generateText({
    system,
    prompt,
    maxOutputTokens: outputTokens,
    stage: effectiveStage,
  });

  console.log(`[TextService] Provider: ${aiRes.provider} | length: ${aiRes.text?.length}`);

  const { ok, data: parsedRaw } = safeParse(aiRes.text);
  if (!ok) console.error('[TextService] ⚠ JSON parse failed — storing raw response');

  const fresh = await Project.findById(projectId);
  const setFields = {};
  let parsed = parsedRaw;

  switch (effectiveStage) {
    case 'story': {
      parsed = normalizeStoryPayload(parsedRaw, ctx);

      setFields['artifacts.storyText'] = parsed.storyText || '';
      setFields['artifacts.storyIdea'] = storyIdea || ctx.project.artifacts?.storyIdea || '';

      const storyOutline = {
        bookTitle: parsed.bookTitle,
        moral: parsed.moral,
        synopsis: parsed.synopsis,
        spreadOnly: parsed.spreadOnly || false,
        islamicTheme: parsed.islamicTheme,
        characters: parsed.characters,
        suggestedChapterCount: parsed.chapterOutline.length || ctx.project.chapterCount,
      };

      if (parsed.chapterOutline.length > 0) {
        storyOutline.chapters = parsed.chapterOutline.map((ch, i) => ({
          title: ch.title || `Chapter ${i + 1}`,
          goal: ch.goal || '',
          keyScene: ch.keyScene || '',
          duaHint: ch.duaHint || 'natural Islamic moment',
          endingBeat: ch.endingBeat || 'end with momentum or emotional resonance',
          chapterNumber: ch.chapterNumber || i + 1,
          charactersInScene: normArr(ch.charactersInScene),
          illustrationMoments: normArr(ch.illustrationMoments),
        }));
        console.log(`[TextService] Story included chapterOutline: ${storyOutline.chapters.length} chapters pre-saved`);
      }

      setFields['artifacts.outline'] = storyOutline;

      if (parsed.dedicationMessage) {
        setFields['artifacts.dedication'] = {
          greeting: 'Assalamu Alaikum, dear parents!',
          message: parsed.dedicationMessage,
          closing: `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`,
          includeQrPlaceholder: true,
        };
      }

      if (parsed.bookTitle && parsed.bookTitle !== ctx.project.title) {
        setFields.title = parsed.bookTitle;
      }

      setFields.currentStage = 'story';
      setFields['stepsComplete.story'] = true;
      setFields.currentStep = Math.max(fresh.currentStep || 1, 2);
      break;
    }

    case 'spreadPlanning': {
      if (profile.mode === 'chapter-book') {
        parsed = normalizeOutlinePayload(parsedRaw, ctx);
        setFields['artifacts.outline'] = parsed;
        setFields['artifacts.spreadOnly'] = false;

        if (parsed.islamicTheme) setFields['artifacts.themePage'] = parsed.islamicTheme;
        if (parsed.dedicationMessage) {
          setFields['artifacts.dedication'] = {
            greeting: 'Assalamu Alaikum, dear parents!',
            message: parsed.dedicationMessage,
            closing: `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`,
            includeQrPlaceholder: true,
          };
        }
      } else {
        parsed = normalizeSpreadPlanningPayload(parsedRaw, ctx);
        setFields['artifacts.spreads'] = parsed.spreads || [];
        setFields['artifacts.spreadOnly'] = parsed.spreadOnly || false;
      }

      setFields.currentStage = 'spreadPlanning';
      setFields['stepsComplete.spreads'] = true;
      setFields.currentStep = Math.max(fresh.currentStep || 1, 3);
      break;
    }

    case 'outline': {
      parsed = normalizeOutlinePayload(parsedRaw, ctx);
      setFields['artifacts.outline'] = parsed;

      if (parsed.dedicationMessage) {
        setFields['artifacts.dedication'] = {
          greeting: 'Assalamu Alaikum, dear parents!',
          message: parsed.dedicationMessage,
          closing: `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`,
          includeQrPlaceholder: true,
        };
      }

      if (parsed.islamicTheme) setFields['artifacts.themePage'] = parsed.islamicTheme;
      setFields.currentStage = 'outline';
      break;
    }

    case 'dedication':
      parsed = {
        greeting: str(parsedRaw.greeting || 'Assalamu Alaikum, dear parents!'),
        message: str(parsedRaw.message || ''),
        closing: str(parsedRaw.closing || `Jazakallah Khair — ${ctx.project.authorName || 'NoorStudio'}`),
        includeQrPlaceholder: parsedRaw.includeQrPlaceholder !== false,
      };
      setFields['artifacts.dedication'] = parsed;
      break;

    case 'theme':
      parsed = {
        sectionTitle: str(parsedRaw.sectionTitle || ''),
        arabicPhrase: str(parsedRaw.arabicPhrase || ''),
        transliteration: str(parsedRaw.transliteration || ''),
        meaning: str(parsedRaw.meaning || ''),
        referenceType: str(parsedRaw.referenceType || 'quran'),
        referenceSource: str(parsedRaw.referenceSource || ''),
        referenceText: str(parsedRaw.referenceText || ''),
        explanation: str(parsedRaw.explanation || ''),
        dailyPractice: str(parsedRaw.dailyPractice || ''),
      };
      setFields['artifacts.themePage'] = parsed;
      break;

    case 'chapter':
    case 'chapters': {
      const chapters = normArr(fresh.artifacts?.chapters);

      if (profile.mode === 'chapter-book') {
        parsed = normalizeChapterBookPayload(parsedRaw, ctx, chapterIndex);
        chapters[chapterIndex] = parsed;
      } else {
        parsed = normalizePictureBookChapterPayload(parsedRaw, ctx, chapterIndex);
        chapters[chapterIndex] = parsed;
      }

      setFields['artifacts.chapters'] = chapters;
      setFields.currentStage = 'chapters';
      break;
    }

    case 'spreads': {
      parsed = normalizeSpreadPlanningPayload(parsedRaw, ctx);
      setFields['artifacts.spreads'] = parsed.spreads || [];
      setFields['artifacts.spreadOnly'] = true;
      setFields.currentStage = 'spreads';
      break;
    }

    case 'humanize': {
      if (fresh.artifacts?.spreadOnly || profile.spreadOnly) {
        const originalSpreads = normArr(fresh.artifacts?.spreads);
        const rawSpreads = normArr(parsedRaw.spreads);
        parsed = {
          spreadOnly: true,
          spreads: rawSpreads.map((s, i) =>
            normalizeSpread(s, i, profile, ctx.characters, originalSpreads[i] || {})
          ),
          changesMade: uniqStrings(parsedRaw.changesMade || []),
        };

        setFields['artifacts.spreads'] = parsed.spreads;
        setFields['artifacts.spreadOnly'] = true;
      } else {
        const humanized = normArr(fresh.artifacts?.humanized);
        const originalChapters = normArr(fresh.artifacts?.chapters);
        const fallbackChapter = originalChapters[chapterIndex] || {};

        parsed = profile.mode === 'chapter-book'
          ? normalizeHumanizedChapterBookPayload(parsedRaw, ctx, chapterIndex, fallbackChapter)
          : normalizeHumanizedPictureBookPayload(parsedRaw, ctx, chapterIndex, fallbackChapter);

        humanized[chapterIndex] = parsed;
        setFields['artifacts.humanized'] = humanized;
      }

      setFields.currentStage = 'humanized';
      break;
    }

    case 'spreadRerun': {
      const source = getSpreadSourceForRerun(fresh, chapterIndex);
      const fallbackSpread = source.spreads[spreadIndex] || {};
      parsed = normalizeSpread(parsedRaw, spreadIndex, profile, ctx.characters, fallbackSpread);

      if (fresh.artifacts?.spreadOnly || profile.spreadOnly) {
        const spreads = normArr(fresh.artifacts?.spreads);
        spreads[spreadIndex] = { ...spreads[spreadIndex], ...parsed };
        setFields['artifacts.spreads'] = spreads;
      } else {
        const isHumanized = normArr(fresh.artifacts?.humanized).length > 0;
        const key = isHumanized ? 'artifacts.humanized' : 'artifacts.chapters';
        const chapters = normArr(isHumanized ? fresh.artifacts.humanized : fresh.artifacts.chapters);
        const ch = chapters[chapterIndex] || {};
        const chSpreads = normArr(ch.spreads);
        chSpreads[spreadIndex] = { ...chSpreads[spreadIndex], ...parsed };
        chapters[chapterIndex] = {
          ...ch,
          spreads: chSpreads,
          chapterIllustrationHint: ch.chapterIllustrationHint || parsed.illustrationHint || '',
        };
        setFields[key] = chapters;
      }
      break;
    }

    default:
      break;
  }

  setFields[`aiUsage.stages.${effectiveStage}`] = {
    inputTokens: aiRes.usage?.inputTokens,
    outputTokens: aiRes.usage?.outputTokens,
    updatedAt: new Date(),
  };

  await Project.findByIdAndUpdate(projectId, {
    $set: setFields,
    $inc: {
      'aiUsage.totalInputTokens': aiRes.usage?.inputTokens || 0,
      'aiUsage.totalOutputTokens': aiRes.usage?.outputTokens || 0,
    },
  });

  await savePromptHistory(
    projectId,
    effectiveStage,
    effectiveStage === 'chapter' || effectiveStage === 'chapters' || effectiveStage === 'humanize'
      ? chapterIndex
      : spreadIndex,
    prompt,
    parsed,
    aiRes.provider,
  );

  console.log(`[TextService] ✓ stage="${effectiveStage}" saved | mode=${profile.mode}`);
  return {
    result: parsed,
    usage: aiRes.usage,
    provider: aiRes.provider,
    prompt,
    stage: effectiveStage,
  };
}