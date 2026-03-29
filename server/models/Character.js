import mongoose from 'mongoose';

const poseSchema = new mongoose.Schema(
  {
    poseKey: { type: String, required: true, trim: true }, // standing, sitting, waving
    label: { type: String, required: true, trim: true },
    prompt: { type: String, default: '' },                 // exact pose prompt used
    imageUrl: { type: String, default: '' },               // optional per-pose image
    sourceSheetUrl: { type: String, default: '' },         // pose sheet source
    approved: { type: Boolean, default: true },
    priority: { type: Number, default: 0 },
    useForScenes: { type: [String], default: [] },         // ["walking", "greeting"]
    notes: { type: String, default: '' },
  },
  { _id: false }
);

const promptConfigSchema = new mongoose.Schema(
  {
    masterSystemNote: { type: String, default: '' },
    portraitPromptPrefix: { type: String, default: '' },
    portraitPromptSuffix: { type: String, default: '' },
    posePromptPrefix: { type: String, default: '' },
    posePromptSuffix: { type: String, default: '' },
    scenePromptPrefix: { type: String, default: '' }, // later reused in chapter/spread prompts
    scenePromptSuffix: { type: String, default: '' },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    universeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Universe', required: true },

    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ['protagonist', 'supporting', 'villain', 'elder', 'other'],
      default: 'protagonist',
    },

    ageRange: { type: String, default: '' },
    traits: { type: [String], default: [] },

    visualDNA: {
      style: { type: String, default: 'pixar-3d' },
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
      hairVisibility: {
        type: String,
        enum: ['visible', 'partially-visible', 'hidden'],
        default: 'visible',
      },

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
      heightCm: { type: Number, default: 0, min: 0, max: 250 },
      heightFeet: { type: Number, default: 0, min: 0, max: 9 },
      weightKg: { type: Number, default: 0, min: 0, max: 300 },
      weightCategory: { type: String, default: '' }, // derived from BMI — do NOT set by user

      // Facial features — explicit locks so AI never randomises these
      facialHair: { type: String, default: '' },   // e.g. "white full beard", "trimmed white mustache", "" = clean-shaven
      glasses: { type: String, default: '' },       // e.g. "round black-frame glasses", "" = no glasses

      accessories: { type: [String], default: [] },
      paletteNotes: { type: String, default: '' },

      // legacy compatibility
      hairOrHijab: { type: String, default: '' },
      outfitRules: { type: String, default: '' },
    },

    modestyRules: {
      hijabAlways: { type: Boolean, default: false },
      longSleeves: { type: Boolean, default: false },
      looseClothing: { type: Boolean, default: true },
      notes: { type: String, default: '' },
    },

    imageUrl: { type: String, default: '' },           // portrait
    selectedStyle: { type: String, default: '' },
    styleApprovedAt: { type: Date },

    poseLibrary: { type: [poseSchema], default: [] },
    approvedPoseKeys: { type: [String], default: [] },

    promptConfig: {
      type: promptConfigSchema,
      default: () => ({
        masterSystemNote: '',
        portraitPromptPrefix: '',
        portraitPromptSuffix: '',
        posePromptPrefix: '',
        posePromptSuffix: '',
        scenePromptPrefix: '',
        scenePromptSuffix: '',
      }),
    },

    generationMeta: {
      portraitPrompt: { type: String, default: '' },
      poseSheetPrompt: { type: String, default: '' },
      poseCount: { type: Number, default: 0 },
    },

    status: {
      type: String,
      enum: ['draft', 'generated', 'approved'],
      default: 'draft',
    },
  },
  { timestamps: true }
);

schema.index({ universeId: 1, userId: 1 });
schema.index({ userId: 1, updatedAt: -1 });

export const Character = mongoose.model('Character', schema);