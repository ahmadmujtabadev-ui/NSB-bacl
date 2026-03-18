// models/Project.js  — updated schema with fix fields
// NEW FIELDS ADDED:
// artifacts.spreadOnly        — boolean, true when age < 6
// artifacts.spreads           — flat spread list for age < 6
// artifacts.spreadIllustrations — illustrations for spreads-only mode
// artifacts.promptHistory     — text prompt history per stage/page
// artifacts.imagePromptHistory — image prompt history per spread/cover
// artifacts.cover.frontPrompt — editable front cover prompt (FIX 4)
// artifacts.cover.backPrompt  — editable back cover prompt (FIX 4)
// Each spread/chapter has a 'prompt' field (FIX 2 & 3)

import mongoose from 'mongoose';

/*
  artifacts — updated Mixed field:
  {
    // Existing
    outline:       { bookTitle, moral, spreadOnly, spreads (age<6), chapters (age>=6), islamicTheme, ... }
    chapters:      [{ chapterNumber, chapterTitle, spreads: [{spreadIndex, text, prompt, illustrationHint, ...}] }]
    humanized:     [{ chapterNumber, chapterTitle, spreads: [{spreadIndex, text, prompt, ...}], changesMade }]

    // FIX 1: Age < 6 flat spreads
    spreadOnly:    boolean
    spreads:       [{ spreadIndex, text, prompt, illustrationHint, textPosition }]

    // FIX 3: Illustrations with prompts
    illustrations: [{ chapterNumber, spreads: [{spreadIndex, imageUrl, prompt, text, ...}], variants, selectedVariantIndex }]
    spreadIllustrations: [{ spreadIndex, imageUrl, prompt, text, textPosition }]  -- for spreadOnly mode

    // FIX 4: Cover with promptsa
    cover: { frontUrl, frontPrompt, backUrl, backPrompt }

    // FIX 2: Prompt history
    promptHistory: [{ stage, index, prompt, resultPreview, provider, createdAt }]
    imagePromptHistory: [{ type, chapterIndex, spreadIndex, prompt, imageUrl, provider, createdAt }]

    layout: { spreads: [...], pageCount, trimSize }
    export: { pdfUrl, epubUrl, pageCount, expiresAt }
  }
*/

const schema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User',      required: true },
  universeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Universe'  },
  characterIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Character' }],

  title:             { type: String, required: true, trim: true },
  ageRange:          String,
  chapterCount:      { type: Number, default: 4, min: 2, max: 12 },
  template:          { type: String, enum: ['adventure', 'moral', 'dua', 'ramadan', 'custom'], default: 'moral' },
  learningObjective: String,
  authorName:        String,

  status:       { type: String, enum: ['draft', 'generating', 'complete', 'exported'], default: 'draft' },
  currentStage: String,

  // All AI-generated content — Mixed for flexibility
  artifacts: { type: mongoose.Schema.Types.Mixed, default: {} },

  trimSize:               { type: String, enum: ['6x9', '8x10', 'square'], default: '6x9' },
  illustrationDimensions: { width: { type: Number, default: 1536 }, height: { type: Number, default: 1024 } },
  coverDimensions:        { width: { type: Number, default: 1024 }, height: { type: Number, default: 1536 } },

  aiUsage: {
    totalInputTokens:  { type: Number, default: 0 },
    totalOutputTokens: { type: Number, default: 0 },
    totalCostUsd:      { type: Number, default: 0 },
    stages:            { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  publishedAt: Date,
  shareToken:  { type: String, sparse: true },
}, { timestamps: true });

schema.index({ userId: 1, updatedAt: -1 });

export const Project = mongoose.model('Project', schema);

// ─── Artifacts shape reference (not enforced by Mongoose, for documentation) ──
//
// artifacts.spreadOnly = true when ageRange starts with < 6
//
// artifacts.spreads = [                         ← age < 6 flat list
//   {
//     spreadIndex: 0,
//     text: "max 10 words, rhyming",
//     prompt: "instruction used to generate text — shown & editable in UI",
//     illustrationHint: "...",
//     textPosition: "bottom",
//   }
// ]
//
// artifacts.chapters = [                        ← age >= 6
//   {
//     chapterNumber: 1,
//     chapterTitle: "...",
//     spreads: [
//       {
//         spreadIndex: 0,
//         text: "...",
//         prompt: "instruction used — shown & editable in UI",
//         illustrationHint: "...",
//         textPosition: "bottom",
//       }
//     ]
//   }
// ]
//
// artifacts.illustrations = [
//   {
//     chapterNumber: 1,
//     spreads: [
//       {
//         spreadIndex: 0,
//         imageUrl: "https://...",
//         prompt: "full image generation prompt — shown & editable in UI",
//         text: "...",
//         textPosition: "bottom",
//       }
//     ]
//   }
// ]
//
// artifacts.cover = {
//   frontUrl: "https://...",
//   frontPrompt: "full prompt used — editable from cover editor UI",
//   backUrl: "https://...",
//   backPrompt: "full prompt used — editable from cover editor UI",
// }
//
// artifacts.promptHistory = [         ← text stage history, last 100
//   { stage, index, prompt, resultPreview, provider, createdAt }
// ]
//
// artifacts.imagePromptHistory = [    ← image stage history, last 200
//   { type, chapterIndex, spreadIndex, prompt, imageUrl, provider, createdAt }
// ]