/**
 * seed-test-data.js
 *
 * Creates two complete test datasets for the user decoded from the provided JWT:
 *   userId = 69b09edec765c521498fb056
 *
 * Dataset A — "Sunshine Garden"   (2–4 year-olds, picture book / spreads)
 * Dataset B — "The Crescent Academy" (10–12 year-olds, chapter book)
 *
 * Each dataset contains:
 *   • 1 Universe
 *   • 5 Characters  (all statuses: draft / generated / approved mix)
 *   • 1 KnowledgeBase
 *
 * Usage:
 *   node server/scripts/seed-test-data.js
 *
 * Safe to re-run — it deletes any previous seed data for this user that
 * carries the seedTag before inserting fresh records.
 */

import mongoose from 'mongoose';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

// ─── Inline MongoDB URI (same as .env) ────────────────────────────────────────
// No DB name in URI — matches the app .env exactly, so Mongoose lands in "test"
const MONGO_URI =
  'mongodb+srv://noorstudio:th5BG7KZ@cluster0.gi6ta62.mongodb.net';

const USER_ID = new mongoose.Types.ObjectId('69b09edec765c521498fb056');

// ─── Load models (ESM dynamic import from existing files) ──────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadModels() {
  const toUrl = (rel) => pathToFileURL(path.join(__dirname, rel)).href;
  const [modU, modC, modK] = await Promise.all([
    import(toUrl('../models/Universe.js')),
    import(toUrl('../models/Character.js')),
    import(toUrl('../models/KnowledgeBase.js')),
  ]);
  // Models may be named exports or default exports
  const Universe      = modU.Universe      ?? modU.default;
  const Character     = modC.Character     ?? modC.default;
  const KnowledgeBase = modK.KnowledgeBase ?? modK.default;
  return { Universe, Character, KnowledgeBase };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATASET A — SUNSHINE GARDEN  (ages 2–4, picture book)
// ═══════════════════════════════════════════════════════════════════════════════

function buildUniverseA() {
  return {
    userId: USER_ID,
    name: 'Sunshine Garden',
    description:
      'A cosy, colourful village surrounded by flowers and fruit trees where toddlers discover kindness, sharing, and the beauty of saying Bismillah before every little task.',
    seriesBible:
      'Every story must be completable in one read-aloud sitting (≤10 minutes). ' +
      'Each spread ends with a single gentle lesson. ' +
      'No conflict that cannot be resolved by the end of the book.',
    artStyle: 'pixar-3d',
    ageRange: '2-4',
    tone: 'calm-educational',
    colorPalette: ['#FFD166', '#06D6A0', '#118AB2', '#EF476F', '#FFF9C4'],
    islamicRules: {
      hijabAlways: true,
      noMusic: false,
      noAnimals: false,
      customRules: 'All female characters 7+ wear hijab. Every action begins with Bismillah.',
    },
    tags: ['toddler', 'picture-book', 'nature', 'kindness', 'islamic'],
  };
}

