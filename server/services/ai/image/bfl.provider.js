import { AI_CONFIG }        from '../ai.config.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';
import { AIProviderError }  from '../../../errors.js';

const BFL_BASE = 'https://api.bfl.ml';

export async function bflGenerate(req, retry = 0) {
  if (!AI_CONFIG.keys.bfl) throw new AIProviderError('BFL_API_KEY not configured', 'bfl');

  const width  = req.width  || 1024;
  const height = req.height || (req.task === 'cover' ? 1536 : 768);

  const body = {
    prompt:           req.prompt,
    width,
    height,
    steps:            req.task === 'cover' ? 35 : 30,
    guidance:         req.task === 'cover' ? 8.5 : 7.5,
    safety_tolerance: 2,
    output_format:    'jpg',
    ...(req.seed && { seed: req.seed }),
  };

  console.log(`[BFL] Submitting job — task=${req.task} ${width}x${height} attempt=${retry + 1}`);
  console.log(`[BFL] Prompt (first 120): ${req.prompt?.slice(0, 120)}`);

  try {
    // ── Step 1: Submit ──────────────────────────────────────────────────
    const submitRes = await fetchWithTimeout(`${BFL_BASE}/v1/flux-pro-1.1`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-key': AI_CONFIG.keys.bfl },
      body:    JSON.stringify(body),
    }, 30_000);

    const submitText = await submitRes.text();
    console.log(`[BFL] Submit response HTTP ${submitRes.status}: ${submitText.slice(0, 300)}`);

    if (!submitRes.ok) {
      let msg = submitText;
      try { msg = JSON.parse(submitText)?.detail || JSON.parse(submitText)?.message || submitText; } catch {}
      throw new AIProviderError(`BFL submit HTTP ${submitRes.status}: ${msg}`, 'bfl');
    }

    const { id: jobId } = JSON.parse(submitText);
    if (!jobId) throw new AIProviderError(`BFL submit returned no job ID: ${submitText}`, 'bfl');
    console.log(`[BFL] Job ID: ${jobId}`);

    // ── Step 2: Poll ────────────────────────────────────────────────────
    const start    = Date.now();
    let pollCount  = 0;

    while (Date.now() - start < 120_000) {
      await sleep(3000);
      pollCount++;

      const pollRes  = await fetchWithTimeout(`${BFL_BASE}/v1/get_result?id=${jobId}`, {
        headers: { 'x-key': AI_CONFIG.keys.bfl },
      }, 10_000);

      const pollData = await pollRes.json();
      console.log(`[BFL] Poll #${pollCount} (${Math.round((Date.now() - start) / 1000)}s): status=${pollData.status}`);

      if (pollData.status === 'Ready') {
        const imageUrl = pollData.result?.sample;
        console.log(`[BFL] ✓ Ready — imageUrl: ${imageUrl?.slice(0, 100)}`);
        return {
          imageUrl,
          provider: 'bfl',
          providerMeta: {
            jobId,
            seed:           pollData.result?.seed,
            model:          'flux-pro-1.1',
            processingTime: Date.now() - start,
          },
        };
      }

      if (pollData.status === 'Error' || pollData.status === 'Failed') {
        console.error('[BFL] Job failed:', JSON.stringify(pollData));
        throw new AIProviderError(`BFL job ${pollData.status}: ${JSON.stringify(pollData.result || {})}`, 'bfl');
      }

      if (pollData.status === 'Content Moderated') {
        throw new AIProviderError('BFL: prompt was content-moderated — adjust the prompt', 'bfl');
      }

      if (pollData.status === 'Request Moderated') {
        throw new AIProviderError('BFL: request moderated — check prompt for policy violations', 'bfl');
      }
    }

    throw new AIProviderError('BFL: job timed out after 120s', 'bfl');

  } catch (err) {
    console.error(`[BFL] Error (attempt ${retry + 1}): ${err.message}`);
    if (err instanceof AIProviderError && err.message.includes('Moderated')) throw err; // don't retry moderated
    if (retry < AI_CONFIG.maxRetries) {
      const delay = Math.pow(2, retry) * 1500;
      console.log(`[BFL] Retrying in ${delay}ms...`);
      await sleep(delay);
      return bflGenerate(req, retry + 1);
    }
    throw err instanceof AIProviderError ? err : new AIProviderError(err.message, 'bfl');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
