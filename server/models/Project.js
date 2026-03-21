// models/Project.js
// PRODUCTION-READY — Enhanced schema supporting 5-step new flow
// Step 1: Story generation
// Step 2: Spread planning + character setup
// Step 3: Character styling (master reference image)
// Step 4: Image variants per spread (user selects best)
// Step 5: Book editor + export

import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User',      required: true, index: true },
  universeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Universe'  },
  characterIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Character' }],

  // ─── Core book metadata ───────────────────────────────────────────────────
  title:             { type: String, required: true, trim: true, maxlength: 200 },
  ageRange:          { type: String, trim: true },                         // e.g. "2-4", "4-6", "6-8"
  chapterCount:      { type: Number, default: 4, min: 2, max: 16 },
  template:          { type: String, enum: ['adventure', 'moral', 'dua', 'ramadan', 'custom'], default: 'moral' },
  learningObjective: { type: String, trim: true, maxlength: 500 },
  authorName:        { type: String, trim: true, maxlength: 100 },
  language:          { type: String, enum: ['english', 'urdu', 'arabic', 'bilingual'], default: 'english' },

  // ─── Step tracking (5-step new flow) ─────────────────────────────────────
  currentStep: { type: Number, default: 1, min: 1, max: 5 },
  stepsComplete: {
    story:     { type: Boolean, default: false },  // Step 1 done
    spreads:   { type: Boolean, default: false },  // Step 2 done
    style:     { type: Boolean, default: false },  // Step 3 done
    images:    { type: Boolean, default: false },  // Step 4 done
    editor:    { type: Boolean, default: false },  // Step 5 done
  },

  // ─── Status ───────────────────────────────────────────────────────────────
  status:       { type: String, enum: ['draft', 'generating', 'complete', 'exported', 'error'], default: 'draft' },
  currentStage: { type: String, default: '' },     // last AI stage run
  errorMessage: { type: String, default: '' },

  // ─── Book style settings (set in Step 2) ─────────────────────────────────
  bookStyle: {
    artStyle:               { type: String, default: 'pixar-3d' },
    colorPalette:           { type: String, default: 'warm-pastels' },
    lightingStyle:          { type: String, default: 'warm-golden' },
    backgroundStyle:        { type: String, default: 'mixed' },
    indoorRoomDescription:  { type: String, default: '' },
    outdoorDescription:     { type: String, default: '' },
    islamicDecorStyle:      { type: String, default: 'subtle' },
    textPlacementDefault:   { type: String, default: 'bottom' },
    bookProps:              { type: String, default: '' },          // recurring props e.g. "blue race car"
    negativePrompt:         { type: String, default: '' },          // custom negative prompt additions
    guidanceScale:          { type: Number, default: 7.5 },
    inferenceSteps:         { type: Number, default: 45 },
    referenceStrength:      { type: Number, default: 0.82 },
  },

  // ─── Print settings ───────────────────────────────────────────────────────
  trimSize:    { type: String, enum: ['6x6', '7x7', '8x8', '8.5x8.5', '8x10', '6x9'], default: '8.5x8.5' },
  imageWidth:  { type: Number, default: 1024 },
  imageHeight: { type: Number, default: 1024 },

  // ─── All AI-generated content lives here ─────────────────────────────────
  // See shape reference at bottom of file
  artifacts: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ─── AI usage tracking ────────────────────────────────────────────────────
  aiUsage: {
    totalInputTokens:  { type: Number, default: 0 },
    totalOutputTokens: { type: Number, default: 0 },
    totalCostUsd:      { type: Number, default: 0 },
    totalCreditsUsed:  { type: Number, default: 0 },
    stages:            { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  // ─── Publishing ───────────────────────────────────────────────────────────
  publishedAt: { type: Date },
  shareToken:  { type: String, sparse: true, index: true },
  isPublic:    { type: Boolean, default: false },

}, {
  timestamps: true,
  strict: false,    // allow dynamic artifact fields without schema errors
});

// ─── Indexes ──────────────────────────────────────────────────────────────────
schema.index({ userId: 1, updatedAt: -1 });
schema.index({ userId: 1, status: 1 });
schema.index({ shareToken: 1 }, { sparse: true });

export const Project = mongoose.model('Project', schema);

