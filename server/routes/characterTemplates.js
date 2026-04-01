import { Router } from 'express';
import { CharacterTemplate } from '../models/CharacterTemplate.js';
import { Character } from '../models/Character.js';

const router = Router();

// ─── Built-in default templates ───────────────────────────────────────────────
// These are always available to every user regardless of DB state.
const DEFAULT_TEMPLATES = [
  {
    _id: 'default_hijabi_girl_pastel',
    name: 'Hijabi Girl – Pastel Garden',
    description: 'A cheerful young girl with a pink hijab and pastel outfit. Perfect for stories about kindness and nature.',
    category: 'girl',
    thumbnailUrl: '',
    tags: ['hijabi', 'pastel', 'young', 'girl'],
    isDefault: true,
    role: 'protagonist',
    ageRange: '5-8',
    traits: ['kind', 'cheerful', 'curious'],
    visualDNA: {
      style: 'pixar-3d',
      gender: 'girl',
      ageLook: '6-year-old',
      skinTone: 'light-beige',
      eyeColor: 'dark-brown',
      faceShape: 'round-friendly',
      eyebrowStyle: 'soft-rounded',
      noseStyle: 'button',
      cheekStyle: 'chubby-rosy',
      hairStyle: '',
      hairColor: '',
      hairVisibility: 'hidden',
      hijabStyle: 'pink-solid',
      hijabColor: 'pink',
      topGarmentType: 'long-sleeve tunic',
      topGarmentColor: 'teal',
      topGarmentDetails: 'daisy embroidery on collar',
      bottomGarmentType: 'wide-leg pants',
      bottomGarmentColor: 'white',
      shoeType: 'mary-jane flats',
      shoeColor: 'white',
      bodyBuild: 'average build',
      heightFeel: 'small',
      heightCm: 112,
      weightKg: 20,
      facialHair: '',
      glasses: '',
      accessories: ['small floral wristband'],
      paletteNotes: 'Soft pastels — teal, pink, white',
    },
    modestyRules: { hijabAlways: true, longSleeves: true, looseClothing: true, notes: '' },
    palettePreview: { primary: '#E88CC8', secondary: '#4DB6AC', accent: '#FFFFFF' },
  },
  {
    _id: 'default_adventurous_boy',
    name: 'Adventurous Boy – Warm Earth',
    description: 'A brave boy with a warm tan complexion, ready for every adventure. Great for journey and discovery stories.',
    category: 'boy',
    thumbnailUrl: '',
    tags: ['boy', 'adventure', 'earth-tones'],
    isDefault: true,
    role: 'protagonist',
    ageRange: '6-10',
    traits: ['brave', 'adventurous', 'curious'],
    visualDNA: {
      style: 'pixar-3d',
      gender: 'boy',
      ageLook: '8-year-old',
      skinTone: 'tan',
      eyeColor: 'dark-brown',
      faceShape: 'square-determined',
      eyebrowStyle: 'thick-arched',
      noseStyle: 'rounded-soft',
      cheekStyle: 'flat-smooth',
      hairStyle: 'short-dark-brown',
      hairColor: 'dark-brown',
      hairVisibility: 'visible',
      hijabStyle: '',
      hijabColor: '',
      topGarmentType: 'polo shirt',
      topGarmentColor: 'orange',
      topGarmentDetails: '',
      bottomGarmentType: 'cargo pants',
      bottomGarmentColor: 'khaki',
      shoeType: 'sneakers',
      shoeColor: 'brown',
      bodyBuild: 'average build',
      heightFeel: 'average height',
      heightCm: 128,
      weightKg: 28,
      facialHair: '',
      glasses: '',
      accessories: ['small backpack'],
      paletteNotes: 'Warm earth — orange, khaki, brown',
    },
    modestyRules: { hijabAlways: false, longSleeves: false, looseClothing: true, notes: '' },
    palettePreview: { primary: '#F4A041', secondary: '#C3A37E', accent: '#7B5E3A' },
  },
  {
    _id: 'default_wise_grandma',
    name: 'Wise Nana – Soft Grace',
    description: 'A warm and gentle grandmother figure with soft beige hijab. Perfect for wisdom and family stories.',
    category: 'elder-female',
    thumbnailUrl: '',
    tags: ['elder', 'female', 'hijabi', 'wisdom', 'family'],
    isDefault: true,
    role: 'supporting',
    ageRange: '60-70',
    traits: ['wise', 'kind', 'patient'],
    visualDNA: {
      style: 'pixar-3d',
      gender: 'female',
      ageLook: 'elderly woman 65',
      skinTone: 'warm-olive',
      eyeColor: 'hazel',
      faceShape: 'oval-gentle',
      eyebrowStyle: 'thin-straight',
      noseStyle: 'rounded-soft',
      cheekStyle: 'soft-round',
      hairStyle: '',
      hairColor: '',
      hairVisibility: 'hidden',
      hijabStyle: 'simple-beige',
      hijabColor: 'beige',
      topGarmentType: 'long robe / abaya',
      topGarmentColor: 'sage green',
      topGarmentDetails: 'simple gold trim on cuffs',
      bottomGarmentType: 'long skirt',
      bottomGarmentColor: 'cream',
      shoeType: 'soft slippers',
      shoeColor: 'beige',
      bodyBuild: 'average build',
      heightFeel: 'average height',
      heightCm: 155,
      weightKg: 65,
      facialHair: '',
      glasses: 'round gold-frame glasses',
      accessories: ['prayer beads (tasbih) in hand'],
      paletteNotes: 'Muted sage, cream, beige — warm and soft',
    },
    modestyRules: { hijabAlways: true, longSleeves: true, looseClothing: true, notes: '' },
    palettePreview: { primary: '#A2B5A0', secondary: '#D4C5A9', accent: '#C9A86C' },
  },
  {
    _id: 'default_wise_grandpa',
    name: 'Kind Grandpa – White Beard',
    description: 'A gentle grandfather with a full white beard and warm smile. Ideal for wisdom and storytelling roles.',
    category: 'elder-male',
    thumbnailUrl: '',
    tags: ['elder', 'male', 'beard', 'wisdom', 'family'],
    isDefault: true,
    role: 'supporting',
    ageRange: '65-75',
    traits: ['wise', 'patient', 'gentle'],
    visualDNA: {
      style: 'pixar-3d',
      gender: 'male',
      ageLook: 'elderly man 70',
      skinTone: 'golden',
      eyeColor: 'brown',
      faceShape: 'oval-balanced',
      eyebrowStyle: 'bushy-straight',
      noseStyle: 'broad-flat',
      cheekStyle: 'soft-round',
      hairStyle: 'short white',
      hairColor: 'white',
      hairVisibility: 'visible',
      hijabStyle: '',
      hijabColor: '',
      topGarmentType: 'long thobe / jubbah',
      topGarmentColor: 'white',
      topGarmentDetails: 'light embroidery on collar',
      bottomGarmentType: 'matching trousers',
      bottomGarmentColor: 'white',
      shoeType: 'leather sandals',
      shoeColor: 'brown',
      bodyBuild: 'average build',
      heightFeel: 'tall',
      heightCm: 168,
      weightKg: 75,
      facialHair: 'full white beard, well-groomed',
      glasses: '',
      accessories: ['kufi cap (white)', 'prayer beads in pocket'],
      paletteNotes: 'Clean white, warm brown, golden',
    },
    modestyRules: { hijabAlways: false, longSleeves: true, looseClothing: true, notes: '' },
    palettePreview: { primary: '#F5F5F0', secondary: '#C8A86C', accent: '#8B6347' },
  },
  {
    _id: 'default_toddler_girl',
    name: 'Toddler Daisy – Sunshine Yellow',
    description: 'An adorable chubby toddler in sunshine yellow. Perfect for under-3 picture books about play and learning.',
    category: 'toddler',
    thumbnailUrl: '',
    tags: ['toddler', 'girl', 'yellow', 'cute', 'young'],
    isDefault: true,
    role: 'protagonist',
    ageRange: '2-4',
    traits: ['playful', 'curious', 'cheerful'],
    visualDNA: {
      style: 'pixar-3d',
      gender: 'girl',
      ageLook: '3-year-old toddler',
      skinTone: 'fair',
      eyeColor: 'dark-brown',
      faceShape: 'round-youthful',
      eyebrowStyle: 'soft-rounded',
      noseStyle: 'button',
      cheekStyle: 'chubby-rosy',
      hairStyle: 'ponytail-high',
      hairColor: 'dark-brown',
      hairVisibility: 'visible',
      hijabStyle: '',
      hijabColor: '',
      topGarmentType: 'puffy dress',
      topGarmentColor: 'yellow',
      topGarmentDetails: 'small daisy buttons',
      bottomGarmentType: 'bloomers/diaper cover',
      bottomGarmentColor: 'white',
      shoeType: 'mary-jane flats',
      shoeColor: 'yellow',
      bodyBuild: 'chubby and soft',
      heightFeel: 'very small',
      heightCm: 88,
      weightKg: 14,
      facialHair: '',
      glasses: '',
      accessories: [],
      paletteNotes: 'Sunshine yellow, white — soft and bright',
    },
    modestyRules: { hijabAlways: false, longSleeves: false, looseClothing: false, notes: '' },
    palettePreview: { primary: '#FFD54F', secondary: '#FFFFFF', accent: '#FFAB40' },
  },
  {
    _id: 'default_teen_hijabi',
    name: 'Teen Hijabi – Confident Purple',
    description: 'A confident teenager with a purple hijab. Perfect for stories about identity, friendship, and faith.',
    category: 'teen-girl',
    thumbnailUrl: '',
    tags: ['teen', 'hijabi', 'purple', 'confident', 'girl'],
    isDefault: true,
    role: 'protagonist',
    ageRange: '13-16',
    traits: ['confident', 'determined', 'creative'],
    visualDNA: {
      style: 'pixar-3d',
      gender: 'girl',
      ageLook: '14-year-old teenager',
      skinTone: 'caramel',
      eyeColor: 'dark-brown',
      faceShape: 'oval-gentle',
      eyebrowStyle: 'thick-arched',
      noseStyle: 'straight-narrow',
      cheekStyle: 'high-defined',
      hairStyle: '',
      hairColor: '',
      hairVisibility: 'hidden',
      hijabStyle: 'purple-solid',
      hijabColor: 'purple',
      topGarmentType: 'modest blouse',
      topGarmentColor: 'purple',
      topGarmentDetails: '',
      bottomGarmentType: 'wide-leg trousers',
      bottomGarmentColor: 'dark navy',
      shoeType: 'sneakers',
      shoeColor: 'white',
      bodyBuild: 'slim and lean',
      heightFeel: 'tall',
      heightCm: 162,
      weightKg: 52,
      facialHair: '',
      glasses: '',
      accessories: ['small backpack', 'notebook'],
      paletteNotes: 'Purple, navy, white — bold and clean',
    },
    modestyRules: { hijabAlways: true, longSleeves: true, looseClothing: true, notes: '' },
    palettePreview: { primary: '#9C27B0', secondary: '#1A237E', accent: '#FFFFFF' },
  },
  {
    _id: 'default_young_boy_creative',
    name: 'Creative Boy – Ocean Blue',
    description: 'A playful and imaginative boy with curly hair. Great for art, science, and creative adventure stories.',
    category: 'boy',
    thumbnailUrl: '',
    tags: ['boy', 'curly', 'blue', 'creative', 'playful'],
    isDefault: true,
    role: 'protagonist',
    ageRange: '8-12',
    traits: ['creative', 'playful', 'helpful'],
    visualDNA: {
      style: 'pixar-3d',
      gender: 'boy',
      ageLook: '10-year-old',
      skinTone: 'brown',
      eyeColor: 'dark-brown',
      faceShape: 'round-friendly',
      eyebrowStyle: 'natural-full',
      noseStyle: 'rounded-soft',
      cheekStyle: 'dimpled',
      hairStyle: 'curly-black',
      hairColor: 'black',
      hairVisibility: 'visible',
      hijabStyle: '',
      hijabColor: '',
      topGarmentType: 'graphic t-shirt',
      topGarmentColor: 'blue',
      topGarmentDetails: 'paint splash pattern',
      bottomGarmentType: 'jeans',
      bottomGarmentColor: 'dark blue',
      shoeType: 'sneakers',
      shoeColor: 'white',
      bodyBuild: 'slim and lean',
      heightFeel: 'average height',
      heightCm: 138,
      weightKg: 33,
      facialHair: '',
      glasses: '',
      accessories: ['art bag', 'paint brush in pocket'],
      paletteNotes: 'Blues, white — fresh and creative',
    },
    modestyRules: { hijabAlways: false, longSleeves: false, looseClothing: false, notes: '' },
    palettePreview: { primary: '#1976D2', secondary: '#1565C0', accent: '#FFFFFF' },
  },
  {
    _id: 'default_golden_bird',
    name: 'Sunny – Golden Bird',
    description: 'A cheerful round golden bird companion character. Perfect as a loyal sidekick in any Islamic children\'s story.',
    category: 'animal',
    thumbnailUrl: '',
    tags: ['animal', 'bird', 'golden', 'companion', 'cheerful'],
    isDefault: true,
    role: 'supporting',
    ageRange: 'n/a',
    traits: ['cheerful', 'curious', 'loyal'],
    visualDNA: {
      style: 'pixar-3d',
      gender: 'neutral',
      ageLook: 'small bird',
      skinTone: '',
      eyeColor: 'dark-brown',
      faceShape: 'round-friendly',
      eyebrowStyle: '',
      noseStyle: '',
      cheekStyle: '',
      hairStyle: '',
      hairColor: 'golden-yellow',
      hairVisibility: 'visible',
      hijabStyle: '',
      hijabColor: '',
      topGarmentType: '',
      topGarmentColor: 'golden yellow',
      topGarmentDetails: 'orange-tipped wing feathers',
      bottomGarmentType: '',
      bottomGarmentColor: '',
      shoeType: '',
      shoeColor: 'orange',
      bodyBuild: 'chubby and soft',
      heightFeel: 'very small',
      heightCm: 18,
      weightKg: 0,
      facialHair: '',
      glasses: '',
      accessories: [],
      paletteNotes: 'Golden yellow body, orange wing tips, white chest',
    },
    modestyRules: { hijabAlways: false, longSleeves: false, looseClothing: false, notes: '' },
    palettePreview: { primary: '#FFD740', secondary: '#FF6D00', accent: '#FFFFFF' },
  },
];

