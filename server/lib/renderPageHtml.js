// server/lib/renderPageHtml.js
// Converts a saved editor page (with fabricJson) into a self-contained HTML
// string that Puppeteer renders pixel-for-pixel to match the Fabric.js canvas.
//
// KEY FIX: Fabric.js stores object.left / object.top as the position of the
// object's ORIGIN POINT (not its top-left corner).  By default images and
// groups use originX:'center', originY:'center', so we must subtract half
// the rendered size to get the true CSS top-left.
//
// Canvas logical size: PAGE_W=750, PAGE_H=1000
// fontSize → vw:    fabricFontSize / 7.5 vw   (750px canvas = 100vw)
// letterSpacing → em: fabricCharSpacing / 1000 em
// lineHeight → unitless multiplier (pass through)

const PAGE_W = 750;
const PAGE_H = 1000;

// All Google Fonts used by the editor
const FONTS_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Merriweather:ital,wght@0,400;0,700;1,400;1,700&family=Cinzel:wght@400;700&family=Nunito:ital,wght@0,400;0,700;1,400;1,700&family=Fredoka+One&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Raleway:ital,wght@0,400;0,700;1,400;1,700&family=Amiri:ital,wght@0,400;0,700;1,400;1,700&family=Cairo:wght@400;700&family=Oswald:wght@400;700&family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Dancing+Script:wght@400;700&family=Pacifico&family=Baloo+2:wght@400;700&display=swap" rel="stylesheet">`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(val, base) {
  return ((val / base) * 100).toFixed(6) + '%';
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Fabric.js stores left/top as the position of the object's ORIGIN POINT.
 * Adjust to get the CSS top-left corner of the element's bounding box.
 *
 * originX: 'left'(default) | 'center' | 'right'
 * originY: 'top'(default)  | 'center' | 'bottom'
 *
 * renderedW/H = natural size × scale (already in logical px).
 */
function originAdjust(left, top, renderedW, renderedH, originX, originY) {
  let cssLeft = left;
  let cssTop  = top;

  if      (originX === 'center') cssLeft -= renderedW / 2;
  else if (originX === 'right')  cssLeft -= renderedW;

  if      (originY === 'center') cssTop  -= renderedH / 2;
  else if (originY === 'bottom') cssTop  -= renderedH;

  return { cssLeft, cssTop };
}

/** Build the CSS transform string from angle / scaleX / scaleY. */
function buildTransform(obj, extraScaleApplied = false) {
  const parts = [];
  if (obj.angle) parts.push(`rotate(${obj.angle}deg)`);
  // When scaleX/scaleY are already baked into width/height (images) we skip them here.
  // For text we apply them.
  if (!extraScaleApplied && ((obj.scaleX ?? 1) !== 1 || (obj.scaleY ?? 1) !== 1)) {
    parts.push(`scale(${obj.scaleX ?? 1}, ${obj.scaleY ?? 1})`);
  }
  return parts.join(' ');
}

// ─── Text objects (textbox / i-text) ─────────────────────────────────────────

function renderText(obj) {
  // For textboxes, width is the explicit container width (at scaleX=1).
  // scaleX/scaleY scale the whole box, so adjust rendered width/height.
  const scaleX = obj.scaleX ?? 1;
  const scaleY = obj.scaleY ?? 1;
  const renderedW = (obj.width  ?? 0) * scaleX;
  // Height is auto for text — we can't know it without rendering, so use 0
  // for origin adjustment (most textboxes are originY:'top').
  const renderedH = (obj.height ?? 0) * scaleY;

  const { cssLeft, cssTop } = originAdjust(
    obj.left ?? 0, obj.top ?? 0,
    renderedW, renderedH,
    obj.originX ?? 'left',
    obj.originY ?? 'top',
  );

  const styles = [
    'position:absolute',
    `left:${pct(cssLeft, PAGE_W)}`,
    `top:${pct(cssTop, PAGE_H)}`,
    `width:${pct(renderedW, PAGE_W)}`,
    'box-sizing:border-box',
    `opacity:${obj.opacity ?? 1}`,
    'transform-origin:top left',
  ];

  const transform = buildTransform(obj, true); // scale already in width
  if (transform) styles.push(`transform:${transform}`);

  // Font
  const fsSizeVw = ((obj.fontSize ?? 16) / 7.5).toFixed(6) + 'vw';
  styles.push(`font-family:${obj.fontFamily || 'serif'}`);
  styles.push(`font-size:${fsSizeVw}`);
  styles.push(`font-weight:${obj.fontWeight || 'normal'}`);
  styles.push(`font-style:${obj.fontStyle || 'normal'}`);
  styles.push(`color:${obj.fill || '#000000'}`);
  styles.push(`text-align:${obj.textAlign || 'left'}`);
  styles.push(`line-height:${obj.lineHeight ?? 1.4}`);

  const ls = obj.charSpacing != null ? ((obj.charSpacing / 1000).toFixed(6) + 'em') : '0em';
  styles.push(`letter-spacing:${ls}`);

  // Shadow
  if (obj.shadow && typeof obj.shadow === 'string') {
    styles.push(`text-shadow:${obj.shadow}`);
  } else if (obj.shadow && typeof obj.shadow === 'object' && obj.shadow.color) {
    const s = obj.shadow;
    styles.push(`text-shadow:${s.offsetX ?? 0}px ${s.offsetY ?? 0}px ${s.blur ?? 0}px ${s.color}`);
  }

  // Background and padding
  styles.push(`background-color:${obj.backgroundColor || 'transparent'}`);
  if (obj.padding != null) styles.push(`padding:${obj.padding}px`);

  // Text wrapping
  styles.push('white-space:pre-wrap');
  styles.push('word-break:break-word');
  styles.push('overflow:hidden');

  const content = esc(obj.text || '').replace(/\n/g, '<br>');
  return `<div style="${styles.join(';')}">${content}</div>`;
}

