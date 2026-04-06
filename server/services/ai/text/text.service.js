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

// ─── KB chapter-count resolver ────────────────────────────────────────────────

/**
 * Parse a chapter-range string such as "10 to 14" or "8-12" and return
 * the upper bound of the range (so the user always gets the richer book).
 * Returns NaN if the string cannot be parsed.
 */
function parseChapterRangeMax(rangeStr) {
  if (!rangeStr) return NaN;
  // extract all integers from the string
  const nums = String(rangeStr).match(/\d+/g);
  if (!nums || nums.length === 0) return NaN;
  return Math.max(...nums.map(Number));
}

/**
 * Determine the effective chapter count for a project, honouring the
 * Knowledge Base `bookFormatting.middleGrade.chapterRange` when the project
 * has not been given an explicit override.
 *
 * Priority:
 *  1. Outline already generated → use actual chapter count from outline
 *  2. KB bookFormatting.middleGrade.chapterRange (parsed)
 *  3. project.chapterCount (set by user on the project form)
 *  4. Age-profile fallback (4 for chapter-book, 3 for picture-book)
 */
export function resolveChapterCount(project, kb, { fromOutline = false } = {}) {
  // 1. Already-generated outline takes precedence
  if (fromOutline) {
    const outlineChapters = project.artifacts?.outline?.chapters;
    if (Array.isArray(outlineChapters) && outlineChapters.length > 0) {
      return outlineChapters.length;
    }
  }

  // 2. KB chapterRange (middleGrade only — picture-books don't use it)
  const kbRange = kb?.bookFormatting?.middleGrade?.chapterRange;
  const fromKb = parseChapterRangeMax(kbRange);
  if (!isNaN(fromKb) && fromKb > 0) return fromKb;

  // 3. Explicit project field
  const fromProject = Number(project.chapterCount);
  if (fromProject > 0) return fromProject;

  // 4. Fallback
  const profile = getAgeProfile(project.ageRange);
  return profile.mode === 'chapter-book' ? 4 : 3;
}

// ═══════════════════════════════════════════════════════════════════════════════
// KB RESOLVERS  — KB-first, profile-fallback
// Each resolver returns a plain data object.  Prompt builders read from these
// objects only — they never access kb.* or profile.* directly.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve all text-generation formatting rules for the project.
 * KB values win; age-profile hard-coded numbers are the last resort.
 */
export function resolveFormattingRules(project, kb) {
  const profile = getAgeProfile(project.ageRange);
  const { mode } = profile;

  // ── Shared defaults ────────────────────────────────────────────────────────
  const rules = {
    mode,
    spreadOnly: profile.spreadOnly,
    chapterProse: profile.chapterProse,
    // spread / picture-book
    maxWordsPerSpread: profile.maxWords,
    spreadCount: Number(project.chapterCount) || 10,
    pageFlow: [],
    pageCount: Number(project.chapterCount) || 10,
    segmentCount: '',
    wordCountTarget: '',
    readingType: 'parent-read',
    pageLayout: '',
    reflectionPrompt: '',
    bonusPageContent: '',
    emotionalPattern: null,
    illustrationStyle: '',
    colorPalette: '',
    fontPreferences: [],
    specialRules: [],
    // chapter-book
    minChapterWords: profile.minChapterWords || 900,
    maxChapterWords: profile.maxChapterWords || 1400,
    chapterCount: resolveChapterCount(project, kb),
    chapterRhythm: [],
    frontMatter: [],
    endMatter: [],
    sceneLength: '',
  };

  if (mode === 'spreads-only') {
    console.log("spread only")
    const u = kb?.underSixDesign || {};
    console.log("under-6 design rules:", u);
    if (u.maxWordsPerSpread) rules.maxWordsPerSpread = Number(u.maxWordsPerSpread) || rules.maxWordsPerSpread;
    if (u.readingType) rules.readingType = u.readingType;
    if (u.pageLayout) rules.pageLayout = u.pageLayout;
    if (u.reflectionPrompt) rules.reflectionPrompt = u.reflectionPrompt;
    if (u.bonusPageContent) rules.bonusPageContent = u.bonusPageContent;
    if (u.emotionalPattern) rules.emotionalPattern = u.emotionalPattern;
    if (u.illustrationStyle) rules.illustrationStyle = u.illustrationStyle;
    if (u.colorPalette) rules.colorPalette = u.colorPalette;
    if (u.fontPreferences?.length) rules.fontPreferences = u.fontPreferences;
    if (u.specialRules?.length) rules.specialRules = u.specialRules;
    // spread count from junior page count if available
    const jr = kb?.bookFormatting?.junior || {};
    const jrPageCount = jr.pageCount || kb?.underSixDesign?.pageCount;
    if (jrPageCount) {
      const nums = String(jrPageCount).match(/\d+/g);
      if (nums) rules.spreadCount = Math.max(...nums.map(Number));
    }

  } else if (mode === 'picture-book') {
    const jr = kb?.bookFormatting?.junior || {};
    if (jr.wordCount) rules.wordCountTarget = jr.wordCount;
    if (jr.pageFlow?.length) rules.pageFlow = jr.pageFlow;
    if (jr.segmentCount) rules.segmentCount = jr.segmentCount;
    if (jr.pageCount) {
      const nums = String(jr.pageCount).match(/\d+/g);
      if (nums) rules.pageCount = Math.max(...nums.map(Number));
    }
    // under-6 design can optionally override maxWordsPerSpread for older picture-books
    const u = kb?.underSixDesign || {};
    console.log("under-6 design rules:", u);
    if (u.maxWordsPerSpread) rules.maxWordsPerSpread = Number(u.maxWordsPerSpread) || rules.maxWordsPerSpread;

  } else if (mode === 'chapter-book') {
    const mg = kb?.bookFormatting?.middleGrade || {};
    if (mg.wordCount) rules.wordCountTarget = mg.wordCount;
    if (mg.sceneLength) rules.sceneLength = mg.sceneLength;
    if (mg.chapterRhythm?.length) rules.chapterRhythm = mg.chapterRhythm;
    if (mg.frontMatter?.length) rules.frontMatter = mg.frontMatter;
    if (mg.endMatter?.length) rules.endMatter = mg.endMatter;
    // Derive per-chapter word targets (KB > profile defaults)
    if (mg.sceneLength) {
      const n = parseChapterRangeMax(mg.sceneLength); // already handles "300–500" → 500
      if (!isNaN(n) && n > 0) { rules.minChapterWords = Math.round(n * 0.85); rules.maxChapterWords = Math.round(n * 1.15); }
    } else if (mg.wordCount && mg.chapterRange) {
      const total = parseInt(String(mg.wordCount).replace(/[^0-9]/g, ''), 10);
      const chaps = parseChapterRangeMax(mg.chapterRange);
      if (!isNaN(total) && !isNaN(chaps) && chaps > 0) {
        const perCh = Math.round(total / chaps);
        rules.minChapterWords = Math.round(perCh * 0.85);
        rules.maxChapterWords = Math.round(perCh * 1.15);
      }
    }
  }

  return rules;
}

/**
 * Return background scene rules for the current age group.
 * Returns null when KB has no backgroundSettings.
 */
export function resolveBackgroundRules(project, kb) {
  const bg = kb?.backgroundSettings;
  if (!bg) return null;
  const { mode } = getAgeProfile(project.ageRange);
  const groupKey = mode === 'chapter-book' ? 'middleGrade' : 'junior';
  const bgGroup = bg[groupKey] || bg.junior || bg.middleGrade || {};
  return {
    tone: bgGroup.tone || '',
    locations: bgGroup.locations || [],
    colorStyle: bgGroup.colorStyle || '',
    lightingStyle: bgGroup.lightingStyle || '',
    timeOfDay: bgGroup.timeOfDay || '',
    cameraHint: bgGroup.cameraHint || '',
    keyFeatures: bgGroup.keyFeatures || [],
    additionalNotes: bgGroup.additionalNotes || '',
    avoidBackgrounds: bg.avoidBackgrounds || [],
    universalRules: bg.universalRules || '',
  };
}

/**
 * Return du'a objects ready for prompt injection.
 * Each item: { arabic, transliteration, meaning, when }
 */
