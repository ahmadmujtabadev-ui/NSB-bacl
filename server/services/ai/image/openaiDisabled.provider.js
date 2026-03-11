import { AIProviderError } from '../../../errors.js';

/**
 * DALL-E / OpenAI image generation is permanently DISABLED.
 * Use BFL FLUX for text-to-image, Replicate for img2img consistency.
 */
export function openaiDisabledGenerate() {
  throw new AIProviderError(
    'OpenAI/DALL-E is disabled. Use BFL FLUX (text-to-image) or Replicate (character consistency).',
    'openai-disabled'
  );
}
