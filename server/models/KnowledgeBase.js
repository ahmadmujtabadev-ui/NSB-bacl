import mongoose from 'mongoose';
const { Schema } = mongoose;
const ObjId = Schema.Types.ObjectId;

// ─── Reusable sub-schemas ────────────────────────────────────────────────────

const AgeGroupBackgroundSchema = new Schema({
  tone:             String,                    // e.g. "Bright, safe, familiar"
  locations:        { type: [String], default: [] }, // school, masjid, playground …
  colorStyle:       String,                    // e.g. "Soft color palettes, gentle shadows"
  lightingStyle:    String,                    // e.g. "golden hues for peace, blue for worry"
  keyFeatures:      { type: [String], default: [] }, // specific visual rules
  additionalNotes:  String,
  _id: false,
}, { _id: false });

const TypographyByGroupSchema = new Schema({
  middleGrade: String,   // e.g. "Serif – Literata, Alegreya"
  junior:      String,   // e.g. "Bold rounded – Fredoka, Baloo"
  saeeda:      String,   // e.g. "Organic, handwritten-feel"
  _id: false,
}, { _id: false });

const AtmosphereByGroupSchema = new Schema({
  middleGrade: String,   // e.g. "Cinematic lighting, natural environments"
  junior:      String,   // e.g. "Bright joyful, plot-related objects"
  saeeda:      String,   // e.g. "Dreamlike macro-world"
  _id: false,
}, { _id: false });

// ─── Character-level guide (embedded in KB, keyed by characterId) ────────────

const FaithGuideSchema = new Schema({
  faithTone:        String,      // e.g. "reflective & questioning" / "joyful & imitative"
  faithExpressions: { type: [String], default: [] }, // how faith shows in behaviour
  duaStyle:         String,      // e.g. "whispered in solitude under pressure"
  islamicTraits:    { type: [String], default: [] }, // patient, grateful, honest …
  faithExamples:    { type: [String], default: [] }, // specific dialogue/action samples
}, { _id: false });

const CharacterGuideSchema = new Schema({
  characterId:      { type: ObjId, ref: 'Character' },   // optional – can be name-only
  characterName:    { type: String, required: true },

  // ── Dialogue & Voice ────────────────────────────────────────────────────────
  speakingStyle:    String,   // e.g. "fast, buzzing, excitable" / "slow, minimal, wise"
  dialogueExamples: { type: [String], default: [] }, // verbatim example lines

  // ── Extended character info ──────────────────────────────────────────────────
  moreInfo:         String,   // background, lore, personality depth
  personalityNotes: { type: [String], default: [] }, // additional personality tags
  literaryRole:     String,   // "carries theme of Truth vs Comfort", etc.

  // ── Faith integration per character ─────────────────────────────────────────
  faithGuide:       FaithGuideSchema,
}, { _id: false });

// ─── Main schema ─────────────────────────────────────────────────────────────

