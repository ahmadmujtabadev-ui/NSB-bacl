// server/lib/renderPageHtml.js
// Converts a saved editor page (fabricJson) into self-contained HTML for Puppeteer.
//
// Canvas: 750×1000px  |  PDF: 432pt×576pt (6"×8")
//
// ──────────────────────────────────────────────────────────────────────────────
// CRITICAL FIX — Unrendered page fallback (issue: blank pages in downloaded PDF)
// ──────────────────────────────────────────────────────────────────────────────
// When the user downloads the PDF without visiting every page in the editor,
// pages they never opened have fabricJson == null in the database.
//
// Previously these pages rendered as:
//   - a thumbnail (rarely present for unvisited pages), OR
//   - page.imageUrl as full-bleed, OR
//   - a blank coloured square
//
// For text pages, text chapters, and chapter openers this produced EMPTY
// LOOKING PDF PAGES because:
//   - text pages have no imageUrl of their own
//   - chapter openers DO have imageUrl but show no text
//
// NEW BEHAVIOUR:
//   - Chapter/scene/moment/opener pages with imageUrl → full-bleed image +
//     text overlay at bottom (same as editor's default full-bleed layout).
//   - Chapter text pages without imageUrl → clean text-only layout using
//     the template's fontFamily/colours, matching the editor's text-page
//     default.
//   - Cover pages always render their imageUrl full-bleed with title overlay.
// ──────────────────────────────────────────────────────────────────────────────

const PAGE_W = 750;
const PAGE_H = 1000;
const PDF_CSS_W = 576;  // default: Apple Books / portrait
const PDF_CSS_H = 768;

// Per-platform CSS canvas sizes (must match puppeteerPdf.js PLATFORM_PDF_CONFIGS viewports)
const PLATFORM_CSS_DIMS = {
  kdp:    { cssW: 840, cssH: 840 },
  apple:  { cssW: 576, cssH: 768 },
  ingram: { cssW: 840, cssH: 840 },
};

const FONT_COMBO_WATERMARKS = new Set();

const FONTS_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Merriweather:ital,wght@0,400;0,700;1,400;1,700&family=Cinzel:wght@400;700&family=Nunito:ital,wght@0,400;0,700;1,400;1,700&family=Fredoka+One&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Raleway:ital,wght@0,400;0,700;1,400;1,700&family=Amiri:ital,wght@0,400;0,700;1,400;1,700&family=Cairo:wght@400;700&family=Oswald:wght@400;700&family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Dancing+Script:wght@400;700&family=Pacifico&family=Baloo+2:wght@400;700&display=swap" rel="stylesheet">`;

export const PDF_TEMPLATES = {
  classic: {
    name: 'Classic',
    pageBackground: '#fffef7',
    fontFamily: 'Merriweather, Georgia, serif',
    textColor: '#2c1e0f',
    accentColor: '#8b6914',
    css: `
      .page { background-color: #fffef7; }
      .page::after {
        content:''; position:absolute; inset:0; pointer-events:none;
        background:radial-gradient(ellipse at center,transparent 60%,rgba(139,105,20,0.04) 100%);
        z-index:9999;
      }
    `,
  },
  modern: {
    name: 'Modern',
    pageBackground: '#ffffff',
    fontFamily: 'Lato, "Helvetica Neue", sans-serif',
    textColor: '#1a1a1a',
    accentColor: '#2563eb',
    css: `.page { background-color:#ffffff; border-right:1px solid #e5e7eb; border-bottom:1px solid #e5e7eb; }`,
  },
  editorial: {
    name: 'Editorial',
    pageBackground: '#fafaf8',
    fontFamily: '"Playfair Display", Georgia, serif',
    textColor: '#0f0f0f',
    accentColor: '#c9a84c',
    css: `
      .page { background-color:#fafaf8; border-top:3px solid #c9a84c; box-shadow:0 2px 16px rgba(0,0,0,0.12); }
      [data-role="chapter-header"],[data-role="page-num"] { color:#c9a84c !important; }
    `,
  },
  splitpanel: {
    name: 'Split Panel',
    renderStrategy: 'sidebyside',
    pageBackground: '#ffffff',
    fontFamily: 'Lato, "Helvetica Neue", sans-serif',
    textColor: '#ffffff',
    textColorDark: '#0f2b26',
    accentColor: '#0d7a6e',
    panelColor: '#0d7a6e',
    panelColorDark: '#085249',
    css: `.page { background-color:#ffffff; }`,
  },
  storyheader: {
    name: 'Storybook',
    renderStrategy: 'stacked',
    pageBackground: '#fdf6ee',
    fontFamily: '"Nunito", "Helvetica Neue", sans-serif',
    textColor: '#2d1a0e',
    accentColor: '#c94f1e',
    headerColor: '#c94f1e',
    headerColorLight: '#e07b54',
    css: `.page { background-color:#fdf6ee; }`,
  },
};

// ─── Helpers (unchanged) ──────────────────────────────────────────────────────

function pct(val, base) { return ((val / base) * 100).toFixed(6) + '%'; }

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function originAdjust(left, top, renderedW, renderedH, originX, originY) {
  const ox = originX || 'left';
  const oy = originY || 'top';
  let cssLeft = left ?? 0;
  let cssTop  = top  ?? 0;
  if      (ox === 'center') cssLeft -= renderedW / 2;
  else if (ox === 'right')  cssLeft -= renderedW;
  if      (oy === 'center') cssTop  -= renderedH / 2;
  else if (oy === 'bottom') cssTop  -= renderedH;
  return { cssLeft, cssTop };
}

