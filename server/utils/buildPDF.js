// server/utils/buildPDF.js
//
// Page order:
//   1. Front Cover (full-bleed image)
//   2. Dedication page  (from artifacts.dedication)
//   3. Theme / Islamic Intro page  (from artifacts.themePage)
//   4–N. Story spreads — one page per spread, illustration + text overlay
//   N+1. Back Cover (full-bleed image)
//
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs      from "fs";
import path    from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

// Square 8×8 inches (576 × 576 pt) — best for picture books
const PAGE_W = 576;
const PAGE_H = 576;

// Design tokens
const CREAM    = rgb(0.995, 0.975, 0.938); // warm off-white
const GOLD     = rgb(0.86, 0.68, 0.18);    // Islamic gold
const GOLD_DRK = rgb(0.60, 0.44, 0.06);
const INK      = rgb(0.10, 0.07, 0.02);    // near-black warm
const INK_MID  = rgb(0.28, 0.22, 0.08);
const INK_LITE = rgb(0.52, 0.44, 0.26);
const WHITE    = rgb(1, 1, 1);
const BLACK    = rgb(0, 0, 0);
const TEAL     = rgb(0.12, 0.48, 0.46);    // accent — matches Pixar/Islamic palette
const TEAL_LT  = rgb(0.84, 0.95, 0.93);
const GREEN    = rgb(0.18, 0.52, 0.22);
const GREEN_LT = rgb(0.88, 0.97, 0.88);

// ═══════════════════════════════════════════════════════════
// FONT LOADER
// ═══════════════════════════════════════════════════════════

function loadFontBytes(fileName) {
  const p = path.join(__dirname, "..", "assets", "fonts", fileName);
  if (!fs.existsSync(p)) throw new Error(`Font not found: ${p}`);
  return fs.readFileSync(p);
}

// ═══════════════════════════════════════════════════════════
// SAFE STRING  — strips control characters pdf-lib can't render
// ═══════════════════════════════════════════════════════════

function S(v, fallback = "") {
  if (v == null) return fallback;
  return String(v)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
}

// ═══════════════════════════════════════════════════════════
// IMAGE HELPERS
// ═══════════════════════════════════════════════════════════

async function fetchBytes(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:")) {
    try {
      const b64 = url.slice(url.indexOf(",") + 1).replace(/[\s\r\n]/g, "");
      return new Uint8Array(Buffer.from(b64, "base64"));
    } catch { return null; }
  }
  try {
    const r = await fetch(url);
    if (!r.ok) { console.warn(`[pdf] HTTP ${r.status} for ${url.slice(0, 60)}`); return null; }
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) { console.warn(`[pdf] fetch error:`, e.message); return null; }
}

async function embedImg(doc, bytes) {
  if (!bytes || bytes.length < 4) return null;
  const u = bytes instanceof Buffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes;
  const isPng = u[0]===0x89 && u[1]===0x50 && u[2]===0x4e && u[3]===0x47;
  const isJpg = u[0]===0xff && u[1]===0xd8;
  try {
    if (isPng) return await doc.embedPng(u);
    if (isJpg) return await doc.embedJpg(u);
    try { return await doc.embedPng(u); } catch {}
    try { return await doc.embedJpg(u); } catch {}
    return null;
  } catch (e) { console.warn("[pdf] embedImg:", e.message); return null; }
}

/** Fill the entire box — cover mode (no letterboxing) */
function drawCover(page, img, x, y, bw, bh) {
  if (!img) return;
  const { width: iw, height: ih } = img.scale(1);
  const s  = Math.max(bw / iw, bh / ih);
  const dw = iw * s, dh = ih * s;
  page.drawImage(img, { x: x + (bw - dw) / 2, y: y + (bh - dh) / 2, width: dw, height: dh });
}

/** Fit entirely inside box — no cropping */
function drawFit(page, img, x, y, bw, bh) {
  if (!img) return;
  const { width: iw, height: ih } = img.scale(1);
  const s  = Math.min(bw / iw, bh / ih);
  const dw = iw * s, dh = ih * s;
  page.drawImage(img, { x: x + (bw - dw) / 2, y: y + (bh - dh) / 2, width: dw, height: dh });
}

// ═══════════════════════════════════════════════════════════
// TEXT HELPERS
// ═══════════════════════════════════════════════════════════

