#!/usr/bin/env node
/**
 * Standalone Gemini Image Test
 * Tests all image tasks WITHOUT touching your main codebase
 * Saves images as local PNG files so you can inspect them
 *
 * Usage:
 *   GOOGLE_API_KEY=your_key node test-gemini-images.js
 *   or just: node test-gemini-images.js  (if key is in .env)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Load .env manually (no dotenv dependency needed) ──────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Try to load .env from current dir or parent
function loadEnv(envPath) {
  try {
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
    console.log(`✓ Loaded env from: ${envPath}`);
  } catch {}
}

// Try multiple .env locations
loadEnv(path.join(process.cwd(), '.env'));
loadEnv(path.join(process.cwd(), '..', '.env'));
loadEnv(path.join(__dirname, '.env'));

// ── Config ────────────────────────────────────────────────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const OUTPUT_DIR     = path.join(process.cwd(), 'gemini-test-output');
const BASE_URL       = process.env.BASE_URL || 'http://localhost:3001';
const PROJECT_ID     = process.env.PROJECT_ID || '69b07593ba420cec0974167b';

// ── Colours ───────────────────────────────────────────────────────────────────
const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

let passed = 0, failed = 0;

function check(label, condition, info = '') {
  if (condition) {
    console.log(c.green(`  ✓ ${label}`) + (info ? c.dim(` — ${info}`) : ''));
    passed++;
  } else {
    console.log(c.red(`  ✗ ${label}`) + (info ? c.red(` — ${info}`) : ''));
    failed++;
  }
}

function section(title) {
  const pad = '─'.repeat(Math.max(0, 52 - title.length));
  console.log('\n' + c.bold(c.cyan(`── ${title} ${pad}`)));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Ensure output directory ───────────────────────────────────────────────────
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
console.log(c.dim(`  Output dir: ${OUTPUT_DIR}`));

// ── Core Gemini API call ──────────────────────────────────────────────────────
async function callGemini(prompt, referenceUrl = null, modelName = 'gemini-2.5-flash-image') {
  const parts = [];

  // Add reference image if provided
  if (referenceUrl) {
    try {
      console.log(c.dim(`  Fetching reference: ${referenceUrl.slice(0, 60)}...`));
      const imgRes = await fetch(referenceUrl);
      if (imgRes.ok) {
        const mime = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        const buf  = await imgRes.arrayBuffer();
        parts.push({ inline_data: { mime_type: mime, data: Buffer.from(buf).toString('base64') } });
        console.log(c.dim(`  Reference loaded: ${buf.byteLength} bytes, mime: ${mime}`));
      }
    } catch (err) {
      console.warn(c.yellow(`  ⚠ Reference fetch failed: ${err.message}`));
    }
  }

  parts.push({ text: `Generate exactly ONE single image. Do not tile or duplicate.\n\n${prompt}` });

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 1.0,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 8192,
      responseModalities: ['IMAGE'],
      candidateCount: 1,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GOOGLE_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
  }

  const parts2  = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts2.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imgPart?.inlineData?.data) {
    throw new Error(`No image in response. Parts: ${JSON.stringify(parts2.map(p => Object.keys(p)))}`);
  }

  return {
    b64:  imgPart.inlineData.data,
    mime: imgPart.inlineData.mimeType || 'image/png',
  };
}

// ── Save image to disk ────────────────────────────────────────────────────────
function saveImage(b64, filename) {
  const ext      = 'png';
  const fullPath = path.join(OUTPUT_DIR, `${filename}.${ext}`);
  fs.writeFileSync(fullPath, Buffer.from(b64, 'base64'));
  return fullPath;
}

// ── Test 1: Direct Gemini API (no server) ────────────────────────────────────
async function testDirectGemini() {
  section('1. Direct Gemini API — Cover (no server)');

  if (!GOOGLE_API_KEY) {
    console.log(c.red('  ✗ GOOGLE_API_KEY not set — skipping direct API tests'));
    console.log(c.yellow('  Run with: GOOGLE_API_KEY=your_key node test-gemini-images.js'));
    failed += 3;
    return;
  }

  // Test cover
  try {
    console.log(c.dim('  Generating cover image...'));
    const start = Date.now();
    const { b64, mime } = await callGemini(
      'Children\'s book cover illustration. A curious 7-year-old Muslim girl named Yasmin in a sunlit garden at golden hour. She wears a light blue hijab and teal dress. Warm, inviting, Pixar 3D animation style. No text or letters.'
    );
    const ms   = Date.now() - start;
    const file = saveImage(b64, '01-cover');
    const size = fs.statSync(file).size;

    check('Cover generated',        !!b64,              `${(size / 1024).toFixed(1)} KB`);
    check('Cover saved to disk',    fs.existsSync(file), path.basename(file));
    check('Cover > 50KB',           size > 50000,        `${(size / 1024).toFixed(1)} KB in ${ms}ms`);
    console.log(c.yellow(`  ℹ Open file: ${file}`));
  } catch (err) {
    check('Cover generated', false, err.message);
    console.log(c.red(`  Error: ${err.message}`));
  }
}

async function testDirectIllustration() {
  section('2. Direct Gemini API — Illustration');
  if (!GOOGLE_API_KEY) { failed++; return; }

  try {
    console.log(c.dim('  Generating illustration...'));
    const start = Date.now();
    const { b64 } = await callGemini(
      'Children\'s book illustration. Yasmin, a 7-year-old Muslim girl with light blue hijab and teal dress, kneeling beside flower pots in a garden, looking hopeful. Pixar 3D animation style, warm lighting, child-friendly. No text.'
    );
    const ms   = Date.now() - start;
    const file = saveImage(b64, '02-illustration-ch1');
    const size = fs.statSync(file).size;

    check('Illustration generated', !!b64,              `${(size / 1024).toFixed(1)} KB in ${ms}ms`);
    check('Illustration > 50KB',    size > 50000,        `${(size / 1024).toFixed(1)} KB`);
    console.log(c.yellow(`  ℹ Open file: ${file}`));
  } catch (err) {
    check('Illustration generated', false, err.message);
  }
}

async function testDirectIllustrationWithRef() {
  section('3. Direct Gemini API — Illustration WITH reference');
  if (!GOOGLE_API_KEY) { failed++; return; }

  // Use a real public test image as reference
  const refUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png';

  try {
    console.log(c.dim('  Generating illustration with reference image...'));
    const start = Date.now();
    const { b64 } = await callGemini(
      'Children\'s book illustration. Based on the reference style, show Yasmin, a 7-year-old Muslim girl with light blue hijab, sitting under a tree reading a book. Pixar 3D style. No text.',
      refUrl
    );
    const ms   = Date.now() - start;
    const file = saveImage(b64, '03-illustration-with-ref');
    const size = fs.statSync(file).size;

    check('Illustration+ref generated', !!b64,       `${(size / 1024).toFixed(1)} KB in ${ms}ms`);
    check('Illustration+ref > 50KB',    size > 50000, `${(size / 1024).toFixed(1)} KB`);
    console.log(c.yellow(`  ℹ Open file: ${file}`));
  } catch (err) {
    check('Illustration+ref generated', false, err.message);
  }
}

// ── Test 2: Via your server API ───────────────────────────────────────────────
async function testViaServer() {
  section('4. Via Server API — Cover');

  // First login to get token
  let token = '';
  try {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@noorstudio.test', password: 'TestPass123!' }),
    });

    // Try to get any token from recent test run
    if (loginRes.ok) {
      const data = await loginRes.json();
      token = data.token || '';
    }
  } catch {}

  if (!token) {
    console.log(c.yellow('  ℹ No token — registering new test user'));
    try {
      const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Image Tester',
          email: `imgtest_${Date.now()}@noorstudio.test`,
          password: 'TestPass123!',
        }),
      });
      const regData = await regRes.json();
      token = regData.token || '';
    } catch (err) {
      console.log(c.red(`  ✗ Could not get auth token: ${err.message}`));
      return;
    }
  }

  check('Got auth token', !!token, token ? token.slice(0, 20) + '...' : 'MISSING');
  if (!token) return;

  // Test cover via server
  try {
    console.log(c.dim(`  POST /api/ai/image/generate task=cover projectId=${PROJECT_ID}`));
    const start = Date.now();
    const res = await fetch(`${BASE_URL}/api/ai/image/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        task: 'cover',
        projectId: PROJECT_ID,
        style: 'pixar-3d',
      }),
    });

    const data = await res.json();
    const ms = Date.now() - start;

    console.log(c.yellow(`  ℹ status=${res.status} provider=${data.provider} time=${ms}ms`));

    check('Server cover HTTP 200',   res.status === 200,            `status: ${res.status}`);
    check('Server cover provider',   data.provider === 'gemini',    data.provider || 'missing');
    check('Server cover imageUrl',   !!data.imageUrl,               (data.imageUrl || '').slice(0, 80));

    if (data.imageUrl) {
      // Check if it's base64 (BAD) or a URL (GOOD)
      const isBase64 = data.imageUrl.startsWith('data:');
      const isUrl    = data.imageUrl.startsWith('http');
      check('imageUrl is URL not base64', isUrl, isBase64 ? '⚠ BASE64 — needs Cloudinary fix' : data.imageUrl.slice(0, 60));

      // If base64, save locally so you can inspect it
      if (isBase64) {
        const b64  = data.imageUrl.split(',')[1];
        const file = saveImage(b64, '04-server-cover-base64');
        const size = fs.statSync(file).size;
        console.log(c.yellow(`  ℹ Saved base64 image locally: ${file} (${(size/1024).toFixed(1)} KB)`));
        check('Base64 image > 50KB', size > 50000, `${(size/1024).toFixed(1)} KB`);
      }
    }

    if (res.status !== 200) {
      console.log(c.red(`  Error: ${JSON.stringify(data.error || data)}`));
    } else {
      console.log(c.dim(`  providerMeta: ${JSON.stringify(data.providerMeta)}`));
    }
  } catch (err) {
    check('Server cover', false, err.message);
  }
}

async function testServerIllustration() {
  section('5. Via Server API — Illustration');

  let token = '';
  try {
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Image Tester 2',
        email: `imgtest2_${Date.now()}@noorstudio.test`,
        password: 'TestPass123!',
      }),
    });
    const regData = await regRes.json();
    token = regData.token || '';
  } catch {}

  if (!token) { check('Got token for illustration test', false, 'skipping'); return; }

  try {
    console.log(c.dim(`  POST /api/ai/image/generate task=illustration projectId=${PROJECT_ID}`));
    const res = await fetch(`${BASE_URL}/api/ai/image/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ task: 'illustration', chapterIndex: 0, projectId: PROJECT_ID, style: 'pixar-3d' }),
    });

    const data = await res.json();
    check('Server illustration HTTP 200', res.status === 200, `status: ${res.status}`);
    check('Server illustration imageUrl', !!data.imageUrl,    (data.imageUrl || '').slice(0, 80));

    if (data.imageUrl?.startsWith('data:')) {
      const b64  = data.imageUrl.split(',')[1];
      const file = saveImage(b64, '05-server-illustration-base64');
      const size = fs.statSync(file).size;
      console.log(c.yellow(`  ℹ Saved locally: ${file} (${(size/1024).toFixed(1)} KB)`));
    }

    if (res.status !== 200) console.log(c.red(`  Error: ${JSON.stringify(data.error || data)}`));
  } catch (err) {
    check('Server illustration', false, err.message);
  }
}

// ── Test model availability ───────────────────────────────────────────────────
async function testModelAvailability() {
  section('0. Check Which Gemini Models Are Available');

  if (!GOOGLE_API_KEY) {
    console.log(c.yellow('  ✗ No GOOGLE_API_KEY — skipping model check'));
    return;
  }

  try {
    const res  = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GOOGLE_API_KEY}`);
    const data = await res.json();

    if (!res.ok) {
      console.log(c.red(`  ✗ ListModels failed: ${data?.error?.message}`));
      return;
    }

    const imageModels = (data.models || []).filter(m =>
      m.supportedGenerationMethods?.includes('generateContent') &&
      (m.name.includes('flash') || m.name.includes('imagen') || m.name.includes('image'))
    );

    console.log(c.yellow(`  ℹ Image-capable models on your API key:`));
    for (const m of imageModels) {
      console.log(c.dim(`    • ${m.name.replace('models/', '')} — ${m.displayName}`));
    }

    const hasFlashImage = imageModels.some(m => m.name.includes('flash-image'));
    check('gemini-2.5-flash-image available', hasFlashImage, hasFlashImage ? '✓' : '⚠ Not in your API tier');

  } catch (err) {
    console.log(c.red(`  ✗ Model list error: ${err.message}`));
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────
async function run() {
  console.log(c.bold('\n🎨 Gemini Image Generation Test'));
  console.log(c.cyan(`   API Key: ${GOOGLE_API_KEY ? GOOGLE_API_KEY.slice(0, 8) + '...' : '⚠ NOT SET'}`));
  console.log(c.cyan(`   Server:  ${BASE_URL}`));
  console.log(c.cyan(`   Project: ${PROJECT_ID}`));
  console.log(c.cyan(`   Output:  ${OUTPUT_DIR}\n`));

  await testModelAvailability();
  await testDirectGemini();
  await sleep(2000);  // avoid rate limiting
  await testDirectIllustration();
  await sleep(2000);
  await testDirectIllustrationWithRef();
  await sleep(1000);
  await testViaServer();
  await sleep(1000);
  await testServerIllustration();

  const total = passed + failed;
  const pct   = total ? Math.round((passed / total) * 100) : 0;

  console.log('\n' + '─'.repeat(56));
  console.log(c.bold(`  ${c.green(`${passed} passed`)}  ${failed > 0 ? c.red(`${failed} failed`) : c.green('0 failed')}  (${pct}%)`));
  console.log(c.yellow(`\n  📁 Check generated images in:\n     ${OUTPUT_DIR}`));

  if (failed === 0) {
    console.log(c.green(c.bold('\n  ✅ All image tests passed!\n')));
  } else {
    console.log(c.yellow('\n  ⚠  Some tests failed — check errors above.\n'));
  }
}

run().catch(err => {
  console.error(c.red('\n💥 Fatal:'), err.message);
  process.exit(1);
});