function buildTransformCss(obj) {
  const parts = [];
  if (obj.angle) parts.push(`rotate(${obj.angle}deg)`);
  return parts.length ? `transform:${parts.join(' ')};transform-origin:top left;` : '';
}

function applyOpacityToColor(colorStr, opacity) {
  if (!opacity || opacity === 1 || !colorStr || colorStr === 'transparent') return colorStr;
  const op = Math.max(0, Math.min(1, opacity));
  const rgba = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgba) {
    const a = rgba[4] !== undefined ? parseFloat(rgba[4]) : 1;
    return `rgba(${rgba[1]},${rgba[2]},${rgba[3]},${(a * op).toFixed(4)})`;
  }
  const hex = colorStr.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length === 6) {
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${op.toFixed(4)})`;
    }
  }
  return colorStr;
}

function buildClipStyle(obj, cssLeft, cssTop, renderedW, renderedH) {
  const cp = obj.clipPath;
  if (!cp || cp.type !== 'rect' || !cp.absolutePositioned || !renderedW || !renderedH) return null;
  const cpW = (cp.width ?? 0) * (cp.scaleX ?? 1);
  const cpH = (cp.height ?? 0) * (cp.scaleY ?? 1);
  const { cssLeft: cpLeft, cssTop: cpTop } = originAdjust(cp.left ?? 0, cp.top ?? 0, cpW, cpH, cp.originX, cp.originY);
  const t = Math.max(0, cpTop - cssTop);
  const l = Math.max(0, cpLeft - cssLeft);
  const b = Math.max(0, (cssTop + renderedH) - (cpTop + cpH));
  const r = Math.max(0, (cssLeft + renderedW) - (cpLeft + cpW));
  return `clip-path:inset(${((t / renderedH) * 100).toFixed(4)}% ${((r / renderedW) * 100).toFixed(4)}% ${((b / renderedH) * 100).toFixed(4)}% ${((l / renderedW) * 100).toFixed(4)}%)`;
}

function extractFontFamilies(objects) {
  const fonts = new Set();
  for (const obj of objects) {
    if ((obj?.type === 'textbox' || obj?.type === 'i-text') && obj.fontFamily) fonts.add(obj.fontFamily);
    if (Array.isArray(obj?.styles)) {
      for (const s of obj.styles) { if (s?.style?.fontFamily) fonts.add(s.style.fontFamily); }
    }
  }
  return [...fonts];
}

function applyFabricStyles(text, stylesArr) {
  if (!stylesArr || stylesArr.length === 0) return null;
  const len = text.length;
  const charStyle = new Array(len).fill(null);
  for (const range of stylesArr) {
    const s = range.start ?? 0;
    const e = Math.min(range.end ?? len, len);
    for (let i = s; i < e; i++) charStyle[i] = range.style || null;
  }
  const segments = [];
  let i = 0;
  while (i < len) {
    const style = charStyle[i];
    const key = JSON.stringify(style);
    let j = i + 1;
    while (j < len && JSON.stringify(charStyle[j]) === key) j++;
    segments.push({ text: text.slice(i, j), style });
    i = j;
  }
  return segments.map(({ text: seg, style }) => {
    const safe = esc(seg).replace(/\n/g, '<br>');
    if (!style) return safe;
    const css = [];
    if (style.fontFamily)          css.push(`font-family:${style.fontFamily}`);
    if (style.fontSize)            css.push(`font-size:${(style.fontSize / 7.5).toFixed(4)}vw`);
    if (style.fontWeight)          css.push(`font-weight:${style.fontWeight}`);
    if (style.fontStyle)           css.push(`font-style:${style.fontStyle}`);
    if (style.fill)                css.push(`color:${style.fill}`);
    if (style.underline)           css.push('text-decoration:underline');
    if (style.linethrough)         css.push('text-decoration:line-through');
    if (style.charSpacing != null) css.push(`letter-spacing:${(style.charSpacing / 1000).toFixed(4)}em`);
    if (style.textBackgroundColor) css.push(`background-color:${style.textBackgroundColor}`);
    return css.length ? `<span style="${css.join(';')}">${safe}</span>` : safe;
  }).join('');
}

// ─── Object renderers (unchanged from working version) ────────────────────────

function renderText(obj) {
  const rawText = (obj.text ?? '').trim();
  if (FONT_COMBO_WATERMARKS.size > 0 && FONT_COMBO_WATERMARKS.has(rawText)) return '';
  const scaleX    = obj.scaleX ?? 1;
  const scaleY    = obj.scaleY ?? 1;
  const rawW      = obj.width  ?? 0;
  const estW      = rawW > 0 ? rawW : (rawText.length) * (obj.fontSize ?? 16) * 0.6;
  const renderedW = estW * scaleX;
  const renderedH = (obj.height ?? 0) * scaleY;
  const { cssLeft, cssTop } = originAdjust(obj.left ?? 0, obj.top ?? 0, renderedW, renderedH, obj.originX, obj.originY);
  const opacity   = obj.opacity ?? 1;
  const textColor = applyOpacityToColor(obj.fill || '#000000', opacity);
  let shadowCss = '';
  if (obj.shadow?.color) {
    const s = obj.shadow;
    shadowCss = `text-shadow:${s.offsetX ?? 0}px ${s.offsetY ?? 0}px ${s.blur ?? 0}px ${s.color};`;
  } else if (typeof obj.shadow === 'string' && obj.shadow) {
    shadowCss = `text-shadow:${obj.shadow};`;
  }
  const lsEm = obj.charSpacing != null ? (obj.charSpacing / 1000).toFixed(4) + 'em' : '0em';
  const pos   = `left:${pct(cssLeft, PAGE_W)};top:${pct(cssTop, PAGE_H)};width:${pct(renderedW, PAGE_W)};`;
  const tf    = buildTransformCss(obj);
  let bgHtml = '';
  const hasBg = obj.backgroundColor &&
    obj.backgroundColor !== 'transparent' &&
    obj.backgroundColor !== '' &&
    obj.backgroundColor !== 'rgba(0,0,0,0)';
  if (hasBg) {
    const bgH = renderedH > 0 ? renderedH : (obj.fontSize ?? 16) * (obj.lineHeight ?? 1.5) * 2;
    bgHtml = `<div style="position:absolute;${pos}height:${pct(bgH, PAGE_H)};background-color:${obj.backgroundColor};opacity:${opacity};border-radius:3px;pointer-events:none;box-sizing:border-box;${obj.padding != null ? `padding:${obj.padding}px;` : ''}${tf}"></div>`;
  }
  const styledContent = applyFabricStyles(obj.text || '', obj.styles);
  const innerContent  = styledContent !== null
    ? styledContent
    : esc(obj.text || '').replace(/\n/g, '<br>');
  const textCss = [
    `position:absolute`,
    pos,
    `box-sizing:border-box`,
    `background-color:transparent`,
    `font-family:${obj.fontFamily || 'serif'}`,
    `font-size:${((obj.fontSize ?? 16) / 7.5).toFixed(4)}vw`,
    `font-weight:${obj.fontWeight || 'normal'}`,
    `font-style:${obj.fontStyle || 'normal'}`,
    `color:${textColor}`,
    `text-align:${obj.textAlign || 'left'}`,
    `line-height:${obj.lineHeight ?? 1.4}`,
    `letter-spacing:${lsEm}`,
    `word-spacing:${lsEm}`,
    `white-space:pre-wrap`,
    `word-break:break-word`,
    `overflow:hidden`,
    obj.padding != null ? `padding:${obj.padding}px` : '',
    shadowCss.replace(/;$/, ''),
    tf.replace(/;$/, ''),
  ].filter(Boolean).join(';');
  return bgHtml + `<div data-role="${esc(obj._role || '')}" style="${textCss}">${innerContent}</div>`;
}

function renderImage(obj) {
  if (!obj?.src) return '';
  const scaleX  = obj.scaleX ?? 1;
  const scaleY  = obj.scaleY ?? 1;
  const sourceW = obj.width  ?? PAGE_W;
  const sourceH = obj.height ?? PAGE_H;
  const cropX   = obj.cropX  ?? 0;
  const cropY   = obj.cropY  ?? 0;
  const visibleW = sourceW * scaleX;
  const visibleH = sourceH * scaleY;
  const hasClip   = obj.clipPath?.type === 'rect' && obj.clipPath?.absolutePositioned;
  const fullBleed =
    !hasClip &&
    (obj.__background === true || (visibleW >= PAGE_W * 0.9 && visibleH >= PAGE_H * 0.9));
  if (fullBleed && cropX === 0 && cropY === 0) {
    return `<img src="${esc(obj.src)}" crossorigin="anonymous" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center center;opacity:${obj.opacity ?? 1};" alt="" loading="eager">`;
  }
  const { cssLeft, cssTop } = originAdjust(obj.left ?? 0, obj.top ?? 0, visibleW, visibleH, obj.originX, obj.originY);
  const tf = buildTransformCss(obj).replace(/;$/, '');
  if (cropX || cropY) {
    const outerStyle = [
      'position:absolute',
      `left:${pct(cssLeft, PAGE_W)}`,
      `top:${pct(cssTop, PAGE_H)}`,
      `width:${pct(visibleW, PAGE_W)}`,
      `height:${pct(visibleH, PAGE_H)}`,
      'overflow:hidden',
      `opacity:${obj.opacity ?? 1}`,
      tf,
    ].filter(Boolean).join(';');
    const innerStyle = [
      'position:absolute',
      `left:${pct(-(cropX * scaleX), PAGE_W)}`,
      `top:${pct(-(cropY * scaleY), PAGE_H)}`,
      `width:${pct((sourceW + cropX) * scaleX, PAGE_W)}`,
      `height:${pct((sourceH + cropY) * scaleY, PAGE_H)}`,
      'max-width:none',
      'max-height:none',
    ].join(';');
    return `<div style="${outerStyle}"><img src="${esc(obj.src)}" crossorigin="anonymous" style="${innerStyle}" alt="" loading="eager"></div>`;
  }
  const s = [
    'position:absolute',
    `left:${pct(cssLeft, PAGE_W)}`,
    `top:${pct(cssTop, PAGE_H)}`,
    `width:${pct(visibleW, PAGE_W)}`,
    `height:${pct(visibleH, PAGE_H)}`,
    'object-fit:fill',
    `opacity:${obj.opacity ?? 1}`,
    tf,
  ];
  const clip = buildClipStyle(obj, cssLeft, cssTop, visibleW, visibleH);
  if (clip) { s.push(clip); s.push('overflow:hidden'); }
  return `<img src="${esc(obj.src)}" crossorigin="anonymous" style="${s.join(';')}" alt="" loading="eager">`;
}

