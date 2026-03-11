import Replicate from "replicate";
import { AI_CONFIG, getServerBaseUrl } from "../ai.config.js";
import { buildStyleEnhancedPrompt } from "../utils/stylePrompt.js";
import { AIProviderError } from "../../../errors.js";

const FLUX_T2I = "black-forest-labs/flux-1.1-pro";
const FLUX_PULID =
  "zsxkib/flux-pulid:8baa7ef2255075b46f4d91cd238c21d31181b3e6e64d1e3c7f8e4b4f2c5f0d77";

// ── Client ────────────────────────────────────────────────────────────────────
let _client = null;

function getClient() {
  const token = AI_CONFIG?.keys?.replicate;
  if (!token) {
    throw new AIProviderError("REPLICATE_API_TOKEN not configured", "replicate");
  }
  if (!_client) _client = new Replicate({ auth: token });
  return _client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toAbsoluteUrl(url) {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  // protocol-relative //cdn...
  if (url.startsWith("//")) return `https:${url}`;

  const base = getServerBaseUrl()?.replace(/\/+$/, "") || "";
  if (!base) return url;

  // ensure leading slash
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${base}${path}`;
}

function isRetryableStatus(status) {
  // retry only transient: 408/429/5xx
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function extractHttpStatus(err) {
  // replicate sdk errors differ by version; handle common shapes
  return (
    err?.status ||
    err?.response?.status ||
    err?.cause?.status ||
    err?.cause?.response?.status
  );
}

function extractProviderDetail(err) {
  // try to get the JSON body/message for debugging
  const detail =
    err?.response?.data ||
    err?.cause?.response?.data ||
    err?.details ||
    err?.body ||
    null;

  if (!detail) return null;

  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

async function parseReplicateOutput(output) {
  // common outputs:
  // - string URL
  // - [url]
  // - FileOutput-like object with .url()
  // - object with { url: "..." } or { output: ... }
  if (typeof output === "string") return output;

  if (Array.isArray(output) && output.length > 0) return String(output[0]);

  if (output && typeof output.url === "function") {
    return String(await output.url());
  }

  if (output && typeof output.url === "string") return output.url;

  if (output && output.output) {
    // sometimes nested
    return parseReplicateOutput(output.output);
  }

  // last resort
  return output ? String(output) : undefined;
}

function safePrompt(prompt) {
  const p = String(prompt || "").trim();
  if (!p) throw new AIProviderError("Prompt is required for image generation", "replicate");
  return p;
}

function resolveAspectRatio(task) {
  // FLUX expects aspect_ratio like "1:1", "4:3", "2:3", etc.
  if (task === "cover") return "2:3";
  if (task === "portrait") return "2:3";
  return "4:3";
}

function resolveFormat(fmt) {
  // Replicate validation accepts: webp | jpg | png
  const f = String(fmt || "jpg").toLowerCase();
  if (f === "jpeg") return "jpg";
  if (f === "jpg" || f === "png" || f === "webp") return f;
  return "jpg";
}

function throwProviderError(prefix, err, provider = "replicate") {
  const status = extractHttpStatus(err);
  const detail = extractProviderDetail(err);

  const msgParts = [prefix, err?.message].filter(Boolean);
  if (detail) msgParts.push(detail);

  const msg = msgParts.join(" | ");

  // Preserve upstream status if meaningful
  if (status) throw new AIProviderError(msg, provider, status);

  throw new AIProviderError(msg, provider);
}

// ─────────────────────────────────────────────────────────────────────────────
// Text-to-image — FLUX 1.1 Pro
// Used for: anchor illustrations (Ch1), covers, portraits
// ─────────────────────────────────────────────────────────────────────────────
export async function replicateTextToImage(req, attempt = 0) {
  const client = getClient();
  const task = req?.task || "illustration";
  const aspectRatio = task === "cover" || task === "portrait" ? "2:3" : "4:3";

  const prompt = String(req?.prompt || "").trim();
  if (!prompt) throw new AIProviderError("Prompt is required", "replicate", 400);

  const styledPrompt = buildStyleEnhancedPrompt(prompt, req?.style || "pixar-3d");

  const input = {
    prompt: styledPrompt,
    aspect_ratio: aspectRatio,
    output_format: "jpg", // ✅ FORCE VALID VALUE
    output_quality: 90,
    safety_tolerance: 2,
    prompt_upsampling: true,
    ...(req?.seed ? { seed: req.seed } : {}),
  };

  console.log("NEW REPLICATE PROVIDER LOADED v3");
  console.log("[Replicate T2I] INPUT:", {
    output_format: input.output_format,
    aspect_ratio: input.aspect_ratio,
  });

  try {
    const output = await client.run(FLUX_T2I, { input });
    const imageUrl = await parseReplicateOutput(output);

    if (!imageUrl || imageUrl === "undefined") {
      throw new AIProviderError("Replicate returned no image URL", "replicate", 502);
    }

    return { imageUrl, provider: "replicate", providerMeta: { model: FLUX_T2I, aspectRatio } };
  } catch (err) {
    const status = extractHttpStatus(err) || 502;
    const detail = extractProviderDetail(err);
    const msg = `Replicate T2I failed (${status}): ${err?.message}${detail ? ` | ${detail}` : ""}`;
    throw new AIProviderError(msg, "replicate", status);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// img2img — FLUX PuLID (character consistency)
// Used for: Ch2+ illustrations with Ch1 identity reference
// ─────────────────────────────────────────────────────────────────────────────
export async function replicateGenerate(req, attempt = 0) {
  const client = getClient();

  const task = req?.task || "illustration";
  const isCover = task === "cover";

  const width = Number.isFinite(req?.width) ? req.width : 1024;
  const height = Number.isFinite(req?.height) ? req.height : isCover ? 1536 : 768;

  const prompt = safePrompt(req?.prompt);
  const styledPrompt = buildStyleEnhancedPrompt(prompt, req?.style || "pixar-3d");

  // this must be a public URL
  const faceRef = toAbsoluteUrl(req?.references?.[0]);

  if (!faceRef) {
    throw new AIProviderError("PuLID requires a main_face_image reference", "replicate", 400);
  }

  const negPrompt = isCover
    ? "text, words, letters, numbers, watermark, blurry, distorted, low quality, deformed"
    : "different face, changed appearance, wrong skin tone, text, watermark, blurry, distorted, deformed";

  const input = {
    prompt: styledPrompt,
    negative_prompt: negPrompt,
    main_face_image: faceRef, // <— IMPORTANT
    width,
    height,
    // PuLID schema supports these:
    num_outputs: Number.isFinite(req?.count) ? req.count : 1,
    guidance_scale: isCover ? 8 : 4, // schema default is 4
    num_steps: isCover ? 20 : 20,    // schema max is 20
    start_step: 0,                   // 0–4 recommended for fidelity
    id_weight: Number.isFinite(req?.referenceStrength) ? req.referenceStrength : 1,

    output_format: "jpg",
    output_quality: 90,

    ...(req?.seed ? { seed: req.seed } : {}),
  };

  console.log(`[Replicate PuLID] INPUT:`, {
    hasRef: !!input.main_face_image,
    output_format: input.output_format,
    width: input.width,
    height: input.height,
    id_weight: input.id_weight,
  });

  try {
    const output = await client.run(FLUX_PULID, { input });
    const imageUrl = await parseReplicateOutput(output);

    if (!imageUrl || imageUrl === "undefined") {
      throw new AIProviderError("Replicate PuLID returned no image URL", "replicate", 502);
    }

    return {
      imageUrl,
      provider: "replicate",
      providerMeta: { model: FLUX_PULID, size: `${width}x${height}` },
    };
  } catch (err) {
    const status = err?.statusCode || err?.status || 500;
    res.status(status).json({
      success: false,
      error: {
        code: err?.code || "INTERNAL_ERROR",
        message: err?.message || "Unknown error",
        provider: err?.provider || "unknown",
        status,
      },
    });
  }
}