import { AI_CONFIG } from '../ai.config.js';
import { claudeGenerate } from './claude.provider.js';
import { mockTextGenerate } from './mockText.provider.js';

/**
 * Route to the correct text provider based on config.
 * @param {import('../ai.types.js').TextRequest} req
 * @returns {Promise<import('../ai.types.js').TextResponse>}
 */
export function generateText(req) {
  if (AI_CONFIG.textProvider === 'claude' && AI_CONFIG.keys.claude) {
    return claudeGenerate(req);
  }
  return mockTextGenerate(req);
}
