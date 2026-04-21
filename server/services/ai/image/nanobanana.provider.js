import { AI_CONFIG } from '../ai.config.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';
import { AIProviderError } from '../../../errors.js';

const NEG_COVER = 'text,words,letters,numbers,title,author,watermark,logo,barcode,typography,blurry,distorted,low quality,deformed,scary,violent,revealing clothing,horizontal';
const NEG_ILLUSTRATION = 'different face,changed appearance,wrong skin tone,missing hijab,text,watermark,blurry,distorted,low quality,deformed,scary,violent,revealing clothing';

/**
 * NanoBanana custom image model.
 * @param {import('../ai.types.js').ImageRequest & { traceId: string }} req
 * @param {number} [retry]
 * @returns {Promise<import('../ai.types.js').ImageResponse>}
 */
export async function nanobananaGenerate(req, retry = 0) {
  if (!AI_CONFIG.keys.nanobanana) throw new AIProviderError('NANOBANANA_API_KEY not configured', 'nanobanana');

  const size = req.task === 'cover' ? { width: 1024, height: 1536 } : { width: 1024, height: 768 };

  try {
    const res = await fetchWithTimeout(`${AI_CONFIG.nanobanana.apiUrl}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_CONFIG.keys.nanobanana}` },
      body: JSON.stringify({
        model: AI_CONFIG.nanobanana.model,
        prompt: req.prompt,
        negative_prompt: req.task === 'cover' ? NEG_COVER : NEG_ILLUSTRATION,
        reference_images: req.references || [],
        width: req.width || size.width,
        height: req.height || size.height,
        style: req.style || 'pixar-3d',
        guidance_scale: req.task === 'cover' ? 8.5 : 7.5,
        num_inference_steps: req.task === 'cover' ? 35 : 30,
        ...(req.seed && { seed: req.seed }),
        ...(req.referenceStrength && { reference_strength: req.referenceStrength }),
      }),
    });

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new AIProviderError(`NanaBanana ${res.status}: ${e.message || res.statusText}`, 'nanobanana');
    }

    const data = await res.json();
    return {
      imageUrl: data.image_url || data.url,
      provider: 'nanobanana',
      providerMeta: { model: AI_CONFIG.nanobanana.model, seed: data.seed },
    };
  } catch (err) {
    if (retry < AI_CONFIG.maxRetries) {
      await sleep(Math.pow(2, retry) * 1000);
      return nanobananaGenerate(req, retry + 1);
    }
    throw err instanceof AIProviderError ? err : new AIProviderError(err.message, 'nanobanana');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