function buildCharactersA(universeId) {
  return [
    // ── 1. Zara (protagonist) ─────────────────────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Zara',
      role: 'protagonist',
      ageRange: '4',
      traits: ['curious', 'kind', 'loves flowers', 'giggly', 'brave'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'female',
        ageLook: '3-year-old toddler',
        skinTone: 'warm honey-brown',
        eyeColor: 'dark brown',
        faceShape: 'round & friendly',
        eyebrowStyle: 'thin soft arches',
        noseStyle: 'tiny button nose',
        cheekStyle: 'full rosy chubby cheeks',
        hairStyle: 'two small puffs / pigtails peeking from hijab',
        hairColor: 'black',
        hairVisibility: 'partially-visible',
        hijabStyle: 'soft round baby hijab with small flower pin',
        hijabColor: 'pastel yellow with tiny white daisies',
        topGarmentType: 'long-sleeve tunic',
        topGarmentColor: 'mint green',
        topGarmentDetails: 'embroidered collar with small flowers',
        bottomGarmentType: 'wide-leg trousers',
        bottomGarmentColor: 'soft white',
        shoeType: 'rounded toddler Mary-Jane flats',
        shoeColor: 'sunshine yellow',
        bodyBuild: 'small toddler round tummy',
        heightFeel: 'very small',
        heightCm: 96,
        heightFeet: 3,
        weightKg: 14,
        weightCategory: 'healthy',
        accessories: ['small daisy wristband', 'tiny pink backpack with star charm'],
        paletteNotes: 'Warm yellows, mint greens, soft whites — always cheerful',
      },
      modestyRules: { hijabAlways: true, longSleeves: true, looseClothing: true },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Zara is a tiny 3-year-old Muslim girl full of wonder. Always render her in toddler proportions — big head, chubby hands, round tummy. She wears her flower hijab proudly and her eyes catch the light.',
        portraitPromptPrefix:
          'Portrait of Zara, a 3-year-old Muslim toddler girl, pixar-3d style, warm studio lighting, ',
        scenePromptPrefix:
          'Zara (tiny Muslim toddler, mint tunic, yellow flower hijab, dark sparkly eyes) ',
      },
    },

    // ── 2. Adam (supporting boy) ──────────────────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Adam',
      role: 'supporting',
      ageRange: '4',
      traits: ['playful', 'generous', 'loves to run', 'loud laugh', 'protective of Zara'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'male',
        ageLook: '4-year-old toddler',
        skinTone: 'light olive',
        eyeColor: 'hazel-green',
        faceShape: 'round with rosy cheeks',
        eyebrowStyle: 'slightly bushy, expressive',
        noseStyle: 'small button',
        cheekStyle: 'chubby pink',
        hairStyle: 'short curly dark hair, slightly messy',
        hairColor: 'dark brown',
        hairVisibility: 'visible',
        hijabStyle: '',
        hijabColor: '',
        topGarmentType: 'short-sleeve t-shirt',
        topGarmentColor: 'sky blue with small crescent moon print',
        topGarmentDetails: 'tiny crescent moon embroidered on chest',
        bottomGarmentType: 'elastic-waist shorts',
        bottomGarmentColor: 'navy blue',
        shoeType: 'velcro sneakers',
        shoeColor: 'white with blue trim',
        bodyBuild: 'sturdy toddler, slight round tummy',
        heightFeel: 'slightly taller than Zara',
        heightCm: 104,
        heightFeet: 3,
        weightKg: 16,
        weightCategory: 'healthy',
        accessories: ['small orange kite in hand (key prop)', 'bandage on left knee'],
        paletteNotes: 'Blues, navy, white — active and energetic palette',
      },
      modestyRules: { hijabAlways: false, longSleeves: false, looseClothing: true },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Adam is a 4-year-old energetic Muslim boy, pixar-3d toddler proportions. He always looks ready to run or jump. Expressive hazel eyes. Often shown mid-action.',
        portraitPromptPrefix:
          'Portrait of Adam, energetic 4-year-old Muslim toddler boy, pixar-3d style, ',
        scenePromptPrefix:
          'Adam (4-year-old toddler boy, blue crescent t-shirt, curly dark hair, hazel eyes) ',
      },
    },

    // ── 3. Baba (supporting — father figure) ──────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Baba',
      role: 'supporting',
      ageRange: '35-40',
      traits: ['gentle giant', 'patient', 'loves gardening', 'storyteller at bedtime', 'protective'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'male',
        ageLook: 'mid-30s father',
        skinTone: 'warm medium brown',
        eyeColor: 'dark brown, kind and warm',
        faceShape: 'oval, strong jaw',
        eyebrowStyle: 'full dark brows',
        noseStyle: 'medium straight',
        cheekStyle: 'slight definition',
        hairStyle: 'short neat hair, slightly wavy',
        hairColor: 'black with slight grey at temples',
        hairVisibility: 'visible',
        facialHair: 'neat short beard, well-groomed, dark with slight grey',
        topGarmentType: 'long linen thobe / long-sleeve casual shirt',
        topGarmentColor: 'soft sage green',
        topGarmentDetails: 'simple neat stitching at collar',
        bottomGarmentType: 'loose linen trousers',
        bottomGarmentColor: 'cream/off-white',
        shoeType: 'simple leather sandals',
        shoeColor: 'tan brown',
        bodyBuild: 'tall, broad shoulders, gentle presence',
        heightFeel: 'tall — towers kindly over Zara and Adam',
        heightCm: 182,
        heightFeet: 6,
        weightKg: 82,
        weightCategory: 'healthy',
        accessories: ['small wooden rosary (tasbih) in hand', 'simple silver ring on right hand'],
        paletteNotes: 'Earth tones, sage green, cream — calm and trustworthy',
      },
      modestyRules: { hijabAlways: false, longSleeves: true, looseClothing: true },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Baba is Zara\'s father, a gentle tall Muslim man in his mid-30s. Always depicted with kind eyes and a warm beard. He kneels or crouches to be at child-level in scenes with Zara and Adam.',
        portraitPromptPrefix:
          'Portrait of Baba, gentle Muslim father mid-30s, pixar-3d style, warm lighting, ',
        scenePromptPrefix:
          'Baba (tall gentle Muslim father, sage thobe, neat beard, kind brown eyes) ',
      },
    },

    // ── 4. Nana (supporting — grandmother) ────────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Nana',
      role: 'elder',
      ageRange: '65-70',
      traits: ['deeply wise', 'warm storyteller', 'expert baker', 'always smiling', 'teaches duas'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'female',
        ageLook: 'elderly grandmother 65+',
        skinTone: 'warm deep brown, soft wrinkled skin',
        eyeColor: 'dark brown, crinkle-eyed when smiling',
        faceShape: 'round, soft wrinkles, full cheeks',
        eyebrowStyle: 'thin delicate white arches',
        noseStyle: 'soft slightly wide',
        cheekStyle: 'full warm grandmotherly cheeks',
        hairStyle: 'white hair fully covered',
        hairColor: 'white (not visible)',
        hairVisibility: 'hidden',
        hijabStyle: 'soft draped hijab, traditionally wrapped',
        hijabColor: 'dusty rose/mauve with small white floral border',
        topGarmentType: 'long modest blouse',
        topGarmentColor: 'dusty rose',
        topGarmentDetails: 'subtle geometric embroidery at cuffs',
        bottomGarmentType: 'long flowing skirt',
        bottomGarmentColor: 'deep plum',
        shoeType: 'soft flat indoor slippers',
        shoeColor: 'cream',
        bodyBuild: 'short, slightly rounded, grandmotherly soft',
        heightFeel: 'short and round, very approachable',
        heightCm: 158,
        heightFeet: 5,
        weightKg: 68,
        weightCategory: 'healthy',
        accessories: ['silver tasbih beads in hand', 'small reading glasses on nose', 'apron with flower pockets'],
        paletteNotes: 'Dusty rose, mauve, plum — warm, safe, home-feeling',
      },
      modestyRules: { hijabAlways: true, longSleeves: true, looseClothing: true },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Nana is a beloved Muslim grandmother, warm and round, always wearing her dusty rose hijab. She is always shown near the kitchen or garden. Her face has gentle smile lines. She is the heart of Sunshine Garden.',
        portraitPromptPrefix:
          'Portrait of Nana, warm Muslim grandmother 65+, pixar-3d style, cosy warm lighting, ',
        scenePromptPrefix:
          'Nana (short round Muslim grandmother, dusty rose hijab, silver tasbih, warm smile) ',
      },
    },

    // ── 5. Sunny (animal companion — friendly little bird) ────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Sunny',
      role: 'other',
      ageRange: 'n/a',
      traits: ['cheerful', 'chirps in response to duas', 'always perched near Zara', 'colourful wings', 'loves seeds'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'other',
        ageLook: 'small cartoon bird',
        skinTone: 'bright golden-yellow feathers',
        eyeColor: 'round black with white sparkle',
        faceShape: 'round tiny beak, big eyes',
        hairStyle: 'small crest of orange feathers on head',
        hairColor: 'orange',
        hairVisibility: 'visible',
        topGarmentType: 'none (feathers)',
        topGarmentColor: 'golden-yellow body, orange wing tips, white belly',
        bodyBuild: 'tiny round bird, plump and soft',
        heightFeel: 'tiny — fits in Zara\'s palm',
        heightCm: 15,
        heightFeet: 0,
        weightKg: 0,
        weightCategory: 'healthy',
        accessories: ['small red seed in beak (key prop)'],
        paletteNotes: 'Golden yellow, orange, white — sunshine personified',
      },
      modestyRules: { hijabAlways: false, longSleeves: false, looseClothing: false },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Sunny is a tiny golden cartoon bird companion in the Sunshine Garden universe. Always depicted as round, plump, and glowing yellow-orange. Shows emotion through wing position and eye expression.',
        portraitPromptPrefix:
          'Portrait of Sunny, tiny golden cartoon bird, pixar-3d style, soft warm lighting, ',
        scenePromptPrefix:
          'Sunny (tiny golden-yellow plump cartoon bird, orange crest, big sparkly eyes) ',
      },
    },
  ];
}

