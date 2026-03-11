import { config } from '../../config.js';

export const AI_CONFIG = {
  textProvider:  config.ai.textProvider,
  imageProvider: config.ai.imageProvider,
  maxRetries:    config.ai.maxRetries,
  timeoutMs:     config.ai.timeoutMs,

  keys: config.ai.keys,
  nanobanana: config.ai.nanobanana,
  railway: config.ai.railway,
};

/** Derive the absolute base URL for internal asset references (e.g. Replicate needs full URLs). */
export function getServerBaseUrl() {
  if (AI_CONFIG.railway.publicDomain) return `https://${AI_CONFIG.railway.publicDomain}`;
  if (AI_CONFIG.railway.publicUrl)    return AI_CONFIG.railway.publicUrl;
  return 'http://localhost:5000';
}