function renderRect(obj) {
  const scaleX    = obj.scaleX ?? 1, scaleY = obj.scaleY ?? 1;
  const renderedW = (obj.width  ?? 0) * scaleX;
  const renderedH = (obj.height ?? 0) * scaleY;
  const { cssLeft, cssTop } = originAdjust(obj.left ?? 0, obj.top ?? 0, renderedW, renderedH, obj.originX, obj.originY);
  const s = [
    'position:absolute',
    `left:${pct(cssLeft, PAGE_W)}`, `top:${pct(cssTop, PAGE_H)}`,
    `width:${pct(renderedW, PAGE_W)}`, `height:${pct(renderedH, PAGE_H)}`,
    `background-color:${obj.fill || 'transparent'}`, `opacity:${obj.opacity ?? 1}`,
    'box-sizing:border-box',
  ];
  if (obj.strokeWidth && obj.stroke) s.push(`border:${obj.strokeWidth}px solid ${obj.stroke}`);
  if (obj.rx) s.push(`border-radius:${pct(obj.rx, PAGE_W)}`);
  const tf = buildTransformCss(obj); if (tf) s.push(tf.replace(/;$/, ''));
  return `<div style="${s.join(';')}"></div>`;
}

function renderCircle(obj) {
  const scaleX    = obj.scaleX ?? 1, scaleY = obj.scaleY ?? 1;
  const radius    = obj.radius ?? 50;
  const renderedW = radius * 2 * scaleX;
  const renderedH = radius * 2 * scaleY;
  const { cssLeft, cssTop } = originAdjust(obj.left ?? 0, obj.top ?? 0, renderedW, renderedH, obj.originX, obj.originY);
  const s = [
    'position:absolute',
    `left:${pct(cssLeft, PAGE_W)}`, `top:${pct(cssTop, PAGE_H)}`,
    `width:${pct(renderedW, PAGE_W)}`, `height:${pct(renderedH, PAGE_H)}`,
    `background-color:${obj.fill || 'transparent'}`,
    'border-radius:50%', `opacity:${obj.opacity ?? 1}`,
  ];
  if (obj.strokeWidth && obj.stroke) s.push(`border:${obj.strokeWidth}px solid ${obj.stroke}`);
  const tf = buildTransformCss(obj); if (tf) s.push(tf.replace(/;$/, ''));
  return `<div style="${s.join(';')}"></div>`;
}

