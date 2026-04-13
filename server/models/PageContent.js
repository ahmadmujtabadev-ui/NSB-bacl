// server/models/PageContent.js — new model
import mongoose from 'mongoose';

const PageContentSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  pageId:    { type: String, required: true },
  fabricJson: { type: mongoose.Schema.Types.Mixed },
  savedAt:   { type: Date, default: Date.now },
}, { strict: false });

// Compound unique index — one doc per project+page
PageContentSchema.index({ projectId: 1, pageId: 1 }, { unique: true });

export default mongoose.model('PageContent', PageContentSchema);