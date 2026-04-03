/**
 * DEFAULT_KB_TEMPLATES — 5 pre-built Knowledge Base configurations.
 * When a user picks one, its fields are pre-filled into the new KB.
 * Users can edit everything after creation.
 */
export const DEFAULT_KB_TEMPLATES = [
  {
    _id: "kbt_picture_book",
    name: "Islamic Picture Book",
    ageRange: "3–6 years",
    icon: "🌟",
    description: "Simple faith values, bright safe scenes, and du'as for the very young. Perfect for bedtime stories and parent-read-aloud books.",
    palette: ["#FFD93D", "#4FC3F7", "#81C784", "#FF8A65"],
    islamicValues: [
      "Saying Alhamdulillah with gratitude",
      "Sharing is a form of sadaqah",
      "Kindness to animals is rewarded",
      "Listening to parents and grandparents",
      "Saying Bismillah before eating",
      "Helping others makes Allah happy",
    ],
    duas: [
      { arabic: "بِسْمِ اللَّهِ", transliteration: "Bismillah", meaning: "In the name of Allah", context: "Before eating, starting activities" },
      { arabic: "الْحَمْدُ لِلَّهِ", transliteration: "Alhamdulillah", meaning: "All praise is for Allah", context: "Expressing gratitude" },
      { arabic: "سُبْحَانَ اللَّهِ", transliteration: "SubhanAllah", meaning: "Glory be to Allah", context: "When seeing something beautiful in nature" },
    ],
    avoidTopics: ["Violence or scary content", "Adult relationships", "Death described graphically", "Complex theology"],
    backgroundSettings: {
      junior: {
        tone: "Bright, safe, familiar, cheerful",
        colorStyle: "Vibrant, saturated, primary colors with warm accents",
        lightingStyle: "Soft golden daylight, no harsh shadows",
        timeOfDay: "afternoon",
        cameraHint: "medium",
        locations: ["bedroom", "kitchen", "garden", "masjid", "playground", "grandparent's house"],
        keyFeatures: ["Rounded soft shapes", "Warm safe lighting", "Clear foreground separation"],
      },
    },
    coverDesign: {
      selectedCoverTemplate: "ct_classic_children",
      atmosphere: { junior: "Bright joyful sunshine, warm golden light, safe familiar world" },
      typography: { junior: "Bold rounded — Fredoka One, Baloo Bhaijaan" },
      islamicMotifs: ["Crescent moon", "Stars", "Simple geometric patterns"],
      avoidCover: ["Dark moody lighting", "Complex compositions", "Text-heavy design"],
    },
    bookFormatting: {
      junior: { wordCount: "500–1,500", pageCount: "24–32 pages", segmentCount: "4–6 segments" },
    },
    underSixDesign: {
      maxWordsPerSpread: 12,
      readingType: "parent-read",
      pageLayout: "Full-page illustration left, short text right (max 12 words)",
      fontStyle: "Rounded, large, high contrast, dyslexia-friendly",
    },
  },

  {
    _id: "kbt_middle_grade",
    name: "Middle Grade Adventure",
    ageRange: "8–12 years",
    icon: "⚔️",
    description: "Cinematic adventures with Islamic themes woven naturally. Complex characters, moral dilemmas, and faith tested through action.",
    palette: ["#1A2456", "#C9A84C", "#2D6A4F", "#E94560"],
    islamicValues: [
      "Sabr (patience) in the face of difficulty",
      "Tawakkul (trust in Allah) after doing your best",
      "Honesty even when it is costly",
      "Courage comes from faith, not fearlessness",
      "Respecting knowledge and those who teach it",
      "Helping the weak and speaking for justice",
      "Brotherhood and sisterhood in Islam",
    ],
    duas: [
      { arabic: "حَسْبُنَا اللَّهُ وَنِعْمَ الْوَكِيلُ", transliteration: "Hasbunallahu wa ni'mal wakeel", meaning: "Allah is sufficient for us and He is the best disposer of affairs", context: "When facing overwhelming odds or fear" },
      { arabic: "رَبِّ اشْرَحْ لِي صَدْرِي", transliteration: "Rabbi ishrah li sadri", meaning: "My Lord, expand my chest (with ease)", context: "Before a challenge or difficult conversation" },
      { arabic: "لَا إِلَهَ إِلَّا أَنتَ سُبْحَانَكَ إِنِّي كُنتُ مِنَ الظَّالِمِينَ", transliteration: "La ilaha illa anta subhanaka inni kuntu minaz-zalimin", meaning: "There is no god but You, glory be to You, indeed I was among the wrongdoers", context: "When the character makes a serious mistake" },
    ],
    avoidTopics: ["Graphic violence", "Romance beyond age-appropriate friendship", "Mockery of religion", "Hopeless endings"],
    backgroundSettings: {
      middleGrade: {
        tone: "Cinematic, dramatic, adventurous with emotional warmth",
        colorStyle: "Rich, deep colors with atmospheric lighting and golden accents",
        lightingStyle: "Cinematic golden hour, dramatic rim lighting, volumetric atmosphere",
        timeOfDay: "golden-hour",
        cameraHint: "wide",
        locations: ["ancient city", "masjid courtyard", "bazaar", "desert landscape", "mountain pass", "underground chamber", "ship deck"],
        keyFeatures: ["Three-layer depth (foreground/mid/background)", "Architectural Islamic detail", "Epic scale"],
      },
    },
    coverDesign: {
      selectedCoverTemplate: "ct_epic_cinematic",
      atmosphere: { middleGrade: "Cinematic dramatic lighting, epic scale, sense of adventure and discovery" },
      typography: { middleGrade: "Bold condensed serif — Cinzel, Trajan" },
      islamicMotifs: ["Mosque silhouette", "Islamic geometric pattern in architecture", "Crescent moon in sky"],
      characterComposition: ["Main character in dynamic pose, lower-center", "Eye contact with reader", "Expression shows determination and faith"],
    },
    bookFormatting: {
      middleGrade: { wordCount: "20,000–35,000", chapterRange: "8–12", sceneLength: "500–800 words" },
    },
  },

  {
    _id: "kbt_quran_stories",
    name: "Quran & Sunnah Stories",
    ageRange: "5–10 years",
    icon: "📖",
    description: "Stories rooted in Quran and hadith. Rich in du'as, Arabic vocabulary, and Islamic values shown through prophetic examples.",
    palette: ["#2D6A4F", "#C9A84C", "#1B6CA8", "#F0EBD8"],
    islamicValues: [
      "Following the example of the Prophet ﷺ",
      "Love for the Quran and its recitation",
      "Dhikr (remembrance of Allah) throughout the day",
      "Feeding the hungry is worship",
      "The best of people are those who learn the Quran and teach it",
      "Smiling at your brother is sadaqah",
      "Cleanliness is part of faith",
    ],
    duas: [
      { arabic: "اللَّهُمَّ إِنِّي أَسْأَلُكَ عِلْمًا نَافِعًا", transliteration: "Allahumma inni as'aluka 'ilman nafi'an", meaning: "O Allah, I ask You for beneficial knowledge", context: "Before studying or learning" },
      { arabic: "رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً", transliteration: "Rabbana atina fid-dunya hasanatan", meaning: "Our Lord, give us good in this world and good in the hereafter", context: "General supplication, end of chapters" },
      { arabic: "أَعُوذُ بِاللَّهِ مِنَ الشَّيْطَانِ الرَّجِيمِ", transliteration: "A'udhu billahi minash-shaytanir-rajim", meaning: "I seek refuge with Allah from the accursed Satan", context: "Before reciting Quran or facing temptation" },
    ],
    avoidTopics: ["Inaccurate portrayal of prophets", "Mixing fictional magic with Islamic belief", "Disrespect toward Islamic practices"],
    backgroundSettings: {
      junior: {
        tone: "Warm, reverent, inviting, historically rich",
        colorStyle: "Warm gold and green tones, aged manuscript feel",
        lightingStyle: "Warm candlelight indoors, clear golden outdoor light",
        timeOfDay: "morning",
        cameraHint: "medium",
        locations: ["masjid interior", "ancient marketplace", "desert oasis", "simple home", "olive grove", "river banks"],
        keyFeatures: ["Islamic architectural detail", "Natural organic settings", "Warm welcoming atmosphere"],
      },
    },
    coverDesign: {
      selectedCoverTemplate: "ct_islamic_heritage",
      atmosphere: { junior: "Warm golden hour, dignified and rich, Islamic cultural heritage feel" },
      typography: { junior: "Elegant rounded serif — Amiri, Scheherazade" },
      islamicMotifs: ["Arabesque patterns", "Crescent moon", "Geometric star border", "Calligraphy-inspired title zone"],
    },
    bookFormatting: {
      junior: { wordCount: "1,500–3,000", pageCount: "24–36 pages", segmentCount: "5–7 segments" },
    },
  },

  {
    _id: "kbt_nature_explorer",
    name: "Nature Explorer",
    ageRange: "6–10 years",
    icon: "🌿",
    description: "Adventure in the natural world. Each story reveals Allah's signs in creation — plants, animals, weather, and science woven with wonder.",
    palette: ["#2D6A4F", "#52B788", "#F9C784", "#87CEEB"],
    islamicValues: [
      "Every living thing praises Allah in its own way",
      "Being a caretaker (khalifah) of the Earth",
      "Kindness to animals is rewarded by Allah",
      "Water is a blessing — never waste it",
      "Looking at nature is a form of reflection (tafakkur)",
      "Planting a tree is sadaqah jariyah",
    ],
    duas: [
      { arabic: "سُبْحَانَ الَّذِي خَلَقَ هَذَا", transliteration: "SubhanaAllahi wa bihamdihi, subhanaAllahil azeem", meaning: "Glory and praise to Allah, glory to Allah the Great", context: "When the character sees something amazing in nature" },
      { arabic: "اللَّهُمَّ أَنْتَ رَبِّي", transliteration: "Allahumma anta rabbi la ilaha illa anta", meaning: "O Allah, You are my Lord, none has the right to be worshipped but You", context: "In moments of wonder and realization" },
    ],
    avoidTopics: ["Evolutionary concepts presented as fact without context", "Cruelty to animals", "Pollution described approvingly"],
    backgroundSettings: {
      junior: {
        tone: "Lush, alive, vibrant, wonder-filled",
        colorStyle: "Rich greens and blues, warm sunlight dappling, high color saturation",
        lightingStyle: "Dappled sunlight through leaves, clear open-sky outdoor light",
        timeOfDay: "afternoon",
        cameraHint: "wide",
        locations: ["forest", "garden", "river bank", "mountain meadow", "coral reef (underwater)", "desert bloom", "bird sanctuary"],
        keyFeatures: ["Detailed botanical environment", "Animals integrated naturally", "Layered nature depth"],
      },
    },
    coverDesign: {
      selectedCoverTemplate: "ct_nature_adventure",
      atmosphere: { junior: "Vibrant lush green nature, warm sunshine dappling through foliage, adventure and discovery" },
      typography: { junior: "Adventurous friendly — Cabin, Nunito" },
      islamicMotifs: ["Sunrise suggesting Allah's signs", "Intricate leaf patterns", "Water and sky elements"],
    },
    bookFormatting: {
      junior: { wordCount: "1,000–2,500", pageCount: "28–40 pages", segmentCount: "5–8 segments" },
    },
  },

  {
    _id: "kbt_saeeda_world",
    name: "Saeeda Micro-World",
    ageRange: "4–7 years",
    icon: "🌸",
    description: "Magical micro-world stories where tiny characters explore giant flowers, dewdrops, and miniature worlds — every detail a sign of Allah.",
    palette: ["#C3B8E8", "#B5D5C5", "#F9C784", "#E8A598"],
    islamicValues: [
      "Even the smallest creature glorifies Allah",
      "Beauty is a gift — appreciate it with gratitude",
      "Being curious about Allah's creation is an act of worship",
      "Small acts of kindness ripple out like water",
      "Every dewdrop and petal is a reminder of Allah",
    ],
    duas: [
      { arabic: "رَبِّ زِدْنِي عِلْمًا", transliteration: "Rabbi zidni 'ilma", meaning: "My Lord, increase me in knowledge", context: "When Saeeda discovers something new and wonders about it" },
      { arabic: "سُبْحَانَ اللَّهِ", transliteration: "SubhanAllah", meaning: "Glory be to Allah", context: "When seeing something beautiful or surprising" },
    ],
    avoidTopics: ["Scary insects or creatures", "Dark or frightening spaces", "Anything that diminishes wonder"],
    backgroundSettings: {
      saeeda: {
        tone: "Dreamlike, magical, glowing, miniature scale wonder",
        colorStyle: "Soft pastel watercolor washes, translucent light effects, iridescent shimmer",
        lightingStyle: "Glowing bioluminescent-feel, soft diffused magical light, dewdrop reflections",
        timeOfDay: "morning",
        cameraHint: "close",
        locations: ["inside a flower", "on a giant leaf", "beside a dewdrop", "inside a honeycomb", "under a mushroom", "inside a bird feather"],
        keyFeatures: ["Macro scale rendering", "Glowing translucent light effects", "Soft organic natural textures"],
      },
    },
    coverDesign: {
      selectedCoverTemplate: "ct_watercolor_dream",
      atmosphere: { saeeda: "Dreamlike magical, soft warm pastels, gentle and whimsical, handcrafted feel" },
      typography: { junior: "Organic handwritten-feel — Caveat, Pacifico" },
      islamicMotifs: ["Floral geometric patterns", "Dewdrop reflections suggesting tasbih", "Natural organic Islamic pattern elements"],
    },
    bookFormatting: {
      junior: { wordCount: "300–800", pageCount: "20–28 pages", segmentCount: "3–5 segments" },
    },
    underSixDesign: {
      maxWordsPerSpread: 8,
      readingType: "parent-read",
      pageLayout: "Full-spread illustration with floating text overlay in safe zones",
      fontStyle: "Rounded, large, handwritten-feel",
    },
  },
];
