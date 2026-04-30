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
  timeOfDay:    String,   // e.g. "afternoon" | "morning" | "evening" | "golden-hour"
  cameraHint:   String,   // e.g. "wide" | "medium" | "close" | "full-body"
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
    wrongTerm:  { type: String, default: '' },  // term to avoid (e.g. "Koran" → use "Quran")
    example:    { type: String, default: '' },
    type:       { type: String, default: '' },
    ageGroup:   String,
    _id: false,
  }],
  // Mixed allows both legacy strings and new {topic, severity, category} objects
  avoidTopics: { type: [Schema.Types.Mixed], default: [] },

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
    // ── Selected visual template ─────────────────────────────────────────────
    selectedCoverTemplate: { type: String, default: null },

    // ── Front Cover content ──────────────────────────────────────────────────
    bookTitle:            String,   // e.g. "The Desert of Wonders"
    subtitle:             String,   // e.g. "A Journey Beyond the Stars"
    authorName:           String,   // e.g. "Zara Al-Amin"
    mainVisualConcept:    String,   // scene description for AI
    characterDescription: String,   // character appearance on cover
    moodTheme:            String,   // e.g. "Fantasy / Dark / Adventure"
    colorStyle:           String,   // e.g. "Deep purple + white glow + gold accents"

    // ── Title placement ──────────────────────────────────────────────────────
    titlePlacement:          String,
    authorTaglinePlacement:  String,

    // ── Spine ────────────────────────────────────────────────────────────────
    selectedSpineTemplate: { type: String, default: null },
    spineColorBackground:  String,   // derived from spine template
    spineTypographyStyle:  String,   // derived from spine template
    spinePromptDirective:  String,   // full AI directive from spine template
    spineTitle:   String,
    spineAuthor:  String,
    publisherLogo: String,

    // ── Back cover ───────────────────────────────────────────────────────────
    selectedBackTemplate:  { type: String, default: null },
    backBackgroundStyle:   String,   // derived from back cover template
    backPromptDirective:   String,   // full AI directive from back cover template
    blurb:         String,   // 120-180 word story description
    publisherName: String,
    website:       String,
    price:         String,
    isbn:          String,

    // ── Design / print settings ──────────────────────────────────────────────
    trimSize:   String,   // e.g. "6 x 9 inches"
    spineWidth: String,   // e.g. "0.85 inches"
    bleed:      String,   // e.g. "0.125 inch"
    resolution: String,   // e.g. "300 DPI"

    // ── Visual style ─────────────────────────────────────────────────────────
    typographyTitle: String,   // e.g. "Serif / Fantasy / Ultra-bold"
    typographyBody:  String,   // e.g. "Sans-serif / Clean"
    lightingEffects: String,   // e.g. "Warm golden glow with atmospheric fog"
    foregroundLayer: String,   // e.g. "Character silhouette"
    midgroundLayer:  String,   // e.g. "Landscape, ruins"
    backgroundLayer: String,   // e.g. "Sky, castle, city"

    // ── Per-series atmosphere & typography ───────────────────────────────────
    atmosphere:  AtmosphereByGroupSchema,
    typography:  TypographyByGroupSchema,

    // ── Branding & layout ────────────────────────────────────────────────────
    brandingRules:        { type: [String], default: [] },
    characterComposition: { type: [String], default: [] },
    characterMustInclude: { type: [String], default: [] },
    optionalAddons:       { type: [String], default: [] },
    islamicMotifs:        { type: [String], default: [] },
    avoidCover:           { type: [String], default: [] },
    extraNotes:           String,
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
  // 5. BOOK FORMATTING RULES (per age group)
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

}, { timestamps: true });

// ─── Indexes ──────────────────────────────────────────────────────────────────
schema.index({ universeId: 1, userId: 1 });

export const KnowledgeBase = mongoose.model('KnowledgeBase', schema);