// ─── Image objects ────────────────────────────────────────────────────────────

function renderImage(obj) {
  if (!obj.src) return '';

  const scaleX    = obj.scaleX ?? 1;
  const scaleY    = obj.scaleY ?? 1;
  const renderedW = (obj.width  ?? PAGE_W) * scaleX;
  const renderedH = (obj.height ?? PAGE_H) * scaleY;

  // Full-bleed background images — __background flag OR image fills the canvas
  const isFullBleed =
    obj.__background === true ||
    (renderedW >= PAGE_W * 0.9 && renderedH >= PAGE_H * 0.9);

  if (isFullBleed) {
    const imgStyles = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'object-fit:cover',
      `opacity:${obj.opacity ?? 1}`,
    ];
    if (obj.shadow && typeof obj.shadow === 'string') {
      imgStyles.push(`filter:drop-shadow(${obj.shadow})`);
    }
    return `<img src="${esc(obj.src)}" style="${imgStyles.join(';')}" alt="" loading="eager">`;
  }

  // Positioned image — apply origin adjustment
  const { cssLeft, cssTop } = originAdjust(
    obj.left ?? 0, obj.top ?? 0,
    renderedW, renderedH,
    obj.originX ?? 'left',
    obj.originY ?? 'top',
  );

  const imgStyles = [
    'position:absolute',
    `left:${pct(cssLeft, PAGE_W)}`,
    `top:${pct(cssTop, PAGE_H)}`,
    `width:${pct(renderedW, PAGE_W)}`,
    `height:${pct(renderedH, PAGE_H)}`,
    'object-fit:cover',
    `opacity:${obj.opacity ?? 1}`,
    'transform-origin:top left',
  ];

  const transform = buildTransform(obj, true); // scale baked into w/h
  if (transform) imgStyles.push(`transform:${transform}`);

  if (obj.shadow && typeof obj.shadow === 'string') {
    imgStyles.push(`filter:drop-shadow(${obj.shadow})`);
  }

  return `<img src="${esc(obj.src)}" style="${imgStyles.join(';')}" alt="" loading="eager">`;
}

// ─── Rect shapes ──────────────────────────────────────────────────────────────

function renderRect(obj) {
  const scaleX    = obj.scaleX ?? 1;
  const scaleY    = obj.scaleY ?? 1;
  const renderedW = (obj.width  ?? 0) * scaleX;
  const renderedH = (obj.height ?? 0) * scaleY;

  const { cssLeft, cssTop } = originAdjust(
    obj.left ?? 0, obj.top ?? 0,
    renderedW, renderedH,
    obj.originX ?? 'left',
    obj.originY ?? 'top',
  );

  const styles = [
    'position:absolute',
    `left:${pct(cssLeft, PAGE_W)}`,
    `top:${pct(cssTop, PAGE_H)}`,
    `width:${pct(renderedW, PAGE_W)}`,
    `height:${pct(renderedH, PAGE_H)}`,
    `background-color:${obj.fill || 'transparent'}`,
    `opacity:${obj.opacity ?? 1}`,
    'box-sizing:border-box',
    'transform-origin:top left',
  ];

  if (obj.strokeWidth && obj.stroke) {
    styles.push(`border:${obj.strokeWidth}px solid ${obj.stroke}`);
  }
  if (obj.rx) {
    styles.push(`border-radius:${pct(obj.rx, PAGE_W)}`);
  }

  const transform = buildTransform(obj, true);
  if (transform) styles.push(`transform:${transform}`);

  return `<div style="${styles.join(';')}"></div>`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Renders a single saved editor page to a self-contained HTML string.
 *
 * @param {object} page  — { id, fabricJson, thumbnail, text, title, type, layoutType }
 * @returns {string}     — full HTML document
 */
export function renderPageHtml(page) {
  const raw = page.fabricJson;
  const fabricJson =
    raw == null             ? {} :
    typeof raw === 'string' ? JSON.parse(raw) :
    raw;

  const objects = Array.isArray(fabricJson.objects) ? fabricJson.objects : [];
  const bgColor = fabricJson.background || '#fffef7';

  const parts = [];

  // Sort: __background objects first (z-order: behind everything else)
  const sorted = [
    ...objects.filter(o => o?.__background),
    ...objects.filter(o => !o?.__background),
  ];

  for (const obj of sorted) {
    if (!obj) continue;

    // ── Skip rules ─────────────────────────────────────────────────────────
    // Decorative dash dividers (thin lines, not meaningful in PDF)
    if (obj.type === 'line' && obj._role === 'divider') continue;
    // Background rect fills — the page container already has the bg color
    if (obj.__background === true && obj.type === 'rect') continue;

    // ── Render by type ─────────────────────────────────────────────────────
    if (obj.type === 'textbox' || obj.type === 'i-text') {
      parts.push(renderText(obj));
    } else if (obj.type === 'image') {
      parts.push(renderImage(obj));
    } else if (obj.type === 'rect') {
      parts.push(renderRect(obj));
    }
    // path / polygon / circle / line — decorative; skip for fidelity reasons
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${FONTS_LINK}
<style>
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  html, body {
    width:750px;
    height:1000px;
    overflow:hidden;
    background:transparent;
  }
  .page {
    position:relative;
    width:750px;
    height:1000px;
    overflow:hidden;
    background-color:${bgColor};
  }
  img { display:block; }
</style>
</head>
<body>
<div class="page">
${parts.join('\n')}
</div>
</body>
</html>`;
}
