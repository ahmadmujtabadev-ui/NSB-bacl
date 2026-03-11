import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
  universeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Universe', required: true },
  name:       { type: String, required: true, trim: true },

  islamicValues:    { type: [String], default: [] },
  duas: [{
    arabic:          { type: String, required: true },
    transliteration: { type: String, required: true },
    meaning:         { type: String, required: true },
    context:         String,
    _id: false,
  }],
  vocabulary: [{
    word:       { type: String, required: true },
    definition: { type: String, required: true },
    ageGroup:   String,
    _id: false,
  }],
  illustrationRules: { type: [String], default: [] },
  avoidTopics:       { type: [String], default: [] },
  customRules:       String,
}, { timestamps: true });

schema.index({ universeId: 1, userId: 1 });

export const KnowledgeBase = mongoose.model('KnowledgeBase', schema);
