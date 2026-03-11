import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },

  pdfUrl:    String,
  epubUrl:   String,
  pageCount: Number,
  trimSize:  String,

  status:   { type: String, enum: ['pending', 'processing', 'complete', 'failed'], default: 'pending' },
  error:    String,

  expiresAt: Date,
}, { timestamps: true });

schema.index({ projectId: 1 });
schema.index({ userId: 1, createdAt: -1 });

export const Export = mongoose.model('Export', schema);