function renderTriangle(obj) {
  const scaleX    = obj.scaleX ?? 1, scaleY = obj.scaleY ?? 1;
  const renderedW = (obj.width  ?? 100) * scaleX;
  const renderedH = (obj.height ?? 100) * scaleY;
  const { cssLeft, cssTop } = originAdjust(obj.left ?? 0, obj.top ?? 0, renderedW, renderedH, obj.originX, obj.originY);
  const fill   = obj.fill        || 'transparent';
  const stroke = obj.stroke      || 'none';
  const sw     = obj.strokeWidth ?? 0;
  const pts    = `${(renderedW / 2).toFixed(2)},0 ${renderedW.toFixed(2)},${renderedH.toFixed(2)} 0,${renderedH.toFixed(2)}`;
  const tf     = buildTransformCss(obj);
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:${pct(cssLeft,PAGE_W)};top:${pct(cssTop,PAGE_H)};width:${pct(renderedW,PAGE_W)};height:${pct(renderedH,PAGE_H)};opacity:${obj.opacity??1};overflow:visible;${tf}" viewBox="0 0 ${renderedW.toFixed(2)} ${renderedH.toFixed(2)}"><polygon points="${pts}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"/></svg>`;
}

function renderPolygon(obj) {
  if (!Array.isArray(obj.points) || obj.points.length < 3) return '';
  const scaleX    = obj.scaleX ?? 1, scaleY = obj.scaleY ?? 1;
  const rawW      = obj.width  ?? 100, rawH = obj.height ?? 100;
  const renderedW = rawW * scaleX, renderedH = rawH * scaleY;
  const { cssLeft, cssTop } = originAdjust(obj.left ?? 0, obj.top ?? 0, renderedW, renderedH, obj.originX, obj.originY);
  const fill   = obj.fill        || 'transparent';
  const stroke = obj.stroke      || 'none';
  const sw     = obj.strokeWidth ?? 0;
  const scaledPts = obj.points.map(p => {
    const sx = ((p.x + rawW / 2) / rawW) * renderedW;
    const sy = ((p.y + rawH / 2) / rawH) * renderedH;
    return `${sx.toFixed(3)},${sy.toFixed(3)}`;
  }).join(' ');
  const tf = buildTransformCss(obj);
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:${pct(cssLeft,PAGE_W)};top:${pct(cssTop,PAGE_H)};width:${pct(renderedW,PAGE_W)};height:${pct(renderedH,PAGE_H)};opacity:${obj.opacity??1};overflow:visible;${tf}" viewBox="0 0 ${renderedW.toFixed(2)} ${renderedH.toFixed(2)}"><polygon points="${scaledPts}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"/></svg>`;
}

