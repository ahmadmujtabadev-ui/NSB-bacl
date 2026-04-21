import { AI_CONFIG } from '../ai.config.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';
import { AIProviderError } from '../../../errors.js';

/**
 * Gemini 2.5 Flash Image — uses generateContent API (same as AI Studio / your working old code).
 * Works for ALL image tasks: illustration, cover, portrait, pose-sheet.
 *
 * API:  POST /v1beta/models/gemini-2.5-flash-preview-05-20:generateContent
 * Auth: ?key=GOOGLE_API_KEY
 */


const GEMINI_MODEL = 'gemini-2.5-flash-image';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * @param {{ prompt: string, references?: string[], aspectRatio?: string, task?: string, traceId?: string }} req
 * @param {number} retry
 */
export async function geminiGenerate(req, retry = 0) {
  if (!AI_CONFIG.keys.google) {
    throw new AIProviderError('GOOGLE_API_KEY not configured', 'gemini');
  }

  if (!req.prompt?.trim()) {
    throw new AIProviderError('Prompt is required', 'gemini');
  }

  const parts = [];

  // ── Optional reference image (img2img style) ──────────────────────────────
  const referenceUrl = req.references?.[0];
  if (referenceUrl) {
    try {
      console.log(`[Gemini][${req.traceId}] Fetching reference image...`);
      const imgRes = await fetchWithTimeout(referenceUrl);
      const mime = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
      const buf = await imgRes.arrayBuffer();
      const base64 = Buffer.from(buf).toString('base64');
      console.log(`[Gemini][${req.traceId}] Reference loaded: ${base64.length} chars, mime: ${mime}`);

      parts.push({
        inline_data: { mime_type: mime, data: base64 },
      });
    } catch (err) {
      // Non-fatal — proceed without reference
      console.warn(`[Gemini][${req.traceId}] Could not load reference image: ${err.message}`);
    }
  }

  // ── Text prompt ───────────────────────────────────────────────────────────
  parts.push({ text: req.prompt });

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 1.0,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 8192,
      responseModalities: ['IMAGE', 'TEXT'],   // ✅ must include IMAGE
    },
  };

  const url = `${GEMINI_ENDPOINT}?key=${AI_CONFIG.keys.google}`;

  try {
    const start = Date.now();
    console.log(`[Gemini][${req.traceId}] task=${req.task} model=${GEMINI_MODEL} hasRef=${!!referenceUrl}`);

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const message = errBody?.error?.message || JSON.stringify(errBody);
      throw new AIProviderError(`Gemini HTTP ${res.status}: ${message}`, 'gemini');
    }

    const data = await res.json();

    // ── Extract image part (camelCase inlineData from generateContent) ──────
    const responseParts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = responseParts.find(
      p => p.inlineData?.mimeType?.startsWith('image/')
    );

    if (!imagePart?.inlineData?.data) {
      console.error(`[Gemini][${req.traceId}] Unexpected response:`, JSON.stringify(data).slice(0, 500));
      throw new AIProviderError('No image returned in Gemini response', 'gemini');
    }

    const outputMime = imagePart.inlineData.mimeType || 'image/png';
    const b64 = imagePart.inlineData.data;
    const processingTime = Date.now() - start;

    console.log(`[Gemini][${req.traceId}] Done in ${processingTime}ms mime=${outputMime}`);

    return {
      imageUrl: `data:${outputMime};base64,${b64}`,
      provider: 'gemini',
      providerMeta: {
        model: GEMINI_MODEL,
        processingTime,
        aspectRatio: req.aspectRatio || '1:1',
        hadReference: !!referenceUrl,
        task: req.task,
      },
    };

  } catch (err) {
    if (retry < AI_CONFIG.maxRetries) {
      const delay = Math.pow(2, retry) * 1000;
      console.warn(`[Gemini][${req.traceId}] Retry ${retry + 1}/${AI_CONFIG.maxRetries} in ${delay}ms — ${err.message}`);
      await sleep(delay);
      return geminiGenerate(req, retry + 1);
    }

    throw err instanceof AIProviderError
      ? err
      : new AIProviderError(err.message, 'gemini');
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