export function resolveDuaRules(kb) {
  return normArr(kb?.duas || [])
    .filter(d => d.transliteration)
    .map(d => ({
      arabic: d.arabic || '',
      transliteration: d.transliteration,
      meaning: d.meaning || '',
      when: d.when || d.context || '',
    }));
}

/**
 * Return vocabulary objects ready for prompt injection.
 * Each item: { word, definition, example }
 */
export function resolveVocabularyRules(kb) {
  return normArr(kb?.vocabulary || [])
    .filter(v => v.word)
    .map(v => ({ word: v.word, definition: v.definition || '', example: v.example || '' }));
}

/**
 * Build a map of canonicalized character name → KB character guide.
 * Resolves by case-insensitive name match.
 */
export function resolveCharacterGuideMap(characters, kb) {
  const guides = {};
  if (!kb?.characterGuides?.length) return guides;
  const nameIndex = new Map(characters.map(c => [str(c.name).toLowerCase(), str(c.name)]));
  for (const g of kb.characterGuides) {
    const canon = nameIndex.get(str(g.characterName).toLowerCase()) || str(g.characterName);
    if (canon) guides[canon] = g;
  }
  return guides;
}

/**
 * Build the Arabic safety block, seeding the approved list from KB duas first,
 * then filling gaps from the built-in constant map.
 */
export function buildArabicSafetyBlockFromKB(kb) {
  const approved = new Map();
  // Fill from constant fallbacks
  for (const p of Object.values(ARABIC_PHRASES)) {
    approved.set(p.transliteration.toLowerCase(), p);
  }
  // KB duas with arabic override/extend the list
  for (const d of normArr(kb?.duas || [])) {
    if (d.arabic && d.transliteration) {
      approved.set(d.transliteration.toLowerCase(), {
        arabic: d.arabic,
        transliteration: d.transliteration,
        meaning: d.meaning || '',
      });
    }
  }
  const list = [...approved.values()]
    .map(p => `  • ${p.transliteration}: "${p.arabic}" — ${p.meaning}`)
    .join('\n');
  return `ARABIC RULES (CRITICAL — violations break the book):
1. NEVER generate Arabic script yourself
2. ONLY use exact Unicode strings from this approved list:
${list}
3. If phrase is NOT in the list, use ONLY the transliteration
4. Always return: { arabic, transliteration, meaning } as separate fields`;
}

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

/**
 * Escape literal control characters (newlines, tabs, carriage returns) that
 * appear INSIDE JSON string values. The AI occasionally writes multi-paragraph
 * chapterText with raw newlines, which makes JSON.parse fail even though the
 * JSON structure is otherwise valid.
 */