function wrap(text, font, size, maxW) {
  const safe = S(text).replace(/\r\n|\r/g, "\n");
  const out  = [];
  for (const para of safe.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let cur = words[0];
    for (let i = 1; i < words.length; i++) {
      const nxt = `${cur} ${words[i]}`;
      let w = maxW + 1;
      try { w = font.widthOfTextAtSize(nxt, size); } catch {}
      cur = w <= maxW ? nxt : (out.push(cur), words[i]);
    }
    out.push(cur);
    out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function textW(font, text, size) {
  try { return font.widthOfTextAtSize(S(text), size); } catch { return 0; }
}

function drawCentred(page, text, y, size, font, color = INK) {
  const s   = S(text);
  if (!s) return;
  const tw  = textW(font, s, size);
  page.drawText(s, { x: PAGE_W / 2 - tw / 2, y, size, font, color });
}

function drawMultilineCentred(page, lines, startY, size, font, color, lineH) {
  let y = startY;
  for (const l of lines) {
    if (!l) { y -= lineH * 0.5; continue; }
    drawCentred(page, l, y, size, font, color);
    y -= lineH;
  }
  return y;
}

// ── Decorative rule ──────────────────────────────────────────
function hLine(page, y, x1, x2, thick = 0.75, color = GOLD) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: thick, color });
}

// ── Diamond ornament row ─────────────────────────────────────
function drawOrnaments(page, cx, y, font, count = 5, size = 9) {
  const sp    = 20;
  const startX = cx - ((count - 1) * sp) / 2;
  for (let i = 0; i < count; i++) {
    try { page.drawText("◆", { x: startX + i * sp, y, size, font, color: GOLD }); }
    catch { page.drawText("*", { x: startX + i * sp, y, size, font, color: GOLD }); }
  }
}

// ── Rounded rectangle (simulated with drawRectangle + corner circles) ───────
function rrect(page, x, y, w, h, color, opacity = 1, borderColor = null, borderW = 0) {
  page.drawRectangle({ x, y, width: w, height: h, color, opacity,
    ...(borderColor ? { borderColor, borderWidth: borderW } : {}) });
}

// ── Page number ──────────────────────────────────────────────
function pageNum(page, n, font) {
  const s = String(n);
  const x = PAGE_W / 2 - textW(font, s, 9) / 2;
  page.drawText(s, { x, y: 16, size: 9, font, color: INK_LITE });
}

// ═══════════════════════════════════════════════════════════
// DATA HELPERS
// ═══════════════════════════════════════════════════════════

function toArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  const keys = Object.keys(v).map(Number).filter(n => !isNaN(n));
  if (!keys.length) return [];
  const arr = [];
  keys.sort((a, b) => a - b).forEach(k => { arr[k] = v[k]; });
  return arr.filter(Boolean);
}

function pickTextContent(artifacts) {
  const h = toArr(artifacts?.humanized);
  const c = toArr(artifacts?.chapters);
  return h.length ? h : c;
}

/**
 * For picture books, merge text-spreads + illustration-spreads.
 * Returns array of { text, textPosition, imageUrl, illustrationHint }
 */
function mergeChapterSpreads(textCh, illCh) {
  const tSpreads = toArr(textCh?.spreads);
  const iSpreads = toArr(illCh?.spreads);
  const count    = Math.max(tSpreads.length, iSpreads.length, 1);
  const out      = [];
  for (let i = 0; i < count; i++) {
    const t = tSpreads[i] || {};
    const ill = iSpreads[i] || {};
    out.push({
      spreadIndex:      i,
      text:             S(t.text || ill.text),
      textPosition:     S(t.textPosition || ill.textPosition || "bottom"),
      imageUrl:         S(ill.imageUrl || ""),
      illustrationHint: S(t.illustrationHint || ill.illustrationHint),
    });
  }
  return out;
}

function resolveTheme(tp) {
  if (!tp) return null;
  return {
    title:          S(tp.sectionTitle || tp.title),
    arabic:         S(tp.arabicPhrase),
    transliteration:S(tp.transliteration),
    meaning:        S(tp.meaning),
    refType:        S(tp.referenceType || "quran").toUpperCase(),
    refSource:      S(tp.referenceSource || tp.reference),
    refText:        S(tp.referenceText),
    explanation:    S(tp.explanation || tp.whyWeDoIt),
    dailyPractice:  S(tp.dailyPractice),
  };
}

// ═══════════════════════════════════════════════════════════
// BORDER DESIGNS
// ═══════════════════════════════════════════════════════════

