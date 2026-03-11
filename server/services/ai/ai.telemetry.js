import mongoose from 'mongoose';

// Inline schema — keeps telemetry self-contained
const aiUsageSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  projectId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  provider:      String,
  stage:         String,
  requestType:   { type: String, enum: ['text', 'image'] },
  tokensIn:      Number,
  tokensOut:     Number,
  creditsCharged:{ type: Number, default: 0 },
  success:       { type: Boolean, default: true },
  errorCode:     String,
  durationMs:    Number,
  metadata:      mongoose.Schema.Types.Mixed,
}, { timestamps: true });

aiUsageSchema.index({ userId: 1, createdAt: -1 });
aiUsageSchema.index({ projectId: 1 });

const AIUsage = mongoose.model('AIUsage', aiUsageSchema);

/**
 * Fire-and-forget telemetry log. Never throws.
 */
export async function logAIUsage(data) {
  try {
    await AIUsage.create(data);
  } catch (err) {
    console.error('[Telemetry] Failed to log AI usage:', err.message);
  }
}

export { AIUsage };