function fixJsonStrings(text) {
  if (!text || typeof text !== 'string') return text;
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { continue; }           // strip bare CR
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

function safeParse(text) {
  if (!text) return { ok: false, data: { raw: text } };

  const clean = stripFences(text);

  // ── Attempt 1: direct parse ───────────────────────────────────────────────
  try {
    const parsed = JSON.parse(clean);
    return { ok: true, data: parsed };
  } catch (_) { }

  // ── Attempt 2: fix unescaped control chars inside strings, then parse ─────
  try {
    const fixed = fixJsonStrings(clean);
    const parsed = JSON.parse(fixed);
    console.warn('[TextService] JSON recovered by fixing unescaped string chars');
    return { ok: true, data: parsed };
  } catch (_) { }

  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');

  // ── Attempt 3: brace-slice then fix ──────────────────────────────────────
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const slice = fixJsonStrings(clean.slice(firstBrace, lastBrace + 1));
      const parsed = JSON.parse(slice);
      console.warn('[TextService] JSON recovered via brace-slicing');
      return { ok: true, data: parsed };
    } catch (_) { }
  }

  // ── Attempt 4: close truncated structure then fix ─────────────────────────
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

      if (inString) partial += '"';           // close open string cleanly
      while (openBrackets > 0) { partial += ']'; openBrackets--; }
      while (openBraces > 0) { partial += '}'; openBraces--; }

      const parsed = JSON.parse(fixJsonStrings(partial));
      console.warn('[TextService] JSON recovered by closing truncated structure');
      return { ok: true, data: parsed };
    } catch (_) { }
  }

  // ── Attempt 5: regex field extraction (truncated chapter / spread responses)
  //    Recovers the most important text fields even when the JSON is cut off
  //    mid-value and Attempts 1-4 all fail.
  try {
    /**
     * Extract the full value of a JSON string field, tolerating a missing
     * closing quote (i.e. the response was truncated inside that string).
     *
     * Strategy:
     *  1. Find  "fieldName"  :  "  in the raw text.
     *  2. Walk forward character-by-character, honouring JSON escape sequences.
     *  3. Stop at an unescaped closing quote OR at end-of-string.
     *  4. Return whatever we collected (possibly partial but still useful).
     */
    const extractStr = (field) => {
      // Match opening:  "fieldName"   :   "
      const startRe = new RegExp(`"${field}"\\s*:\\s*"`);
      const startMatch = clean.match(startRe);
      if (!startMatch) return null;

      let i = startMatch.index + startMatch[0].length;
      let result = '';
      let esc = false;

      while (i < clean.length) {
        const ch = clean[i++];

        if (esc) {
          // Decode common JSON escapes back to real characters
          switch (ch) {
            case 'n': result += '\n'; break;
            case 't': result += '\t'; break;
            case 'r': result += '\r'; break;
            case '"': result += '"'; break;
            case '\\': result += '\\'; break;
            default: result += ch; break;
          }
          esc = false;
          continue;
        }

        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') break;          // clean end of string value
        result += ch;
      }

      return result || null;
    };

    /** Extract a numeric field value. */
    const extractNum = (field) => {
      const m = clean.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`));
      return m ? Number(m[1]) : null;
    };

    /**
     * Extract a JSON array field as a raw string, then try to parse it.
     * Returns [] on any failure.
     */
    const extractArr = (field) => {
      const startRe = new RegExp(`"${field}"\\s*:\\s*\\[`);
      const startMatch = clean.match(startRe);
      if (!startMatch) return [];

      let i = startMatch.index + startMatch[0].length - 1; // points at '['
      let depth = 0;
      let inStr = false;
      let esc = false;
      let fragment = '';

      while (i < clean.length) {
        const ch = clean[i++];
        fragment += ch;

        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '[') depth++;
        if (ch === ']') { depth--; if (depth === 0) break; }
      }

      // Close any open structure if the array was truncated
      if (depth > 0) { while (depth-- > 0) fragment += ']'; }

      try { return JSON.parse(fixJsonStrings(fragment)); } catch (_) { return []; }
    };

    // ── Pull every field we care about ──────────────────────────────────────

    // Shared / chapter-book fields
    const chapterNumber = extractNum('chapterNumber');
    const chapterTitle = extractStr('chapterTitle');
    const chapterText = extractStr('chapterText');
    const chapterSummary = extractStr('chapterSummary');
    const islamicMoment = extractStr('islamicMoment');
    const illustrationMoments = extractArr('illustrationMoments');

    // Picture-book / spread fields
    const spreadOnly = /\"spreadOnly\"\s*:\s*true/i.test(clean);
    const totalSpreads = extractNum('totalSpreads');
    const spreads = extractArr('spreads');

    // Story / outline fields
    const bookTitle = extractStr('bookTitle');
    const synopsis = extractStr('synopsis');
    const moral = extractStr('moral');
    const storyText = extractStr('storyText');
    const dedicationMsg = extractStr('dedicationMessage');

    // Humanize field
    const changesMade = extractArr('changesMade');

    // ── Decide which recovery payload makes sense ────────────────────────────

    // Chapter-book chapter
    if (chapterText && chapterText.length > 80) {
      console.warn('[TextService] JSON recovered via regex extraction (chapter-book chapter)');
      return {
        ok: true,
        data: {
          chapterNumber: chapterNumber ?? 1,
          chapterTitle: chapterTitle ?? `Chapter ${chapterNumber ?? 1}`,
          chapterText,
          chapterSummary: chapterSummary ?? '',
          islamicMoment: islamicMoment ?? '',
          illustrationMoments: illustrationMoments.length ? illustrationMoments : [],
          changesMade: changesMade.length ? changesMade : [],
          _truncated: true,
        },
      };
    }

    // Picture-book chapter (has spreads array but no chapterText)
    if (spreads.length > 0 && chapterNumber !== null) {
      console.warn('[TextService] JSON recovered via regex extraction (picture-book chapter)');
      return {
        ok: true,
        data: {
          chapterNumber: chapterNumber ?? 1,
          chapterTitle: chapterTitle ?? `Chapter ${chapterNumber ?? 1}`,
          chapterSummary: chapterSummary ?? '',
          islamicMoment: islamicMoment ?? '',
          spreads,
          changesMade: changesMade.length ? changesMade : [],
          _truncated: true,
        },
      };
    }

    // Spreads-only book
    if (spreads.length > 0 && spreadOnly) {
      console.warn('[TextService] JSON recovered via regex extraction (spreads-only)');
      return {
        ok: true,
        data: {
          spreadOnly: true,
          totalSpreads: totalSpreads ?? spreads.length,
          spreads,
          changesMade: changesMade.length ? changesMade : [],
          _truncated: true,
        },
      };
    }

    // Story / outline
    if (bookTitle || storyText || synopsis) {
      console.warn('[TextService] JSON recovered via regex extraction (story/outline)');
      return {
        ok: true,
        data: {
          bookTitle: bookTitle ?? '',
          synopsis: synopsis ?? '',
          moral: moral ?? '',
          storyText: storyText ?? '',
          dedicationMessage: dedicationMsg ?? '',
          characters: extractArr('characters'),
          chapterOutline: extractArr('chapterOutline'),
          chapters: extractArr('chapters'),
          _truncated: true,
        },
      };
    }

    // Nothing useful recovered — fall through to hard failure
  } catch (regexErr) {
    console.warn('[TextService] Regex extraction attempt threw:', regexErr?.message);
  }

  // ── All attempts exhausted ────────────────────────────────────────────────
  console.error('[TextService] All JSON parse attempts failed');
  console.error('[TextService] Raw preview:', text?.slice(0, 400));
  return { ok: false, data: { raw: text } };
}

// ─── Arabic safety block ──────────────────────────────────────────────────────

const ARABIC_PHRASES = {
  bismillah: { arabic: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', transliteration: 'Bismillah ir-Rahman ir-Raheem', meaning: 'In the name of Allah, the Most Gracious, the Most Merciful' },
  alhamdulillah: { arabic: 'الْحَمْدُ لِلَّهِ', transliteration: 'Alhamdulillah', meaning: 'All praise is for Allah' },
  subhanallah: { arabic: 'سُبْحَانَ اللَّهِ', transliteration: 'SubhanAllah', meaning: 'Glory be to Allah' },
  allahu_akbar: { arabic: 'اللَّهُ أَكْبَرُ', transliteration: 'Allahu Akbar', meaning: 'Allah is the Greatest' },
  inshallah: { arabic: 'إِنْ شَاءَ اللَّهُ', transliteration: "In sha' Allah", meaning: 'If Allah wills' },
  mashallah: { arabic: 'مَا شَاءَ اللَّهُ', transliteration: "Masha' Allah", meaning: 'What Allah has willed' },
  assalamu_alaykum: { arabic: 'السَّلَامُ عَلَيْكُمْ', transliteration: 'Assalamu Alaykum', meaning: 'Peace be upon you' },
  jazakallah_khair: { arabic: 'جَزَاكَ اللَّهُ خَيْرًا', transliteration: 'Jazakallah Khair', meaning: 'May Allah reward you with goodness' },
  astaghfirullah: { arabic: 'أَسْتَغْفِرُ اللَّهَ', transliteration: 'Astaghfirullah', meaning: 'I seek forgiveness from Allah' },
  sabr: { arabic: 'صَبْر', transliteration: 'Sabr', meaning: 'Patience' },
  tawakkul: { arabic: 'تَوَكُّل', transliteration: 'Tawakkul', meaning: 'Trust in Allah' },
  shukr: { arabic: 'شُكْر', transliteration: 'Shukr', meaning: 'Gratitude' },
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

function kbBlock(kb, opts = {}) {
  if (!kb) return '';
  const lines = [`KNOWLEDGE BASE: ${kb.name}`];

  if (kb.islamicValues?.length) lines.push(`Islamic Values: ${kb.islamicValues.join(', ')}`);
  if (kb.avoidTopics?.length) lines.push(`Avoid Topics: ${kb.avoidTopics.join(', ')}`);

  // ── Du'as ────────────────────────────────────────────────────────────────
  if (kb.duas?.length) {
    const duaLines = kb.duas.map(d => {
      const parts = [];
      if (d.transliteration) parts.push(d.transliteration);
      if (d.meaning) parts.push(`"${d.meaning}"`);
      if (d.when) parts.push(`(when: ${d.when})`);
      return parts.join(' — ');
    }).filter(Boolean);
    if (duaLines.length) lines.push(`Du'as to weave naturally into story: ${duaLines.join(' | ')}`);
  }

  // ── Vocabulary ────────────────────────────────────────────────────────────
  if (kb.vocabulary?.length) {
    const vocabLines = kb.vocabulary.map(v => {
      if (!v.word) return null;
      let entry = v.word;
      if (v.definition) entry += ` (${v.definition})`;
      if (v.example) entry += ` — e.g. "${v.example}"`;
      return entry;
    }).filter(Boolean);
    if (vocabLines.length) lines.push(`Islamic Vocabulary (use naturally in prose): ${vocabLines.join(' | ')}`);
  }

  // ── Background settings (fed into both text + image prompts) ────────────
  if (kb.backgroundSettings) {
    const bg = kb.backgroundSettings;
    const targetGroup = opts.ageGroup === 'underSix' ? 'junior' : (opts.ageGroup || 'junior');
    const bgGroup = bg[targetGroup] || bg.junior;
    if (bgGroup) {
      if (bgGroup.tone) lines.push(`Background Tone: ${bgGroup.tone}`);
      if (bgGroup.locations?.length) lines.push(`Preferred Locations: ${bgGroup.locations.join(', ')}`);
      if (bgGroup.colorStyle) lines.push(`Color Style: ${bgGroup.colorStyle}`);
      if (bgGroup.lightingStyle) lines.push(`Lighting Style: ${bgGroup.lightingStyle}`);
      if (bgGroup.timeOfDay) lines.push(`Default Time of Day: ${bgGroup.timeOfDay}`);
      if (bgGroup.cameraHint) lines.push(`Default Camera Hint: ${bgGroup.cameraHint}`);
      if (bgGroup.keyFeatures?.length) lines.push(`Scene Key Features: ${bgGroup.keyFeatures.join(', ')}`);
    }
    if (bg.avoidBackgrounds?.length) lines.push(`Avoid Backgrounds: ${bg.avoidBackgrounds.join(', ')}`);
    if (bg.universalRules) lines.push(`Background Universal Rules: ${bg.universalRules}`);
  }

  // ── Book formatting (text-gen guide) ───────────────────────────────────
  if (opts.ageGroup === 'middleGrade' && kb.bookFormatting?.middleGrade) {
    const f = kb.bookFormatting.middleGrade;
    if (f.wordCount) lines.push(`Target Word Count: ${f.wordCount}`);
    if (f.chapterRange) lines.push(`Chapter Count: ${f.chapterRange}`);
    if (f.sceneLength) lines.push(`Scene Length: ${f.sceneLength}`);
    if (f.chapterRhythm?.length) lines.push(`Chapter Rhythm: ${f.chapterRhythm.join(' → ')}`);
  }
  if (opts.ageGroup === 'junior' && kb.bookFormatting?.junior) {
    const f = kb.bookFormatting.junior;
    if (f.wordCount) lines.push(`Target Word Count: ${f.wordCount}`);
    if (f.pageFlow?.length) lines.push(`Page Flow: ${f.pageFlow.join(' → ')}`);
  }

  // ── Under-6 / Spreads-only design prefs ────────────────────────────────
  if (opts.ageGroup === 'underSix' && kb.underSixDesign) {
    const u = kb.underSixDesign;
    if (u.maxWordsPerSpread) lines.push(`Max Words Per Spread: ${u.maxWordsPerSpread}`);
    if (u.pageLayout) lines.push(`Page Layout: ${u.pageLayout}`);
    if (u.fontStyle) lines.push(`Font Style: ${u.fontStyle}`);
    if (u.reflectionPrompt) lines.push(`Reflection Prompt: ${u.reflectionPrompt}`);
    if (u.specialRules?.length) lines.push(`Special Rules: ${u.specialRules.join('; ')}`);
  }

  // ── Character guides (voice + faith, matched by name/id) ───────────────
  if (opts.characterNames?.length && kb.characterGuides?.length) {
    const names = opts.characterNames.map(n => n.toLowerCase());
    const matched = kb.characterGuides.filter(
      g => names.includes((g.characterName || '').toLowerCase())
    );
    for (const g of matched) {
      const f = g.faithGuide || {};
      lines.push(`\nVOICE GUIDE — ${g.characterName} (non-negotiable):`);
      if (g.literaryRole) lines.push(`  Role: ${g.literaryRole}`);
      if (g.speakingStyle) lines.push(`  Voice: ${g.speakingStyle} — every dialogue line must match this exactly`);
      if (g.moreInfo) lines.push(`  Background: ${g.moreInfo}`);
      if (f.faithTone) lines.push(`  Faith expression: ${f.faithTone} — woven naturally, never as a lecture`);
      if (f.duaStyle) lines.push(`  Du'a style: ${f.duaStyle}`);
      if (f.islamicTraits?.length) lines.push(`  Good qualities (show through actions): ${f.islamicTraits.join(', ')}`);
      if (f.faithExpressions?.length) lines.push(`  Habitual behaviours: ${f.faithExpressions.join('; ')}`);
      const allEx = [...(f.faithExamples || []), ...(g.dialogueExamples || [])].filter(Boolean).slice(0, 4);
      if (allEx.length) lines.push(`  Voice examples: ${allEx.map(e => `"${e.replace(/^"|"$/g, '')}"`).join(' | ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the KB context block injected into every system prompt.
 * Calls the typed resolvers so KB values drive the content.
 */
function buildKbBlock(project, kb, characters = []) {
  if (!kb) return '';
  const rules = resolveFormattingRules(project, kb);
  const bgRules = resolveBackgroundRules(project, kb);
  const duas = resolveDuaRules(kb);
  const vocab = resolveVocabularyRules(kb);
  const guideMap = resolveCharacterGuideMap(characters, kb);
  const lines = [`KNOWLEDGE BASE: ${kb.name}`];

  // ── Faith layer ────────────────────────────────────────────────────────────
  if (kb.islamicValues?.length)
    lines.push(`Islamic Values (weave naturally — do not preach): ${kb.islamicValues.join(', ')}`);
  if (kb.avoidTopics?.length)
    lines.push(`⛔ Avoid These Topics Entirely: ${kb.avoidTopics.join(', ')}`);

  // ── Du'as ──────────────────────────────────────────────────────────────────
  if (duas.length) {
    const formatted = duas.map(d => {
      const parts = [d.transliteration, d.meaning ? `"${d.meaning}"` : '', d.when ? `(when: ${d.when})` : ''];
      return parts.filter(Boolean).join(' — ');
    });
    lines.push(`Du'as — place naturally at fitting story moments: ${formatted.join(' | ')}`);
  }

  // ── Vocabulary ─────────────────────────────────────────────────────────────
  if (vocab.length) {
    const formatted = vocab.map(v => {
      let s = v.word;
      if (v.definition) s += ` (${v.definition})`;
      if (v.example) s += ` — e.g. "${v.example}"`;
      return s;
    });
    lines.push(`Islamic Vocabulary (use naturally, do not define in prose): ${formatted.join(' | ')}`);
  }

  // ── Background rules ───────────────────────────────────────────────────────
  if (bgRules) {
    if (bgRules.tone) lines.push(`Scene Tone: ${bgRules.tone}`);
    if (bgRules.locations?.length) lines.push(`Preferred Locations: ${bgRules.locations.join(', ')}`);
    if (bgRules.colorStyle) lines.push(`Color Style: ${bgRules.colorStyle}`);
    if (bgRules.lightingStyle) lines.push(`Lighting: ${bgRules.lightingStyle}`);
    if (bgRules.timeOfDay) lines.push(`Default Time of Day: ${bgRules.timeOfDay}`);
    if (bgRules.cameraHint) lines.push(`Default Camera Hint: ${bgRules.cameraHint}`);
    if (bgRules.keyFeatures?.length) lines.push(`Key Visual Features: ${bgRules.keyFeatures.join(', ')}`);
    if (bgRules.additionalNotes) lines.push(`Scene Notes: ${bgRules.additionalNotes}`);
    if (bgRules.avoidBackgrounds?.length) lines.push(`⛔ Avoid Backgrounds: ${bgRules.avoidBackgrounds.join(', ')}`);
    if (bgRules.universalRules) lines.push(`Universal Scene Rule: ${bgRules.universalRules}`);
  }

  // ── Format rules (book-type-specific) ─────────────────────────────────────
  if (rules.mode === 'chapter-book') {
    if (rules.wordCountTarget) lines.push(`Total Word Count Target: ${rules.wordCountTarget}`);
    if (rules.sceneLength) lines.push(`Scene Length: ${rules.sceneLength}`);
    if (rules.chapterRhythm?.length) lines.push(`Chapter Rhythm: ${rules.chapterRhythm.join(' → ')}`);
    if (rules.frontMatter?.length) lines.push(`Front Matter: ${rules.frontMatter.join(', ')}`);
    if (rules.endMatter?.length) lines.push(`End Matter: ${rules.endMatter.join(', ')}`);
  } else if (rules.mode === 'picture-book') {
    if (rules.wordCountTarget) lines.push(`Total Word Count: ${rules.wordCountTarget}`);
    if (rules.pageFlow?.length) lines.push(`Page Flow: ${rules.pageFlow.join(' → ')}`);
    if (rules.segmentCount) lines.push(`Segment Count: ${rules.segmentCount}`);
  } else if (rules.mode === 'spreads-only') {
    if (rules.maxWordsPerSpread) lines.push(`Max Words Per Spread: ${rules.maxWordsPerSpread}`);
    if (rules.pageLayout) lines.push(`Page Layout: ${rules.pageLayout}`);
    if (rules.readingType) lines.push(`Reading Type: ${rules.readingType}`);
    if (rules.illustrationStyle) lines.push(`Illustration Style: ${rules.illustrationStyle}`);
    if (rules.colorPalette) lines.push(`Color Palette: ${rules.colorPalette}`);
    if (rules.specialRules?.length) lines.push(`Special Rules: ${rules.specialRules.join('; ')}`);
    if (rules.reflectionPrompt) lines.push(`Reflection Prompt (last spread): "${rules.reflectionPrompt}"`);
    if (rules.bonusPageContent) lines.push(`Bonus Page: ${rules.bonusPageContent}`);
    if (rules.emotionalPattern) {
      const ep = rules.emotionalPattern;
      const parts = [ep.conflictOrQuestion, ep.emotionReaction, ep.resolve].filter(Boolean);
      if (parts.length) lines.push(`Emotional Pattern Per Segment: ${parts.join(' → ')}`);
    }
  }

  // ── Character guides (voice + faith — injected as precise AI directives) ────
  for (const [name, g] of Object.entries(guideMap)) {
    const f = g.faithGuide || {};
    const block = [`\n━━ CHARACTER VOICE LOCK — ${name} (follow exactly) ━━`];

    // Story role
    if (g.literaryRole) block.push(`  STORY ROLE: ${g.literaryRole}`);

    // Speaking voice — highest priority for dialogue generation
    if (g.speakingStyle) {
      block.push(`  SPEAKING VOICE: ${g.speakingStyle}`);
      block.push(`  → Every line of ${name}'s dialogue must match this voice. No exceptions.`);
    }

    // Personality depth
    if (g.personalityNotes?.length) block.push(`  PERSONALITY: ${g.personalityNotes.join('; ')}`);
    if (g.moreInfo) block.push(`  BACKGROUND: ${g.moreInfo}`);

    // Faith character — how Islam shows in their behaviour, never lecturing
    const faithParts = [];
    if (f.faithTone) faithParts.push(`Faith expression: ${f.faithTone}`);
    if (f.duaStyle) faithParts.push(`Du'a style: ${f.duaStyle}`);
    if (faithParts.length) {
      block.push(`  FAITH CHARACTER: ${faithParts.join(' | ')}`);
      block.push(`  → Weave faith naturally into actions and speech — never as a lecture or explanation.`);
    }

    // Good qualities shown through behaviour
    if (f.islamicTraits?.length) {
      block.push(`  GOOD QUALITIES (show through actions, not statements): ${f.islamicTraits.join(', ')}`);
    }

    // Habitual behaviours
    if (f.faithExpressions?.length) {
      block.push(`  HABITUAL BEHAVIOURS: ${f.faithExpressions.join('; ')}`);
    }

    // Authentic voice examples — AI must match this register
    const allExamples = [
      ...(f.faithExamples || []),
      ...(g.dialogueExamples || []),
    ].filter(Boolean);
    if (allExamples.length) {
      block.push(`  VOICE EXAMPLES (match this register and energy):`);
      allExamples.slice(0, 5).forEach(ex => block.push(`    • ${ex}`));
    }

    lines.push(block.join('\n'));
  }

  return lines.join('\n');
}

// Keep legacy alias so any code calling buildKbOpts(project, chars) still resolves
// to the correct ageGroup without crashing. New prompt builders use buildKbBlock directly.
function buildKbOpts(project, characters = []) {
  const { mode } = getAgeProfile(project?.ageRange);
  return {
    ageGroup: mode === 'spreads-only' ? 'underSix' : mode === 'picture-book' ? 'junior' : 'middleGrade',
    characterNames: characters.map(c => c.name).filter(Boolean),
  };
}

function characterBlock(characters) {
  if (!characters?.length) return 'No specific approved characters defined.';
  return `APPROVED CHARACTERS (use ONLY these exact names):
${characters.map(c => {
    const vd = c.visualDNA || {};
    const mod = c.modestyRules || {};
    return `  • ${c.name} — ${c.role}, age ${c.ageRange}, ${vd.gender || 'child'}
    Traits: ${(c.traits || []).join(', ')}
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
  const chapterCount = resolveChapterCount(ctx.project, ctx.kb);

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

  const chapterCount = Number(parsed.chapterCount) || resolveChapterCount(ctx.project, ctx.kb);
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
  const rules = resolveFormattingRules(project, kb);
  const arabic = buildArabicSafetyBlockFromKB(kb);
  const charBlock = characterBlock(characters);

  const poseConstraint = characters.length
    ? `POSE RULES:
- Use ONLY these approved poses: ${[...new Set(characters.flatMap(c => c.approvedPoseKeys || []))].join(', ') || 'standing, sitting, walking, thinking, reading-quran, praying-salah'}
- Every illustrationMoment MUST include a valid poseKey from the list above
- The story prose must DESCRIBE the action matching the poseKey`
    : '';

  // Format description derived from resolved rules (KB-first)f
  const formatDesc = rules.mode === 'spreads-only'
    ? `SPREADS-ONLY PICTURE BOOK for ages ${project.ageRange}:
  - NO chapters — just illustrated pages with short text
  - Max ${rules.maxWordsPerSpread} words/page${rules.pageLayout ? `\n  - Layout: ${rules.pageLayout}` : ''}
  - Simple, warm, complete sentences — each page one complete thought
  - Reading type: ${rules.readingType}${rules.wordCountTarget ? `\n  - Story total target: ${rules.wordCountTarget}` : '\n  - Story total: 300–500 words flowing narrative'}`
    : rules.mode === 'picture-book'
      ? `PICTURE BOOK for ages ${project.ageRange}:
  - Simple chapters with illustrated spreads
  - Max ${rules.maxWordsPerSpread} words per spread${rules.wordCountTarget ? `\n  - Total word target: ${rules.wordCountTarget}` : '\n  - Story total: 400–700 words'}${rules.pageFlow.length ? `\n  - Page Flow: ${rules.pageFlow.join(' → ')}` : ''}`
      : `CHAPTER BOOK for ages ${project.ageRange}:
  - storyText must be a full-book synopsis (not chapter prose)
  - Chapters: ${rules.chapterCount}${rules.wordCountTarget ? `\n  - Total word target: ${rules.wordCountTarget}` : '\n  - Keep storyText 500–900 words'}${rules.chapterRhythm.length ? `\n  - Chapter Rhythm: ${rules.chapterRhythm.join(' → ')}` : ''}`;

  const system = `You are an expert Islamic children's book author.
Book Format:
${formatDesc}

${universeBlock(universe)}
${buildKbBlock(project, kb, characters)}
${charBlock}
${poseConstraint}
${arabic}

CRITICAL RULES:
- Use ONLY approved character names exactly as given
- Every chapter/spread/scene must use exact approved character names
- Do NOT invent unnamed family members or generic labels
- Output ONLY raw valid JSON. NO markdown fences. Start with { end with }`;

  const chapterBookExtra = rules.mode === 'chapter-book' ? `
This is a CHAPTER BOOK for ages ${project.ageRange}.
The "storyText" field must be a SYNOPSIS (500–900 words), NOT full chapter prose.
Also include "chapterOutline" with EXACTLY ${rules.chapterCount} chapters.${rules.chapterRhythm.length ? `\nFollow this chapter rhythm: ${rules.chapterRhythm.join(' → ')}` : ''}
Each chapter must include:
- title, goal, keyScene, islamicMoment, endingBeat, charactersInScene
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
- Teach Islamic values naturally (use KB values if provided)
- Feature only approved characters
- Use KB du'as at fitting story moments
- Use KB vocabulary naturally in prose
- Have a clear story arc with a memorable Islamic moral

Respond ONLY with this JSON:
{
  "bookTitle": "string",
  "synopsis": "2-3 sentence summary",
  "moral": "specific Islamic lesson",
  "storyText": "${rules.mode === 'chapter-book' ? '500–900 word narrative synopsis of the full arc' : '300–600 word complete story'}",
  "suggestedPageCount": ${rules.mode === 'chapter-book' ? 0 : rules.pageCount},
  "suggestedChapterCount": ${rules.mode === 'chapter-book' ? rules.chapterCount : 0},
  "spreadOnly": ${rules.spreadOnly},
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
  ]${rules.mode === 'chapter-book' ? `,
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
  const rules = resolveFormattingRules(project, kb);
  const arabic = buildArabicSafetyBlockFromKB(kb);
  const charBlock = characterBlock(characters);
  const poseConstraint = characters.length
    ? `POSE RULES:
- Use ONLY these approved poses: ${[...new Set(characters.flatMap(c => c.approvedPoseKeys || []))].join(', ') || 'standing, sitting, walking, thinking, reading-quran, praying-salah'}
- Every spread MUST include a valid poseKey from the list above`
    : '';
  const storyText = project.artifacts?.storyText || project.artifacts?.outline?.synopsis || '';
  const bookStyle = project.bookStyle || {};
  const spreadCount = rules.spreadCount;

  const textRules = rules.mode === 'spreads-only'
    ? `TEXT RULES FOR AGE ${project.ageRange}:
- Each page gets EXACTLY ONE complete natural sentence
- Max ${rules.maxWordsPerSpread} words${rules.pageLayout ? `\n- Layout: ${rules.pageLayout}` : ''}
- Reading type: ${rules.readingType}
- Warm, gentle, grammatically complete`
    : `TEXT RULES FOR AGE ${project.ageRange}:
- 1-2 complete sentences per spread
- Max ${rules.maxWordsPerSpread} words${rules.pageFlow.length ? `\n- Follow page flow: ${rules.pageFlow.join(' → ')}` : ''}
- Clear, warm narrative prose`;

  const system = `You are an expert Islamic children's picture book author and illustrator.
Age: ${project.ageRange} — Mode: ${rules.mode}

${textRules}

${universeBlock(universe)}
${buildKbBlock(project, kb, characters)}
${charBlock}
${poseConstraint}
${arabic}

CRITICAL RULES:
- Use only approved character names exactly
- Every spread must include charactersInScene using approved names
- Weave KB du'as and vocabulary naturally — do not force them
- Return strict structured JSON only
- Output ONLY raw valid JSON. Start with { end with }`;

  const prompt = `Break this story into ${spreadCount} illustrated spreads.

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
  "spreadOnly": ${rules.spreadOnly},
  "totalSpreads": ${spreadCount},
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "${rules.mode === 'spreads-only' ? `ONE complete natural sentence, max ${rules.maxWordsPerSpread} words` : `1-2 sentences, max ${rules.maxWordsPerSpread} words`}",
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

// ═══════════════bu═══════════════════════════════════════════════════════════════
// STEP 2b: PICTURE BOOK CHAPTER GENERATION
// ══════════════════════════════════════════════════════════════════════════════

function buildPictureBookChapterPrompt({ project, universe, characters, kb }, chapterIndex) {
  const rules = resolveFormattingRules(project, kb);
  const outline = project.artifacts?.outline;
  const outlineChapters = normArr(outline?.chapters);
  const chapterOutline = outlineChapters[chapterIndex];
  const arabic = buildArabicSafetyBlockFromKB(kb);
  const sceneChars = (chapterOutline?.charactersInScene || []).length
    ? characters.filter(c => chapterOutline.charactersInScene.includes(c.name))
    : characters;

  const poseConstraint = sceneChars.length
    ? `POSE RULES:
- Use ONLY these approved poses: ${[...new Set(sceneChars.flatMap(c => c.approvedPoseKeys || []))].join(', ') || 'standing, sitting, walking, thinking, reading-quran, praying-salah'}
- Every spread MUST include a valid poseKey from the list above`
    : '';

  const system = `You are an expert Islamic children's picture book author.
PICTURE BOOK for ages ${project.ageRange}. MAX ${rules.maxWordsPerSpread} words per spread.
Each spread = one illustrated page with 1-2 short sentences.${rules.pageLayout ? `\nPage Layout: ${rules.pageLayout}` : ''}${rules.pageFlow.length ? `\nPage Flow: ${rules.pageFlow.join(' → ')}` : ''}
${universeBlock(universe)}
${buildKbBlock(project, kb, sceneChars)}
${characterBlock(sceneChars)}
${poseConstraint}
${arabic}

CRITICAL RULES:
- Use charactersInScene, not charactersInSpread
- Use only exact approved character names
- Weave KB du'as and vocabulary naturally at fitting moments
- Return strict raw JSON only`;

  return {
    system,
    prompt: `Write Chapter ${chapterIndex + 1} of "${project.title}".
Chapter: ${chapterOutline?.title || `Chapter ${chapterIndex + 1}`}
Goal: ${chapterOutline?.goal || ''}
Key Scene: ${chapterOutline?.keyScene || ''}
Islamic Moment: ${chapterOutline?.duaHint || 'A natural Islamic value or faith moment'}
Characters in this chapter: ${sceneChars.map(c => c.name).join(', ')}
MAX ${rules.maxWordsPerSpread} words per spread text.

Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "chapterSummary": "1-2 sentence summary",
  "islamicMoment": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "1-2 clear sentences, max ${rules.maxWordsPerSpread} words",
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
  // All word targets, rhythm, and formatting come from resolved rules (KB-first)
  const rules = resolveFormattingRules(project, kb);
  const { minChapterWords, maxChapterWords } = rules;

  const outline = project.artifacts?.outline || {};
  const chapterOutline = normArr(outline?.chapters || [])[chapterIndex];
  const storyText = project.artifacts?.storyText || '';
  const arabic = buildArabicSafetyBlockFromKB(kb);
  const bookStyle = project.bookStyle || {};

  const totalChapters = normArr(outline?.chapters || []).length || rules.chapterCount;

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

  const poseConstraint = sceneChars.length
    ? `POSE RULES:
- Use ONLY these approved poses: ${[...new Set(sceneChars.flatMap(c => c.approvedPoseKeys || []))].join(', ') || 'standing, sitting, walking, thinking, reading-quran, praying-salah'}
- Every illustrationMoment MUST include a valid poseKey from the list above
- The story prose must DESCRIBE the action matching the poseKey`
    : '';

  const rhythmHint = rules.chapterRhythm.length
    ? `Chapter Rhythm Guide: ${rules.chapterRhythm.join(' → ')}`
    : '';

  const perChapterTarget = minChapterWords && maxChapterWords
    ? `${minChapterWords}–${maxChapterWords}`
    : null;
  const totalWordBudget = rules.wordCountTarget
    ? `Total book word budget: ${rules.wordCountTarget} across ${totalChapters} chapters (~${Math.round(parseInt(String(rules.wordCountTarget).replace(/[^0-9]/g, ''), 10) / totalChapters) || maxChapterWords} words per chapter).`
    : '';

  const system = `You are an expert Islamic children's chapter book author for ages ${project.ageRange}.

This is a REAL CHAPTER BOOK, not a spread-based picture book.

⚠ WORD COUNT — HARD LIMITS (most important rule):
- This chapter MUST be ${perChapterTarget || `${minChapterWords}–${maxChapterWords}`} words.
- ${totalWordBudget}
- DO NOT stop before reaching ${minChapterWords} words — a chapter under ${minChapterWords} words is INCOMPLETE.
- DO NOT exceed ${maxChapterWords} words.
- If you finish a scene early, extend with more dialogue, inner reflection, or sensory detail until you hit the minimum.

CRITICAL WRITING RULES:
- Write ONE full prose chapter
- Length: EXACTLY ${perChapterTarget || `${minChapterWords}–${maxChapterWords}`} words${rules.sceneLength ? ` (scene length guide: ${rules.sceneLength})` : ''}
- Third-person past tense
- Novel-like, immersive, warm, adventurous
- Preserve continuity with earlier chapters
- Use strong scene-setting, dialogue, emotion, atmosphere
- Integrate Islamic values, KB du'as, and KB vocabulary naturally
- End with curiosity, suspense, discovery, or emotional shift
${rhythmHint}

${universeBlock(universe)}
${buildKbBlock(project, kb, sceneChars)}
${characterBlock(sceneChars)}
${poseConstraint}
${arabic}

CRITICAL STRUCTURE RULES:
- Return exactly 2 illustrationMoments max
- Each illustrationMoment must be an object, not a string
- Use exact approved character names only
- Output ONLY raw valid JSON — no markdown fences, no code blocks
- In the chapterText field, separate paragraphs with \\n\\n (escaped newline), NOT literal line breaks
- Do NOT use unescaped double quotes inside string values`;

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
Setting Reference: ${bookStyle.backgroundStyle === 'indoor'
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
  "chapterText": "Full prose chapter — MUST be ${minChapterWords}–${maxChapterWords} words. Hard limit: ${maxChapterWords} words.",
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
  const rules = resolveFormattingRules(project, kb);
  const arabic = buildArabicSafetyBlockFromKB(kb);
  const outline = project.artifacts?.outline;
  const count = normArr(outline?.spreads || []).length || rules.spreadCount;

  const emotionalPatternHint = rules.emotionalPattern
    ? `Emotional Pattern Per Segment: ${[rules.emotionalPattern.conflictOrQuestion, rules.emotionalPattern.emotionReaction, rules.emotionalPattern.resolve].filter(Boolean).join(' → ')}`
    : '';

  const system = `You are an expert Islamic picture book author for very young children (ages ${project.ageRange}).

SENTENCE RULES:
- Every "text" field MUST be one complete grammatical sentence
- Max ${rules.maxWordsPerSpread} words${rules.pageLayout ? `\n- Layout: ${rules.pageLayout}` : ''}
- Reading type: ${rules.readingType}
- Each sentence carries one clear warm emotional moment
- The ${count} sentences together tell a complete story arc
${emotionalPatternHint}${rules.reflectionPrompt ? `\n- Final spread reflection prompt: "${rules.reflectionPrompt}"` : ''}${rules.bonusPageContent ? `\n- Bonus page: ${rules.bonusPageContent}` : ''}${rules.specialRules.length ? `\n- Special Rules: ${rules.specialRules.join('; ')}` : ''}

${universeBlock(universe)}
${buildKbBlock(project, kb, characters)}
${characterBlock(characters)}
${arabic}

CRITICAL RULES:
- Use only exact approved character names
- Weave KB du'as and vocabulary naturally at fitting moments
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
      "text": "ONE complete grammatical sentence, max ${rules.maxWordsPerSpread} words",
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
  const rules = resolveFormattingRules(project, kb);
  const arabic = buildArabicSafetyBlockFromKB(kb);

  const system = `You are an expert Islamic children's book author.
${universeBlock(universe)}
${buildKbBlock(project, kb, characters)}
${characterBlock(characters)}
${arabic}

CRITICAL RULES:
- Use exact approved character names only
- Return strict raw valid JSON only`;

  const prompt = rules.spreadOnly ? `
Create a spreads-only picture book outline for ages ${project.ageRange}.
Title: "${project.title}"
Learning Objective: ${project.learningObjective || 'Islamic values'}
NO chapters — just ${rules.spreadCount} illustrated spreads.${rules.pageLayout ? `\nPage Layout: ${rules.pageLayout}` : ''}${rules.maxWordsPerSpread ? `\nMax words per spread: ${rules.maxWordsPerSpread}` : ''}

Respond ONLY with:
{
  "bookTitle": "string",
  "moral": "string",
  "synopsis": "string",
  "spreadOnly": true,
  "totalSpreads": ${rules.spreadCount},
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
Create EXACTLY ${rules.chapterCount} chapters for "${project.title}".
Age Range: ${project.ageRange}
Mode: ${rules.mode}
${rules.chapterRhythm.length ? `Follow this chapter rhythm: ${rules.chapterRhythm.join(' → ')}` : ''}
${rules.mode === 'chapter-book' ? `
CHAPTER BOOK RULES:
- Each chapter supports later full prose generation (${rules.minChapterWords}–${rules.maxChapterWords} words each)
- Include 1-2 illustration moments only
- Use exact approved character names only
- Each chapter ends with momentum${rules.frontMatter.length ? `\n- Include front matter: ${rules.frontMatter.join(', ')}` : ''}${rules.endMatter.length ? `\n- Include end matter: ${rules.endMatter.join(', ')}` : ''}
` : `
PICTURE BOOK RULES:
- Each chapter will later become short illustrated spreads (max ${rules.maxWordsPerSpread} words/spread)
- Use exact approved character names only${rules.pageFlow.length ? `\n- Page Flow: ${rules.pageFlow.join(' → ')}` : ''}
`}

Respond ONLY with:
{
  "bookTitle": "string",
  "moral": "string",
  "synopsis": "string",
  "spreadOnly": false,
  "chapterCount": ${rules.chapterCount},
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
IMPORTANT: chapters array MUST have exactly ${rules.chapterCount} items.`;

  return { system, prompt };
}

// ─── Dedication ───────────────────────────────────────────────────────────────

function buildDedicationPrompt({ project, kb }) {
  const arabic = buildArabicSafetyBlockFromKB(kb);
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

function buildThemePagePrompt({ project, kb, characters = [] }) {
  const arabic = buildArabicSafetyBlockFromKB(kb);
  return {
    system: `You are an Islamic educator for children ages ${project.ageRange}. Output ONLY raw valid JSON. ${arabic}`,
    prompt: `Create Islamic theme reference page for "${project.title}".
Objective: ${project.learningObjective || 'Islamic values'}
${kb ? buildKbBlock(project, kb, characters) : ''}
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

// function buildHumanizePrompt({ project, kb, characters }, chapterIndex) {
//   const profile = getAgeProfile(project.ageRange);
//   const arabic = buildArabicBlock();
//   const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';
//   const chaptersArr = normArr(project.artifacts?.chapters);
//   const chapter = chaptersArr[chapterIndex];

//   const system = `You are a children's book editor for Islamic content, ages ${project.ageRange}.
// ${characterBlock(characters)}
// ${arabic}
// Output ONLY raw valid JSON.`;

//   if (profile.mode === 'chapter-book') {
//     const chapterText = String(chapter?.chapterText || chapter?.text || '');

//     return {
//       system,
//       prompt: `Polish Chapter ${chapterIndex + 1} of "${project.title}".

// Current chapter title: ${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}

// Current chapter text:
// ${chapterText}

// Editing rules:
// - Keep plot and meaning intact
// - Preserve approved characters exactly
// - Preserve illustration intent
// - Improve prose quality, atmosphere, dialogue, and flow
// - Keep Islamic values natural
// - Avoid: ${avoidTopics}

// Respond ONLY with:
// {
//   "chapterNumber": ${chapterIndex + 1},
//   "chapterTitle": "${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}",
//   "chapterText": "improved full prose chapter",
//   "chapterSummary": "improved 2-3 sentence summary",
//   "islamicMoment": "${chapter?.islamicMoment || ''}",
//   "illustrationMoments": [
//     {
//       "momentTitle": "string",
//       "illustrationHint": "string",
//       "charactersInScene": ["exact approved names only"],
//       "poseKey": "optional pose key",
//       "characterEmotion": { "ExactName": "emotion" },
//       "sceneEnvironment": "indoor|outdoor|mixed",
//       "timeOfDay": "morning|afternoon|evening|night",
//       "continuityNotes": "brief continuity note",
//       "cameraHint": "wide|medium|close|over-shoulder|full-body"
//     }
//   ],
//   "changesMade": ["list of specific improvements"]
// }`
//     };
//   }

//   if (profile.mode === 'picture-book') {
//     return {
//       system,
//       prompt: `Polish picture book chapter ${chapterIndex + 1} of "${project.title}".
// Current spreads: ${JSON.stringify(chapter?.spreads || [], null, 2)}
// Avoid: ${avoidTopics}
// MAX ${profile.maxWords} words per spread.
// Preserve approved character names and scene intent.

// Respond ONLY with:
// {
//   "chapterNumber": ${chapterIndex + 1},
//   "chapterTitle": "string",
//   "chapterSummary": "1-2 sentence summary",
//   "islamicMoment": "string",
//   "spreads": [
//     {
//       "spreadIndex": 0,
//       "text": "improved text, max ${profile.maxWords} words",
//       "prompt": "updated instruction",
//       "illustrationHint": "string",
//       "charactersInScene": ["exact approved names only"],
//       "poseKey": "optional pose key",
//       "textPosition": "bottom|top",
//       "characterEmotion": { "ExactName": "emotion" },
//       "sceneEnvironment": "indoor|outdoor|mixed",
//       "timeOfDay": "morning|afternoon|evening|night",
//       "continuityNotes": "brief continuity note",
//       "cameraHint": "wide|medium|close|over-shoulder|full-body"
//     }
//   ],
//   "changesMade": ["list of changes"]
// }`
//     };
//   }

//   return buildSpreadHumanizePrompt({ project, characters, kb });
// }

function buildHumanizePrompt({ project, kb, characters }, chapterIndex) {
  const rules = resolveFormattingRules(project, kb);
  const arabic = buildArabicSafetyBlockFromKB(kb);
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';
  const chaptersArr = normArr(project.artifacts?.chapters);
  const chapter = chaptersArr[chapterIndex];

  const system = `You are a professional children's book editor specializing in Islamic content for ages ${project.ageRange}.

Your job is to REWRITE and IMPROVE the given chapter prose. You MUST make meaningful changes.
DO NOT return the same text. DO NOT copy the original.

${characterBlock(characters)}
${arabic}
Output ONLY raw valid JSON.`;

  if (profile.mode === 'chapter-book') {
    const chapterText = String(chapter?.chapterText || chapter?.text || '');

    return {
      system,
      prompt: `HUMANIZE and IMPROVE Chapter ${chapterIndex + 1} of "${project.title}".

ORIGINAL CHAPTER TEXT TO REWRITE:
---
${chapterText}
---

YOU MUST make ALL of these improvements:
1. Replace robotic or repetitive transitions with natural varied flow
2. Add sensory details — sounds, textures, smells, light, temperature
3. Make dialogue feel natural and age-appropriate for ${project.ageRange}
4. Vary sentence length and rhythm — mix short punchy sentences with longer descriptive ones
5. Deepen emotional moments — show feelings through actions, not just statements
6. Strengthen scene-setting at chapter opening
7. Make the ending beat more resonant and memorable
8. Keep all Islamic values, Arabic phrases, and dua moments exactly as-is
9. Keep all approved character names exactly as-is
10. Keep the same plot events and chapter goal

RULES:
- The rewritten chapterText MUST be noticeably different from the original
- Length MUST be ${rules.minChapterWords}–${rules.maxChapterWords} words — do NOT stop before ${rules.minChapterWords} words
- Avoid: ${avoidTopics}
- DO NOT reproduce the original text verbatim

Respond ONLY with this JSON:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "${chapter?.chapterTitle || `Chapter ${chapterIndex + 1}`}",
  "chapterText": "FULLY REWRITTEN prose chapter — must be meaningfully different from original",
  "chapterSummary": "improved 2-3 sentence summary",
  "islamicMoment": "${chapter?.islamicMoment || ''}",
  "illustrationMoments": [
    {
      "momentTitle": "string",
      "illustrationHint": "string",
      "charactersInScene": ["exact approved names only"],
      "poseKey": "standing|walking|running|thinking|sitting|waving|reading-quran|praying-salah|laughing|sad|surprised|kneeling",
      "characterEmotion": { "ExactName": "emotion" },
      "sceneEnvironment": "indoor|outdoor|mixed",
      "timeOfDay": "morning|afternoon|evening|night",
      "continuityNotes": "brief continuity note",
      "cameraHint": "wide|medium|close|over-shoulder|full-body"
    }
  ],
  "changesMade": [
    "list at least 5 specific improvements you made",
    "e.g. Added sensory detail to opening scene",
    "e.g. Rewrote Zubair's dialogue to sound more natural",
    "e.g. Varied sentence length in marketplace scene",
    "e.g. Deepened emotional moment when wallet is returned",
    "e.g. Strengthened chapter ending beat"
  ]
}`
    };
  }

  if (profile.mode === 'picture-book') {
    return {
      system,
      prompt: `REWRITE and IMPROVE picture book chapter ${chapterIndex + 1} of "${project.title}".

ORIGINAL SPREADS:
${JSON.stringify(chapter?.spreads || [], null, 2)}

YOU MUST improve EVERY spread text by:
1. Making sentences more vivid and warm
2. Adding sensory or emotional detail
3. Improving rhythm and flow
4. Keeping max ${rules.maxWordsPerSpread} words per spread
5. Keeping all approved character names exactly

Avoid: ${avoidTopics}

Respond ONLY with:
{
  "chapterNumber": ${chapterIndex + 1},
  "chapterTitle": "string",
  "chapterSummary": "1-2 sentence summary",
  "islamicMoment": "string",
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "REWRITTEN improved text, max ${rules.maxWordsPerSpread} words — must differ from original",
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
  "changesMade": ["list at least 3 specific improvements made"]
}`
    };
  }

  return buildSpreadHumanizePrompt({ project, characters, kb });
}

// ─── Spread humanize ──────────────────────────────────────────────────────────

// function buildSpreadHumanizePrompt({ project, characters, kb }) {
//   const profile = getAgeProfile(project.ageRange);
//   const spreads = normArr(project.artifacts?.spreads || []);
//   const arabic = buildArabicBlock();
//   const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';

//   const system = `You are an expert Islamic picture book editor for ages ${project.ageRange}.
// SPREADS-ONLY book — ${spreads.length} pages, NO chapters.
// EACH "text" MUST BE one complete, grammatically correct sentence (max ${profile.maxWords} words).
// Output ONLY raw valid JSON.
// ${characterBlock(characters)}
// ${arabic}`;

//   return {
//     system,
//     prompt: `Polish all ${spreads.length} page texts for "${project.title}".
// Avoid: ${avoidTopics}
// Keep all structure and approved character names.
// Improve text clarity without changing scene meaning.

// Current spreads: ${JSON.stringify(spreads, null, 2)}

// Respond ONLY with:
// {
//   "spreadOnly": true,
//   "spreads": [
//     {
//       "spreadIndex": 0,
//       "text": "ONE complete grammatical sentence, max ${profile.maxWords} words",
//       "prompt": "copy or refine original",
//       "illustrationHint": "same scene intent",
//       "textPosition": "bottom|top",
//       "charactersInScene": ["exact approved names only"],
//       "poseKey": "optional pose key",
//       "characterEmotion": { "ExactName": "emotion" },
//       "sceneEnvironment": "indoor|outdoor|mixed",
//       "timeOfDay": "morning|afternoon|evening|night",
//       "continuityNotes": "brief continuity note",
//       "cameraHint": "wide|medium|close|over-shoulder|full-body"
//     }
//   ],
//   "changesMade": ["what improved"]
// }`
//   };
// }

function buildSpreadHumanizePrompt({ project, characters, kb }) {
  const rules = resolveFormattingRules(project, kb);
  const spreads = normArr(project.artifacts?.spreads || []);
  const arabic = buildArabicSafetyBlockFromKB(kb);
  const avoidTopics = (kb?.avoidTopics || []).join(', ') || 'none';

  const system = `You are a professional Islamic picture book editor for ages ${project.ageRange}.
SPREADS-ONLY book — ${spreads.length} pages, NO chapters.

You MUST rewrite and improve every page text. DO NOT return the same text.
EACH "text" MUST BE one complete, grammatically correct sentence (max ${rules.maxWordsPerSpread} words).

${characterBlock(characters)}
${arabic}
Output ONLY raw valid JSON.`;

  return {
    system,
    prompt: `REWRITE and IMPROVE all ${spreads.length} page texts for "${project.title}".

ORIGINAL SPREADS:
${JSON.stringify(spreads, null, 2)}

YOU MUST improve EVERY spread by:
1. Making sentences warmer and more vivid
2. Improving rhythm — vary short and longer phrases
3. Adding one specific sensory or emotional detail per page
4. Ensuring each sentence flows naturally from the previous
5. Keeping all approved character names exactly as-is
6. Keeping max ${rules.maxWordsPerSpread} words per page

Avoid: ${avoidTopics}

Respond ONLY with:
{
  "spreadOnly": true,
  "spreads": [
    {
      "spreadIndex": 0,
      "text": "ONE REWRITTEN complete grammatical sentence — must differ from original, max ${rules.maxWordsPerSpread} words",
      "prompt": "copy or refine original instruction",
      "illustrationHint": "same scene intent, can be improved",
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
  "changesMade": ["list at least 3 specific improvements made across the spreads"]
}`
  };
}

// ─── Spread rerun ─────────────────────────────────────────────────────────────

function buildSpreadRerunPrompt({ project, kb, characters }, chapterIndex, spreadIndex, customPrompt) {
  const rules = resolveFormattingRules(project, kb);
  const arabic = buildArabicSafetyBlockFromKB(kb);
  const source = getSpreadSourceForRerun(project, chapterIndex);
  const current = source.spreads[spreadIndex] || {};

  const system = `You are an expert Islamic ${rules.mode === 'picture-book' ? 'picture book' : 'spreads-only picture book'} author for ages ${project.ageRange}.
${rules.mode === 'spreads-only'
      ? `CRITICAL: The "text" field must be ONE complete natural sentence, max ${rules.maxWordsPerSpread} words.`
      : `MAX ${rules.maxWordsPerSpread} words per page.`}
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
    // Chapter books need space for full synopsis + all chapter outline entries.
    // Scale budget with chapter count from KB, capped at Claude's 8192 token limit.
    const storyChapterCount = resolveChapterCount(ctx.project, ctx.kb);
    // ~3500 base (synopsis + metadata) + ~350 tokens per chapter outline entry
    const dynamicMin = Math.min(3500 + storyChapterCount * 350, 8192);
    outputTokens = Math.max(budget.maxOutputTokens || 0, dynamicMin);
  } else if (effectiveStage === 'spreadPlanning') {
    // Each spread needs ~250 tokens (text, hint, characters, emotions, scene fields).
    // Scale with spread count, floor at 4000, cap at 8192.
    const spreadCount = Number(ctx.project.chapterCount) || 10;
    const dynamicMin = Math.min(2000 + spreadCount * 250, 8192);
    outputTokens = Math.max(budget.maxOutputTokens || 0, dynamicMin);
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
  if (!ok) {
    console.error('[TextService] ⚠ JSON parse failed — raw preview:', aiRes.text?.slice(0, 300));
    if (effectiveStage === 'chapter' || effectiveStage === 'chapters') {
      throw Object.assign(
        new Error(`Chapter ${chapterIndex + 1}: AI returned a non-JSON response. Please retry this chapter.`),
        { code: 'AI_PARSE_FAILED', chapterIndex }
      );
    }
  }

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