/** Classic Islamic-style border — thin gold double frame */
function drawIslamicBorder(page, margin = 22) {
  const m = margin;
  const opts = { thickness: 1.5, color: GOLD };
  const opts2 = { thickness: 0.5, color: GOLD };
  // Outer frame
  page.drawLine({ start: { x: m, y: m }, end: { x: PAGE_W - m, y: m }, ...opts });
  page.drawLine({ start: { x: m, y: PAGE_H - m }, end: { x: PAGE_W - m, y: PAGE_H - m }, ...opts });
  page.drawLine({ start: { x: m, y: m }, end: { x: m, y: PAGE_H - m }, ...opts });
  page.drawLine({ start: { x: PAGE_W - m, y: m }, end: { x: PAGE_W - m, y: PAGE_H - m }, ...opts });
  // Inner frame (4px inset)
  const m2 = m + 5;
  page.drawLine({ start: { x: m2, y: m2 }, end: { x: PAGE_W - m2, y: m2 }, ...opts2 });
  page.drawLine({ start: { x: m2, y: PAGE_H - m2 }, end: { x: PAGE_W - m2, y: PAGE_H - m2 }, ...opts2 });
  page.drawLine({ start: { x: m2, y: m2 }, end: { x: m2, y: PAGE_H - m2 }, ...opts2 });
  page.drawLine({ start: { x: PAGE_W - m2, y: m2 }, end: { x: PAGE_W - m2, y: PAGE_H - m2 }, ...opts2 });
  // Corner diamonds
  const corners = [[m+1, m+1], [PAGE_W-m-1, m+1], [m+1, PAGE_H-m-1], [PAGE_W-m-1, PAGE_H-m-1]];
  for (const [cx, cy] of corners) {
    page.drawCircle({ x: cx, y: cy, size: 3, color: GOLD });
  }
}

// ═══════════════════════════════════════════════════════════
// PAGE BUILDERS
// ═══════════════════════════════════════════════════════════

// ── 1. FRONT COVER ──────────────────────────────────────────────────────────
function buildCoverPage(doc, img, bookTitle, author) {
  const pg = doc.addPage([PAGE_W, PAGE_H]);

  if (img) {
    drawCover(pg, img, 0, 0, PAGE_W, PAGE_H);
    // Bottom gradient band for title
    const bh = Math.round(PAGE_H * 0.30);
    rrect(pg, 0, 0, PAGE_W, bh, BLACK, 0.68);
    // Thin gold top-of-band line
    pg.drawLine({ start: { x: 0, y: bh }, end: { x: PAGE_W, y: bh }, thickness: 1.5, color: GOLD });

    const titleSize = bookTitle.length > 28 ? 18 : bookTitle.length > 18 ? 22 : 26;
    const titleLines = wrap(bookTitle, null, titleSize, PAGE_W - 72);
    let ty = Math.round(bh * 0.75);
    for (const line of titleLines) {
      if (!line) continue;
      // Using pre-loaded boldFont — set via closure
      drawCentred(pg, line, ty, titleSize, pg.__boldFont, WHITE);
      ty -= titleSize + 6;
    }
    if (author) {
      drawCentred(pg, `by ${author}`, Math.max(ty - 4, 20), 11, pg.__font, rgb(0.88, 0.86, 0.82));
    }
  } else {
    // ── Text-only cover fallback ────────────────────────
    rrect(pg, 0, 0, PAGE_W, PAGE_H, rgb(0.13, 0.30, 0.28)); // deep teal
    // Large gold arc / ornament area top
    rrect(pg, 0, PAGE_H - 140, PAGE_W, 140, rgb(0.86, 0.68, 0.18));
    rrect(pg, 0, 0, PAGE_W, 80, rgb(0.86, 0.68, 0.18));

    const titleSize = bookTitle.length > 24 ? 22 : 30;
    const titleLines = wrap(bookTitle, pg.__boldFont, titleSize, PAGE_W - 80);
    const totalH = titleLines.filter(l => l).length * (titleSize + 8);
    let ty = PAGE_H / 2 + totalH / 2;
    for (const line of titleLines) {
      if (!line) continue;
      drawCentred(pg, line, ty, titleSize, pg.__boldFont, WHITE);
      ty -= titleSize + 8;
    }
    if (author) {
      drawCentred(pg, `by ${author}`, PAGE_H * 0.18, 14, pg.__font, rgb(0.96, 0.90, 0.72));
    }
    drawOrnaments(pg, PAGE_W / 2, PAGE_H / 2 - totalH / 2 - 30, pg.__font, 5, 10);
  }
}

