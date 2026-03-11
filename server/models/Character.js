import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
  universeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Universe', required: true },
  name:       { type: String, required: true, trim: true },
  role:       { type: String, enum: ['protagonist', 'supporting', 'villain', 'elder', 'other'], default: 'protagonist' },
  ageRange:   String,
  traits:     { type: [String], default: [] },
  speakingStyle: String,

  visualDNA: {
    style:        String,
    gender:       String,
    skinTone:     String,
    eyeColor:     String,
    faceShape:    String,
    hairOrHijab:  String,
    outfitRules:  String,
    accessories:  String,
    paletteNotes: String,
  },

  modestyRules: {
    hijabAlways:   { type: Boolean, default: false },
    longSleeves:   { type: Boolean, default: false },
    looseClothing: { type: Boolean, default: true },
    notes:         String,
  },

  imageUrl:     String, // Cloudinary CDN — portrait
  poseSheetUrl: String, // Cloudinary CDN — 12-pose sheet
  status: { type: String, enum: ['draft', 'generated', 'approved'], default: 'draft' },
}, { timestamps: true });

schema.index({ universeId: 1, userId: 1 });

export const Character = mongoose.model('Character', schema);
