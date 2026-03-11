import { generateLocalIllustration } from '../utils/localIllustration.js';

/**
 * Mock image provider — returns SVG data-URL for dev.
 * @param {import('../ai.types.js').ImageRequest & { traceId: string }} req
 * @returns {Promise<import('../ai.types.js').ImageResponse>}
 */
export async function mockImageGenerate(req) {
  await sleep(400 + Math.random() * 400);
  const size = req.task === 'cover' ? { width: 1024, height: 1536 } : { width: 1024, height: 768 };
  return {
    imageUrl: generateLocalIllustration(req.prompt, req.task || 'illustration', size),
    provider: 'mock',
    providerMeta: { prompt: req.prompt.slice(0, 80), task: req.task, mock: true },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