// ── 2. DEDICATION PAGE ──────────────────────────────────────────────────────
function buildDedicationPage(doc, dedication, author, pn, fonts) {
  const pg = doc.addPage([PAGE_W, PAGE_H]);
  pg.__font = fonts.regular; pg.__boldFont = fonts.bold;

  rrect(pg, 0, 0, PAGE_W, PAGE_H, CREAM);
  drawIslamicBorder(pg, 28);

  // Bismillah / ornament top
  drawOrnaments(pg, PAGE_W / 2, PAGE_H - 68, fonts.bold, 7, 8);

  // "A message for you" header
  const header = "A Message for You";
  rrect(pg, PAGE_W / 2 - 120, PAGE_H - 110, 240, 32, GOLD, 1);
  drawCentred(pg, header, PAGE_H - 100, 14, fonts.bold, rgb(0.08, 0.05, 0.01));

  hLine(pg, PAGE_H - 120, 60, PAGE_W - 60, 0.75, GOLD);

  const CW   = PAGE_W - 120;
  const LEFT = 60;
  let y      = PAGE_H - 148;

  // Greeting
  if (dedication?.greeting) {
    drawCentred(pg, S(dedication.greeting), y, 15, fonts.bold, INK);
    y -= 26;
  }

  // Message body
  if (dedication?.message) {
    y -= 8;
    const lines = wrap(dedication.message, fonts.regular, 12, CW);
    // Light teal background box
    const boxH = lines.filter(l => l).length * 18 + lines.filter(l => !l).length * 9 + 28;
    rrect(pg, LEFT - 10, y - boxH + 8, CW + 20, boxH, TEAL_LT, 0.85,
          TEAL, 0.5);
    y -= 14;
    for (const line of lines) {
      if (!line) { y -= 8; continue; }
      pg.drawText(S(line), { x: LEFT, y, size: 12, font: fonts.regular, color: INK_MID });
      y -= 18;
    }
    y -= 10;
  }

  hLine(pg, y - 4, 60, PAGE_W - 60, 0.5, GOLD);
  y -= 22;

  // NoorStudio fixed message
  const extra = `We hope your child enjoys reading this book as much as we enjoyed making and illustrating it.`;
  const eLines = wrap(extra, fonts.regular, 11, CW);
  for (const line of eLines) {
    if (!line) { y -= 6; continue; }
    drawCentred(pg, line, y, 11, fonts.regular, INK_MID);
    y -= 17;
  }

  // Closing / signature
  if (dedication?.closing) {
    y -= 12;
    drawCentred(pg, `— ${S(dedication.closing)}`, y, 11, fonts.regular, INK_LITE);
    y -= 16;
  }

  drawOrnaments(pg, PAGE_W / 2, 50, fonts.regular, 5, 7);
  pageNum(pg, pn, fonts.regular);
}

