/**
 * Mock text provider — returns realistic placeholder JSON for dev/testing.
 *
 * Stage detection uses SYSTEM prompt keywords (more reliable than prompt body
 * since chapter prompts contain the word "outline" in their body).
 *
 * @param {import('../ai.types.js').TextRequest} req
 * @returns {Promise<import('../ai.types.js').TextResponse>}
 */
export async function mockTextGenerate(req) {
  await sleep(600 + Math.random() * 400);

  const sys   = (req.system  || '').toLowerCase();
  const lower = (req.prompt  || '').toLowerCase();
  let text;

  // ── Humanize / Polish — check first; system mentions "editor" ────────────
  if (sys.includes('editor') || lower.includes('polish this chapter')) {
    text = JSON.stringify({
      chapterNumber: 1,
      chapterTitle: 'Chapter 1: The Journey Begins',
      text: 'The first rays of dawn crept through Yasmin\'s window, painting golden stripes across her bedroom floor. Her eyes flew open and a smile spread across her face. "Bismillah," she whispered softly — just as Mama had taught her. It was the first word of her day, a blessing before anything else. Today was special. She would visit her grandmother in the village across the river, the one with the rose garden and the best mint tea in the whole world. She dressed quickly in her favorite teal dress and tied her light blue hijab with care.',
      changesMade: [
        'Added sensory details (golden stripes, mint tea)',
        'Natural dialogue — Bismillah used organically',
        'Shorter sentences for read-aloud rhythm',
        'Emotional hook strengthened at chapter end',
      ],
    });

  // ── Chapter Writing — system mentions "children's book author" ────────────
  } else if (sys.includes("children's book author") || lower.includes('write chapter')) {
    const num = parseInt(
      lower.match(/write chapter\s*(\d+)/i)?.[1] ||
      lower.match(/^chapter\s*(\d+)/im)?.[1] || '1'
    );
    const titles = [
      'The Journey Begins',
      'A Stranger on the Road',
      'Lost in the Olive Grove',
      "Grandmother's Rose Garden",
    ];
    const title = titles[(num - 1) % titles.length];

    text = JSON.stringify({
      chapterNumber: num,
      chapterTitle: `Chapter ${num}: ${title}`,
      text: `Yasmin woke early that morning, the sun just beginning to peek through her curtains. "Bismillah," she whispered before her feet touched the cool floor — just as Mama always reminded her. Today was the day she had been waiting for all week. She dressed quickly in her favourite teal dress, tied her light blue hijab carefully, and ran downstairs where the smell of warm bread already filled the air. Mama was packing a woven basket with gifts for Grandmother: golden dates, honey cakes still warm from the oven, and a small jar of rose water. "Remember, habibti," Mama said, kneeling down to meet Yasmin's eyes, "the best gift you can give is kindness." Yasmin nodded seriously and clutched the basket handle. She was ready for the journey ahead.`,
      vocabularyNotes: [
        'Bismillah — In the name of Allah, said before beginning any action',
        'Habibti — My dear, a term of endearment in Arabic',
      ],
      islamicAdabChecks: [
        'Bismillah before starting the day',
        'Listening to and respecting parents',
        'Dressing modestly with hijab',
      ],
    });

  // ── Book Outline — system mentions "curriculum" ───────────────────────────
  } else if (sys.includes('curriculum') || lower.includes('learning objective') || (lower.includes('outline') && !lower.includes('write chapter'))) {
    const count = parseInt(lower.match(/(\d+)-chapter/)?.[1] || '4');
    const allChapters = [
      { title: 'The Journey Begins',       goal: 'Introduce Yasmin and set up the journey', keyScene: 'Yasmin packs the basket and says Bismillah', duaHint: 'Bismillah before starting a journey' },
      { title: 'A Stranger on the Road',   goal: 'First test of generosity',                keyScene: 'Yasmin meets a hungry child and shares her food', duaHint: 'Hadith: the best people are those who help others' },
      { title: 'Lost in the Olive Grove',  goal: 'Show that kindness is rewarded by Allah', keyScene: "The child's family guides Yasmin when she is lost", duaHint: "Ya Allah — calling on Allah's guidance" },
      { title: "Grandmother's Rose Garden", goal: 'Reinforce the moral with elder wisdom',  keyScene: 'Grandmother shares her own story of generosity', duaHint: 'Alhamdulillah — gratitude to Allah' },
      { title: 'The Gift That Keeps Giving', goal: 'Deepen the lesson through reflection',  keyScene: 'Yasmin writes in her journal about what she learned', duaHint: 'Dua for barakah in what we share' },
    ].slice(0, count);

    text = JSON.stringify({
      bookTitle: 'Yasmin and the Garden of Patience',
      moral: 'True happiness comes from giving to others and trusting in Allah, even when it is difficult.',
      chapters: allChapters,
    });

  // ── Fallback ──────────────────────────────────────────────────────────────
  } else {
    text = JSON.stringify({
      message: 'Mock response — no stage matched',
      systemHint: req.system?.slice(0, 80),
      promptHint: req.prompt?.slice(0, 80),
    });
  }

  return {
    text,
    usage: {
      inputTokens:  Math.ceil(((req.system || '') + req.prompt).length / 4),
      outputTokens: Math.ceil(text.length / 4),
    },
    provider: 'mock',
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