function renderLine(obj) {
  if (obj._role === 'divider') return '';
  const left   = obj.left   ?? 0;
  const top    = obj.top    ?? 0;
  const x1     = obj.x1     ?? 0;
  const y1     = obj.y1     ?? 0;
  const x2     = obj.x2     ?? 0;
  const y2     = obj.y2     ?? 0;
  const scaleX = obj.scaleX ?? 1;
  const scaleY = obj.scaleY ?? 1;
  const ax1 = left + x1 * scaleX;
  const ay1 = top  + y1 * scaleY;
  const ax2 = left + x2 * scaleX;
  const ay2 = top  + y2 * scaleY;
  const stroke = obj.stroke      || '#000';
  const sw     = obj.strokeWidth ?? 1;
  const pad    = sw + 2;
  const bx  = Math.min(ax1, ax2) - pad;
  const by  = Math.min(ay1, ay2) - pad;
  const bw  = Math.abs(ax2 - ax1) + pad * 2;
  const bh  = Math.abs(ay2 - ay1) + pad * 2;
  const lx1 = ax1 - bx;
  const ly1 = ay1 - by;
  const lx2 = ax2 - bx;
  const ly2 = ay2 - by;
  const tf = buildTransformCss(obj);
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:${pct(bx,PAGE_W)};top:${pct(by,PAGE_H)};width:${pct(bw,PAGE_W)};height:${pct(Math.max(bh,sw*2),PAGE_H)};opacity:${obj.opacity??1};overflow:visible;${tf}" viewBox="0 0 ${bw.toFixed(2)} ${Math.max(bh, sw * 2).toFixed(2)}"><line x1="${lx1.toFixed(2)}" y1="${ly1.toFixed(2)}" x2="${lx2.toFixed(2)}" y2="${ly2.toFixed(2)}" stroke="${esc(stroke)}" stroke-width="${sw}" stroke-linecap="round"/></svg>`;
}

function renderPath(obj) {
  if (!Array.isArray(obj.path) || obj.path.length === 0) return '';
  const scaleX    = obj.scaleX ?? 1, scaleY = obj.scaleY ?? 1;
  const rawW      = obj.width  ?? 100, rawH = obj.height ?? 100;
  const renderedW = rawW * scaleX, renderedH = rawH * scaleY;
  const { cssLeft, cssTop } = originAdjust(obj.left ?? 0, obj.top ?? 0, renderedW, renderedH, obj.originX, obj.originY);
  const fill   = obj.fill        || 'none';
  const stroke = obj.stroke      || 'none';
  const sw     = obj.strokeWidth ?? 0;
  const d      = obj.path.map(seg => Array.isArray(seg) ? seg.join(' ') : '').join(' ');
  const vbX    = -(rawW / 2), vbY = -(rawH / 2);
  const tf     = buildTransformCss(obj);
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:${pct(cssLeft,PAGE_W)};top:${pct(cssTop,PAGE_H)};width:${pct(renderedW,PAGE_W)};height:${pct(renderedH,PAGE_H)};opacity:${obj.opacity??1};overflow:visible;${tf}" viewBox="${vbX.toFixed(2)} ${vbY.toFixed(2)} ${rawW.toFixed(2)} ${rawH.toFixed(2)}"><path d="${esc(d)}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}" stroke-linejoin="${obj.strokeLineJoin || 'miter'}" stroke-linecap="${obj.strokeLineCap || 'butt'}"/></svg>`;
}

// ─── Page type helpers ────────────────────────────────────────────────────────

function getPageType(id = '') {
  if (id === 'cover-front') return 'cover-front';
  if (id === 'cover-back')  return 'cover-back';
  const m = id.match(/^chapter-\d+-([a-z]+)/i);
  return m ? m[1].toLowerCase() : 'unknown';
}

function placeholderBg(id = '') {
  if (id === 'cover-front' || id === 'cover-back') return '#111111';
  const m = id.match(/^chapter-\d+-([a-z]+)/i);
  if (!m) return '#fffef7';
  return ['opener', 'moment', 'scene'].includes(m[1].toLowerCase()) ? '#111111' : '#fffef7';
}

// Detect a "spread-style" imagery page (full-bleed image + overlay text).
function isIllustrationPage(pageType) {
  return ['opener', 'scene', 'moment', 'spread', 'cover-front', 'cover-back'].includes(pageType);
}

function htmlShell(template, bgColor, body, fontFamilies = [], cssW = PDF_CSS_W, cssH = PDF_CSS_H) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${FONTS_LINK}
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
  html,body{width:${cssW}px;height:${cssH}px;overflow:hidden;background:transparent;margin:0;padding:0;}
  :root{--page-bg:${bgColor};}
  .page{
    position:relative;
    width:${cssW}px;height:${cssH}px;
    overflow:hidden;
    background-color:var(--page-bg);
  }
  img{display:block;image-rendering:-webkit-optimize-contrast;image-rendering:high-quality;}
  ${template.css}
</style>
</head>
<body data-fonts="${fontFamilies.join(',')}">
<div class="page">
${body}
</div>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  NEW: Default renderers for unrendered pages (no fabricJson yet)
//
//  These produce clean, on-brand layouts matching the editor's defaults so the
//  downloaded PDF includes every page — not just the ones the user clicked
//  through. Each renderer chooses a layout based on page type:
//
//    cover-front / cover-back → full-bleed image + title text
//    opener / scene / moment  → full-bleed image + caption at bottom
//    text                     → clean text page with page number
//    spread                   → full-bleed image + bottom text overlay
//    unknown                  → imageUrl full-bleed or text-only fallback
// ══════════════════════════════════════════════════════════════════════════════

