import { AI_CONFIG } from '../ai.config.js';

export function getProviderStatus() {
  return {
    textProvider:         AI_CONFIG.textProvider,
    imageProvider:        AI_CONFIG.keys.replicate ? 'replicate' : 'mock',
    claudeConfigured:     !!AI_CONFIG.keys.claude,
    bflConfigured:        false,  // BFL removed — geo-blocked in some regions
    replicateConfigured:  !!AI_CONFIG.keys.replicate,
    geminiConfigured:     !!AI_CONFIG.keys.google,
    nanobananaConfigured: !!AI_CONFIG.keys.nanobanana,
    openaiDisabled:       true,
    routing: {
      'pose-sheet':               'gemini',
      'illustration (no refs)':   'replicate flux-1.1-pro (text-to-image)',
      'illustration (with refs)': 'replicate flux-pulid (img2img, identity lock)',
      'cover':                    'replicate flux-1.1-pro (text-to-image)',
      'portrait':                 'replicate flux-1.1-pro (text-to-image)',
    },
  };
}
