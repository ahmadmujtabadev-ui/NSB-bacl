import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:        { type: String, required: true, trim: true },
  description: String,
  seriesBible: String,
  artStyle:    { type: String, enum: ['pixar-3d', 'watercolor', 'anime', 'manga', '2d-vector', 'paper-cutout'], default: 'pixar-3d' },
  colorPalette:{ type: [String], default: [] },
  islamicRules:{
    hijabAlways:  { type: Boolean, default: true },
    noMusic:      { type: Boolean, default: false },
    noAnimals:    { type: Boolean, default: false },
    customRules:  String,
  },
  tags: { type: [String], default: [] },
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

schema.virtual('characterCount', { ref: 'Character', localField: '_id', foreignField: 'universeId', count: true });
schema.virtual('bookCount',      { ref: 'Project',   localField: '_id', foreignField: 'universeId', count: true });
schema.index({ userId: 1, updatedAt: -1 });

export const Universe = mongoose.model('Universe', schema);
