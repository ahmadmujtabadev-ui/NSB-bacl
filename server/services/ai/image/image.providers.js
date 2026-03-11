import { AI_CONFIG }       from '../ai.config.js';
import { geminiGenerate }  from './gemini.provider.js';

/**
 * Route to Gemini image provider (Imagen 3).
 *
 * All image generation tasks are handled by Gemini:
 *
 *  1. task === 'pose-sheet'    → Gemini with reference image (multi-pose grid)
 *  2. task === 'illustration'  → Gemini (with or without style reference)
 *  3. task === 'cover'         → Gemini text-to-image
 *  4. task === 'portrait'      → Gemini text-to-image
 *  5. Fallback                 → throws clear error (no mock, no silent fail)
 */
export async function generateImage(req) {
  const hasRefs = Array.isArray(req.references) && req.references.length > 0;

  console.log(`[ImageProviders] Routing: task=${req.task} hasRefs=${hasRefs} refs=${req.references?.length || 0}`);
  console.log(`[ImageProviders] Keys: google=${!!AI_CONFIG.keys.google}`);

  if (!AI_CONFIG.keys.google) {
    throw Object.assign(
      new Error('GOOGLE_API_KEY is required — Gemini is the only configured image provider'),
      { code: 'GEMINI_NOT_CONFIGURED' }
    );
  }

  switch (req.task) {

    // Pose sheet — pass portrait reference for multi-pose grid generation
    case 'pose-sheet':
      if (!hasRefs) {
        throw Object.assign(
          new Error('pose-sheet requires at least one reference image'),
          { code: 'MISSING_REFERENCE' }
        );
      }
      console.log('[ImageProviders] → Gemini (pose-sheet with reference)');
      return geminiGenerate(req);

    // Illustration — with or without style reference
    case 'illustration':
      console.log(`[ImageProviders] → Gemini (illustration, hasRefs=${hasRefs})`);
      return geminiGenerate(req);

    // Cover art — text-to-image
    case 'cover':
      console.log('[ImageProviders] → Gemini (cover, text-to-image)');
      return geminiGenerate({ ...req, aspectRatio: '16:9' }); // covers look better in landscape

    // Portrait — text-to-image
    case 'portrait':
      console.log('[ImageProviders] → Gemini (portrait, text-to-image)');
      return geminiGenerate({ ...req, aspectRatio: '3:4' }); // portraits = tall crop

    // Unknown task — fail loudly so you catch routing bugs early
    default:
      throw Object.assign(
        new Error(`Unknown image task: "${req.task}"`),
        { code: 'UNKNOWN_TASK' }
      );
  }
}