// ─── Helper: merge default template thumbnail overrides from DB ───────────────
async function mergeDefaultThumbnails(defaults) {
  const refs = defaults.map((t) => t._id);
  const overrides = await CharacterTemplate.find({ defaultTemplateRef: { $in: refs } }).lean();
  const overrideMap = {};
  for (const o of overrides) overrideMap[o.defaultTemplateRef] = o.thumbnailUrl;
  return defaults.map((t) => overrideMap[t._id] ? { ...t, thumbnailUrl: overrideMap[t._id] } : t);
}

// ─── GET /api/character-templates ────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const [userTemplates, defaultsWithThumbnails] = await Promise.all([
      CharacterTemplate.find({
        defaultTemplateRef: '',       // exclude override-only docs
        $or: [
          { createdBy: req.user._id },
          { isPublic: true },
        ],
      }).sort({ createdAt: -1 }).lean(),
      mergeDefaultThumbnails(DEFAULT_TEMPLATES),
    ]);

    res.json([...defaultsWithThumbnails, ...userTemplates]);
  } catch (e) {
    next(e);
  }
});

// ─── GET /api/character-templates/defaults ───────────────────────────────────
router.get('/defaults', async (req, res, next) => {
  try {
    res.json(await mergeDefaultThumbnails(DEFAULT_TEMPLATES));
  } catch (e) {
    next(e);
  }
});