function renderDefaultCover(page, template, isFront = true, cssW = PDF_CSS_W, cssH = PDF_CSS_H) {
  const imageUrl = page.imageUrl || '';
  const title    = esc(page.title || page.label || '');
  const synopsis = esc(page.text || '');

  const bg = '#111111';

  const imgHtml = imageUrl
    ? `<img src="${esc(imageUrl)}" crossorigin="anonymous" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" alt="" loading="eager">`
    : '';

  if (isFront) {
    const titleOverlay = title
      ? `<div style="position:absolute;left:6%;right:6%;top:8%;text-align:center;">
          <div style="font-family:'Fredoka One', 'Nunito', sans-serif;font-size:9vw;font-weight:700;color:#ffffff;line-height:1.1;text-shadow:2px 4px 12px rgba(0,0,0,0.85);word-break:break-word;">
            ${title}
          </div>
         </div>`
      : '';
    return htmlShell(template, bg, imgHtml + titleOverlay, [], cssW, cssH);
  }

  // Back cover: image with synopsis overlay bottom-center
  const synopsisOverlay = synopsis
    ? `<div style="position:absolute;left:8%;right:8%;bottom:10%;background:rgba(255,255,255,0.88);padding:22px;border-radius:6px;">
        <div style="font-family:'Merriweather', Georgia, serif;font-size:2.4vw;line-height:1.6;color:#1a1a1a;text-align:center;">
          ${synopsis}
        </div>
       </div>`
    : '';
  return htmlShell(template, bg, imgHtml + synopsisOverlay, [], cssW, cssH);
}

function renderDefaultIllustration(page, template, cssW = PDF_CSS_W, cssH = PDF_CSS_H) {
  const imageUrl = page.imageUrl || page.chapterImageUrl || '';
  const caption  = esc(page.text || '');

  const bg = '#111111';

  const imgHtml = imageUrl
    ? `<img src="${esc(imageUrl)}" crossorigin="anonymous" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" alt="" loading="eager">`
    : `<div style="position:absolute;inset:0;background:${placeholderBg(page.id)};"></div>`;

  const captionHtml = caption
    ? `<div style="position:absolute;left:6%;right:6%;bottom:5%;background:rgba(0,0,0,0.42);padding:14px 18px;border-radius:4px;">
        <div style="font-family:'Nunito', sans-serif;font-size:2.4vw;line-height:1.55;color:#ffffff;text-align:center;text-shadow:1px 1px 5px rgba(0,0,0,0.9);word-break:break-word;">
          ${caption}
        </div>
       </div>`
    : '';

  return htmlShell(template, bg, imgHtml + captionHtml, [], cssW, cssH);
}

function renderDefaultTextPage(page, template, cssW = PDF_CSS_W, cssH = PDF_CSS_H) {
  const bg      = template.pageBackground || '#fffef7';
  const subt    = esc(page.subTitle || '');
  const bodyTxt = (page.text || '').trim();

  const pageNum = page.pageNum ? esc(String(page.pageNum)) : '';

  const paragraphs = bodyTxt
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px 0;">${p.split('\n').map(esc).join('<br>')}</p>`)
    .join('');

  const header = subt
    ? `<div style="position:absolute;left:0;right:0;top:4%;text-align:center;">
        <div style="font-family:'Cinzel', serif;font-size:1.8vw;color:${template.accentColor || '#8b6914'};letter-spacing:0.2em;text-transform:uppercase;">
          ${subt}
        </div>
       </div>`
    : '';

  const divider = `<div style="position:absolute;left:20%;right:20%;top:9%;height:1px;background:${template.accentColor || '#c9a84c'};opacity:0.5;"></div>`;

  const body = bodyTxt
    ? `<div style="position:absolute;left:10%;right:10%;top:13%;bottom:10%;overflow:hidden;">
        <div style="font-family:${template.fontFamily};font-size:2.6vw;line-height:1.75;color:${template.textColor};text-align:left;">
          ${paragraphs}
        </div>
       </div>`
    : '';

  const footer = pageNum
    ? `<div style="position:absolute;left:0;right:0;bottom:4%;text-align:center;">
        <div style="font-family:'Merriweather', serif;font-size:1.6vw;color:${template.accentColor || '#8b6914'};">
          ${pageNum}
        </div>
       </div>`
    : '';

  return htmlShell(template, bg, header + divider + body + footer, [], cssW, cssH);
}

function renderDefaultForPageType(page, template, cssW = PDF_CSS_W, cssH = PDF_CSS_H) {
  const pt = getPageType(page.id ?? '');

  if (pt === 'cover-front') return renderDefaultCover(page, template, true, cssW, cssH);
  if (pt === 'cover-back')  return renderDefaultCover(page, template, false, cssW, cssH);

  if (isIllustrationPage(pt)) return renderDefaultIllustration(page, template, cssW, cssH);

  if (pt === 'text') return renderDefaultTextPage(page, template, cssW, cssH);

  // Unknown page type — use imageUrl if available, otherwise text
  if (page.imageUrl) return renderDefaultIllustration(page, template, cssW, cssH);
  if (page.text) return renderDefaultTextPage(page, template, cssW, cssH);

  // Truly empty — final fallback
  return htmlShell(template, template.pageBackground || '#fffef7', '', [], cssW, cssH);
}

// ─── Layout strategies (stacked / sidebyside) ─────────────────────────────────

function textToHtml(raw) {
  return (raw || '').split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px 0;">${p.split('\n').map(esc).join('<br>')}</p>`
  ).join('');
}

