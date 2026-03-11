import Anthropic from '@anthropic-ai/sdk';
import { AI_CONFIG } from '../ai.config.js';
import { generateLocalIllustration } from '../utils/localIllustration.js';
import { LOCAL_CHARACTER_SPECS } from '../utils/localCharacterSpecs.js';

let _client = null;
function getClient() {
  if (!_client && AI_CONFIG.keys.claude) _client = new Anthropic({ apiKey: AI_CONFIG.keys.claude });
  return _client;
}

/**
 * Claude + local SVG generation — fallback when no image API is configured.
 * Claude enhances the description; SVG renderer draws characters.
 * @param {import('../ai.types.js').ImageRequest} req
 * @returns {Promise<import('../ai.types.js').ImageResponse>}
 */
export async function claudeLocalGenerate(req) {
  let description = req.prompt;
  const client = getClient();

  if (client) {
    try {
      const charRef = Object.entries(LOCAL_CHARACTER_SPECS)
        .map(([, c]) => `${c.name}: ${c.distinctiveFeatures}, skin ${c.skinTone}`)
        .join('; ');

      const res = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 400,
        system: `You are an illustration description specialist. Given a scene, write a vivid visual description for a children's book illustration. Characters: ${charRef}. Keep it warm, child-friendly, Islamic aesthetic. Output ONLY the description.`,
        messages: [{ role: 'user', content: `Describe: ${req.prompt}` }],
      });
      const block = res.content.find(c => c.type === 'text');
      if (block) description = block.text;
    } catch {
      // Fallback to original prompt
    }
  }

  const size = req.task === 'cover' ? { width: 1024, height: 1536 } : { width: 800, height: 600 };
  return {
    imageUrl: generateLocalIllustration(description, req.task || 'illustration', size),
    provider: 'claude-local',
    providerMeta: { description: description.slice(0, 150) },
  };
}