// ─── PATCH /api/character-templates/:id/thumbnail ────────────────────────────
router.patch('/:id/thumbnail', async (req, res, next) => {
  try {
    const { thumbnailUrl } = req.body;
    if (!thumbnailUrl) return res.status(400).json({ error: { code: 'VALIDATION', message: 'thumbnailUrl is required' } });

    const isDefault = DEFAULT_TEMPLATES.some((t) => t._id === req.params.id);

    if (isDefault) {
      // Upsert an override document for this default template
      await CharacterTemplate.findOneAndUpdate(
        { defaultTemplateRef: req.params.id },
        { defaultTemplateRef: req.params.id, thumbnailUrl, name: req.params.id, category: 'girl', isDefault: false },
        { upsert: true, new: true }
      );
    } else {
      const tpl = await CharacterTemplate.findOne({ _id: req.params.id });
      if (!tpl) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } });
      tpl.thumbnailUrl = thumbnailUrl;
      await tpl.save();
    }

    res.json({ message: 'Thumbnail updated', thumbnailUrl });
  } catch (e) {
    next(e);
  }
});

// ─── GET /api/character-templates/:id ────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    // Check built-in defaults first (with thumbnail override)
    const def = DEFAULT_TEMPLATES.find((t) => t._id === req.params.id);
    if (def) {
      const override = await CharacterTemplate.findOne({ defaultTemplateRef: req.params.id }).lean();
      return res.json(override?.thumbnailUrl ? { ...def, thumbnailUrl: override.thumbnailUrl } : def);
    }

    const tpl = await CharacterTemplate.findById(req.params.id).lean();
    if (!tpl) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } });

    res.json(tpl);
  } catch (e) {
    next(e);
  }
});

