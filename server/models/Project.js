// server/models/Project.js
// PRODUCTION-READY — Enhanced schema supporting review-first workflow
// Compatible with current routes + new review routes

import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User',          required: true, index: true },
  universeId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Universe' },
  knowledgeBaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeBase' },
  characterIds:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Character' }],

  // ─── Core book metadata ───────────────────────────────────────────────────
  title:             { type: String, required: true, trim: true, maxlength: 200 },
  ageRange:          { type: String, trim: true },
  chapterCount:      { type: Number, default: 4, min: 2, max: 16 },
  template:          { type: String, enum: ['adventure', 'moral', 'dua', 'ramadan', 'custom'], default: 'moral' },
  learningObjective: { type: String, trim: true, maxlength: 500 },
  authorName:        { type: String, trim: true, maxlength: 100 },
  language:          { type: String, enum: ['english', 'urdu', 'arabic', 'bilingual'], default: 'english' },

  // ─── Legacy 5-step tracking (kept for compatibility) ─────────────────────
  currentStep: { type: Number, default: 1, min: 1, max: 5 },
  stepsComplete: {
    story:   { type: Boolean, default: false },
    spreads: { type: Boolean, default: false },
    style:   { type: Boolean, default: false },
    images:  { type: Boolean, default: false },
    editor:  { type: Boolean, default: false },
  },

  // ─── New workflow tracking (review-first) ────────────────────────────────
  workflow: {
    mode:         { type: String, default: '' }, // spreads-only | picture-book | chapter-book
    currentStage: { type: String, default: 'story' },
    stages: {
      story:          { type: Boolean, default: false },
      structure:      { type: Boolean, default: false },
      style:          { type: Boolean, default: false },
      prose:          { type: Boolean, default: false },
      humanize:       { type: Boolean, default: false },
      illustrations:  { type: Boolean, default: false },
      cover:          { type: Boolean, default: false },
      editor:         { type: Boolean, default: false },
      layout:         { type: Boolean, default: false },
    },
  },

  // ─── Status ───────────────────────────────────────────────────────────────
  status:       { type: String, enum: ['draft', 'generating', 'complete', 'exported', 'error'], default: 'draft' },
  currentStage: { type: String, default: '' },
  errorMessage: { type: String, default: '' },

  // ─── Book style settings ─────────────────────────────────────────────────
  bookStyle: {
    artStyle:               { type: String, default: 'pixar-3d' },
    colorPalette:           { type: String, default: 'warm-pastels' },
    lightingStyle:          { type: String, default: 'warm-golden' },
    backgroundStyle:        { type: String, default: 'mixed' },
    indoorRoomDescription:  { type: String, default: '' },
    outdoorDescription:     { type: String, default: '' },
    islamicDecorStyle:      { type: String, default: 'subtle' },
    textPlacementDefault:   { type: String, default: 'bottom' },
    bookProps:              { type: String, default: '' },
    negativePrompt:         { type: String, default: '' },
    guidanceScale:          { type: Number, default: 7.5 },
    inferenceSteps:         { type: Number, default: 45 },
    referenceStrength:      { type: Number, default: 0.82 },
  },

  // ─── Print settings ───────────────────────────────────────────────────────
  trimSize:    { type: String, enum: ['6x6', '7x7', '8x8', '8.5x8.5', '8x10', '6x9'], default: '8.5x8.5' },
  imageWidth:  { type: Number, default: 1024 },
  imageHeight: { type: Number, default: 1024 },

  // ─── All AI-generated content lives here ─────────────────────────────────
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
  strict: false,
});

// ─── Indexes ────────────────────────────────────────────────────────────────
schema.index({ userId: 1, updatedAt: -1 });
schema.index({ userId: 1, status: 1 });
schema.index({ shareToken: 1 }, { sparse: true });
schema.index({ userId: 1, 'workflow.currentStage': 1 });

export const Project = mongoose.model('Project', schema);

/*
artifacts.review = {
  story: {
    status: "draft|generated|edited|approved",
    current: {
      bookTitle: "",
      synopsis: "",
      moral: "",
      storyText: "",
      islamicTheme: {},
      dedicationMessage: ""
    },
    versions: [],
    promptHistory: [],
    approvedAt: null,
    updatedAt: ""
  },

  structure: {
    mode: "spreads-only|picture-book|chapter-book",
    items: [
      // spreads-only / picture-book
      {
        key: "s0" or "ch0_s0",
        unitType: "spread",
        status: "draft|generated|edited|approved",
        current: {
          text: "",
          prompt: "",
          illustrationHint: "",
          charactersInScene: [],
          characterEmotion: {},
          sceneEnvironment: "indoor|outdoor",
          timeOfDay: "morning|afternoon|evening|night",
          textPosition: "bottom|top"
        },
        versions: [],
        approvedAt: null,
        updatedAt: ""
      },

      // chapter-book
      {
        key: "ch0",
        unitType: "chapter-outline",
        status: "draft|generated|edited|approved",
        current: {
          chapterNumber: 1,
          title: "",
          goal: "",
          keyScene: "",
          duaHint: "",
          endingBeat: "",
          charactersInScene: [],
          illustrationMoments: []
        },
        versions: [],
        approvedAt: null,
        updatedAt: ""
      }
    ]
  },

  prose: [
    {
      key: "ch0",
      chapterIndex: 0,
      status: "draft|generated|edited|approved",
      current: {
        chapterNumber: 1,
        chapterTitle: "",
        chapterSummary: "",
        chapterText: "",
        islamicMoment: "",
        illustrationMoments: []
      },
      versions: [],
      approvedAt: null,
      updatedAt: ""
    }
  ],

  humanized: [
    {
      key: "ch0",
      chapterIndex: 0,
      status: "draft|generated|edited|approved",
      current: {
        chapterNumber: 1,
        chapterTitle: "",
        chapterSummary: "",
        chapterText: "",
        changesMade: []
      },
      versions: [],
      approvedAt: null,
      updatedAt: ""
    }
  ],

  illustrations: [
    {
      key: "s0" | "ch0_s0" | "ch0_img0",
      chapterIndex: 0,
      spreadIndex: 0,
      sourceType: "spread|chapter-moment",
      status: "draft|generated|edited|approved",
      current: {
        imageUrl: "",
        prompt: "",
        seed: null,
        selectedVariantIndex: 0,
        variants: []
      },
      versions: [],
      approvedAt: null,
      updatedAt: ""
    }
  ],

  cover: {
    front: {
      status: "draft|generated|edited|approved",
      current: {
        imageUrl: "",
        prompt: "",
        seed: null,
        selectedVariantIndex: 0,
        variants: []
      },
      versions: [],
      approvedAt: null,
      updatedAt: ""
    },
    back: {
      status: "draft|generated|edited|approved",
      current: {
        imageUrl: "",
        prompt: "",
        seed: null,
        selectedVariantIndex: 0,
        variants: []
      },
      versions: [],
      approvedAt: null,
      updatedAt: ""
    }
  }
};
*/