// server/lib/renderPageHtml.js
// Converts a saved editor page (fabricJson) into a self-contained HTML string
// that Puppeteer renders pixel-for-pixel to match the Fabric.js canvas.
//
// Canvas logical size : PAGE_W=750 × PAGE_H=1000
// PDF page size       : 432pt × 576pt  (6" × 8")
// Font sizing         : fabricFontSize / 7.5  → vw  (750px = 100vw)
// Letter-spacing      : fabricCharSpacing / 1000 → em
// Origin fix          : Fabric stores left/top at the object's originX/Y anchor
//                       (commonly 'center'); we subtract half the rendered size
//                       to get the true CSS top-left corner.

const PAGE_W = 750;
const PAGE_H = 1000;

// ─── Google Fonts ─────────────────────────────────────────────────────────────

const FONTS_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700;1,400;1,700&family=Merriweather:ital,wght@0,400;0,700;1,400;1,700&family=Cinzel:wght@400;700&family=Nunito:ital,wght@0,400;0,700;1,400;1,700&family=Fredoka+One&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=Raleway:ital,wght@0,400;0,700;1,400;1,700&family=Amiri:ital,wght@0,400;0,700;1,400;1,700&family=Cairo:wght@400;700&family=Oswald:wght@400;700&family=Montserrat:ital,wght@0,400;0,700;1,400;1,700&family=Dancing+Script:wght@400;700&family=Pacifico&family=Baloo+2:wght@400;700&display=swap" rel="stylesheet">`;

