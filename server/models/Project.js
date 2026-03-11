import mongoose from 'mongoose';

/*
  artifacts — flexible Mixed field:
  {
    outline:       { bookTitle, moral, chapters: [{title, goal, keyScene, duaHint}] }
    chapters:      [{ chapterNumber, title, text, vocabularyNotes, islamicAdabChecks }]
    humanized:     [{ chapterNumber, title, text, changesMade }]
    illustrations: [{ chapterNumber, variants: [{variantIndex, imageUrl, prompt, seed, selected}], selectedVariantIndex }]
    cover:         { frontUrl, backUrl, prompt }
    layout:        { spreads: [...], pageCount, trimSize }
    export:        { pdfUrl, epubUrl, pageCount, expiresAt }
  }
*/

const schema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
  universeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Universe' },
  characterIds:[{ type: mongoose.Schema.Types.ObjectId, ref: 'Character' }],

  title:            { type: String, required: true, trim: true },
  ageRange:         String,
  chapterCount:     { type: Number, default: 4, min: 2, max: 12 },
  template:         { type: String, enum: ['adventure', 'moral', 'dua', 'ramadan', 'custom'], default: 'moral' },
  learningObjective:String,
  authorName:       String,

  status:       { type: String, enum: ['draft', 'generating', 'complete', 'exported'], default: 'draft' },
  currentStage: String,

  artifacts: { type: mongoose.Schema.Types.Mixed, default: {} },

  trimSize:              { type: String, enum: ['6x9', '8x10', 'square'], default: '6x9' },
  illustrationDimensions:{ width: { type: Number, default: 1536 }, height: { type: Number, default: 1024 } },
  coverDimensions:       { width: { type: Number, default: 1024 }, height: { type: Number, default: 1536 } },

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
