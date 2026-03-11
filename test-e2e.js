#!/usr/bin/env node
/**
 * NoorStudio E2E Test v2 — Gemini-Only Image Provider
 * Real providers only — no mock seeding for AI stages.
 * Every failure dumps the full server response so you can see exactly what went wrong.
 *
 * Usage:
 *   node test-e2e-v2.js
 *   BASE_URL=https://your-app.up.railway.app node test-e2e-v2.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3001';

let TOKEN = '';
let universeId, characterId, projectId;

// ─── Colours ──────────────────────────────────────────────────────────────────
const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

let passed = 0, failed = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function req(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data, headers: res.headers };
}

function check(label, condition, info = '') {
  if (condition) {
    console.log(c.green(`  ✓ ${label}`) + (info ? c.dim(` — ${info}`) : ''));
    passed++;
  } else {
    console.log(c.red(`  ✗ ${label}`) + (info ? c.red(` — ${info}`) : ''));
    failed++;
  }
}

function dump(label, value) {
  const str = typeof value === 'object'
    ? JSON.stringify(value, null, 2)
    : String(value);
  const preview = str.length > 800 ? str.slice(0, 800) + '\n  ...(truncated)' : str;
  console.log(c.dim(`  📦 ${label}: `) + preview);
}

function section(title) {
  const pad = '─'.repeat(Math.max(0, 52 - title.length));
  console.log('\n' + c.bold(c.cyan(`── ${title} ${pad}`)));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── 0. Health ────────────────────────────────────────────────────────────────
async function testHealth() {
  section('0. Health Check');
  const { status, data } = await req('GET', '/health', null, false);
  check('Server is up', status === 200, data.status);
  if (status !== 200) dump('Health response', data);
}

// ─── 1. Auth ──────────────────────────────────────────────────────────────────
async function testAuth() {
  section('1. Auth');
  const email    = `test_${Date.now()}@noorstudio.test`;
  const password = 'TestPass123!';

  const reg = await req('POST', '/api/auth/register', { name: 'Test User', email, password }, false);
  check('Register — credits start at 50', reg.status === 201 && reg.data.user?.credits === 50, `credits: ${reg.data.user?.credits}`);
  if (reg.status !== 201) { dump('Register error', reg.data); process.exit(1); }
  TOKEN = reg.data.token;

  const login = await req('POST', '/api/auth/login', { email, password }, false);
  check('Login returns token', login.status === 200 && !!login.data.token);
  TOKEN = login.data.token;

  const me = await req('GET', '/api/auth/me');
  check('/me returns correct user', me.status === 200 && me.data.user?.email === email);
}

// ─── 2. Universe ──────────────────────────────────────────────────────────────
async function testUniverse() {
  section('2. Universe');
  const create = await req('POST', '/api/universes', {
    name: 'Garden of Patience',
    artStyle: 'pixar-3d',
    colorPalette: ['#4A7BA7', '#D4A574', '#7EC8A4'],
    islamicRules: { hijabAlways: true, noMusic: false, customRules: 'Characters always greet with Salam' },
    seriesBible: 'Stories teaching Islamic values through Yasmin, a curious 7-year-old.',
  });
  check('Create universe', create.status === 201, create.data.name);
  if (create.status !== 201) { dump('Error', create.data); process.exit(1); }
  universeId = create.data._id;
}

// ─── 3. Character ─────────────────────────────────────────────────────────────
async function testCharacter() {
  section('3. Character');
  const create = await req('POST', '/api/characters', {
    universeId,
    name: 'Yasmin', role: 'protagonist', ageRange: '7-8 years',
    traits: ['curious', 'kind', 'brave'],
    speakingStyle: 'Simple, warm. Uses Bismillah and Alhamdulillah naturally.',
    visualDNA: {
      style: 'pixar-3d', gender: 'female', skinTone: '#D4A574',
      eyeColor: 'warm brown', faceShape: 'round',
      hairOrHijab: 'light blue hijab with small flower pattern',
      outfitRules: 'Teal long-sleeve dress, fully covered',
      accessories: 'small golden bracelet', paletteNotes: 'warm earth tones',
    },
    modestyRules: { hijabAlways: true, longSleeves: true, looseClothing: true },
  });
  check('Create character', create.status === 201, create.data.name);
  if (create.status !== 201) { dump('Error', create.data); process.exit(1); }
  characterId = create.data._id;

  const approve = await req('PUT', `/api/characters/${characterId}`, {
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png',
    status: 'approved',
  });
  check('Approve character', approve.status === 200 && approve.data.status === 'approved', approve.data.status);
  if (approve.status !== 200) dump('Approve error', approve.data);
}

// ─── 4. Knowledge Base ────────────────────────────────────────────────────────
async function testKnowledgeBase() {
  section('4. Knowledge Base');
  const create = await req('POST', '/api/knowledge-bases', {
    universeId, name: 'Islamic Values — Ages 6-8',
    islamicValues: ['sabr (patience)', 'tawakkul (trust in Allah)', 'shukr (gratitude)', 'sadaqa (charity)'],
    duas: [
      { arabic: 'بِسْمِ اللَّهِ', transliteration: 'Bismillah', meaning: 'In the name of Allah', context: 'Before any action' },
      { arabic: 'الْحَمْدُ لِلَّهِ', transliteration: 'Alhamdulillah', meaning: 'All praise is for Allah', context: 'When grateful' },
    ],
    vocabulary: [
      { word: 'Sabr', definition: 'Patience — staying calm and trusting Allah', ageGroup: '6-8' },
      { word: 'Dua',  definition: 'A personal prayer to Allah',                 ageGroup: '6-8' },
    ],
    illustrationRules: ['Full modest dress always', 'No music instruments', 'Masjid domes allowed in background'],
    avoidTopics: ['Halloween', 'Santa Claus', 'violent imagery', 'romance'],
    customRules: 'Arabic words always followed by English meaning in parentheses.',
  });
  check('Create knowledge base', create.status === 201, create.data.name);
  if (create.status !== 201) dump('KB error', create.data);
}

// ─── 5. Project ───────────────────────────────────────────────────────────────
async function testProject() {
  section('5. Project Setup');
  const create = await req('POST', '/api/projects', {
    universeId, characterIds: [characterId],
    title: 'Yasmin and the Garden of Patience',
    ageRange: '6-8 years', chapterCount: 4, template: 'moral',
    learningObjective: 'Children will learn that sabr (patience) is a gift from Allah.',
    authorName: 'NoorStudio',
  });
  check('Create project', create.status === 201, create.data.title);
  if (create.status !== 201) { dump('Error', create.data); process.exit(1); }
  projectId = create.data._id;

  const get = await req('GET', `/api/projects/${projectId}`);
  check('Characters populated', get.status === 200 && get.data.characterIds?.length > 0, `${get.data.characterIds?.length} chars`);
}

// ─── 6. AI Status ─────────────────────────────────────────────────────────────
async function testAIStatus() {
  section('6. AI Provider Status');
  const { status, data } = await req('GET', '/api/ai/status');
  check('Status endpoint 200',   status === 200);
  check('Claude configured',     !!data.claudeConfigured,  data.claudeConfigured  ? 'ok' : '⚠ MISSING — text will fail');
  // ✅ Gemini only — Replicate/BFL removed
  check('Gemini configured (images)', !!data.googleConfigured, data.googleConfigured ? 'ok' : '⚠ MISSING — ALL images will fail');
  dump('Full AI status', data);
}

// ─── 7. Stage 1 — Outline ────────────────────────────────────────────────────
async function testStage1Outline() {
  section('7. Stage 1 — Outline (Claude)');
  const res = await req('POST', '/api/ai/generate', { stage: 'outline', projectId });
  check('HTTP 200', res.status === 200, `status: ${res.status}`);

  if (res.status !== 200) { dump('Error response', res.data); return; }

  const { result, provider, creditsCharged } = res.data;
  console.log(c.yellow(`  ℹ provider: ${provider}  creditsCharged: ${creditsCharged}`));
  dump('Outline result', result);

  check('Has bookTitle',     !!result?.bookTitle && !result?.raw,                    result?.bookTitle || 'MISSING or raw wrapper present');
  check('Has chapters[]',    Array.isArray(result?.chapters) && result.chapters.length > 0, `${result?.chapters?.length} chapters`);
  check('No raw wrapper',    !result?.raw,                                           result?.raw ? '⚠ fence-strip failed' : 'ok');
  check('Credits charged=3', creditsCharged === 3,                                  `charged: ${creditsCharged}`);

  if (result?.raw) {
    console.log(c.red('  ⚠ Claude returned fenced JSON — stripFences() not working:'));
    console.log(c.dim('    ' + result.raw.slice(0, 200)));
  }
}

// ─── 8. Stage 2 — Chapters ───────────────────────────────────────────────────
async function testStage2Chapters() {
  section('8. Stage 2 — Chapter Writing (Claude)');

  for (let i = 0; i < 2; i++) {
    const res = await req('POST', '/api/ai/generate', { stage: 'chapter', projectId, chapterIndex: i });
    check(`Ch${i + 1} HTTP 200`,        res.status === 200, `status: ${res.status}`);

    if (res.status !== 200) { dump(`Ch${i + 1} error`, res.data); continue; }

    const { result, provider } = res.data;
    console.log(c.yellow(`  ℹ provider: ${provider}`));
    dump(`Ch${i + 1} result`, result);

    check(`Ch${i + 1} has text`,         typeof result?.text === 'string' && result.text.length > 50, `${result?.text?.length} chars`);
    check(`Ch${i + 1} has chapterTitle`, !!result?.chapterTitle, result?.chapterTitle);
    check(`Ch${i + 1} no raw wrapper`,   !result?.raw, result?.raw ? '⚠ fence-strip failed' : 'ok');

    if (result?.raw) console.log(c.red(`  ⚠ Ch${i + 1} raw preview: ${result.raw.slice(0, 200)}`));
    await sleep(500);
  }
}

// ─── 9. Stage 3 — Humanize ───────────────────────────────────────────────────
async function testStage3Humanize() {
  section('9. Stage 3 — Humanize (Claude)');
  const res = await req('POST', '/api/ai/generate', { stage: 'humanize', projectId, chapterIndex: 0 });
  check('HTTP 200', res.status === 200, `status: ${res.status}`);

  if (res.status !== 200) { dump('Error', res.data); return; }

  const { result, provider } = res.data;
  console.log(c.yellow(`  ℹ provider: ${provider}`));
  dump('Humanize result', result);

  check('Has text',        typeof result?.text === 'string' && result.text.length > 50, `${result?.text?.length} chars`);
  check('Has changesMade', Array.isArray(result?.changesMade) && result.changesMade.length > 0, `${result?.changesMade?.length} changes`);
  check('No raw wrapper',  !result?.raw, result?.raw ? '⚠ fence-strip failed' : 'ok');
}

// ─── 10. Stage 4 — Illustrations (Gemini Imagen 3) ───────────────────────────
async function testStage4Illustrations() {
  section('10. Stage 4 — Illustrations (Gemini Imagen 3)');

  // Ch1 — anchor illustration, text-to-image (no ref yet)
  console.log(c.dim('  Ch1: anchor image (Gemini, text-to-image)...'));
  const ch1 = await req('POST', '/api/ai/image/generate', {
    task: 'illustration', chapterIndex: 0, projectId, style: 'pixar-3d',
  });
  check('Ch1 HTTP 200',    ch1.status === 200,     `status: ${ch1.status} provider: ${ch1.data?.provider}`);
  check('Ch1 provider=gemini', ch1.data?.provider === 'gemini', ch1.data?.provider || 'missing');
  check('Ch1 imageUrl',    !!ch1.data?.imageUrl,   `${String(ch1.data?.imageUrl || '').slice(0, 80)}`);
  if (ch1.status !== 200) dump('Ch1 error', ch1.data);
  else dump('Ch1 providerMeta', ch1.data?.providerMeta);

  await sleep(1000); // small pause between Gemini calls

  // Ch2 — with style reference from Ch1
  console.log(c.dim('  Ch2: consistency image (Gemini, with style ref)...'));
  const ch2 = await req('POST', '/api/ai/image/generate', {
    task: 'illustration', chapterIndex: 1, projectId, style: 'pixar-3d',
  });
  check('Ch2 HTTP 200',        ch2.status === 200,     `status: ${ch2.status} provider: ${ch2.data?.provider}`);
  check('Ch2 provider=gemini', ch2.data?.provider === 'gemini', ch2.data?.provider || 'missing');
  check('Ch2 imageUrl',        !!ch2.data?.imageUrl,   `${String(ch2.data?.imageUrl || '').slice(0, 80)}`);
  if (ch2.status !== 200) dump('Ch2 error', ch2.data);
  else dump('Ch2 providerMeta', ch2.data?.providerMeta);
}

// ─── 11. Stage 5 — Cover (Gemini Imagen 3, 16:9) ─────────────────────────────
async function testStage5Cover() {
  section('11. Stage 5 — Cover (Gemini Imagen 3, 16:9)');
  const res = await req('POST', '/api/ai/image/generate', {
    task: 'cover', projectId, style: 'pixar-3d',
  });
  check('HTTP 200',          res.status === 200,       `status: ${res.status} provider: ${res.data?.provider}`);
  check('provider=gemini',   res.data?.provider === 'gemini', res.data?.provider || 'missing');
  check('imageUrl',          !!res.data?.imageUrl,     `${String(res.data?.imageUrl || '').slice(0, 80)}`);
  check('aspectRatio=16:9',  res.data?.providerMeta?.aspectRatio === '16:9', res.data?.providerMeta?.aspectRatio || 'missing');
  if (res.status !== 200) dump('Error', res.data);
  else dump('Cover providerMeta', res.data?.providerMeta);
}

// ─── 12. Stage 6 — Layout ────────────────────────────────────────────────────
async function testStage6Layout() {
  section('12. Stage 6 — Layout Engine');

  const projectState = (await req('GET', `/api/projects/${projectId}`)).data;
  const hasIlls = Array.isArray(projectState.artifacts?.illustrations)
    ? projectState.artifacts.illustrations.length > 0
    : !!projectState.artifacts?.illustrations;

  if (!hasIlls) {
    console.log(c.yellow('  ℹ Seeding placeholder illustrations (image stage did not produce results)'));
    const seedIlls = [0, 1, 2, 3].map(i => ({
      chapterNumber: i + 1,
      variants: [{ variantIndex: 0, imageUrl: 'https://picsum.photos/1024/768', selected: true }],
      selectedVariantIndex: 0,
    }));
    await req('PUT', `/api/projects/${projectId}`, { artifacts: { illustrations: seedIlls } });
  }

  const res = await req('POST', `/api/projects/${projectId}/layout`);
  check('HTTP 200',         res.status === 200, `status: ${res.status}`);
  check('pageCount > 0',    (res.data.layout?.pageCount || 0) > 0, `pages: ${res.data.layout?.pageCount}`);
  check('spreads is array', Array.isArray(res.data.layout?.spreads) && res.data.layout.spreads.length > 0, `${res.data.layout?.spreads?.length} spreads`);
  if (res.status !== 200) dump('Layout error', res.data);
  else dump('Spread types', res.data.layout?.spreads?.map(s => `p${s.page}:${s.type}`));
}

// ─── 13. Stage 7 — Export ────────────────────────────────────────────────────
async function testStage7Export() {
  section('13. Stage 7 — PDF Export');
  const res = await fetch(`${BASE}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ projectId }),
  });
  check('HTTP 200',         res.status === 200, `status: ${res.status}`);
  check('Content-Type PDF', res.headers.get('content-type') === 'application/pdf');

  const buf = await res.arrayBuffer();
  check('PDF > 1 KB',       buf.byteLength > 1000, `${(buf.byteLength / 1024).toFixed(1)} KB`);

  if (res.status !== 200) {
    const txt = Buffer.from(buf).toString('utf8');
    dump('Export error', txt.slice(0, 500));
  }
}

// ─── 14. Credits ─────────────────────────────────────────────────────────────
async function testCredits() {
  section('14. Credit Balance Check');
  const me    = await req('GET', '/api/auth/me');
  const creds = me.data.user?.credits ?? 50;
  check('Credits reduced from 50', creds < 50, `remaining: ${creds}`);
  console.log(c.yellow(`  ℹ Started: 50 | Used: ${50 - creds} | Remaining: ${creds}`));

  const txns = await req('GET', '/api/payments/transactions');
  check('Transactions exist', txns.status === 200 && txns.data.transactions?.length > 0, `${txns.data.transactions?.length} txns`);
  dump('Transactions', txns.data.transactions?.map(t => `${t.amount > 0 ? '+' : ''}${t.amount} ${t.description}`));
}

// ─── 15. Persistence ─────────────────────────────────────────────────────────
async function testPersistence() {
  section('15. Artifact Persistence');
  const res = await req('GET', `/api/projects/${projectId}`);
  check('Project fetchable', res.status === 200);
  const a = res.data.artifacts || {};

  check('outline saved',            !!a.outline && !a.outline?.raw,                     a.outline?.bookTitle || '⚠ raw or missing');
  check('chapters saved as array',  Array.isArray(a.chapters) && a.chapters.length > 0, `${a.chapters?.length} entries`);
  check('chapters[0].text exists',  typeof a.chapters?.[0]?.text === 'string' && a.chapters[0].text.length > 50, `${a.chapters?.[0]?.text?.length} chars`);
  check('humanized saved as array', Array.isArray(a.humanized) && a.humanized.length > 0, `${a.humanized?.length} entries`);
  check('humanized[0].text exists', typeof a.humanized?.[0]?.text === 'string' && a.humanized[0].text.length > 50, `${a.humanized?.[0]?.text?.length} chars`);
  check('layout saved',             !!a.layout?.spreads, `${a.layout?.spreads?.length} spreads`);

  console.log(c.yellow(`  ℹ currentStage: ${res.data.currentStage}`));
  dump('Artifact keys present', Object.keys(a).filter(k => !!a[k]));
  dump('chapters[0] keys',   Object.keys(a.chapters?.[0]  || {}));
  dump('humanized[0] keys',  Object.keys(a.humanized?.[0] || {}));
}

// ─── Runner ───────────────────────────────────────────────────────────────────
async function run() {
  console.log(c.bold('\n🌙 NoorStudio E2E Test v2 — Gemini Image Provider'));
  console.log(c.cyan(`   Server: ${BASE}\n`));

  try {
    await testHealth();
    await testAuth();
    await testUniverse();
    await testCharacter();
    await testKnowledgeBase();
    await testProject();
    await testAIStatus();
    await testStage1Outline();
    await testStage2Chapters();
    await testStage3Humanize();
    await testStage4Illustrations();
    await testStage5Cover();
    await testStage6Layout();
    await testStage7Export();
    await testCredits();
    await testPersistence();
  } catch (err) {
    console.error(c.red('\n  💥 Uncaught fatal error:'), err.message);
    console.error(err.stack);
    failed++;
  }

  const total = passed + failed;
  const pct   = total ? Math.round((passed / total) * 100) : 0;

  console.log('\n' + '─'.repeat(56));
  console.log(c.bold(`  ${c.green(`${passed} passed`)}  ${failed > 0 ? c.red(`${failed} failed`) : c.green('0 failed')}  (${pct}% — ${total} total)`));

  if (failed === 0) {
    console.log(c.green(c.bold('\n  ✅ Full pipeline working!\n')));
  } else {
    console.log(c.yellow('\n  ⚠  Review the 📦 dumps above for each failure.\n'));
    process.exit(1);
  }
}

run();