function extractContent(page, fabricJson) {
  const objects = Array.isArray(fabricJson.objects) ? fabricJson.objects : [];
  let imageUrl = null, imageOpacity = 1;

  if (fabricJson.backgroundImage?.src) {
    imageUrl     = fabricJson.backgroundImage.src;
    imageOpacity = fabricJson.backgroundImage.opacity ?? 1;
  } else {
    const imgs = objects.filter(o => o?.type === 'image' && o.src);
    if (imgs.length) {
      const big = imgs.reduce((a, b) =>
        (a.width ?? 0) * (a.scaleX ?? 1) * (a.height ?? 0) * (a.scaleY ?? 1) >
        (b.width ?? 0) * (b.scaleX ?? 1) * (b.height ?? 0) * (b.scaleY ?? 1) ? a : b
      );
      imageUrl     = big.src;
      imageOpacity = big.opacity ?? 1;
    }
  }

  if (!imageUrl && page.imageUrl) imageUrl = page.imageUrl;
  if (!imageUrl && page.chapterImageUrl) imageUrl = page.chapterImageUrl;

  const text = (page.text ?? '').trim() ||
    objects
      .filter(o => (o?.type === 'textbox' || o?.type === 'i-text') && o.text && o.text.trim())
      .map(o => o.text.trim())
      .filter(Boolean)
      .join('\n\n');

  return { imageUrl, imageOpacity, text };
}

function renderStackedLayout(page, fabricJson, template, cssW = PDF_CSS_W, cssH = PDF_CSS_H) {
  const bg  = fabricJson.background || template.pageBackground || '#fdf6ee';
  const pt  = getPageType(page.id ?? '');
  const { imageUrl, imageOpacity, text } = extractContent(page, fabricJson);
  const ff  = extractFontFamilies(Array.isArray(fabricJson.objects) ? fabricJson.objects : []);
  const isIll = isIllustrationPage(pt);

  if (isIll) {
    const img = imageUrl
      ? `<img src="${esc(imageUrl)}" crossorigin="anonymous" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${imageOpacity};" alt="" loading="eager">`
      : `<div style="position:absolute;inset:0;background:${placeholderBg(page.id)};"></div>`;
    const captionHtml = text
      ? `<div style="position:absolute;left:6%;right:6%;bottom:5%;background:rgba(0,0,0,0.42);padding:14px 18px;border-radius:4px;"><div style="font-family:'Nunito',sans-serif;font-size:2.4vw;line-height:1.55;color:#ffffff;text-align:center;text-shadow:1px 1px 5px rgba(0,0,0,0.9);word-break:break-word;">${textToHtml(text)}</div></div>`
      : '';
    return htmlShell(template, bg, img + captionHtml, ff, cssW, cssH);
  }

  const hdr = `<div style="position:absolute;left:0;top:0;right:0;height:80px;background:linear-gradient(135deg,${template.headerColor} 0%,${template.headerColorLight} 100%);display:flex;align-items:center;padding:0 28px;"><span style="font-family:${template.fontFamily};font-size:3.2vw;font-weight:700;color:#fff;letter-spacing:0.04em;">${esc(page.subTitle || page.label || '')}</span></div>`;

  if (imageUrl && text) {
    return htmlShell(template, bg,
      `${hdr}<img src="${esc(imageUrl)}" crossorigin="anonymous" style="position:absolute;left:0;top:80px;right:0;height:46%;object-fit:cover;opacity:${imageOpacity};" alt="" loading="eager">` +
      `<div style="position:absolute;left:0;right:0;bottom:0;top:calc(80px + 46%);padding:20px 30px;overflow:hidden;background:${bg};">` +
      `<div data-role="body-text" style="font-family:${template.fontFamily};font-size:2.35vw;line-height:1.75;color:${template.textColor};white-space:pre-wrap;word-break:break-word;">${textToHtml(text)}</div></div>`,
      ff, cssW, cssH
    );
  }

  return htmlShell(template, bg,
    `${hdr}<div style="position:absolute;left:0;right:0;top:80px;bottom:0;padding:28px 38px;overflow:hidden;background:${bg};">` +
    `<div data-role="body-text" style="font-family:${template.fontFamily};font-size:2.5vw;line-height:1.8;color:${template.textColor};white-space:pre-wrap;word-break:break-word;">${textToHtml(text || '')}</div></div>`,
    ff, cssW, cssH
  );
}