function buildKbA(universeId, characters) {
  const charMap = {};
  for (const c of characters) charMap[c.name] = c._id;

  return {
    userId: USER_ID,
    universeId,
    name: 'Sunshine Garden — Story Bible',

    islamicValues: [
      'Bismillah before every action',
      'Saying Alhamdulillah with gratitude',
      'Sharing is a form of sadaqah',
      'Kindness to animals is rewarded',
      'Listening to parents and grandparents',
    ],
    duas: [
      {
        arabic: 'بِسْمِ اللَّهِ',
        transliteration: 'Bismillah',
        meaning: 'In the name of Allah',
        context: 'Said before starting any task — eating, playing, drawing',
      },
      {
        arabic: 'الْحَمْدُ لِلَّهِ',
        transliteration: 'Alhamdulillah',
        meaning: 'All praise is for Allah',
        context: 'Said after finishing something good or receiving a gift',
      },
      {
        arabic: 'جَزَاكَ اللَّهُ خَيْرًا',
        transliteration: 'Jazak Allahu Khayran',
        meaning: 'May Allah reward you with goodness',
        context: 'Said when thanking a friend or family member',
      },
    ],
    vocabulary: [
      { word: 'Bismillah', definition: 'In the name of Allah — said before starting', ageGroup: '2-4' },
      { word: 'Baba', definition: 'Father / Daddy', ageGroup: '2-4' },
      { word: 'Nana', definition: 'Grandmother / Nanny', ageGroup: '2-4' },
      { word: 'Masjid', definition: 'The mosque — the place where Muslims pray together', ageGroup: '2-4' },
      { word: 'Sadaqah', definition: 'Giving to others — a kind and blessed act', ageGroup: '2-4' },
    ],
    avoidTopics: [
      'Violence or aggression of any kind',
      'Fear-based discipline',
      'Complex theological debate',
      'Death or loss (unless very gently handled in older books)',
      'Screen time or digital devices as reward',
    ],

    backgroundSettings: {
      junior: {
        tone: 'Bright, safe, familiar — every background feels like a hug',
        locations: ['flower garden', 'kitchen table', 'masjid courtyard', 'playground', 'Nana\'s living room'],
        colorStyle: 'Soft pastel base with one vibrant accent pop — never harsh contrasts',
        lightingStyle: 'Warm golden afternoon light or soft morning glow. No harsh shadows.',
        keyFeatures: [
          'Low camera angle (child eye-level)',
          'Rounded edges on all environment objects',
          'Flowers and plants must look friendly not wild',
          'Masjid dome visible in background skyline',
          'Texture: soft, slightly fuzzy, plush-toy feel',
        ],
        timeOfDay: 'golden-hour',
        cameraHint: 'wide',
        additionalNotes:
          'For toddler pages, backgrounds must not compete with characters. Use shallow depth-of-field blur on background elements.',
      },
      avoidBackgrounds: [
        'Dark forests at night',
        'Urban traffic or busy roads',
        'Scary weather (storms, lightning)',
        'Hospital or medical settings',
      ],
      universalRules:
        'Every scene must feel safe and returnable — toddlers should recognise these spaces as extensions of their own home.',
    },

    coverDesign: {
      titlePlacement: 'Top-centre, above characters, minimum 1/3 of cover height',
      authorTaglinePlacement: 'Bottom strip, gentle font',
      characterComposition: [
        'Zara must appear on every cover',
        'Adam appears on covers where play/outdoor theme',
        'Nana appears on kitchen/storytelling covers',
        'Sunny always perched somewhere visible',
      ],
      characterMustInclude: ['Zara'],
      atmosphere: {
        junior: 'Bright joyful sunshine, garden colours — warmth and safety',
      },
      typography: {
        junior: 'Bold rounded — Fredoka One or Baloo 2, min 48pt',
      },
      islamicMotifs: [
        'Subtle star-and-crescent in corner',
        'Floral arabesque border at bottom edge',
      ],
      brandingRules: [
        'Title must be legible at 200px thumbnail',
        'No faces cropped at cover edge',
        'Leave 60px safe zone at all four edges for printing bleed',
      ],
      avoidCover: [
        'Sad or crying characters on front cover',
        'Dark backgrounds',
        'More than 3 characters on a single cover',
      ],
    },

    underSixDesign: {
      maxWordsPerSpread: 10,
      pageCount: 24,
      readingType: 'parent-read',
      pageLayout: 'Full-bleed illustration left page; right page has text in bottom-third white band',
      fontStyle: 'Rounded, large — minimum 28pt, dyslexia-friendly',
      fontPreferences: ['Fredoka One', 'Baloo 2', 'Lexend'],
      lineSpacing: 'Wide — 1.8× line height',
      textJustification: 'Left-aligned only, never justified',
      spreadStructure: [
        { segment: 'Spread 1-2', description: 'Meet Zara in the garden — establish setting and character' },
        { segment: 'Spread 3-6', description: 'The gentle problem or question' },
        { segment: 'Spread 7-10', description: 'Zara tries, makes a small mistake, asks Nana or Baba' },
        { segment: 'Spread 11', description: 'The Islamic solution / dua moment' },
        { segment: 'Spread 12', description: 'Resolution — Alhamdulillah ending, Sunny chirps happily' },
      ],
      emotionalPattern: {
        conflictOrQuestion: 'Zara notices something unfair or puzzling',
        emotionReaction: 'She feels confused, a tiny bit sad — shown with soft eyes and drooping flower',
        resolve: 'Baba/Nana teaches a gentle lesson, dua is said together, happiness returns',
      },
      reflectionPrompt: 'What would you say? Can you say Bismillah before your next snack?',
      bonusPageContent: 'Final spread: large Bismillah calligraphy art + repeat-after-me dua panel',
      illustrationStyle: 'Pixar-3D, round soft shapes, plush-toy textures, no hard edges',
      colorPalette: 'Pastel sunshine palette — yellow, mint, coral, sky blue',
      specialRules: [
        'Max 10 words of text per spread (excluding dua)',
        'Every spread must show at least one Islamic element (hijab, tasbih, masjid dome in bg, dua)',
        'Sunny must appear on at least 8 out of 12 spreads',
      ],
    },

    characterGuides: [
      {
        characterId: charMap['Zara'],
        characterName: 'Zara',
        dialogueExamples: [
          '"Bismillah!" (before every task)',
          '"Nana, why do flowers sleep at night?"',
          '"Adam, we must share — Baba said so!"',
          '"Alhamdulillah, I found it!"',
        ],
        moreInfo:
          'Zara is the heart of every story. She asks questions that drive the plot. Her wonder must always be genuine — never sarcastic. She models Islamic behaviour naturally, not mechanically.',
        personalityNotes: [
          'Gets excited and talks fast when she discovers something new',
          'Hugs her knees when she is thinking',
          'Always says Bismillah loudly with both hands raised',
          'Cries only once per book — small tear, quickly comforted',
        ],
        literaryRole: 'Mirror for the young reader — she asks what they are thinking',
        faithGuide: {
          faithTone: 'joyful & imitative',
          faithExpressions: ['says Bismillah naturally before actions', 'copies Nana\'s tasbih movement', 'waves at the masjid dome when she passes'],
          duaStyle: 'loud and cheerful, hands raised high',
          islamicTraits: ['grateful', 'kind', 'obedient', 'curious'],
          faithExamples: [
            '"Bismillah!" she said, and picked up the watering can.',
            'Zara closed her eyes and whispered Alhamdulillah, just like Nana taught her.',
          ],
        },
      },
      {
        characterId: charMap['Nana'],
        characterName: 'Nana',
        dialogueExamples: [
          '"Come here, my little flower. Let Nana show you."',
          '"Every seed needs patience, just like every dua."',
          '"Say Bismillah first, habibti."',
          '"Alhamdulillah — look what Allah grew for us!"',
        ],
        moreInfo:
          'Nana is the wisdom anchor of every story. She never lectures — she shows. Her lessons come through stories, baking, or gardening. She always ends with a dua.',
        personalityNotes: [
          'Speaks slowly with warmth, often cups Zara\'s face gently',
          'Always has something cooking — the smell is part of her entrance',
          'Laughs with her whole body, shoulders shaking',
          'Never raises her voice',
        ],
        literaryRole: 'Transmitter of Islamic wisdom — gentle and earned',
        faithGuide: {
          faithTone: 'reflective & deeply rooted',
          faithExpressions: ['constant tasbih in hand', 'begins every sentence with Bismillah or Alhamdulillah', 'faces Qibla direction when making dua'],
          duaStyle: 'soft and whispered, eyes closed, deeply sincere',
          islamicTraits: ['patient', 'wise', 'generous', 'devoted'],
          faithExamples: [
            '"Every morning," Nana said, "I say Alhamdulillah before I even open my eyes."',
            'She pressed her forehead to the prayer mat and Zara watched, very still.',
          ],
        },
      },
    ],

    bookFormatting: {
      junior: {
        wordCount: '80–150 total words',
        pageCount: '24 pages (12 spreads)',
        segmentCount: '12 spreads',
        pageFlow: [
          'Opening: full-bleed garden scene, no text',
          'Spread 1: Introduce Zara with one-sentence intro',
          'Spreads 2-10: gentle problem and Islamic resolution',
          'Spread 11: dua / Islamic lesson panel',
          'Spread 12: Happy ending + Bismillah reminder page',
        ],
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATASET B — THE CRESCENT ACADEMY  (ages 10–12, chapter book)
// ═══════════════════════════════════════════════════════════════════════════════

function buildUniverseB() {
  return {
    userId: USER_ID,
    name: 'The Crescent Academy',
    description:
      'A prestigious boarding school for Muslim youth nestled in a valley between two mountains. Students study science, Arabic, and Quran — and sometimes stumble into mysteries only faith and friendship can solve.',
    seriesBible:
      'Each book is one mystery/challenge resolved over a school term. ' +
      'Faith is shown through action and dilemma, never through lecture. ' +
      'Characters make mistakes and earn forgiveness. ' +
      'Series arc: Khaled learns that real courage is admitting you are wrong.',
    artStyle: 'pixar-3d',
    ageRange: '10-12',
    tone: 'funny-adventurous',
    colorPalette: ['#1B2A4A', '#C9A84C', '#E8F4FD', '#2D6A4F', '#F4A261'],
    islamicRules: {
      hijabAlways: true,
      noMusic: false,
      noAnimals: false,
      customRules:
        'Female characters 7+ wear hijab always. No romance. Prayer times drive plot pacing. ' +
        'Every chapter ends with a character reflecting — not necessarily praying, but pausing.',
    },
    tags: ['chapter-book', 'middle-grade', 'school', 'mystery', 'friendship', 'islamic'],
  };
}

function buildCharactersB(universeId) {
  return [
    // ── 1. Khaled (protagonist) ───────────────────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Khaled',
      role: 'protagonist',
      ageRange: '11',
      traits: ['brave but impulsive', 'fiercely loyal', 'secretly self-doubting', 'natural leader', 'funny without trying'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'male',
        ageLook: '11-year-old boy, slightly gangly pre-teen',
        skinTone: 'medium olive, slightly tanned',
        eyeColor: 'dark brown, intense and expressive',
        faceShape: 'angular jaw beginning to form, still boyish',
        eyebrowStyle: 'thick expressive brows, often furrowed',
        noseStyle: 'straight with slight bump — looks like his father',
        cheekStyle: 'slight hollow, lean face',
        hairStyle: 'short textured fade, slight wave on top',
        hairColor: 'dark brown-black',
        hairVisibility: 'visible',
        topGarmentType: 'Academy uniform — collared shirt under navy blazer',
        topGarmentColor: 'white shirt, navy blazer with gold crescent crest',
        topGarmentDetails: 'Always has his blazer slightly crooked, top button undone',
        bottomGarmentType: 'uniform trousers',
        bottomGarmentColor: 'dark navy',
        shoeType: 'white sneakers (rule-breaking — uniform is black shoes)',
        shoeColor: 'white with a worn-out sole',
        bodyBuild: 'lean, athletic, slightly tall for 11',
        heightFeel: 'tallest in his friend group',
        heightCm: 152,
        heightFeet: 5,
        weightKg: 42,
        weightCategory: 'healthy',
        accessories: ['worn leather wristband', 'small silver compass (gift from father)', 'backpack always half-open'],
        paletteNotes: 'Navy, white, gold — the Academy palette with his personal worn-in touch',
      },
      modestyRules: { hijabAlways: false, longSleeves: false, looseClothing: false },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Khaled is an 11-year-old Muslim boy at a prestigious Islamic boarding school. Lean, slightly tall, angular face. His uniform is always slightly dishevelled. He carries a silver compass. His eyes are the most expressive feature — show emotion through them.',
        portraitPromptPrefix:
          'Portrait of Khaled, 11-year-old Muslim boy, Crescent Academy uniform, pixar-3d style, dramatic lighting, ',
        scenePromptPrefix:
          'Khaled (11-year-old Muslim boy, navy blazer dishevelled, dark expressive eyes, silver compass visible) ',
      },
    },

    // ── 2. Sumaya (supporting — co-lead) ──────────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Sumaya',
      role: 'supporting',
      ageRange: '11',
      traits: ['analytically brilliant', 'speaks precisely', 'deeply faithful', 'rarely wrong', 'hates being interrupted'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'female',
        ageLook: '11-year-old girl, poised and composed',
        skinTone: 'deep warm brown',
        eyeColor: 'dark brown, sharp and watchful behind glasses',
        faceShape: 'oval, sharp cheekbones beginning to show',
        eyebrowStyle: 'strong defined arches',
        noseStyle: 'slightly broad, elegant',
        cheekStyle: 'defined',
        hairStyle: 'natural coils, fully covered',
        hairColor: 'black (not visible)',
        hairVisibility: 'hidden',
        hijabStyle: 'Academy regulation hijab — navy with gold pin, precisely pinned',
        hijabColor: 'navy with thin gold border',
        topGarmentType: 'Academy uniform blazer',
        topGarmentColor: 'navy blazer, white shirt',
        topGarmentDetails: 'Perfect uniform — never a wrinkle, badge always straight',
        bottomGarmentType: 'uniform skirt with modest knee-length',
        bottomGarmentColor: 'navy pleated',
        shoeType: 'black Oxford shoes, perfectly polished',
        shoeColor: 'black',
        bodyBuild: 'average height, poised posture',
        heightFeel: 'slightly shorter than Khaled, but her posture makes her feel equal',
        heightCm: 148,
        heightFeet: 4,
        weightKg: 39,
        weightCategory: 'healthy',
        glasses: 'round gold-frame glasses',
        accessories: ['leather notebook always in hand', 'small enamel Quran pin on lapel', 'mechanical pencil behind ear'],
        paletteNotes: 'Same Academy navy/white/gold — but impeccably neat version of Khaled\'s palette',
      },
      modestyRules: { hijabAlways: true, longSleeves: true, looseClothing: true },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Sumaya is an 11-year-old Muslim girl at Crescent Academy. Impeccably neat uniform, round gold glasses, deep brown skin. She stands with perfect posture and always holds her leather notebook. Convey intelligence and composure.',
        portraitPromptPrefix:
          'Portrait of Sumaya, 11-year-old Muslim girl, Crescent Academy uniform, gold-frame glasses, pixar-3d style, ',
        scenePromptPrefix:
          'Sumaya (11-year-old Muslim girl, perfect navy uniform, round gold glasses, leather notebook in hand) ',
      },
    },

    // ── 3. Ibrahim (comic relief / tech brain) ─────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Ibrahim',
      role: 'supporting',
      ageRange: '10',
      traits: ['genuinely funny', 'tech obsessed', 'talks too much', 'heart of gold', 'terrified of pigeons'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'male',
        ageLook: '10-year-old boy, slightly chubby round face',
        skinTone: 'light warm beige, pink cheeks',
        eyeColor: 'wide hazel-brown, always slightly panicked',
        faceShape: 'round soft face, very expressive',
        eyebrowStyle: 'thin arches, almost always raised',
        noseStyle: 'round button',
        cheekStyle: 'full round, flushes easily',
        hairStyle: 'poofy short afro that escapes under Academy cap',
        hairColor: 'dark brown-black',
        hairVisibility: 'partially-visible',
        topGarmentType: 'Academy uniform, but always has something extra',
        topGarmentColor: 'white shirt, navy blazer',
        topGarmentDetails: 'Blazer pockets always bulging with gadgets/snacks',
        bottomGarmentType: 'uniform trousers, slightly too short',
        bottomGarmentColor: 'navy',
        shoeType: 'chunky black sneakers (technically uniform compliant)',
        shoeColor: 'black',
        bodyBuild: 'slightly chubby, soft and round',
        heightFeel: 'shortest of the main trio',
        heightCm: 141,
        heightFeet: 4,
        weightKg: 41,
        weightCategory: 'healthy',
        accessories: ['smartwatch on left wrist', 'tablet in backpack (always sticking out)', 'earbuds around neck'],
        paletteNotes: 'Navy base with chaotic personal additions — tech-gadget energy',
      },
      modestyRules: { hijabAlways: false, longSleeves: false, looseClothing: false },
      status: 'generated',
      promptConfig: {
        masterSystemNote:
          'Ibrahim is a 10-year-old Muslim boy, the funny tech-obsessed member of the trio. Round face, poofy hair escaping his cap, wide panicked hazel eyes. His blazer pockets always bulge. Convey his exaggerated emotion — he is the most expressive character.',
        portraitPromptPrefix:
          'Portrait of Ibrahim, 10-year-old Muslim boy, bulging pockets, poofy hair, pixar-3d style, ',
        scenePromptPrefix:
          'Ibrahim (10-year-old Muslim boy, round face, bulging blazer pockets, wide hazel eyes, poofy hair) ',
      },
    },

    // ── 4. Fatima (elder girl / wisdom figure) ─────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Fatima',
      role: 'supporting',
      ageRange: '13',
      traits: ['calm under pressure', 'moral backbone of the group', 'keeps secrets well', 'speaks last but says most', 'runs fast'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'female',
        ageLook: '13-year-old girl, early teenage composure',
        skinTone: 'warm golden-olive',
        eyeColor: 'hazel-green, steady gaze',
        faceShape: 'long oval, graceful',
        eyebrowStyle: 'naturally full arched brows',
        noseStyle: 'straight, refined',
        cheekStyle: 'defined angular',
        hairStyle: 'straight hair, fully covered',
        hairColor: 'dark brown (not visible)',
        hairVisibility: 'hidden',
        hijabStyle: 'loose casual hijab, slightly draped — less formal than Sumaya',
        hijabColor: 'forest green with thin white edge',
        topGarmentType: 'Academy blazer, worn open over longer tunic',
        topGarmentColor: 'navy blazer open, white tunic underneath',
        topGarmentDetails: 'Tunic is slightly longer than standard uniform — she has a modest personal style',
        bottomGarmentType: 'wide-leg uniform trousers (she swapped the skirt with permission)',
        bottomGarmentColor: 'dark navy',
        shoeType: 'flat running shoes',
        shoeColor: 'forest green',
        bodyBuild: 'tall, athletic, graceful',
        heightFeel: 'tallest of the girls, eye-level with Khaled',
        heightCm: 160,
        heightFeet: 5,
        weightKg: 50,
        weightCategory: 'healthy',
        accessories: ['small silver ayatul-kursi bracelet', 'water bottle always with her'],
        paletteNotes: 'Academy navy + personal forest green accents — grounded and natural',
      },
      modestyRules: { hijabAlways: true, longSleeves: true, looseClothing: true },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Fatima is a 13-year-old Muslim girl, the calm elder figure of the friend group. Tall, graceful, forest green hijab. She wears her blazer open. She has a steady hazel gaze that conveys she has already considered every option.',
        portraitPromptPrefix:
          'Portrait of Fatima, 13-year-old Muslim girl, forest green hijab, open Academy blazer, pixar-3d style, ',
        scenePromptPrefix:
          'Fatima (13-year-old Muslim girl, forest green hijab, open navy blazer, steady hazel eyes, tall and calm) ',
      },
    },

    // ── 5. Ustaz Tariq (mentor teacher) ───────────────────────────────────────
    {
      userId: USER_ID,
      universeId,
      name: 'Ustaz Tariq',
      role: 'elder',
      ageRange: '42-45',
      traits: ['dry wit', 'expects the best', 'never explains twice', 'secretly proud of students', 'ex-athlete'],
      visualDNA: {
        style: 'pixar-3d',
        gender: 'male',
        ageLook: 'early 40s, distinguished with grey streaks',
        skinTone: 'deep brown, smooth',
        eyeColor: 'dark brown, calm and observant',
        faceShape: 'strong square jaw, angular',
        eyebrowStyle: 'full dark brows with scattered grey',
        noseStyle: 'broad straight, prominent',
        cheekStyle: 'defined hollow',
        hairStyle: 'short neat fade with silver at temples',
        hairColor: 'black with prominent silver-grey streaks',
        hairVisibility: 'visible',
        facialHair: 'short neat beard, well-maintained, salt-and-pepper',
        topGarmentType: 'Academy staff blazer or long academic thobe',
        topGarmentColor: 'dark charcoal blazer with gold crescent pin',
        topGarmentDetails: 'Always has a pen in breast pocket and a stack of papers under arm',
        bottomGarmentType: 'tailored trousers',
        bottomGarmentColor: 'charcoal',
        shoeType: 'polished leather shoes',
        shoeColor: 'dark brown',
        bodyBuild: 'broad-shouldered, clearly athletic even now',
        heightFeel: 'tall, imposing but not threatening',
        heightCm: 186,
        heightFeet: 6,
        weightKg: 88,
        weightCategory: 'healthy',
        accessories: ['silver Quran locket under collar', 'stack of papers always under left arm', 'old-fashioned wristwatch'],
        paletteNotes: 'Charcoal, gold, dark brown — authority and depth',
      },
      modestyRules: { hijabAlways: false, longSleeves: true, looseClothing: false },
      status: 'approved',
      promptConfig: {
        masterSystemNote:
          'Ustaz Tariq is a 42-year-old Muslim teacher at Crescent Academy. Broad-shouldered, salt-and-pepper beard, charcoal blazer. He always has papers under his arm. His expression defaults to calm expectation — never anger, but always knowing.',
        portraitPromptPrefix:
          'Portrait of Ustaz Tariq, 42-year-old Muslim teacher, charcoal blazer, salt-and-pepper beard, pixar-3d style, dramatic lighting, ',
        scenePromptPrefix:
          'Ustaz Tariq (42-year-old Muslim teacher, charcoal blazer, silver-streaked beard, papers under arm, calm authoritative gaze) ',
      },
    },
  ];
}