// ─── PDF Templates ────────────────────────────────────────────────────────────

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
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(ellipse at center, transparent 60%, rgba(139,105,20,0.04) 100%);
        z-index: 9999;
      }
      .page div { font-family: Merriweather, Georgia, serif; }
      [data-role="chapter-header"] { color: #8b6914 !important; }
      [data-role="page-num"]        { color: #8b6914 !important; }
    `,
  },

  modern: {
    name: 'Modern',
    pageBackground: '#ffffff',
    fontFamily: 'Lato, "Helvetica Neue", sans-serif',
    textColor: '#1a1a1a',
    accentColor: '#2563eb',
    css: `
      .page {
        background-color: #ffffff;
        border-right:  1px solid #e5e7eb;
        border-bottom: 1px solid #e5e7eb;
      }
      .page div { font-family: Lato, "Helvetica Neue", sans-serif; }
      [data-role="chapter-header"] {
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }
    `,
  },

  editorial: {
    name: 'Editorial',
    pageBackground: '#fafaf8',
    fontFamily: '"Playfair Display", Georgia, serif',
    textColor: '#0f0f0f',
    accentColor: '#c9a84c',
    css: `
      .page {
        background-color: #fafaf8;
        border-top: 3px solid #c9a84c;
        box-shadow: 0 2px 16px rgba(0,0,0,0.12);
      }
      .page div { font-family: 'Playfair Display', Georgia, serif; }
      [data-role="body-text"],
      [data-role="body-text-right"] { line-height: 1.75 !important; }
      [data-role="chapter-header"],
      [data-role="page-num"]        { color: #c9a84c !important; }
    `,
  },

  // ── Template: Split Panel ─────────────────────────────────────────────────
  // renderStrategy: 'sidebyside'
  // Text pages  → LEFT column (teal panel) contains text, RIGHT column has image
  // Scene/moment → image fills right 60%, teal panel on left
  // Opener/cover → full-bleed illustration
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
    css: `
      .page { background-color: #ffffff; }
      .page::after {
        content: '';
        position: absolute;
        left: 40%; top: 0; bottom: 0;
        width: 2px;
        background: linear-gradient(180deg,
          transparent 0%, rgba(212,167,44,0.5) 20%,
          rgba(212,167,44,0.5) 80%, transparent 100%);
        pointer-events: none;
      }
    `,
  },

  // ── Template: Storybook ───────────────────────────────────────────────────
  // renderStrategy: 'stacked'
  // Text pages  → TOP half is illustration, BOTTOM half is the text content
  // Scene/moment → full-bleed illustration (dramatic end-of-chapter spread)
  // Opener/cover → full-bleed illustration
  storyheader: {
    name: 'Storybook',
    renderStrategy: 'stacked',
    pageBackground: '#fdf6ee',
    fontFamily: '"Nunito", "Helvetica Neue", sans-serif',
    textColor: '#2d1a0e',
    accentColor: '#c94f1e',
    headerColor: '#c94f1e',
    headerColorLight: '#e07b54',
    css: `
      .page { background-color: #fdf6ee; }
      /* bottom warm glow */
      .page::after {
        content: '';
        position: absolute;
        left: 0; right: 0; bottom: 0;
        height: 6px;
        background: linear-gradient(0deg, rgba(201,79,30,0.2) 0%, transparent 100%);
        pointer-events: none;
      }
    `,
  },
};

// ─── Low-level helpers ────────────────────────────────────────────────────────

/** Converts a canvas-space value to a CSS percentage string. */
function pct(val, base) {
  return ((val / base) * 100).toFixed(6) + '%';
}

/** HTML-escapes a string for safe injection. */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Fabric stores left/top at the object's ORIGIN POINT (often 'center').
 * Adjust to get the CSS top-left corner of the element's bounding box.
 */
function originAdjust(left, top, renderedW, renderedH, originX = 'left', originY = 'top') {
  let cssLeft = left;
  let cssTop  = top;
  if      (originX === 'center') cssLeft -= renderedW / 2;
  else if (originX === 'right')  cssLeft -= renderedW;
  if      (originY === 'center') cssTop  -= renderedH / 2;
  else if (originY === 'bottom') cssTop  -= renderedH;
  return { cssLeft, cssTop };
}

/**
 * Build a CSS transform string.
 * When `scaleAlreadyBaked` is true (images), we skip scale() because it is
 * already incorporated into the computed width/height.
 */
function buildTransform(obj, scaleAlreadyBaked = false) {
  const parts = [];
  if (obj.angle) parts.push(`rotate(${obj.angle}deg)`);
  if (!scaleAlreadyBaked && ((obj.scaleX ?? 1) !== 1 || (obj.scaleY ?? 1) !== 1)) {
    parts.push(`scale(${obj.scaleX ?? 1}, ${obj.scaleY ?? 1})`);
  }
  return parts.join(' ');
}

/**
 * Convert a Fabric clipPath rect to a CSS `clip-path: inset(...)` value.
 *
 * The clip rect must have `absolutePositioned: true` so its coordinates are
 * already in canvas space (no parent transform to undo).
 *
 * Inset values are expressed as percentages of the *element's* rendered size,
 * which is what CSS `clip-path: inset()` expects.
 *
 * @param {object} obj       — the image/shape Fabric object
 * @param {number} cssLeft   — element's canvas-space CSS left (origin-adjusted)
 * @param {number} cssTop    — element's canvas-space CSS top  (origin-adjusted)
 * @param {number} renderedW — element's rendered width  (width  × scaleX)
 * @param {number} renderedH — element's rendered height (height × scaleY)
 * @returns {string|null}    — CSS clip-path rule, or null if not applicable
 */
function buildClipStyle(obj, cssLeft, cssTop, renderedW, renderedH) {
  const cp = obj.clipPath;
  if (!cp || cp.type !== 'rect' || !cp.absolutePositioned) return null;
  if (!renderedW || !renderedH) return null;

  // Clip rect rendered dimensions
  const cpW = (cp.width  ?? 0) * (cp.scaleX ?? 1);
  const cpH = (cp.height ?? 0) * (cp.scaleY ?? 1);

  // Clip rect CSS top-left (also origin-adjusted)
  const { cssLeft: cpLeft, cssTop: cpTop } = originAdjust(
    cp.left ?? 0, cp.top ?? 0,
    cpW, cpH,
    cp.originX ?? 'left',
    cp.originY ?? 'top',
  );

  // Insets in canvas pixels (distance from each element edge to the clip boundary)
  const insetTop    = Math.max(0, cpTop  - cssTop);
  const insetLeft   = Math.max(0, cpLeft - cssLeft);
  const insetBottom = Math.max(0, (cssTop  + renderedH) - (cpTop  + cpH));
  const insetRight  = Math.max(0, (cssLeft + renderedW) - (cpLeft + cpW));

  // Convert to percentages relative to the element's own dimensions
  const tPct = ((insetTop    / renderedH) * 100).toFixed(4) + '%';
  const rPct = ((insetRight  / renderedW) * 100).toFixed(4) + '%';
  const bPct = ((insetBottom / renderedH) * 100).toFixed(4) + '%';
  const lPct = ((insetLeft   / renderedW) * 100).toFixed(4) + '%';

  return `clip-path:inset(${tPct} ${rPct} ${bPct} ${lPct})`;
}

// ─── Page-type helper ─────────────────────────────────────────────────────────

/**
 * Extracts the semantic page type from a page id.
 * Returns one of: 'cover-front' | 'cover-back' | 'opener' | 'text' |
 *                 'scene' | 'moment' | 'unknown'
 */
function getPageType(pageId = '') {
  if (pageId === 'cover-front') return 'cover-front';
  if (pageId === 'cover-back')  return 'cover-back';
  const m = pageId.match(/^chapter-\d+-([a-z]+)/i);
  return m ? m[1].toLowerCase() : 'unknown';
}

/**
 * Returns true if, for this template, an image that would normally be
 * full-bleed should instead render as a right-panel inline illustration.
 *
 * Currently active for:
 *   templateId === 'storyheader'  AND  pageType is 'scene' or 'moment'
 *
 * This lets scene/moment illustrations sit beside the coral header + cream
 * background rather than covering the entire page.
 */
function shouldRenderInline(templateId, pageType) {
  return templateId === 'storyheader' && (pageType === 'scene' || pageType === 'moment');
}

/**
 * Renders an image as a right-panel inline illustration (storyheader style).
 * Image occupies the right 62% of the page body, vertically centred below
 * the 80px coral header band (top: ~10%, height: ~84%).
 * A soft rounded corner and drop shadow give it a "placed illustration" feel.
 */
function renderInlineImage(src, opacity = 1) {
  const s = [
    'position:absolute',
    'right:3%',
    'top:10%',
    'width:62%',
    'height:84%',
    'object-fit:cover',
    'border-radius:8px',
    `opacity:${opacity}`,
    'box-shadow:0 8px 32px rgba(0,0,0,0.22)',
    'overflow:hidden',
  ];
  return `<img src="${esc(src)}" crossorigin="anonymous" style="${s.join(';')}" alt="" loading="eager">`;
}

// ─── Per-type renderers ───────────────────────────────────────────────────────

/** Renders a textbox or i-text object. */
function renderText(obj) {
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
    'box-sizing:border-box',
    `opacity:${obj.opacity ?? 1}`,
    'transform-origin:top left',
  ];

  const transform = buildTransform(obj, true); // scale baked into width
  if (transform) styles.push(`transform:${transform}`);

  // Font
  styles.push(`font-family:${obj.fontFamily || 'serif'}`);
  styles.push(`font-size:${((obj.fontSize ?? 16) / 7.5).toFixed(6)}vw`);
  styles.push(`font-weight:${obj.fontWeight || 'normal'}`);
  styles.push(`font-style:${obj.fontStyle || 'normal'}`);
  styles.push(`color:${obj.fill || '#000000'}`);
  styles.push(`text-align:${obj.textAlign || 'left'}`);
  styles.push(`line-height:${obj.lineHeight ?? 1.4}`);
  styles.push(`letter-spacing:${obj.charSpacing != null ? ((obj.charSpacing / 1000).toFixed(6) + 'em') : '0em'}`);

  // Shadow
  if (obj.shadow && typeof obj.shadow === 'string') {
    styles.push(`text-shadow:${obj.shadow}`);
  } else if (obj.shadow?.color) {
    const s = obj.shadow;
    styles.push(`text-shadow:${s.offsetX ?? 0}px ${s.offsetY ?? 0}px ${s.blur ?? 0}px ${s.color}`);
  }

  // Background + padding
  styles.push(`background-color:${obj.backgroundColor || 'transparent'}`);
  if (obj.padding != null) styles.push(`padding:${obj.padding}px`);

  // Wrap
  styles.push('white-space:pre-wrap');
  styles.push('word-break:break-word');
  styles.push('overflow:hidden');

  const content = esc(obj.text || '').replace(/\n/g, '<br>');
  const role    = esc(obj._role || '');

  return `<div data-role="${role}" style="${styles.join(';')}">${content}</div>`;
}

/**
 * Renders an image object.
 *
 * @param {object} obj
 * @param {string} templateId  — active PDF template key
 * @param {string} pageType    — semantic page type from getPageType()
 */
function renderImage(obj, templateId = 'classic', pageType = 'unknown') {
  if (!obj.src) return '';

  const scaleX    = obj.scaleX ?? 1;
  const scaleY    = obj.scaleY ?? 1;
  const renderedW = (obj.width  ?? PAGE_W) * scaleX;
  const renderedH = (obj.height ?? PAGE_H) * scaleY;

  // Clipped images must be treated as positioned (not full-bleed) so the
  // CSS clip-path is computed relative to the correct bounding box.
  const hasClip = obj.clipPath?.type === 'rect' && obj.clipPath?.absolutePositioned;

  // Would this image normally be full-bleed?
  const wouldBeFullBleed =
    !hasClip && (
      obj.__background === true ||
      (renderedW >= PAGE_W * 0.9 && renderedH >= PAGE_H * 0.9)
    );

  // Storyheader inline override: scene/moment illustrations render right-panel
  // instead of full-bleed so the coral header + cream background stay visible.
  if (wouldBeFullBleed && shouldRenderInline(templateId, pageType)) {
    return renderInlineImage(obj.src, obj.opacity ?? 1);
  }

  if (wouldBeFullBleed) {
    const s = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'object-fit:cover',
      `opacity:${obj.opacity ?? 1}`,
    ];
    if (obj.shadow && typeof obj.shadow === 'string') {
      s.push(`filter:drop-shadow(${obj.shadow})`);
    }
    return `<img src="${esc(obj.src)}" crossorigin="anonymous" style="${s.join(';')}" alt="" loading="eager">`;
  }

  // Positioned image
  const { cssLeft, cssTop } = originAdjust(
    obj.left ?? 0, obj.top ?? 0,
    renderedW, renderedH,
    obj.originX ?? 'left',
    obj.originY ?? 'top',
  );

  const s = [
    'position:absolute',
    `left:${pct(cssLeft, PAGE_W)}`,
    `top:${pct(cssTop, PAGE_H)}`,
    `width:${pct(renderedW, PAGE_W)}`,
    `height:${pct(renderedH, PAGE_H)}`,
    'object-fit:cover',
    `opacity:${obj.opacity ?? 1}`,
    'transform-origin:top left',
  ];

  const transform = buildTransform(obj, true);
  if (transform) s.push(`transform:${transform}`);

  if (obj.shadow && typeof obj.shadow === 'string') {
    s.push(`filter:drop-shadow(${obj.shadow})`);
  }

  // Clip path
  const clip = buildClipStyle(obj, cssLeft, cssTop, renderedW, renderedH);
  if (clip) {
    s.push(clip);
    s.push('overflow:hidden');
  }

  return `<img src="${esc(obj.src)}" crossorigin="anonymous" style="${s.join(';')}" alt="" loading="eager">`;
}

/** Renders a rect shape. */
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

  const s = [
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

  if (obj.strokeWidth && obj.stroke) s.push(`border:${obj.strokeWidth}px solid ${obj.stroke}`);
  if (obj.rx) s.push(`border-radius:${pct(obj.rx, PAGE_W)}`);

  const transform = buildTransform(obj, true);
  if (transform) s.push(`transform:${transform}`);

  return `<div style="${s.join(';')}"></div>`;
}

// ─── Layout-strategy helpers ──────────────────────────────────────────────────

/**
 * Extracts the primary image URL and the readable text from a page, regardless
 * of where Fabric.js placed those objects on the canvas.
 *
 * Image priority:
 *   fabricJson.backgroundImage  →  largest image in fabricJson.objects
 *   →  page.chapterImageUrl (injected by exportPdf route for text pages)
 *
 * Text priority:
 *   page.text  →  concatenated text-object content from fabricJson
 */
function extractPageContent(page, fabricJson) {
  const objects = Array.isArray(fabricJson.objects) ? fabricJson.objects : [];

  // ── Primary image ──────────────────────────────────────────────────────────
  let imageUrl     = null;
  let imageOpacity = 1;

  if (fabricJson.backgroundImage?.src) {
    imageUrl     = fabricJson.backgroundImage.src;
    imageOpacity = fabricJson.backgroundImage.opacity ?? 1;
  } else {
    const imgObjs = objects.filter(o => o?.type === 'image' && o.src);
    if (imgObjs.length) {
      // pick the largest (most likely to be the main illustration)
      const largest = imgObjs.reduce((best, o) => {
        const area  = (o.width  ?? 0) * (o.scaleX ?? 1) *
                      (o.height ?? 0) * (o.scaleY ?? 1);
        const bArea = (best.width ?? 0) * (best.scaleX ?? 1) *
                      (best.height ?? 0) * (best.scaleY ?? 1);
        return area > bArea ? o : best;
      });
      imageUrl     = largest.src;
      imageOpacity = largest.opacity ?? 1;
    }
  }

  // Fallback: chapter illustration injected by the export route so that text
  // pages (which have no illustration of their own) can still show the chapter
  // image in layout-strategy templates (stacked / sidebyside).
  if (!imageUrl && page.chapterImageUrl) {
    imageUrl = page.chapterImageUrl;
  }

  // ── Text content ───────────────────────────────────────────────────────────
  const text = (page.text ?? '').trim() ||
    objects
      .filter(o => (o?.type === 'textbox' || o?.type === 'i-text') && o.text)
      .map(o => o.text.trim())
      .filter(Boolean)
      .join('\n\n');

  return { imageUrl, imageOpacity, text };
}

/** Converts plain text into safe HTML paragraphs */
function textToHtml(raw) {
  return raw
    .split(/\n{2,}/)                            // paragraph breaks
    .map(para =>
      `<p style="margin:0 0 14px 0;">${
        para.split('\n').map(esc).join('<br>')
      }</p>`
    )
    .join('');
}

/**
 * STACKED layout (used by storyheader template)
 *
 * - Full-bleed illustration pages (opener / scene / moment / cover):
 *     full-bleed image, no text column
 * - Text pages that have an associated illustration:
 *     coral header band (top 8%), image fills next 47%, text fills rest
 * - Text pages with no image:
 *     coral header band + full scrollable text
 */
function renderStackedLayout(page, fabricJson, template) {
  const bgColor  = fabricJson.background || template.pageBackground || '#fdf6ee';
  const pageType = getPageType(page.id ?? '');
  const { imageUrl, imageOpacity, text } = extractPageContent(page, fabricJson);

  const isIllustrationPage =
    pageType === 'opener' || pageType === 'scene' || pageType === 'moment' ||
    pageType === 'cover-front' || pageType === 'cover-back';

  // ── Illustration pages: full-bleed ────────────────────────────────────────
  if (isIllustrationPage) {
    const img = imageUrl
      ? `<img src="${esc(imageUrl)}" crossorigin="anonymous"
             style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${imageOpacity};"
             alt="" loading="eager">`
      : `<div style="position:absolute;inset:0;background:${placeholderBg(page.id)};"></div>`;
    return htmlShell(template, bgColor, img);
  }

  // ── Text pages ────────────────────────────────────────────────────────────
  // Coral header band (always shown on text pages)
  const headerHtml = `
    <div style="position:absolute;left:0;top:0;right:0;height:80px;
                background:linear-gradient(135deg,${template.headerColor} 0%,${template.headerColorLight} 100%);
                display:flex;align-items:center;padding:0 28px;">
      <span style="font-family:${template.fontFamily};font-size:3.2vw;font-weight:700;
                   color:#fff;letter-spacing:0.04em;opacity:0.95;">
        ${esc(page.subTitle || page.label || '')}
      </span>
    </div>`;

  if (imageUrl && text) {
    // Image top (below header), text bottom
    const body = `
      ${headerHtml}
      <img src="${esc(imageUrl)}" crossorigin="anonymous"
           style="position:absolute;left:0;top:80px;right:0;height:46%;object-fit:cover;opacity:${imageOpacity};"
           alt="" loading="eager">
      <div style="position:absolute;left:0;right:0;bottom:0;top:calc(80px + 46%);
                  padding:20px 30px 22px;overflow:hidden;background:${bgColor};">
        <div data-role="body-text"
             style="font-family:${template.fontFamily};font-size:2.35vw;
                    line-height:1.75;color:${template.textColor};
                    white-space:pre-wrap;word-break:break-word;">
          ${textToHtml(text)}
        </div>
      </div>`;
    return htmlShell(template, bgColor, body);
  }

  if (imageUrl) {
    // Only image (no saved text yet) — image below header, rest cream
    const body = `
      ${headerHtml}
      <img src="${esc(imageUrl)}" crossorigin="anonymous"
           style="position:absolute;left:0;top:80px;right:0;bottom:0;object-fit:cover;opacity:${imageOpacity};"
           alt="" loading="eager">`;
    return htmlShell(template, bgColor, body);
  }

  // Text only — full page text with header
  const body = `
    ${headerHtml}
    <div style="position:absolute;left:0;right:0;top:80px;bottom:0;
                padding:28px 38px 28px;overflow:hidden;background:${bgColor};">
      <div data-role="body-text"
           style="font-family:${template.fontFamily};font-size:2.5vw;
                  line-height:1.8;color:${template.textColor};
                  white-space:pre-wrap;word-break:break-word;">
        ${textToHtml(text || '')}
      </div>
    </div>`;
  return htmlShell(template, bgColor, body);
}

/**
 * SIDE-BY-SIDE layout (used by splitpanel template)
 *
 * - Opener / cover pages: full-bleed illustration
 * - Scene / moment pages:
 *     teal left panel (40%) + image right (60%)
 * - Text pages with image:
 *     teal left panel (40%) with text + image right (60%)
 * - Text pages without image:
 *     teal left panel (40%) + cream right with text
 */
function renderSideBySideLayout(page, fabricJson, template) {
  const bgColor  = fabricJson.background || template.pageBackground || '#ffffff';
  const pageType = getPageType(page.id ?? '');
  const { imageUrl, imageOpacity, text } = extractPageContent(page, fabricJson);

  const isFullBleedPage =
    pageType === 'opener' || pageType === 'cover-front' || pageType === 'cover-back';

  // ── Opener / cover: full-bleed ────────────────────────────────────────────
  if (isFullBleedPage) {
    const img = imageUrl
      ? `<img src="${esc(imageUrl)}" crossorigin="anonymous"
             style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${imageOpacity};"
             alt="" loading="eager">`
      : `<div style="position:absolute;inset:0;background:#111;"></div>`;
    return htmlShell(template, bgColor, img);
  }

  // Left teal panel (shared by all non-opener pages)
  const panelHtml = `
    <div style="position:absolute;left:0;top:0;bottom:0;width:40%;
                background:linear-gradient(180deg,${template.panelColor} 0%,${template.panelColorDark} 100%);">
    </div>`;

  const dividerHtml = `
    <div style="position:absolute;left:40%;top:0;bottom:0;width:2px;
                background:linear-gradient(180deg,transparent,rgba(212,167,44,0.5) 20%,
                rgba(212,167,44,0.5) 80%,transparent);"></div>`;

  // ── Scene / moment: teal left + image right ───────────────────────────────
  if (pageType === 'scene' || pageType === 'moment') {
    const img = imageUrl
      ? `<img src="${esc(imageUrl)}" crossorigin="anonymous"
             style="position:absolute;left:41%;top:0;right:0;bottom:0;
                    object-fit:cover;opacity:${imageOpacity};"
             alt="" loading="eager">`
      : '';
    // Chapter label on left panel
    const labelHtml = `
      <div style="position:absolute;left:0;top:0;width:40%;
                  display:flex;flex-direction:column;align-items:center;
                  justify-content:center;height:100%;padding:30px 20px;text-align:center;">
        <span style="font-family:${template.fontFamily};font-size:2.2vw;font-weight:700;
                     color:rgba(255,255,255,0.9);letter-spacing:0.06em;text-transform:uppercase;">
          ${esc(page.subTitle || page.label || '')}
        </span>
      </div>`;
    return htmlShell(template, bgColor, panelHtml + dividerHtml + labelHtml + img);
  }

  // ── Text pages ────────────────────────────────────────────────────────────
  const chapterLabel = `
    <div style="position:absolute;left:0;top:0;width:40%;height:70px;
                display:flex;align-items:center;justify-content:center;padding:0 16px;
                border-bottom:1px solid rgba(255,255,255,0.1);">
      <span style="font-family:${template.fontFamily};font-size:1.9vw;font-weight:700;
                   color:rgba(255,255,255,0.8);text-align:center;letter-spacing:0.04em;">
        ${esc(page.subTitle || page.label || '')}
      </span>
    </div>`;

  const textColHtml = text
    ? `<div style="position:absolute;left:0;top:70px;width:40%;bottom:0;
                   padding:20px 18px 20px;overflow:hidden;">
         <div data-role="body-text"
              style="font-family:${template.fontFamily};font-size:2.1vw;
                     line-height:1.8;color:rgba(255,255,255,0.88);
                     white-space:pre-wrap;word-break:break-word;">
           ${textToHtml(text)}
         </div>
       </div>`
    : '';

  const imgColHtml = imageUrl
    ? `<img src="${esc(imageUrl)}" crossorigin="anonymous"
           style="position:absolute;left:41%;top:0;right:0;bottom:0;
                  object-fit:cover;opacity:${imageOpacity};"
           alt="" loading="eager">`
    : `<div style="position:absolute;left:41%;top:0;right:0;bottom:0;background:#f5f5f5;"></div>`;

  return htmlShell(template, bgColor,
    panelHtml + dividerHtml + chapterLabel + textColHtml + imgColHtml);
}

// ─── Empty-page fallbacks ─────────────────────────────────────────────────────

/** Wraps a base HTML shell with the given page div body */
function htmlShell(template, bgColor, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${FONTS_LINK}
<style>
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:750px; height:1000px; overflow:hidden; background:transparent; }
  :root { --page-bg: ${bgColor}; }
  .page {
    position: relative;
    width: 750px;
    height: 1000px;
    overflow: hidden;
    background-color: var(--page-bg);
  }
  img { display: block; }
  ${template.css}
</style>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`;
}

/** Full-page thumbnail fallback — used when fabricJson is empty but a JPEG thumbnail exists. */
function buildThumbnailPage(thumbnail, template) {
  const body = `<img src="${thumbnail}" crossorigin="anonymous" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" alt="" loading="eager">`;
  return htmlShell(template, '#000000', body);
}

/** Coloured placeholder for pages that haven't been generated yet. */
function buildPlaceholderPage(bgColor, template) {
  return htmlShell(template, bgColor, '<!-- page not yet generated -->');
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Returns the appropriate placeholder background for a page that has no
 * fabricJson content, based on its id.
 *
 * Opener / cover / moment / scene pages → dark (#111111, matches editor)
 * Text pages → cream (#fffef7)
 */
function placeholderBg(pageId = '') {
  if (pageId === 'cover-front' || pageId === 'cover-back') return '#111111';
  const m = pageId.match(/^chapter-\d+-([a-z]+)/i);
  if (!m) return '#fffef7';
  const type = m[1].toLowerCase();
  return (type === 'opener' || type === 'moment' || type === 'scene') ? '#111111' : '#fffef7';
}

/**
 * Renders one saved editor page to a self-contained HTML string.
 *
 * Empty pages (no fabricJson objects, no background, no thumbnail):
 *   → renders a correctly-coloured placeholder so the PDF page count stays
 *     correct and the layout isn't broken.  The user must re-open the editor
 *     and generate/save those pages to fill them in.
 *
 * @param {object} page       — { id, fabricJson, thumbnail, text, title, type }
 * @param {string} templateId — 'classic' | 'modern' | 'editorial'  (default: 'classic')
 * @returns {string}          — complete HTML document
 */
export function renderPageHtml(page, templateId = 'classic') {
  const template = PDF_TEMPLATES[templateId] ?? PDF_TEMPLATES.classic;

  const raw = page.fabricJson;
  const fabricJson =
    raw == null             ? {} :
    typeof raw === 'string' ? JSON.parse(raw) :
    raw;

  const objects = Array.isArray(fabricJson.objects) ? fabricJson.objects : [];

  // Fabric.js stores a background image set via canvas.setBackgroundImage() at
  // fabricJson.backgroundImage (separate from fabricJson.objects).  We must
  // handle this so opener/scene pages whose image is the canvas background
  // don't render as empty placeholders.
  const bgImageObj = fabricJson.backgroundImage ?? null;

  // ── Empty-page detection ────────────────────────────────────────────────────
  // A page is truly empty only when it has NO objects, NO solid background
  // colour, AND no backgroundImage — AND no text/chapterImageUrl that a
  // layout-strategy template can still use to render something meaningful.
  //
  // For stacked/sidebyside templates, page.text + page.chapterImageUrl are
  // enough to render a proper page, so we skip the placeholder for those.
  const hasLayoutContent =
    (template.renderStrategy === 'stacked' || template.renderStrategy === 'sidebyside') &&
    ((page.text ?? '').trim() || page.chapterImageUrl);

  const isEmpty =
    objects.length === 0 &&
    !bgImageObj &&
    !fabricJson.background &&
    !hasLayoutContent;

  if (isEmpty) {
    if (page.thumbnail) {
      return buildThumbnailPage(page.thumbnail, template);
    }
    const pbg = placeholderBg(page.id);
    return buildPlaceholderPage(pbg, template);
  }

  // ── Layout-strategy dispatch ──────────────────────────────────────────────
  // Templates can declare renderStrategy: 'stacked' or 'sidebyside' to use a
  // fixed re-layout that ignores Fabric.js object positions and instead extracts
  // the primary image + text from page data to render them in a fixed template.
  // Templates without renderStrategy (or 'fabric') use the faithful Fabric renderer.
  if (template.renderStrategy === 'stacked') {
    return renderStackedLayout(page, fabricJson, template);
  }
  if (template.renderStrategy === 'sidebyside') {
    return renderSideBySideLayout(page, fabricJson, template);
  }

  // ── Fabric layout (classic / modern / editorial) ──────────────────────────
  // Semantic page type — used by template-specific render overrides
  const pageType = getPageType(page.id ?? '');

  // Fabricjson background colour takes priority; fall back to template default
  const bgColor = fabricJson.background || template.pageBackground || '#fffef7';

  const parts = [];

  // ── backgroundImage (full-bleed canvas background) ─────────────────────────
  // Rendered first so it sits behind all objects (z-order: bottom layer).
  // For the storyheader template on scene/moment pages, override to inline
  // so the coral header + cream background remain visible.
  if (bgImageObj && bgImageObj.src) {
    const biScaleX    = bgImageObj.scaleX ?? 1;
    const biScaleY    = bgImageObj.scaleY ?? 1;
    const biRenderedW = (bgImageObj.width  ?? PAGE_W) * biScaleX;
    const biRenderedH = (bgImageObj.height ?? PAGE_H) * biScaleY;
    const isFullBg    = biRenderedW >= PAGE_W * 0.9 && biRenderedH >= PAGE_H * 0.9;

    if (isFullBg && shouldRenderInline(templateId, pageType)) {
      // Storyheader inline: right-panel instead of full-bleed
      parts.push(renderInlineImage(bgImageObj.src, bgImageObj.opacity ?? 1));
    } else if (isFullBg) {
      parts.push(
        `<img src="${esc(bgImageObj.src)}" crossorigin="anonymous" ` +
        `style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${bgImageObj.opacity ?? 1};" ` +
        `alt="" loading="eager">`
      );
    } else {
      // Positioned background image (not full-bleed — render at stored coords)
      const { cssLeft, cssTop } = originAdjust(
        bgImageObj.left ?? 0, bgImageObj.top ?? 0,
        biRenderedW, biRenderedH,
        bgImageObj.originX ?? 'left', bgImageObj.originY ?? 'top',
      );
      parts.push(
        `<img src="${esc(bgImageObj.src)}" crossorigin="anonymous" ` +
        `style="position:absolute;left:${pct(cssLeft, PAGE_W)};top:${pct(cssTop, PAGE_H)};` +
        `width:${pct(biRenderedW, PAGE_W)};height:${pct(biRenderedH, PAGE_H)};object-fit:cover;opacity:${bgImageObj.opacity ?? 1};" ` +
        `alt="" loading="eager">`
      );
    }
  }

  // Render __background objects first (z-order: below regular objects)
  const sorted = [
    ...objects.filter(o => o?.__background),
    ...objects.filter(o => !o?.__background),
  ];

  for (const obj of sorted) {
    if (!obj) continue;

    // ── Skip rules ─────────────────────────────────────────────────────────
    if (obj.type === 'line' && obj._role === 'divider') continue;        // decorative dash
    if (obj.__background === true && obj.type === 'rect') continue;      // bg rect → use CSS

    // ── Dispatch ───────────────────────────────────────────────────────────
    if (obj.type === 'textbox' || obj.type === 'i-text') {
      parts.push(renderText(obj));
    } else if (obj.type === 'image') {
      // Pass templateId + pageType so renderImage can apply template overrides
      parts.push(renderImage(obj, templateId, pageType));
    } else if (obj.type === 'rect') {
      parts.push(renderRect(obj));
    }
    // path / polygon / circle → decorative; not critical for text fidelity
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${FONTS_LINK}
<style>
  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:750px; height:1000px; overflow:hidden; background:transparent; }
  /* Base page — fabricJson background colour as CSS variable so templates can override */
  :root { --page-bg: ${bgColor}; }
  .page {
    position: relative;
    width: 750px;
    height: 1000px;
    overflow: hidden;
    background-color: var(--page-bg);
  }
  img { display: block; }

  /* ── Template: ${template.name} ──────────────────────────────────────── */
  ${template.css}
</style>
</head>
<body>
<div class="page">
${parts.join('\n')}
</div>
</body>
</html>`;
}