const schema = new Schema({
  userId:     { type: ObjId, ref: 'User',     required: true },
  universeId: { type: ObjId, ref: 'Universe', required: true },
  name:       { type: String, required: true, trim: true },

  // ── Original fields (kept intact) ──────────────────────────────────────────
  islamicValues: { type: [String], default: [] },
  duas: [{
    arabic:          { type: String, required: true },
    transliteration: { type: String, required: true },
    meaning:         { type: String, required: true },
    context:         String,
    _id: false,
  }],
  vocabulary: [{
    word:       { type: String, required: true },
    definition: { type: String, required: true },
    ageGroup:   String,
    _id: false,
  }],
  illustrationRules: { type: [String], default: [] },
  avoidTopics:       { type: [String], default: [] },
  customRules:       String,

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. ILLUSTRATION BACKGROUND SETTINGS
  //    Per-series visual rules fed directly into image-generation prompts
  // ═══════════════════════════════════════════════════════════════════════════
  backgroundSettings: {
    junior:           AgeGroupBackgroundSchema,  // ages 5-8
    middleGrade:      AgeGroupBackgroundSchema,  // ages 8-13
    saeeda:           AgeGroupBackgroundSchema,  // micro/garden universe
    avoidBackgrounds: { type: [String], default: [] }, // cross-series "never do"
    universalRules:   String,  // e.g. "Every scene must feel handcrafted"
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. COVER DESIGN PREFERENCES
  //    Rules injected into cover-generation prompts
  // ═══════════════════════════════════════════════════════════════════════════
  coverDesign: {
    // Branding & layout
    brandingRules:        { type: [String], default: [] }, // logo placement, title zone
    titlePlacement:       String,   // e.g. "Top 1/3, visible at thumbnail size"
    authorTaglinePlacement: String, // e.g. "Bottom or lower-right corner"

    // Character composition
    characterComposition: { type: [String], default: [] }, // "eye contact for MG", etc.
    characterMustInclude: { type: [String], default: [] }, // e.g. "Khaled or Sumaya always"

    // Visual atmosphere per group
    atmosphere:  AtmosphereByGroupSchema,

    // Typography per group
    typography:  TypographyByGroupSchema,

    // Optional add-ons and extras
    optionalAddons:  { type: [String], default: [] }, // badge, corner icon, motif watermark
    islamicMotifs:   { type: [String], default: [] }, // star pattern, mashrabiya frame …

    // Prohibitions
    avoidCover:      { type: [String], default: [] },

    extraNotes:      String,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. UNDER-6 / SPREADS-ONLY DESIGN PREFERENCES
  //    Governs layout, text, and illustration rules for the youngest readers
  // ═══════════════════════════════════════════════════════════════════════════
  underSixDesign: {
    maxWordsPerSpread:   { type: Number, default: 10 },
    pageCount:           { type: Number, default: 24 },  // 24-40 print spreads
    readingType:         String,   // "parent-read" | "early-independent"
    pageLayout:          String,   // e.g. "Left full-page image, right-side text block"
    fontStyle:           String,   // e.g. "Rounded, large, dyslexia-friendly"
    fontPreferences:     { type: [String], default: [] }, // Lexend, OpenDyslexic …
    lineSpacing:         String,   // e.g. "Wide"
    textJustification:   String,   // e.g. "Left-aligned only"

    // Spread/segment structure
    spreadStructure: [{
      segment:     String,   // e.g. "Title + Dedication", "Meet the Characters", …
      description: String,
      _id: false,
    }],

    // Emotional structure per story segment
    emotionalPattern: {
      conflictOrQuestion: String,
      emotionReaction:    String,
      resolve:            String,
    },

    reflectionPrompt:   String,   // e.g. "Would you say sorry too?"
    bonusPageContent:   String,   // e.g. "Ayah, du'a, or line of wonder"

    illustrationStyle:  String,   // e.g. "Pixar-style, round shapes, soft shadows"
    colorPalette:       String,   // e.g. "Bright, joyful, high contrast"

    specialRules:       { type: [String], default: [] },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. CHARACTER GUIDES
  //    Per-character speaking style, lore, and faith integration
  //    Keyed by characterId OR characterName; merged at prompt-build time
  // ═══════════════════════════════════════════════════════════════════════════
  characterGuides: { type: [CharacterGuideSchema], default: [] },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. LITERARY DEVICES & SYMBOLISM
  //    Reusable symbols and techniques injected into text-generation prompts
  // ═══════════════════════════════════════════════════════════════════════════
  literaryDevices: {
    naturalMetaphors: [{
      symbol:  String,   // e.g. "Puddle"
      meaning: String,   // e.g. "temporary fear or reflection"
      _id: false,
    }],
    symbolAnchors: [{
      symbol:  String,   // e.g. "Broken Compass"
      meaning: String,   // e.g. "loss of moral clarity"
      _id: false,
    }],
    approvedDevices:    { type: [String], default: [] }, // "parallel structure", "quiet epiphany" …
    avoidDevices:       { type: [String], default: [] }, // overused clichés to ban
    poeticLevel:        String,   // e.g. "most-poetic" for Saeeda, "subtle" for MG
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. BOOK FORMATTING RULES (per age group)
  //    Structure handed to text-generation prompts for pacing & layout
  // ═══════════════════════════════════════════════════════════════════════════
  bookFormatting: {
    middleGrade: {
      wordCount:    String,   // e.g. "20,000 – 35,000"
      chapterRange: String,   // e.g. "8 to 12"
      sceneLength:  String,   // e.g. "500–800 words"
      chapterRhythm: { type: [String], default: [] }, // hook, sceneA, reflection, sceneB, close
      frontMatter:   { type: [String], default: [] },
      endMatter:     { type: [String], default: [] },
    },
    junior: {
      wordCount:    String,   // e.g. "1,500–3,000"
      pageCount:    String,   // e.g. "24–40 pages"
      segmentCount: String,   // e.g. "4–6 segments"
      pageFlow:     { type: [String], default: [] },
    },
    _id: false,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. THEMES LIBRARY
  //    Reusable thematic pillars with anchor symbols for prompt injection
  // ═══════════════════════════════════════════════════════════════════════════
  themes: [{
    title:         { type: String, required: true }, // e.g. "Truth vs Comfort"
    coreConflict:  String,
    emotionalBeat: String,
    anchorSymbols: { type: [String], default: [] },
    ageGroups:     { type: [String], default: [] },  // ["junior","middleGrade","saeeda"]
    _id: false,
  }],

}, { timestamps: true });

// ─── Indexes ──────────────────────────────────────────────────────────────────
schema.index({ universeId: 1, userId: 1 });

export const KnowledgeBase = mongoose.model('KnowledgeBase', schema);