// ── 3. ISLAMIC THEME PAGE ───────────────────────────────────────────────────
function buildThemePage(doc, theme, pn, fonts) {
  const pg = doc.addPage([PAGE_W, PAGE_H]);

  // Rich deep-green background
  rrect(pg, 0, 0, PAGE_W, PAGE_H, rgb(0.06, 0.20, 0.14));
  // Top gold band
  rrect(pg, 0, PAGE_H - 90, PAGE_W, 90, rgb(0.80, 0.62, 0.12));
  // Bottom gold band
  rrect(pg, 0, 0, PAGE_W, 56, rgb(0.80, 0.62, 0.12));

  drawIslamicBorder(pg, 18);

  let y = PAGE_H - 56;

  // Section title (e.g. "Saying Alhamdulillah")
  if (theme.title) {
    drawCentred(pg, theme.title.toUpperCase(), y, 16, fonts.bold, rgb(0.08, 0.05, 0.01));
    y -= 100; // jump below gold band
  }

  // Arabic phrase — large, right-to-left appearance
  if (theme.arabic) {
    drawCentred(pg, theme.arabic, y, 38, fonts.bold, GOLD);
    y -= 52;
  }

  // Transliteration
  if (theme.transliteration) {
    drawCentred(pg, theme.transliteration, y, 14, fonts.regular, rgb(0.92, 0.88, 0.74));
    y -= 22;
  }

  // Meaning
  if (theme.meaning) {
    const q = `"${theme.meaning}"`;
    drawCentred(pg, q, y, 13, fonts.regular, rgb(0.85, 0.82, 0.68));
    y -= 28;
  }

  hLine(pg, y, 60, PAGE_W - 60, 0.6, GOLD);
  y -= 20;

  // Reference badge
  if (theme.refSource || theme.refText) {
    const badge = `${theme.refType || "REFERENCE"} — ${theme.refSource}`;
    drawCentred(pg, badge, y, 10, fonts.regular, rgb(0.80, 0.75, 0.54));
    y -= 18;
    if (theme.refText) {
      const refLines = wrap(theme.refText, fonts.regular, 11, PAGE_W - 120);
      // italic-style — just small and lighter
      for (const l of refLines.slice(0, 3)) {
        if (!l) continue;
        drawCentred(pg, l, y, 11, fonts.regular, rgb(0.90, 0.86, 0.70));
        y -= 17;
      }
    }
    y -= 14;
  }

  hLine(pg, y, 60, PAGE_W - 60, 0.6, GOLD);
  y -= 20;

  // Explanation / why we do it
  if (theme.explanation) {
    const lines = wrap(theme.explanation, fonts.regular, 11, PAGE_W - 100);
    for (const l of lines.slice(0, 5)) {
      if (!l) { y -= 7; continue; }
      drawCentred(pg, l, y, 11, fonts.regular, rgb(0.80, 0.78, 0.64));
      y -= 17;
    }
    y -= 8;
  }

  // Daily practice — highlight box
  if (theme.dailyPractice && y > 80) {
    const dpLines = wrap(`💚 ${theme.dailyPractice}`, fonts.regular, 11, PAGE_W - 120);
    const dpH = dpLines.filter(l => l).length * 16 + 20;
    rrect(pg, 60, y - dpH, PAGE_W - 120, dpH, rgb(0.12, 0.38, 0.24), 0.9, GOLD, 0.5);
    let dy = y - 12;
    for (const l of dpLines) {
      if (!l) continue;
      drawCentred(pg, l, dy, 11, fonts.regular, rgb(0.90, 1.0, 0.88));
      dy -= 16;
    }
  }

  drawOrnaments(pg, PAGE_W / 2, 30, fonts.regular, 7, 7);
  pageNum(pg, pn, fonts.regular);
}

// ── 4. STORY SPREAD PAGE (picture-book) ─────────────────────────────────────
// Full-bleed illustration. Text in a nicely styled box at bottom (or top).
async function buildSpreadPage(doc, spread, chapterNum, chapterTitle, pn, fonts) {
  const pg = doc.addPage([PAGE_W, PAGE_H]);

  const imgBytes = await fetchBytes(spread.imageUrl);
  const img      = await embedImg(doc, imgBytes);

  const textPos = spread.textPosition === "top" || spread.textPosition === "overlay-top" ? "top" : "bottom";
  const hasText = !!spread.text;

  if (img) {
    // Full-bleed illustration
    drawCover(pg, img, 0, 0, PAGE_W, PAGE_H);
  } else {
    // Placeholder — warm patterned background
    rrect(pg, 0, 0, PAGE_W, PAGE_H, CREAM);
    drawIslamicBorder(pg, 20);
    drawCentred(pg, "Illustration Loading…", PAGE_H / 2, 14, fonts.regular, INK_LITE);
  }

  // ── Text overlay box ──────────────────────────────────────
  if (hasText) {
    const TEXT_SIZE  = 16;
    const textLines  = wrap(spread.text, fonts.bold, TEXT_SIZE, PAGE_W - 72);
    const lineH      = TEXT_SIZE + 8;
    const textBlockH = textLines.filter(l => l).length * lineH + textLines.filter(l => !l).length * (lineH * 0.4) + 34;

    const boxH = Math.max(textBlockH + 10, 64);
    const boxY = textPos === "top" ? PAGE_H - boxH : 0;

    // Translucent dark band
    rrect(pg, 0, boxY, PAGE_W, boxH, BLACK, 0.62);

    // Gold accent line
    const lineY = textPos === "top" ? boxY : boxY + boxH;
    pg.drawLine({
      start: { x: 0, y: lineY }, end: { x: PAGE_W, y: lineY },
      thickness: 2.5, color: GOLD,
    });

    // Text
    let ty = textPos === "top"
      ? boxY + boxH - 18
      : boxY + boxH - 20;

    for (const line of textLines) {
      if (!line) { ty -= lineH * 0.4; continue; }
      drawCentred(pg, line, ty, TEXT_SIZE, fonts.bold, WHITE);
      ty -= lineH;
    }
  }

  // ── Chapter label badge (small, semi-transparent, top-right) ─────────────
  const badgeLabel = `Ch. ${chapterNum}`;
  const badgeX     = PAGE_W - 64;
  const badgeY     = textPos === "top" ? 10 : PAGE_H - 32;
  rrect(pg, badgeX - 4, badgeY - 4, 56, 22, BLACK, 0.45);
  pg.drawText(badgeLabel, {
    x: badgeX, y: badgeY,
    size: 10, font: fonts.regular, color: rgb(0.90, 0.85, 0.70),
  });

  // ── Page number ───────────────────────────────────────────
  pageNum(pg, pn, fonts.regular);
}