function buildKbB(universeId, characters) {
  const charMap = {};
  for (const c of characters) charMap[c.name] = c._id;

  return {
    userId: USER_ID,
    universeId,
    name: 'Crescent Academy — Series Bible',

    islamicValues: [
      'Tawakkul — trusting Allah while taking action',
      'Shura — consulting others before deciding',
      'Amanah — trustworthiness, especially under pressure',
      'Sabr — patience earns more than rushing',
      'Accountability — admitting mistakes is strength, not weakness',
    ],
    duas: [
      {
        arabic: 'رَبِّ زِدْنِي عِلْمًا',
        transliteration: "Rabbi zidni 'ilma",
        meaning: 'My Lord, increase me in knowledge',
        context: 'Said before study sessions, exams, or when puzzled by a problem',
      },
      {
        arabic: 'حَسْبُنَا اللَّهُ وَنِعْمَ الْوَكِيلُ',
        transliteration: 'Hasbunallahu wa ni\'mal wakeel',
        meaning: 'Allah is sufficient for us and He is the best disposer of affairs',
        context: 'Said when a challenge feels too large — Khaled says this before taking a risk',
      },
      {
        arabic: 'اللَّهُمَّ إِنِّي أَسْأَلُكَ الْعَفْوَ وَالْعَافِيَةَ',
        transliteration: "Allahumma inni as'alukal 'afwa wal 'afiyah",
        meaning: 'O Allah, I ask You for pardon and well-being',
        context: 'Said after making a mistake — Sumaya teaches this to Khaled in Book 1',
      },
    ],
    vocabulary: [
      { word: 'Tawakkul', definition: 'Complete reliance on Allah while still putting in effort', ageGroup: '10-12' },
      { word: 'Shura', definition: 'Consultation — the Islamic principle of seeking advice before deciding', ageGroup: '10-12' },
      { word: 'Amanah', definition: 'Trustworthiness — fulfilling your responsibilities faithfully', ageGroup: '10-12' },
      { word: 'Ustaz', definition: 'Teacher / respected scholar (Arabic)', ageGroup: '10-12' },
      { word: 'Isnad', definition: 'Chain of transmission — used humorously by Ibrahim when tracing rumours', ageGroup: '10-12' },
    ],
    avoidTopics: [
      'Romantic relationships or crushes',
      'Graphic violence',
      'Dismissal of Islamic practice as backwards',
      'Adults being universally untrustworthy',
      'Resolution without accountability',
    ],

    backgroundSettings: {
      middleGrade: {
        tone: 'Cinematic, layered — the Academy feels ancient and alive simultaneously',
        locations: [
          'Great Library (floor-to-ceiling Arabic manuscripts)',
          'Rooftop prayer area with mountain view',
          'Science lab with Islamic geometric tile walls',
          'Covered courtyard with fountain (mashrabiya arches)',
          'Underground archive (books and mystery)',
          'Khaled\'s dormitory room',
          'Academy dining hall at Iftar',
        ],
        colorStyle: 'Deep navy and gold base with natural stone textures. Moonlight through mashrabiya windows.',
        lightingStyle: 'Dramatic side lighting for tense scenes; warm lantern glow for friendship moments; blue dawn for early-morning prayer scenes',
        keyFeatures: [
          'Islamic geometric patterns on walls and floors — always accurate, never decorative only',
          'Arabic calligraphy integrated into the architecture',
          'Mashrabiya (wooden lattice) windows create patterned light',
          'Mountains visible from upper windows',
          'Crescent moon visible in most night/evening exterior shots',
        ],
        timeOfDay: 'evening',
        cameraHint: 'medium',
        additionalNotes:
          'Chapter opener illustrations must establish mood — use dramatic perspective. Scene illustrations (chapter moments) should focus on character interaction, environment at 40% attention.',
      },
      avoidBackgrounds: [
        'Generic school hallways with lockers (feels Western, not Academy)',
        'Cafeteria food fights',
        'Modern cityscape visible from windows',
        'Bright flat cartoon backgrounds — this is a cinematic series',
      ],
      universalRules:
        'The Academy is a character itself. Every setting choice must reinforce: this place is special, old, and sacred. Nothing should feel generic.',
    },

    coverDesign: {
      titlePlacement: 'Top 40% — bold, serif font visible at thumbnail — minimum 2/3 of cover width',
      authorTaglinePlacement: 'Bottom centre, thin clean font',
      characterComposition: [
        'Khaled must be on every cover',
        'Sumaya appears on mystery/puzzle arc covers',
        'Ibrahim appears on comedy/discovery arc covers',
        'Fatima appears when the conflict is moral/ethical',
        'Ustaz Tariq appears on covers where authority is tested',
      ],
      characterMustInclude: ['Khaled'],
      atmosphere: {
        middleGrade: 'Cinematic dramatic lighting — Islamic architectural grandeur, moonlight and lanterns',
      },
      typography: {
        middleGrade: 'Serif — Cinzel or Playfair Display for title; clean sans for author',
      },
      islamicMotifs: [
        'Mashrabiya geometric frame around full cover',
        'Gold crescent above title block',
        'Subtle arabesque corner accents',
        'Academy crest watermark in background',
      ],
      brandingRules: [
        'Series logo (Crescent Academy seal) top-left corner',
        'Book number badge bottom-right',
        'Title legible at 200px thumbnail — test before approval',
        'Characters\' faces never cropped at cover edge',
      ],
      avoidCover: [
        'Generic magic sparkles without Islamic context',
        'Weapons in foreground',
        'Characters looking defeated on front cover',
        'Cluttered — maximum 3 main characters per cover',
      ],
    },

    characterGuides: [
      {
        characterId: charMap['Khaled'],
        characterName: 'Khaled',
        dialogueExamples: [
          '"I already know what to do." (he doesn\'t)',
          '"Hasbunallah — let\'s go."',
          '"Sumaya, just for once, can you not explain the whole thing?"',
          '"I was wrong. I know. Don\'t say it."',
          '"Baba always said: the compass points north, not easy."',
        ],
        moreInfo:
          'Khaled is the reader\'s vehicle — flawed, brave, loveable. His arc per book is always: overconfidence → failure → accountability → growth. He must NEVER be perfect. His faith is real but tested. He does not perform Islam — he lives it imperfectly.',
        personalityNotes: [
          'Talks with his hands, especially when excited',
          'Goes quiet when ashamed — this is the signal to the reader that he has learned',
          'Makes the best accidental plans — his instincts are good even when his logic isn\'t',
          'Fiddles with his silver compass when nervous',
        ],
        literaryRole: 'Protagonist — carries the theme of Courage vs. Pride',
        faithGuide: {
          faithTone: 'earnest but impulsive',
          faithExpressions: ['prays Fajr even when tired', 'says Hasbunallah before anything scary', 'avoids lying but sometimes omits the truth'],
          duaStyle: 'quick and sincere — less form, more heart',
          islamicTraits: ['brave', 'loyal', 'honest (mostly)', 'working on patience'],
          faithExamples: [
            '"Hasbunallah," Khaled whispered, then stepped through the archive door.',
            'He\'d missed Asr. He felt it like a stone in his chest all evening.',
            '"I made a mistake," he said. It was the hardest sentence he had ever said.',
          ],
        },
      },
      {
        characterId: charMap['Sumaya'],
        characterName: 'Sumaya',
        dialogueExamples: [
          '"You haven\'t considered the third possibility."',
          '"According to the manuscript — and I have read it — this was done before."',
          '"Ibrahim. Put the device down. It\'s Maghrib."',
          '"I don\'t guess. I observe."',
          '"Khaled was right. I will only say that once."',
        ],
        moreInfo:
          'Sumaya is Khaled\'s intellectual counterweight. She is never wrong about facts, but sometimes wrong about people. Her arc across the series: learning that faith requires vulnerability, not just knowledge. She is the most visibly devout — and the most challenged by doubt in Book 3.',
        personalityNotes: [
          'Taps her notebook three times when thinking',
          'Never interrupts — but her expression when interrupted is devastating',
          'Reads during every free moment — even meals',
          'Her one non-intellectual passion: astronomy',
        ],
        literaryRole: 'Carries the theme of Knowledge vs. Wisdom',
        faithGuide: {
          faithTone: 'precise and principled',
          faithExpressions: ['knows the full Arabic and meaning of every dua she says', 'never misses a prayer — sets a silent alarm', 'references Quran verses in normal conversation (not preachy — just natural)'],
          duaStyle: 'precise, memorised, full transliteration in her notebook',
          islamicTraits: ['knowledgeable', 'disciplined', 'just', 'learning humility'],
          faithExamples: [
            '"Rabbi zidni \'ilma," she said, and opened the first manuscript.',
            '"The Prophet, peace be upon him, said: consult others. That\'s shura. We should use it."',
          ],
        },
      },
      {
        characterId: charMap['Ibrahim'],
        characterName: 'Ibrahim',
        dialogueExamples: [
          '"Okay so I had a plan but the plan had a plan and the second plan — wait."',
          '"My isnad for this rumour is very strong, by the way."',
          '"I\'m not scared of that bird. I\'m just … cautious."',
          '"SubhanAllah, that actually worked."',
          '"Khaled. KHALED. The teacher is RIGHT THERE."',
        ],
        moreInfo:
          'Ibrahim is the emotional heartbeat of the trio. He is funny in a way that comes from genuine surprise at the world, never sarcasm. His tech obsession is a real talent — it solves a key plot point in every book. His fear of pigeons is a running gag that pays off in Book 4.',
        personalityNotes: [
          'Eyes go very wide when scared — and he is scared often',
          'Talks 30% faster when excited',
          'Stress-eats — always has snacks',
          'Secretly writes poetry but would rather face pigeons than admit it',
        ],
        literaryRole: 'Comic relief AND technical deus ex machina — must never be reduced to just one',
        faithGuide: {
          faithTone: 'joyful and spontaneous',
          faithExpressions: ['says SubhanAllah and MashaAllah genuinely, not as filler', 'forgets prayer time until Sumaya reminds him — then rushes and is sincere', 'his tech is named with Islamic names (Al-Rashid, Al-Hakim)'],
          duaStyle: 'fast and genuine — sometimes mixes up the words but the sincerity is real',
          islamicTraits: ['joyful', 'generous', 'sincere', 'learning consistency'],
          faithExamples: [
            '"SubhanAllah," Ibrahim breathed, staring at the star map. "We literally have all of this and we\'re arguing about lunch."',
            'He prayed quickly, shoes still on, jacket half-off. It wasn\'t perfect. He figured Allah knew that.',
          ],
        },
      },
    ],

    bookFormatting: {
      middleGrade: {
        wordCount: '22,000 – 32,000',
        chapterRange: '10 to 14',
        sceneLength: '600–900 words per scene',
        chapterRhythm: [
          'Chapter 1: In-medias-res opening — mystery/problem appears in first paragraph',
          'Chapters 2-4: Setup — Academy life, character dynamics, clues planted',
          'Chapters 5-7: Rising stakes — first attempt fails, Khaled\'s flaw activated',
          'Chapters 8-10: Lowest point — team breaks apart or key resource lost',
          'Chapters 11-12: Khaled\'s accountability moment — always the turning point',
          'Chapters 13-14: Resolution — prayer scene, reconciliation, mystery solved with Islamic principle as key',
        ],
        frontMatter: ['Half-title', 'Map of Crescent Academy', 'Glossary of Islamic terms used'],
        endMatter: ['Author\'s Note on Islamic concepts used', 'Dua page', 'Teaser first page of next book'],
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n🌙  Crescent Academy & Sunshine Garden — Seed Script');
  console.log('───────────────────────────────────────────────────\n');

  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  console.log('✅  MongoDB connected\n');

  const { Universe, Character, KnowledgeBase } = await loadModels();

  // ── Clean previous seed data for this user ──────────────────────────────────
  console.log('🗑   Removing previous seed data for user 69b09edec765c521498fb056 …');
  const prevUniverses = await Universe.find({
    userId: USER_ID,
    name: { $in: ['Sunshine Garden', 'The Crescent Academy'] },
  }).select('_id');
  const prevIds = prevUniverses.map((u) => u._id);
  await Character.deleteMany({ universeId: { $in: prevIds } });
  await KnowledgeBase.deleteMany({ universeId: { $in: prevIds } });
  await Universe.deleteMany({ _id: { $in: prevIds } });
  console.log(`   Removed ${prevIds.length} universe(s) and their linked data.\n`);

  // ── Dataset A ───────────────────────────────────────────────────────────────
  console.log('📗  Creating Dataset A — Sunshine Garden (ages 2–4) …');
  const univA = await Universe.create(buildUniverseA());
  console.log(`   Universe: "${univA.name}"  (${univA._id})`);

  const rawCharsA = buildCharactersA(univA._id);
  const charsA = await Character.insertMany(rawCharsA);
  console.log(`   Characters (${charsA.length}):`);
  charsA.forEach((c) => console.log(`     • ${c.name} [${c.status}] — ${c._id}`));

  const kbAData = buildKbA(univA._id, charsA);
  const kbA = await KnowledgeBase.create(kbAData);
  console.log(`   Knowledge Base: "${kbA.name}"  (${kbA._id})\n`);

  // ── Dataset B ───────────────────────────────────────────────────────────────
  console.log('📘  Creating Dataset B — The Crescent Academy (ages 10–12) …');
  const univB = await Universe.create(buildUniverseB());
  console.log(`   Universe: "${univB.name}"  (${univB._id})`);

  const rawCharsB = buildCharactersB(univB._id);
  const charsB = await Character.insertMany(rawCharsB);
  console.log(`   Characters (${charsB.length}):`);
  charsB.forEach((c) => console.log(`     • ${c.name} [${c.status}] — ${c._id}`));

  const kbBData = buildKbB(univB._id, charsB);
  const kbB = await KnowledgeBase.create(kbBData);
  console.log(`   Knowledge Base: "${kbB.name}"  (${kbB._id})\n`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════');
  console.log('✅  SEED COMPLETE\n');
  console.log('  Dataset A — Sunshine Garden (2–4 yrs, picture book)');
  console.log(`    Universe ID  : ${univA._id}`);
  console.log(`    Characters   : ${charsA.map((c) => c.name).join(', ')}`);
  console.log(`    KB ID        : ${kbA._id}\n`);
  console.log('  Dataset B — The Crescent Academy (10–12 yrs, chapter book)');
  console.log(`    Universe ID  : ${univB._id}`);
  console.log(`    Characters   : ${charsB.map((c) => c.name).join(', ')}`);
  console.log(`    KB ID        : ${kbB._id}\n`);
  console.log('  Login with token:');
  console.log('  eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2OWIwOWVkZWM3NjVjNTIxNDk4ZmIwNTYiLCJpYXQiOjE3NzQ3MzIxMDEsImV4cCI6MTc3NTMzNjkwMX0.K40eOudDtFMKWN0Jm9iQCAzX7liUtE4fYdARgCN2P9k');
  console.log('═══════════════════════════════════════════════════\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌  Seed failed:', err.message);
  console.error(err.stack);
  mongoose.disconnect().finally(() => process.exit(1));
});
