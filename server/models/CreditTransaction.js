import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount:      { type: Number, required: true }, // positive = credit, negative = debit
  type:        { type: String, enum: ['credit', 'debit'], required: true },
  description: { type: String, required: true },
  refType:     { type: String, enum: ['purchase', 'project', 'bonus', 'refund', 'admin'], default: 'project' },
  refId:       { type: mongoose.Schema.Types.ObjectId }, // projectId, stripePaymentId, etc.
  balanceAfter:{ type: Number }, // snapshot of balance after transaction
}, { timestamps: true });

schema.index({ userId: 1, createdAt: -1 });

export const CreditTransaction = mongoose.model('CreditTransaction', schema);
