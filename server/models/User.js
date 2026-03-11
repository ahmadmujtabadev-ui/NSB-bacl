import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const schema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  name:         { type: String, required: true, trim: true },
  role:         { type: String, enum: ['user', 'admin'], default: 'user' },
  credits:      { type: Number, default: 50, min: 0 },
  plan:         { type: String, enum: ['free', 'starter', 'pro'], default: 'free' },

  stripeCustomerId:    { type: String, sparse: true },
  stripeSubscriptionId:{ type: String },
  subscriptionStatus:  {
    type: String,
    enum: ['active', 'past_due', 'canceled', 'trialing', 'inactive'],
    default: 'inactive',
  },

  lastLoginAt: Date,
}, {
  timestamps: true,
  toJSON: {
    transform(_, ret) {
      delete ret.passwordHash;
      return ret;
    },
  },
});

schema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

schema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, 12);
};

export const User = mongoose.model('User', schema);
