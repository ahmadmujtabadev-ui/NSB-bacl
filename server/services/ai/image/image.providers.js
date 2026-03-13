// import { AI_CONFIG }       from '../ai.config.js';
// import { geminiGenerate }  from './gemini.provider.js';

// /**
//  * Route to Gemini image provider (Imagen 3).
//  *
//  * All image generation tasks are handled by Gemini:
//  *
//  *  1. task === 'pose-sheet'    → Gemini with reference image (multi-pose grid)
//  *  2. task === 'illustration'  → Gemini (with or without style reference)
//  *  3. task === 'cover'         → Gemini text-to-image
//  *  4. task === 'portrait'      → Gemini text-to-image
//  *  5. Fallback                 → throws clear error (no mock, no silent fail)
//  */
// export async function generateImage(req) {
//   const hasRefs = Array.isArray(req.references) && req.references.length > 0;

//   console.log(`[ImageProviders] Routing: task=${req.task} hasRefs=${hasRefs} refs=${req.references?.length || 0}`);
//   console.log(`[ImageProviders] Keys: google=${!!AI_CONFIG.keys.google}`);

//   if (!AI_CONFIG.keys.google) {
//     throw Object.assign(
//       new Error('GOOGLE_API_KEY is required — Gemini is the only configured image provider'),
//       { code: 'GEMINI_NOT_CONFIGURED' }
//     );
//   }

//   switch (req.task) {

//     // Pose sheet — pass portrait reference for multi-pose grid generation
//     case 'pose-sheet':
//       if (!hasRefs) {
//         throw Object.assign(
//           new Error('pose-sheet requires at least one reference image'),
//           { code: 'MISSING_REFERENCE' }
//         );
//       }
//       console.log('[ImageProviders] → Gemini (pose-sheet with reference)');
//       return geminiGenerate(req);

//     // Illustration — with or without style reference
//     case 'illustration':
//       console.log(`[ImageProviders] → Gemini (illustration, hasRefs=${hasRefs})`);
//       return geminiGenerate(req);

//     // Cover art — text-to-image
//     case 'cover':
//       console.log('[ImageProviders] → Gemini (cover, text-to-image)');
//       return geminiGenerate({ ...req, aspectRatio: '16:9' }); // covers look better in landscape

//     // Portrait — text-to-image
//     case 'portrait':
//       console.log('[ImageProviders] → Gemini (portrait, text-to-image)');
//       return geminiGenerate({ ...req, aspectRatio: '3:4' }); // portraits = tall crop

//     // Unknown task — fail loudly so you catch routing bugs early
//     default:
//       throw Object.assign(
//         new Error(`Unknown image task: "${req.task}"`),
//         { code: 'UNKNOWN_TASK' }
//       );
//   }
// }

// server/services/ai/image/image.providers.js
import { AI_CONFIG }      from '../ai.config.js';
import { geminiGenerate } from './gemini.provider.js';
import { v2 as cloudinary } from 'cloudinary';

// ─── Configure Cloudinary ─────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// ─── Upload Helper ────────────────────────────────────────────────────────────

/**
 * Takes the raw result from geminiGenerate.
 * If imageUrl is a base64 data URI or raw base64 string → uploads to Cloudinary.
 * If imageUrl is already an https:// URL → returns as-is.
 */