function renderSideBySideLayout(page, fabricJson, template, cssW = PDF_CSS_W, cssH = PDF_CSS_H) {
  const bg  = fabricJson.background || template.pageBackground || '#ffffff';
  const pt  = getPageType(page.id ?? '');
  const { imageUrl, imageOpacity, text } = extractContent(page, fabricJson);
  const ff  = extractFontFamilies(Array.isArray(fabricJson.objects) ? fabricJson.objects : []);

  if (['opener', 'cover-front', 'cover-back'].includes(pt)) {
    const img = imageUrl
      ? `<img src="${esc(imageUrl)}" crossorigin="anonymous" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${imageOpacity};" alt="" loading="eager">`
      : `<div style="position:absolute;inset:0;background:#111;"></div>`;
    return htmlShell(template, bg, img, ff, cssW, cssH);
  }

  const panel   = `<div style="position:absolute;left:0;top:0;bottom:0;width:40%;background:linear-gradient(180deg,${template.panelColor} 0%,${template.panelColorDark} 100%);"></div>`;
  const divider = `<div style="position:absolute;left:40%;top:0;bottom:0;width:2px;background:linear-gradient(180deg,transparent,rgba(212,167,44,0.5) 20%,rgba(212,167,44,0.5) 80%,transparent);"></div>`;
  const textCol = text
    ? `<div style="position:absolute;left:0;top:70px;width:40%;bottom:0;padding:20px 18px;overflow:hidden;"><div data-role="body-text" style="font-family:${template.fontFamily};font-size:2.1vw;line-height:1.8;color:rgba(255,255,255,0.88);white-space:pre-wrap;word-break:break-word;">${textToHtml(text)}</div></div>`
    : '';
  const imgCol  = imageUrl
    ? `<img src="${esc(imageUrl)}" crossorigin="anonymous" style="position:absolute;left:41%;top:0;right:0;bottom:0;object-fit:cover;opacity:${imageOpacity};" alt="" loading="eager">`
    : `<div style="position:absolute;left:41%;top:0;right:0;bottom:0;background:#f5f5f5;"></div>`;

  return htmlShell(template, bg, panel + divider + textCol + imgCol, ff, cssW, cssH);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function renderPageHtml(page, templateId = 'classic', platformId = 'apple') {
  const template = PDF_TEMPLATES[templateId] ?? PDF_TEMPLATES.classic;
  const { cssW, cssH } = PLATFORM_CSS_DIMS[platformId] ?? PLATFORM_CSS_DIMS.apple;

  const raw = page.fabricJson;
  const fabricJson =
    raw == null             ? {} :
    typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() :
    raw;

  const objects      = Array.isArray(fabricJson.objects) ? fabricJson.objects : [];
  const bgImageObj   = fabricJson.backgroundImage ?? null;
  const fontFamilies = extractFontFamilies(objects);

  // ── Strategy templates (stacked / sidebyside) use page.text directly,
  //    so they work even when fabricJson is empty. They're safe to use as-is.
  if (template.renderStrategy === 'stacked')    return renderStackedLayout(page, fabricJson, template, cssW, cssH);
  if (template.renderStrategy === 'sidebyside') return renderSideBySideLayout(page, fabricJson, template, cssW, cssH);

  // ──────────────────────────────────────────────────────────────────────────
  // CRITICAL FIX: when fabricJson has no content (page was never rendered in
  // editor), fall through to our on-brand default renderers instead of
  // producing a blank page. This ensures the downloaded PDF contains every
  // page in the book — even ones the user never opened.
  // ──────────────────────────────────────────────────────────────────────────
  const hasContent = objects.length > 0 || !!bgImageObj;
  if (!hasContent) {
    return renderDefaultForPageType(page, template, cssW, cssH);
  }

  // ── fabricJson present — render from it (unchanged working path) ─────────
  const bgColor = fabricJson.background || template.pageBackground || '#fffef7';
  const parts   = [];

  if (bgImageObj?.src) {
    const scaleX  = bgImageObj.scaleX ?? 1;
    const scaleY  = bgImageObj.scaleY ?? 1;
    const sourceW = bgImageObj.width  ?? PAGE_W;
    const sourceH = bgImageObj.height ?? PAGE_H;
    const cropX   = bgImageObj.cropX  ?? 0;
    const cropY   = bgImageObj.cropY  ?? 0;
    const visibleW = sourceW * scaleX;
    const visibleH = sourceH * scaleY;
    const { cssLeft, cssTop } = originAdjust(
      bgImageObj.left ?? 0, bgImageObj.top ?? 0,
      visibleW, visibleH,
      bgImageObj.originX, bgImageObj.originY
    );
    if (visibleW >= PAGE_W * 0.9 && visibleH >= PAGE_H * 0.9 && cropX === 0 && cropY === 0) {
      parts.push(`<img src="${esc(bgImageObj.src)}" crossorigin="anonymous" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center center;opacity:${bgImageObj.opacity ?? 1};" alt="" loading="eager">`);
    } else {
      parts.push(`<div style="position:absolute;left:${pct(cssLeft,PAGE_W)};top:${pct(cssTop,PAGE_H)};width:${pct(visibleW,PAGE_W)};height:${pct(visibleH,PAGE_H)};overflow:hidden;opacity:${bgImageObj.opacity ?? 1};"><img src="${esc(bgImageObj.src)}" crossorigin="anonymous" style="position:absolute;left:${pct(-(cropX*scaleX),PAGE_W)};top:${pct(-(cropY*scaleY),PAGE_H)};width:${pct((sourceW+cropX)*scaleX,PAGE_W)};height:${pct((sourceH+cropY)*scaleY,PAGE_H)};max-width:none;max-height:none;" alt="" loading="eager"></div>`);
    }
  }

  const sorted = [
    ...objects.filter(o =>  o?.__background),
    ...objects.filter(o => !o?.__background),
  ];

  for (const obj of sorted) {
    if (!obj) continue;
    if (obj.__background === true && obj.type === 'rect') continue;

    let html = '';
    switch (obj.type) {
      case 'textbox':
      case 'i-text':   html = renderText(obj);     break;
      case 'image':    html = renderImage(obj);    break;
      case 'rect':     html = renderRect(obj);     break;
      case 'circle':   html = renderCircle(obj);   break;
      case 'triangle': html = renderTriangle(obj); break;
      case 'polygon':  html = renderPolygon(obj);  break;
      case 'line':     html = renderLine(obj);     break;
      case 'path':     html = renderPath(obj);     break;
      default: break;
    }
    if (html) parts.push(html);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${FONTS_LINK}
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
  html,body{width:${cssW}px;height:${cssH}px;overflow:hidden;background:transparent;margin:0;padding:0;}
  :root{--page-bg:${bgColor};}
  .page{
    position:relative;
    width:${cssW}px;height:${cssH}px;
    overflow:hidden;
    background-color:var(--page-bg);
  }
  img{display:block;image-rendering:-webkit-optimize-contrast;image-rendering:high-quality;}
  ${template.css}
</style>
</head>
<body data-fonts="${fontFamilies.join(',')}">
<div class="page">
${parts.join('\n')}
</div>
</body>
</html>`;
}