// ═══════════════════════════════════════════════════════════════════════════════
// ARTIFACTS SHAPE REFERENCE
// This is the complete structure of project.artifacts (Mixed field)
// All fields are optional — set as stages complete
// ═══════════════════════════════════════════════════════════════════════════════
/*

artifacts = {

  // ── STEP 1: Story ──────────────────────────────────────────────────────────
  storyIdea:     "user's original short idea",
  storyText:     "full AI-generated story text",
  outline: {
    bookTitle:        "string",
    moral:            "string",
    synopsis:         "string",
    spreadOnly:       boolean,        // true when age < 6
    spreads:          [...],          // age < 6: flat list of spread outlines
    chapters:         [...],          // age >= 6: chapter outlines
    islamicTheme: {
      title, arabicPhrase, transliteration, meaning, reference, referenceText, whyWeDoIt
    },
    dedicationMessage: "string",
  },

  // ── STEP 2: Spread planning ────────────────────────────────────────────────

  // For age < 6 (spreadOnly = true):
  spreadOnly: true,
  spreads: [{
    spreadIndex:       0,
    text:              "page text (max 10 words)",
    prompt:            "instruction used to generate this text — editable",
    illustrationHint:  "what to draw",
    textPosition:      "bottom",
    charactersInScene: ["Ali"],
    characterEmotion:  { Ali: "happy" },
    sceneEnvironment:  "indoor",
    timeOfDay:         "morning",
  }],

  // For age >= 6 (chapters):
  chapters: [{
    chapterNumber:   1,
    chapterTitle:    "string",
    spreads: [{
      spreadIndex:       0,
      text:              "string",
      prompt:            "string",
      illustrationHint:  "string",
      textPosition:      "bottom",
      charactersInScene: [],
      characterEmotion:  {},
      sceneEnvironment:  "indoor",
    }],
  }],

  // Polished/humanized chapters (replaces chapters when set):
  humanized: [{ same shape as chapters }],

  // ── STEP 3: Character styling ──────────────────────────────────────────────
  // Stored on Character model: character.masterReferenceUrl, character.selectedStyle

  // ── STEP 4: Image variants ─────────────────────────────────────────────────

  // For spreadOnly books:
  spreadIllustrations: [{
    spreadIndex:   0,
    imageUrl:      "selected image URL",
    prompt:        "full image prompt used",
    text:          "page text",
    textPosition:  "bottom",
    seed:          12345,
    variants: [{
      variantIndex: 0,
      imageUrl:     "https://...",
      seed:         12345,
      prompt:       "string",
      selected:     true,
    }],
    selectedVariantIndex: 0,
    approvedAt:    "ISO string",
    createdAt:     "ISO string",
  }],

  // For chapter books:
  illustrations: [{
    chapterNumber:        1,
    selectedVariantIndex: 0,
    spreads: [{
      spreadIndex:    0,
      imageUrl:       "selected URL",
      prompt:         "string",
      seed:           12345,
      text:           "string",
      textPosition:   "bottom",
      illustrationHint: "string",
      variants: [{ variantIndex, imageUrl, seed, prompt, selected }],
      selectedVariantIndex: 0,
      approvedAt:     "ISO string",
    }],
    variants: [{ variantIndex, imageUrl, prompt, seed, selected }],  // chapter books
  }],

  // ── Cover ──────────────────────────────────────────────────────────────────
  cover: {
    frontUrl:    "https://...",
    frontPrompt: "full prompt — editable",
    frontSeed:   12345,
    frontVariants: [{ variantIndex, imageUrl, seed }],
    backUrl:     "https://...",
    backPrompt:  "full prompt — editable",
    backSeed:    12345,
  },

  // ── Special pages ──────────────────────────────────────────────────────────
  dedication: {
    greeting:             "string",
    message:              "string",
    closing:              "string",
    includeQrPlaceholder: true,
  },
  themePage: {
    sectionTitle, arabicPhrase, transliteration, meaning,
    referenceType, referenceSource, referenceText, explanation, dailyPractice,
  },

  // ── Step 5: Editor styles ──────────────────────────────────────────────────
  bookEditorStyle: {
    globalFont:       "Nunito",
    globalFontSize:   28,
    globalFontColor:  "#ffffff",
    globalBgColor:    "rgba(0,0,0,0.55)",
    globalBgOpacity:  0.7,
    globalTextAlign:  "center",
    globalLayout:     "text-bottom",
  },

  // Per-page editor overrides:
  pageEdits: {
    "s0": {
      status:       "draft|edited|regenerated|approved|rejected",
      notes:        "string",
      approvedAt:   "ISO string",
      rejectionReason: "string",
      updatedAt:    "ISO string",
      textStyle:    { fontFamily, fontSize, fontWeight, color, bgColor, bgOpacity, textAlign, lineHeight, x, y, width },
      imageStyle:   { objectFit, offsetX, offsetY, scale },
      layout:       "text-bottom|text-top|text-side-right|full-bleed|split",
      textVersions: [{ version, text, prompt, source, createdAt }],
      imageVersions:[{ version, imageUrl, prompt, source, createdAt }],
      currentTextVersion:  1,
      currentImageVersion: 0,
    },
    "ch0_s0": { ... same shape ... },
    "cover_front": { ... },
    "cover_back":  { ... },
  },

  // ── Layout (final assembled page order) ───────────────────────────────────
  layout: {
    spreads:        [...],   // all pages in order with type + content
    pageCount:      14,
    trimSize:       "8.5x8.5",
    format:         "picture-book|chapter-book",
    generatedAt:    "ISO string",
  },

  // ── Export ─────────────────────────────────────────────────────────────────
  export: {
    pdfUrl:      "https://...",
    epubUrl:     "https://...",
    pageCount:   14,
    exportedAt:  "ISO string",
    expiresAt:   "ISO string",
    dpi:         300,
    trimSize:    "8.5x8.5",
  },

  // ── Prompt history (last 100 text, last 200 image) ─────────────────────────
  promptHistory: [{
    stage, index, prompt, resultPreview, provider, createdAt
  }],
  imagePromptHistory: [{
    type, chapterIndex, spreadIndex, prompt, imageUrl, provider, createdAt
  }],
};
*/