// ── Chapter title page (shown once per chapter before its spreads) ───────────
function buildChapterTitlePage(doc, chapterNum, chapterTitle, pn, fonts) {
  const pg = doc.addPage([PAGE_W, PAGE_H]);

  // Deep teal background
  rrect(pg, 0, 0, PAGE_W, PAGE_H, rgb(0.07, 0.24, 0.22));
  drawIslamicBorder(pg, 24);

  // Centre vertical stack
  const CY = PAGE_H / 2;

  // "CHAPTER N" label
  const chLabel = `CHAPTER ${chapterNum}`;
  drawCentred(pg, chLabel, CY + 52, 11, fonts.regular, GOLD);

  // Gold divider
  hLine(pg, CY + 42, PAGE_W / 2 - 70, PAGE_W / 2 + 70, 1, GOLD);

  // Chapter title
  const titleLines = wrap(chapterTitle, fonts.bold, 22, PAGE_W - 100);
  let ty = CY + 18;
  for (const line of titleLines) {
    if (!line) continue;
    drawCentred(pg, line, ty, 22, fonts.bold, WHITE);
    ty -= 30;
  }

  // Gold divider below
  hLine(pg, ty - 8, PAGE_W / 2 - 70, PAGE_W / 2 + 70, 1, GOLD);

  // Ornaments
  drawOrnaments(pg, PAGE_W / 2, ty - 26, fonts.regular, 5, 9);

  pageNum(pg, pn, fonts.regular);
}