async function uploadIfNeeded(geminiResult, { projectId, traceId, task }) {
  const { imageUrl, provider } = geminiResult;

  if (!imageUrl) {
    throw Object.assign(
      new Error('Gemini returned no image data'),
      { code: 'GEMINI_NO_IMAGE' }
    );
  }

  // Already a real URL — no upload needed
  if (imageUrl.startsWith('https://') || imageUrl.startsWith('http://')) {
    console.log(`[ImageProviders] Image already a URL, skipping Cloudinary upload`);
    return { imageUrl, provider };
  }

  // Extract base64 payload — handles both:
  //   "data:image/png;base64,<payload>"
  //   raw base64 string
  const base64 = imageUrl.includes(',')
    ? imageUrl.split(',')[1]
    : imageUrl;

  const folder   = `noorstudio/projects/${projectId || 'general'}/${task}`;
  const publicId = traceId || `img-${Date.now()}`;

  console.log(`[ImageProviders] Uploading to Cloudinary: ${folder}/${publicId}`);

  try {
    const dataUri = `data:image/png;base64,${base64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      folder,
      public_id:     publicId,
      resource_type: 'image',
      overwrite:     true,
    });

    console.log(`[ImageProviders] ✓ Cloudinary upload OK: ${result.secure_url} (${result.bytes} bytes)`);

    return {
      imageUrl: result.secure_url,
      provider,
      cloudinaryPublicId: result.public_id,
    };

  } catch (err) {
    console.error(`[ImageProviders] ✗ Cloudinary upload failed:`, err.message);
    throw Object.assign(
      new Error(`Cloudinary upload failed: ${err.message}`),
      { code: 'CLOUDINARY_UPLOAD_FAILED' }
    );
  }
}

// ─── Main Router ──────────────────────────────────────────────────────────────

/**
 * Route to Gemini image provider (Imagen 3) then upload result to Cloudinary.
 *
 *  1. task === 'pose-sheet'    → Gemini with reference image (multi-pose grid)
 *  2. task === 'illustration'  → Gemini (with or without style reference)
 *  3. task === 'cover'         → Gemini text-to-image (portrait 2:3)
 *  4. task === 'back-cover'    → Gemini text-to-image (portrait 2:3)
 *  5. task === 'portrait'      → Gemini text-to-image (3:4)
 *  6. Fallback                 → throws clear error (no mock, no silent fail)
 */
export async function generateImage(req) {
  const hasRefs = Array.isArray(req.references) && req.references.length > 0;

  console.log(`[ImageProviders] Routing: task=${req.task} hasRefs=${hasRefs} refs=${req.references?.length || 0}`);
  console.log(`[ImageProviders] Keys: google=${!!AI_CONFIG.keys.google}`);
  console.log(`[ImageProviders] Cloudinary: cloud=${process.env.CLOUDINARY_CLOUD_NAME || 'NOT SET'}`);

  if (!AI_CONFIG.keys.google) {
    throw Object.assign(
      new Error('GOOGLE_API_KEY is required — Gemini is the only configured image provider'),
      { code: 'GEMINI_NOT_CONFIGURED' }
    );
  }

  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw Object.assign(
      new Error('Cloudinary env vars missing: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET'),
      { code: 'CLOUDINARY_NOT_CONFIGURED' }
    );
  }

  const uploadMeta = {
    projectId: req.projectId,
    traceId:   req.traceId,
    task:      req.task,
  };

  let geminiResult;

  switch (req.task) {

    case 'pose-sheet':
      if (!hasRefs) {
        throw Object.assign(
          new Error('pose-sheet requires at least one reference image'),
          { code: 'MISSING_REFERENCE' }
        );
      }
      console.log('[ImageProviders] → Gemini (pose-sheet with reference)');
      geminiResult = await geminiGenerate(req);
      break;

    case 'illustration':
      console.log(`[ImageProviders] → Gemini (illustration, hasRefs=${hasRefs})`);
      geminiResult = await geminiGenerate(req);
      break;

    case 'cover':
      console.log('[ImageProviders] → Gemini (cover)');
      geminiResult = await geminiGenerate({ ...req, aspectRatio: '2:3' });
      break;

    case 'back-cover':
      console.log('[ImageProviders] → Gemini (back-cover)');
      geminiResult = await geminiGenerate({ ...req, aspectRatio: '2:3' });
      break;

    case 'portrait':
      console.log('[ImageProviders] → Gemini (portrait)');
      geminiResult = await geminiGenerate({ ...req, aspectRatio: '3:4' });
      break;

    default:
      throw Object.assign(
        new Error(`Unknown image task: "${req.task}"`),
        { code: 'UNKNOWN_TASK' }
      );
  }

  // Upload raw binary / base64 to Cloudinary — returns permanent URL
  return uploadIfNeeded(geminiResult, uploadMeta);
}