import mongoose from 'mongoose';

const visualDNASchema = new mongoose.Schema({
  style: { type: String, default: '' },
  gender: { type: String, default: '' },
  ageLook: { type: String, default: '' },
  skinTone: { type: String, default: '' },
  eyeColor: { type: String, default: '' },
  faceShape: { type: String, default: '' },
  eyebrowStyle: { type: String, default: '' },
  noseStyle: { type: String, default: '' },
  cheekStyle: { type: String, default: '' },
  hairStyle: { type: String, default: '' },
  hairColor: { type: String, default: '' },
  hairVisibility: { type: String, default: 'visible' },
  hijabStyle: { type: String, default: '' },
  hijabColor: { type: String, default: '' },
  topGarmentType: { type: String, default: '' },
  topGarmentColor: { type: String, default: '' },
  topGarmentDetails: { type: String, default: '' },
  bottomGarmentType: { type: String, default: '' },
  bottomGarmentColor: { type: String, default: '' },
  shoeType: { type: String, default: '' },
  shoeColor: { type: String, default: '' },
  bodyBuild: { type: String, default: '' },
  heightFeel: { type: String, default: '' },
  heightCm: { type: Number, default: 0 },
  weightKg: { type: Number, default: 0 },
  facialHair: { type: String, default: '' },
  glasses: { type: String, default: '' },
  accessories: { type: [String], default: [] },
  paletteNotes: { type: String, default: '' },
}, { _id: false });

const characterTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    category: {
      type: String,
      enum: ['girl', 'boy', 'elder-female', 'elder-male', 'animal', 'toddler', 'teen-girl', 'teen-boy', 'adult-male', 'adult-female'],
      required: true,
    },
    thumbnailUrl: { type: String, default: '' },
    // For default (hardcoded) templates: stores the string ID of the default template
    // so thumbnail overrides can be persisted in DB without changing the hardcoded array.
    defaultTemplateRef: { type: String, default: '' },
    tags: { type: [String], default: [] },
    isDefault: { type: Boolean, default: false },
    isPublic: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Core character fields
    role: { type: String, default: 'supporting' },
    ageRange: { type: String, default: '' },
    traits: { type: [String], default: [] },
    visualDNA: { type: visualDNASchema, default: () => ({}) },
    modestyRules: {
      hijabAlways: { type: Boolean, default: false },
      longSleeves: { type: Boolean, default: false },
      looseClothing: { type: Boolean, default: true },
      notes: { type: String, default: '' },
    },

    // Palette summary for display
    palettePreview: {
      primary: { type: String, default: '' },
      secondary: { type: String, default: '' },
      accent: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

export const CharacterTemplate = mongoose.model('CharacterTemplate', characterTemplateSchema);