// ── 5. BACK COVER ───────────────────────────────────────────────────────────
function buildBackCoverPage(doc, img, moral, author, fonts) {
  const pg = doc.addPage([PAGE_W, PAGE_H]);

  if (img) {
    drawCover(pg, img, 0, 0, PAGE_W, PAGE_H);

    // Bottom overlay for moral / branding
    const bh = Math.round(PAGE_H * 0.28);
    rrect(pg, 0, 0, PAGE_W, bh, BLACK, 0.65);
    pg.drawLine({ start: { x: 0, y: bh }, end: { x: PAGE_W, y: bh }, thickness: 2, color: GOLD });

    if (moral) {
      const mLines = wrap(`"${moral}"`, fonts.regular, 11, PAGE_W - 80);
      let my = Math.round(bh * 0.72);
      for (const l of mLines.slice(0, 3)) {
        if (!l) continue;
        drawCentred(pg, l, my, 11, fonts.regular, rgb(0.95, 0.92, 0.80));
        my -= 16;
      }
    }

    pg.drawText("Created with NoorStudio", {
      x: 24, y: 12, size: 8, font: fonts.regular, color: rgb(0.75, 0.72, 0.62),
    });
  } else {
    // Text-only back cover
    rrect(pg, 0, 0, PAGE_W, PAGE_H, rgb(0.07, 0.24, 0.22));
    rrect(pg, 0, PAGE_H - 100, PAGE_W, 100, rgb(0.80, 0.62, 0.12));
    rrect(pg, 0, 0, PAGE_W, 80, rgb(0.80, 0.62, 0.12));
    drawIslamicBorder(pg, 20);

    // "The End"
    drawCentred(pg, "The End", PAGE_H / 2 + 28, 38, fonts.bold, WHITE);
    drawOrnaments(pg, PAGE_W / 2, PAGE_H / 2 - 4, fonts.regular, 7, 9);

    if (moral) {
      const mLines = wrap(`"${moral}"`, fonts.regular, 12, PAGE_W - 100);
      let my = PAGE_H / 2 - 38;
      for (const l of mLines.slice(0, 3)) {
        if (!l) continue;
        drawCentred(pg, l, my, 12, fonts.regular, rgb(0.90, 0.86, 0.70));
        my -= 18;
      }
    }
    if (author) {
      drawCentred(pg, `by ${author}`, 100, 13, fonts.bold, rgb(0.95, 0.90, 0.72));
    }
    pg.drawText("Created with NoorStudio", {
      x: 24, y: 14, size: 8, font: fonts.regular, color: rgb(0.55, 0.45, 0.20),
    });
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════

export async function buildPDF(project) {
  // Always work with a plain object
  const p = typeof project.toObject === "function"
    ? project.toObject({ getters: false, virtuals: false })
    : project;

  const artifacts = p.artifacts ?? {};
  const bookTitle = S(p.title,       "Untitled Book");
  const author    = S(p.authorName, "").trim();
  const moral     = S(artifacts.outline?.moral || artifacts.outline?.synopsis || "");

  console.log(`[pdf] Building "${bookTitle}" | author: "${author}"`);

  // ── Init PDF doc ──────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // ── Load fonts ─────────────────────────────────────────────
  let regFont, boldFont;
  try {
    regFont  = await pdfDoc.embedFont(loadFontBytes("NotoSansArabic-Regular.ttf"), { subset: true });
    boldFont = await pdfDoc.embedFont(loadFontBytes("NotoSansArabic-Bold.ttf"),    { subset: true })
                .catch(() => regFont);
    console.log("[pdf] NotoSansArabic loaded.");
  } catch {
    regFont  = await pdfDoc.embedFont(StandardFonts.Helvetica);
    boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    console.log("[pdf] Fallback to Helvetica.");
  }

  const fonts = { regular: regFont, bold: boldFont };

  pdfDoc.setTitle(bookTitle);
  pdfDoc.setAuthor(author || "NoorStudio");
  pdfDoc.setCreator("NoorStudio PDF Engine v4");
  pdfDoc.setCreationDate(new Date());

  // ── Fetch cover images ────────────────────────────────────
  const cov          = artifacts.cover ?? {};
  const frontUrl     = S(cov.frontUrl || cov.frontCoverUrl || cov.imageUrl || "");
  const backUrl      = S(cov.backUrl  || cov.backCoverUrl  || "");

  console.log(`[pdf] Cover front: ${frontUrl ? "✓" : "✗"} | back: ${backUrl ? "✓" : "✗"}`);

  const [frontBytes, backBytes] = await Promise.all([
    fetchBytes(frontUrl),
    fetchBytes(backUrl),
  ]);
  const frontImg = await embedImg(pdfDoc, frontBytes);
  const coverBackImg = await embedImg(pdfDoc, backBytes);

  // ── Text content ──────────────────────────────────────────
  const textChapters = pickTextContent(artifacts);
  const illustrations = toArr(artifacts.illustrations);

  console.log(`[pdf] Chapters: ${textChapters.length} | Illustrations: ${illustrations.length}`);

  // ── Build spread map: spreads[ci] = IllustrationItem ─────
  const illMap = {};
  for (const ill of illustrations) {
    illMap[String(ill.chapterNumber)] = ill;
  }

  // ── PAGE SEQUENCE ─────────────────────────────────────────
  let pn = 0;

  // ─────────────────────────────────────────────────────────
  // PAGE 1 — FRONT COVER
  // ─────────────────────────────────────────────────────────
  pn++;
  {
    const pg = pdfDoc.addPage([PAGE_W, PAGE_H]);
    pg.__font     = fonts.regular;
    pg.__boldFont = fonts.bold;

    if (frontImg) {
      drawCover(pg, frontImg, 0, 0, PAGE_W, PAGE_H);

      const bh = Math.round(PAGE_H * 0.30);
      rrect(pg, 0, 0, PAGE_W, bh, BLACK, 0.68);
      pg.drawLine({ start: { x: 0, y: bh }, end: { x: PAGE_W, y: bh }, thickness: 2.5, color: GOLD });

      const titleSize  = bookTitle.length > 28 ? 18 : bookTitle.length > 18 ? 22 : 27;
      const titleLines = wrap(bookTitle, boldFont, titleSize, PAGE_W - 72);
      let ty = Math.round(bh * 0.78);
      for (const line of titleLines) {
        if (!line) continue;
        drawCentred(pg, line, ty, titleSize, boldFont, WHITE);
        ty -= titleSize + 7;
      }
      if (author) {
        drawCentred(pg, `by ${author}`, Math.max(ty - 4, 18), 11, regFont, rgb(0.88, 0.85, 0.78));
      }
    } else {
      // Fallback cover
      rrect(pg, 0, 0, PAGE_W, PAGE_H, rgb(0.10, 0.30, 0.26));
      rrect(pg, 0, PAGE_H - 120, PAGE_W, 120, rgb(0.82, 0.64, 0.14));
      rrect(pg, 0, 0, PAGE_W, 80, rgb(0.82, 0.64, 0.14));
      drawIslamicBorder(pg, 20);

      const titleSize  = bookTitle.length > 24 ? 22 : 30;
      const titleLines = wrap(bookTitle, boldFont, titleSize, PAGE_W - 80);
      const th         = titleLines.filter(l => l).length * (titleSize + 10);
      let ty = PAGE_H / 2 + th / 2;
      for (const line of titleLines) {
        if (!line) continue;
        drawCentred(pg, line, ty, titleSize, boldFont, WHITE);
        ty -= titleSize + 10;
      }
      drawOrnaments(pg, PAGE_W / 2, ty - 18, regFont, 7, 9);
      if (author) {
        drawCentred(pg, `by ${author}`, 100, 14, regFont, rgb(0.94, 0.88, 0.70));
      }
    }
    console.log(`[pdf] p${pn}: Front Cover`);
  }

  // ─────────────────────────────────────────────────────────
  // PAGE 2 — DEDICATION
  // ─────────────────────────────────────────────────────────
  pn++;
  buildDedicationPage(pdfDoc, artifacts.dedication, author, pn, fonts);
  console.log(`[pdf] p${pn}: Dedication`);

  // ─────────────────────────────────────────────────────────
  // PAGE 3 — ISLAMIC THEME
  // ─────────────────────────────────────────────────────────
  const theme = resolveTheme(artifacts.themePage);
  if (theme && (theme.arabic || theme.title)) {
    pn++;
    buildThemePage(pdfDoc, theme, pn, fonts);
    console.log(`[pdf] p${pn}: Theme — "${theme.title}"`);
  }

  // ─────────────────────────────────────────────────────────
  // STORY PAGES — one chapter title page + one page per spread
  // ─────────────────────────────────────────────────────────
  if (!textChapters.length) {
    console.warn("[pdf] No chapters found — cover + dedication + theme only.");
  }

  for (let ci = 0; ci < textChapters.length; ci++) {
    const textCh  = textChapters[ci];
    const chNum   = textCh.chapterNumber ?? textCh.chapterIndex ?? ci + 1;
    const chTitle = S(textCh.chapterTitle || textCh.title || `Chapter ${chNum}`);
    const illCh   = illMap[String(chNum)] || illustrations[ci] || null;

    console.log(`[pdf] Chapter ${chNum}: "${chTitle}" | ill: ${illCh ? "✓" : "✗"}`);

    // Chapter title divider page
    pn++;
    buildChapterTitlePage(pdfDoc, chNum, chTitle, pn, fonts);
    console.log(`[pdf]   p${pn}: Chapter divider`);

    // Merge text + illustration spreads
    const spreads = mergeChapterSpreads(textCh, illCh);
    console.log(`[pdf]   ${spreads.length} spread(s)`);

    for (const spread of spreads) {
      pn++;
      await buildSpreadPage(pdfDoc, spread, chNum, chTitle, pn, fonts);
      console.log(`[pdf]   p${pn}: Spread ${spread.spreadIndex + 1} | img: ${spread.imageUrl ? "✓" : "✗"} | text: "${spread.text.slice(0, 40)}"`);
    }
  }

  // ─────────────────────────────────────────────────────────
  // BACK COVER
  // ─────────────────────────────────────────────────────────
  pn++;
  buildBackCoverPage(pdfDoc, coverBackImg, moral, author, fonts);
  console.log(`[pdf] p${pn}: Back Cover`);

  // ─────────────────────────────────────────────────────────
  // SAVE
  // ─────────────────────────────────────────────────────────
  console.log(`[pdf] ✓ Done — ${pn} pages`);
  return await pdfDoc.save({ useObjectStreams: false });
}