// ─── POST /api/character-templates — save an existing character as template ──
router.post('/', async (req, res, next) => {
  try {
    const {
      name,
      description = '',
      category,
      characterId,
      tags = [],
      isPublic = false,
    } = req.body;

    if (!name) return res.status(400).json({ error: { code: 'VALIDATION', message: 'name is required' } });
    if (!category) return res.status(400).json({ error: { code: 'VALIDATION', message: 'category is required' } });

    let visualDNA = {};
    let modestyRules = {};
    let traits = [];
    let role = 'supporting';
    let ageRange = '';
    let thumbnailUrl = '';

    if (characterId) {
      const char = await Character.findOne({ _id: characterId, userId: req.user._id });
      if (!char) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Character not found' } });

      visualDNA = char.visualDNA?.toObject ? char.visualDNA.toObject() : (char.visualDNA || {});
      modestyRules = char.modestyRules?.toObject ? char.modestyRules.toObject() : (char.modestyRules || {});
      traits = char.traits || [];
      role = char.role || 'supporting';
      ageRange = char.ageRange || '';
      thumbnailUrl = char.imageUrl || '';
    } else {
      visualDNA = req.body.visualDNA || {};
      modestyRules = req.body.modestyRules || {};
      traits = req.body.traits || [];
      role = req.body.role || 'supporting';
      ageRange = req.body.ageRange || '';
    }

    const template = await CharacterTemplate.create({
      name,
      description,
      category,
      thumbnailUrl,
      tags,
      isDefault: false,
      isPublic,
      createdBy: req.user._id,
      role,
      ageRange,
      traits,
      visualDNA,
      modestyRules,
    });

    res.status(201).json(template);
  } catch (e) {
    next(e);
  }
});

// ─── DELETE /api/character-templates/:id ─────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const tpl = await CharacterTemplate.findOne({ _id: req.params.id, createdBy: req.user._id });
    if (!tpl) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found or not yours' } });

    await tpl.deleteOne();
    res.json({ message: 'Template deleted' });
  } catch (e) {
    next(e);
  }
});

export default router;
