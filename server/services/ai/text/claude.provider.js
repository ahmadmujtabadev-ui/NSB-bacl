import Anthropic from '@anthropic-ai/sdk';
import { AI_CONFIG } from '../ai.config.js';
import { AIProviderError } from '../../../errors.js';

let _client = null;

function getClient() {
  if (!AI_CONFIG.keys.claude) throw new AIProviderError('CLAUDE_API_KEY not configured', 'claude');
  if (!_client) _client = new Anthropic({ apiKey: AI_CONFIG.keys.claude });
  return _client;
}

/**
 * @param {import('../ai.types.js').TextRequest} req
 * @param {number} [retry]
 * @returns {Promise<import('../ai.types.js').TextResponse>}
 */
export async function claudeGenerate(req, retry = 0) {
  const client = getClient();

  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    });

    const block = res.content.find(c => c.type === 'text');
    if (!block) throw new AIProviderError('No text block in Claude response', 'claude');

    return {
      text: block.text,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      provider: 'claude',
    };
  } catch (err) {
    if (retry < AI_CONFIG.maxRetries) {
      await sleep(Math.pow(2, retry) * 1000);
      return claudeGenerate(req, retry + 1);
    }
    throw new AIProviderError(err.message, 'claude');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
