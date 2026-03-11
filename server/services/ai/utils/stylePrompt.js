const STYLE_PREFIXES = {
  'pixar-3d':    'Pixar-style 3D CGI children\'s book illustration, soft cinematic lighting, subsurface scattering on skin, rounded features, expressive eyes, high-quality render like Disney/Pixar animated films',
  'watercolor':  'Soft traditional watercolor children\'s book illustration, gentle color bleeding, organic textures, delicate brushstrokes, dreamy quality like classic children\'s book art',
  'anime':       'Vibrant Japanese anime style children\'s book illustration, expressive large eyes, dynamic poses, clean linework, cel-shaded coloring, inspired by Studio Ghibli',
  'manga':       'Japanese manga style children\'s book illustration, expressive large eyes, clean black linework, screentone shading, manga panel aesthetic',
  '2d-vector':   'Clean modern 2D vector children\'s book illustration, flat colors, bold outlines, geometric simplification, contemporary aesthetic',
  'paper-cutout':'Textured paper collage style children\'s book illustration, visible paper grain, layered cut-paper shapes, handcrafted feel, Eric Carle inspired',
};

/**
 * Prepend a style directive to a base image prompt.
 * Skips if the prompt already contains the style keywords.
 * @param {string} basePrompt
 * @param {string} style
 */
export function buildStyleEnhancedPrompt(basePrompt, style = 'pixar-3d') {
  const prefix = STYLE_PREFIXES[style] ?? STYLE_PREFIXES['pixar-3d'];
  const lower = basePrompt.toLowerCase();
  const styleLower = style.toLowerCase();

  if (
    lower.includes(styleLower) ||
    (styleLower === 'anime' && lower.includes('manga')) ||
    (styleLower === 'manga' && lower.includes('anime'))
  ) {
    return basePrompt;
  }

  return `${prefix}.\n\n${basePrompt}`;
}
