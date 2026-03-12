// server/utils/buildPDF.js
//
// Layout modes (stored in project.layoutStyle):
//   "text-below"   (default) — illustration top ~45%, text below
//   "text-overlay" — full-page illustration, text in translucent box at bottom
//
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Font loader ───────────────────────────────────────────────
function loadFontBytes(fileName) {
  const p = path.join(__dirname, "..", "assets", "fonts", fileName);
  if (!fs.existsSync(p)) throw new Error(`Font not found: ${p}`);
  return fs.readFileSync(p);
}

// ── Trim sizes (points) ───────────────────────────────────────
const TRIM = {
  "6x9":  { w: 432, h: 648 },
  "8x10": { w: 576, h: 720 },
  square: { w: 600, h: 600 },
};
const getSize = (s) => TRIM[s] ?? TRIM["8x10"];

// ── Helpers ───────────────────────────────────────────────────
function safeStr(v, fallback = "") {
  if (v == null) return fallback;
  return String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** pdf-lib needs pure Uint8Array, not Buffer */
function toUint8(buf) {
  if (!buf) return null;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ── Image fetching ────────────────────────────────────────────
async function getImageBytes(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:")) {
    try {
      const base64 = url.slice(url.indexOf(",") + 1).replace(/[\s\r\n]/g, "");
      return toUint8(Buffer.from(base64, "base64"));
    } catch (e) { console.warn("[pdf] base64 decode:", e.message); return null; }
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) { console.warn("[pdf] fetch:", e.message); return null; }
}

async function embedImage(doc, bytes) {
  if (!bytes || bytes.length < 4) return null;
  const u = bytes instanceof Buffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes;
  const isPng = u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47;
  const isJpg = u[0] === 0xff && u[1] === 0xd8;
  try {
    if (isPng) return await doc.embedPng(u);
    if (isJpg) return await doc.embedJpg(u);
    try { return await doc.embedPng(u); } catch {}
    try { return await doc.embedJpg(u); } catch {}
    return null;
  } catch (e) { console.warn("[pdf] embed:", e.message); return null; }
}

// ── Image drawing ─────────────────────────────────────────────

/**
 * FIT mode — image fits entirely inside box (may letterbox)
 */
function drawImageFit(page, img, x, y, bw, bh) {
  if (!img) return;
  const { width: iw, height: ih } = img.scale(1);
  const s = Math.min(bw / iw, bh / ih);
  const dw = iw * s, dh = ih * s;
  page.drawImage(img, {
    x: x + (bw - dw) / 2,
    y: y + (bh - dh) / 2,
    width: dw, height: dh,
  });
}

/**
 * COVER mode — image fills the entire box; overflow is outside page bounds
 * and is never printed. This eliminates all letterbox / white bars.
 */
function drawImageCover(page, img, x, y, bw, bh) {
  if (!img) return;
  const { width: iw, height: ih } = img.scale(1);
  const s = Math.max(bw / iw, bh / ih); // fill, may overflow
  const dw = iw * s, dh = ih * s;
  page.drawImage(img, {
    x: x + (bw - dw) / 2,
    y: y + (bh - dh) / 2,
    width: dw, height: dh,
  });
}

// ── Text helpers ──────────────────────────────────────────────
function wrapLines(text, font, size, maxW) {
  const safe = safeStr(text).replace(/\r\n|\r/g, "\n");
  const out = [];
  for (const para of safe.split("\n")) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let cur = words[0];
    for (let i = 1; i < words.length; i++) {
      const next = `${cur} ${words[i]}`;
      let w = maxW + 1;
      try { w = font.widthOfTextAtSize(next, size); } catch {}
      if (w <= maxW) cur = next;
      else { out.push(cur); cur = words[i]; }
    }
    out.push(cur);
    out.push("");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function drawFooter(page, n, w, margin, font) {
  try {
    const txt = String(n);
    let tw = 10; try { tw = font.widthOfTextAtSize(txt, 10); } catch {}
    page.drawText(txt, { x: w / 2 - tw / 2, y: margin - 18, size: 10, font, color: rgb(0.5, 0.5, 0.5) });
  } catch {}
}

function drawHLine(page, y, x1, x2, thickness = 0.5, color = rgb(0.82, 0.82, 0.82)) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
}

// ── Chapter data helpers ──────────────────────────────────────
function pickChapters(p) {
  const a = p?.artifacts ?? {};
  if (Array.isArray(a.humanized) && a.humanized.length) return a.humanized;
  if (Array.isArray(a.chapters)  && a.chapters.length)  return a.chapters;
  return [];
}

function resolveChapter(ch, i) {
  return {
    num:   ch.chapterNumber ?? ch.chapterIndex ?? i + 1,
    title: safeStr(ch.chapterTitle ?? ch.title ?? `Chapter ${i + 1}`),
    text:  safeStr(ch.editedText ?? ch.text ?? ch.content ?? ""),
    vocab: ch.vocabularyNotes ?? ch.vocabulary ?? [],
  };
}

/**
 * Returns ALL image URLs for a chapter (supports imagesPerChapter > 1).
 * For age 2–6 books with 2 images per chapter, returns [url0, url1].
 */
function resolveIllustrationUrls(ill) {
  if (!ill) return [];
  const variants = ill.variants ?? [];
  const count    = ill.imagesPerChapter ?? 1;

  if (count === 1) {
    // single image — use selected or first
    const idx = ill.selectedVariantIndex ?? 0;
    const url =
      ill.imageUrl ??
      variants[idx]?.imageUrl ??
      variants.find(v => v.selected)?.imageUrl ??
      variants[0]?.imageUrl ??
      null;
    return url ? [url] : [];
  }

  // Multiple images — collect by variantIndex slot order
  const urls = [];
  for (let slot = 0; slot < count; slot++) {
    const v = variants.find(v => v.variantIndex === slot) ?? variants[slot] ?? null;
    if (v?.imageUrl) urls.push(v.imageUrl);
  }
  return urls;
}

// ── Decorative helpers ────────────────────────────────────────
function drawStars(page, cx, y, font, count = 5) {
  // Simple dot-stars spaced around a center x
  const spacing = 18;
  const startX = cx - ((count - 1) * spacing) / 2;
  for (let i = 0; i < count; i++) {
    try {
      page.drawText("✦", {
        x: startX + i * spacing, y,
        size: 9, font, color: rgb(0.8, 0.65, 0.2),
      });
    } catch {
      page.drawText("*", {
        x: startX + i * spacing, y,
        size: 9, font, color: rgb(0.8, 0.65, 0.2),
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
export async function buildPDF(project) {
  // Always work with a plain object (handles both .lean() and Mongoose docs)
  const p = typeof project.toObject === "function"
    ? project.toObject({ getters: false, virtuals: false })
    : project;

  const layoutStyle = p.layoutStyle ?? "text-below"; // or "text-overlay"
  const { w, h } = getSize(p.trimSize);
  const MARGIN  = 48;          // 0.67 inch — safe print margin
  const CW      = w - MARGIN * 2; // content width

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // ── Fonts ──────────────────────────────────────────────────
  let font, boldFont;
  try {
    font     = await pdfDoc.embedFont(loadFontBytes("NotoSansArabic-Regular.ttf"), { subset: true });
    boldFont = await pdfDoc.embedFont(loadFontBytes("NotoSansArabic-Bold.ttf"),    { subset: true })
              .catch(() => font);
    console.log("[pdf] Custom fonts loaded.");
  } catch {
    font     = await pdfDoc.embedFont(StandardFonts.Helvetica);
    boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    console.log("[pdf] Fallback to Helvetica.");
  }

  const bookTitle = safeStr(p?.title, "Untitled Book");
  const author    = safeStr(p?.authorName).trim();
  const chapters  = pickChapters(p);
  const artifacts = p?.artifacts ?? {};
  const moral     = safeStr(artifacts.outline?.moral ?? artifacts.outline?.synopsis ?? "");

  pdfDoc.setTitle(bookTitle);
  pdfDoc.setAuthor(author || "NoorStudio");
  pdfDoc.setCreator("NoorStudio PDF Engine v3");
  pdfDoc.setCreationDate(new Date());

  console.log("[pdf] Project:", bookTitle, "| chapters:", chapters.length, "| layout:", layoutStyle);

  // ── Gather all image URLs ──────────────────────────────────
  // Cover
  const cov = artifacts.cover ?? {};
  const coverFrontUrl =
    cov.frontUrl ?? cov.frontCoverUrl ?? cov.imageUrl ?? cov.url ?? null;
  const coverBackUrl  =
    cov.backUrl  ?? cov.backCoverUrl  ?? null;

  // Illustrations — collect per chapter, supporting multiple images
  // ill_urls[chNum] = [url0, url1?, ...]
  const illUrls = {}; // { "1": ["url", ...], ... }
  for (const ill of (artifacts.illustrations ?? [])) {
    const chNum = String(ill.chapterNumber);
    const urls  = resolveIllustrationUrls(ill);
    if (urls.length) {
      illUrls[chNum] = urls;
      console.log(`[pdf] ch${chNum}: ${urls.length} image(s)`);
    }
  }

  // ── Fetch/decode all in parallel ──────────────────────────
  const allIllEntries = Object.entries(illUrls); // [[chNum, [url,url?]], ...]
  const flatUrls = allIllEntries.flatMap(([, urls]) => urls);

  console.log(`[pdf] Decoding ${flatUrls.length} illustration(s) + cover...`);

  const [coverFrontBytes, coverBackBytes, ...flatBytes] = await Promise.all([
    getImageBytes(coverFrontUrl),
    getImageBytes(coverBackUrl),
    ...flatUrls.map(u => getImageBytes(u)),
  ]);

  const coverFrontImg = await embedImage(pdfDoc, coverFrontBytes);
  const coverBackImg  = await embedImage(pdfDoc, coverBackBytes);

  // Reconstruct structure: illImgs[chNum] = [PDFImage, PDFImage?]
  let idx = 0;
  const illImgs = {}; // { "1": [PDFImage, ...] }
  for (const [chNum, urls] of allIllEntries) {
    const imgs = [];
    for (let j = 0; j < urls.length; j++) {
      const img = await embedImage(pdfDoc, flatBytes[idx++]);
      if (img) imgs.push(img);
    }
    if (imgs.length) illImgs[chNum] = imgs;
  }

  console.log(`[pdf] coverFront:${!!coverFrontImg} coverBack:${!!coverBackImg} illChapters:${Object.keys(illImgs).length}`);

  let pageNum = 0;

  // ════════════════════════════════════════════════════════════
  // PAGE 1 — COVER (full-bleed image)
  // ════════════════════════════════════════════════════════════
  {
    pageNum++;
    const pg = pdfDoc.addPage([w, h]);

    if (coverFrontImg) {
      // COVER mode — fills entire page, no white bars
      drawImageCover(pg, coverFrontImg, 0, 0, w, h);

      // Bottom gradient overlay for title legibility
      const overlayH = Math.round(h * 0.28);
      pg.drawRectangle({
        x: 0, y: 0, width: w, height: overlayH,
        color: rgb(0, 0, 0), opacity: 0.62,
      });

      // Book title — large, centered, white
      const titleSize = bookTitle.length > 24 ? 19 : bookTitle.length > 16 ? 23 : 27;
      const titleLines = wrapLines(bookTitle, boldFont, titleSize, CW);
      let ty = Math.round(overlayH * 0.72);
      for (const line of titleLines) {
        if (!line) continue;
        let lw = CW; try { lw = boldFont.widthOfTextAtSize(line, titleSize); } catch {}
        pg.drawText(safeStr(line), {
          x: Math.max(MARGIN, w / 2 - lw / 2),
          y: ty,
          size: titleSize, font: boldFont, color: rgb(1, 1, 1),
        });
        ty -= titleSize + 5;
      }
      if (author) {
        const byLine = `by ${author}`;
        let bw2 = 80; try { bw2 = font.widthOfTextAtSize(byLine, 12); } catch {}
        pg.drawText(byLine, {
          x: w / 2 - bw2 / 2,
          y: Math.max(ty - 4, 14),
          size: 12, font, color: rgb(0.88, 0.88, 0.88),
        });
      }
    } else {
      // ── Text-only cover fallback ──────────────────────────
      pg.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0.99, 0.96, 0.88) });
      // Top color band
      pg.drawRectangle({ x: 0, y: h - 130, width: w, height: 130, color: rgb(0.93, 0.85, 0.55) });
      // Bottom color band
      pg.drawRectangle({ x: 0, y: 0, width: w, height: 80, color: rgb(0.93, 0.85, 0.55) });

      const titleSize = bookTitle.length > 24 ? 22 : 29;
      const titleLines = wrapLines(bookTitle, boldFont, titleSize, CW - 20);
      let ty = h - MARGIN - 30;
      for (const line of titleLines) {
        if (!line) continue;
        let lw = CW; try { lw = boldFont.widthOfTextAtSize(line, titleSize); } catch {}
        pg.drawText(safeStr(line), {
          x: w / 2 - lw / 2, y: ty,
          size: titleSize, font: boldFont, color: rgb(0.12, 0.08, 0.02),
        });
        ty -= titleSize + 7;
      }
      if (author) {
        pg.drawText(`By ${author}`, {
          x: MARGIN, y: ty - 10, size: 13, font, color: rgb(0.3, 0.2, 0.05),
        });
      }

      if (moral) {
        const mLines = wrapLines(`"${moral}"`, font, 12, CW - 32);
        const boxH = mLines.length * 18 + 28;
        const boxY = h / 2 - boxH / 2 - 20;
        pg.drawRectangle({
          x: MARGIN - 6, y: boxY - 10, width: CW + 12, height: boxH,
          color: rgb(1, 0.97, 0.88),
          borderColor: rgb(0.88, 0.70, 0.22), borderWidth: 1.5,
        });
        let my = boxY + boxH - 22;
        for (const line of mLines) {
          if (!line) { my -= 9; continue; }
          pg.drawText(safeStr(line), {
            x: MARGIN + 10, y: my, size: 12, font, color: rgb(0.2, 0.15, 0.02),
          });
          my -= 18;
        }
      }
      pg.drawText(
        safeStr(`${chapters.length} chapters • Age ${p?.ageRange ?? ""} • NoorStudio`),
        { x: MARGIN, y: MARGIN - 10, size: 9, font, color: rgb(0.5, 0.4, 0.15) }
      );
    }
  }

  // ════════════════════════════════════════════════════════════
  // PAGE 2 — TABLE OF CONTENTS (kid-friendly design)
  // ════════════════════════════════════════════════════════════
  if (chapters.length) {
    pageNum++;
    const pg = pdfDoc.addPage([w, h]);

    // Warm cream background
    pg.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0.995, 0.975, 0.94) });

    // Top decorative band
    pg.drawRectangle({ x: 0, y: h - 90, width: w, height: 90, color: rgb(0.93, 0.82, 0.45) });

    // "Contents" title
    const heading = "Table of Contents";
    let hw = 200; try { hw = boldFont.widthOfTextAtSize(heading, 20); } catch {}
    pg.drawText(heading, {
      x: w / 2 - hw / 2, y: h - 58,
      size: 20, font: boldFont, color: rgb(0.12, 0.08, 0.02),
    });

    drawHLine(pg, h - 95, MARGIN, w - MARGIN, 1.5, rgb(0.85, 0.70, 0.22));

    let cy = h - 118;
    const rowH = 34;

    for (let i = 0; i < chapters.length; i++) {
      const { num, title } = resolveChapter(chapters[i], i);
      const pgRef = String(i + 3);
      const label = safeStr(`Chapter ${num}:  ${title}`);

      // Alternating row background
      if (i % 2 === 0) {
        pg.drawRectangle({
          x: MARGIN - 6, y: cy - 8, width: CW + 12, height: rowH,
          color: rgb(1, 0.97, 0.90),
        });
      }

      pg.drawText(label, {
        x: MARGIN + 4, y: cy + 8, size: 13, font: boldFont, color: rgb(0.12, 0.1, 0.02),
      });

      // Page number badge
      const badgeX = w - MARGIN - 28;
      pg.drawCircle({ x: badgeX + 12, y: cy + 14, size: 13, color: rgb(0.93, 0.82, 0.45) });
      let pw = 8; try { pw = boldFont.widthOfTextAtSize(pgRef, 11); } catch {}
      pg.drawText(pgRef, {
        x: badgeX + 12 - pw / 2, y: cy + 8,
        size: 11, font: boldFont, color: rgb(0.12, 0.08, 0.02),
      });

      // Dot leaders
      let lw = 200; try { lw = font.widthOfTextAtSize(label, 13); } catch {}
      let dw = 6;   try { dw = font.widthOfTextAtSize(".", 10); } catch {}
      let dx = MARGIN + 4 + lw + 6;
      const dotEnd = badgeX - 4;
      while (dx < dotEnd) {
        pg.drawText(".", { x: dx, y: cy + 8, size: 10, font, color: rgb(0.7, 0.6, 0.3) });
        dx += dw + 2;
      }

      cy -= rowH;
      if (cy < MARGIN + 30) break;
    }

    // Bottom decorative band
    pg.drawRectangle({ x: 0, y: 0, width: w, height: 36, color: rgb(0.93, 0.82, 0.45) });
    drawFooter(pg, pageNum, w, MARGIN + 6, font);
  }

  if (!chapters.length) {
    console.warn("[pdf] No chapters — cover only.");
    return await pdfDoc.save({ useObjectStreams: false });
  }

  // ════════════════════════════════════════════════════════════
  // CHAPTER PAGES
  // ════════════════════════════════════════════════════════════
  const BODY_SIZE      = 13;
  const BODY_LH        = BODY_SIZE + 6;
  const TITLE_SIZE     = 18;
  const HEADER_H       = 80; // height of chapter header band
  const SAFE_BOTTOM    = MARGIN + 26;

  for (let ci = 0; ci < chapters.length; ci++) {
    const { num, title, text, vocab } = resolveChapter(chapters[ci], ci);
    const chKey  = String(num);
    const images = illImgs[chKey] ?? []; // 0, 1, or 2 PDFImage objects

    // Split text into two halves if we have 2 images (one per page)
    const allLines = wrapLines(text, font, BODY_SIZE, CW);
    const textChunks = images.length >= 2
      ? [allLines.slice(0, Math.ceil(allLines.length / 2)), allLines.slice(Math.ceil(allLines.length / 2))]
      : [allLines];

    // We render one page per image (or one page if no images)
    const pageCount = Math.max(images.length, 1);

    for (let slot = 0; slot < pageCount; slot++) {
      const img       = images[slot] ?? null;
      const lines     = textChunks[slot] ?? [];
      const isFirst   = slot === 0;

      pageNum++;
      let pg = pdfDoc.addPage([w, h]);

      // ── Warm background ──────────────────────────────────
      pg.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0.995, 0.978, 0.95) });

      // ── Chapter header band ───────────────────────────────
      if (isFirst) {
        pg.drawRectangle({ x: 0, y: h - HEADER_H, width: w, height: HEADER_H, color: rgb(0.93, 0.82, 0.45) });

        const chapterLabel = `CHAPTER ${num}`;
        pg.drawText(chapterLabel, {
          x: MARGIN, y: h - MARGIN - 4,
          size: 9, font, color: rgb(0.4, 0.25, 0.05),
        });

        const tLines = wrapLines(title, boldFont, TITLE_SIZE, CW);
        let ty = h - MARGIN - 20;
        for (const tl of tLines) {
          pg.drawText(safeStr(tl), {
            x: MARGIN, y: ty, size: TITLE_SIZE, font: boldFont, color: rgb(0.1, 0.07, 0.01),
          });
          ty -= TITLE_SIZE + 3;
        }
        drawHLine(pg, h - HEADER_H - 2, 0, w, 1.5, rgb(0.85, 0.70, 0.22));
      } else {
        // Continuation header — smaller
        pg.drawRectangle({ x: 0, y: h - 40, width: w, height: 40, color: rgb(0.93, 0.82, 0.45) });
        pg.drawText(safeStr(`Chapter ${num}: ${title}`), {
          x: MARGIN, y: h - 26,
          size: 10, font, color: rgb(0.4, 0.25, 0.05),
        });
        drawHLine(pg, h - 42, 0, w, 1, rgb(0.85, 0.70, 0.22));
      }
      drawFooter(pg, pageNum, w, MARGIN, font);

      const contentTop = isFirst ? h - HEADER_H - 10 : h - 44;

      // ════════════════════════════════════════════
      // LAYOUT: TEXT-BELOW (default, print-friendly)
      // ════════════════════════════════════════════
      if (layoutStyle !== "text-overlay") {
        let y = contentTop;

        if (img) {
          // Illustration box: 44% of page height, full content width
          const imgH = Math.round(h * 0.44);
          const imgY = y - imgH;
          const imgX = MARGIN;

          // White background behind illustration
          pg.drawRectangle({ x: imgX, y: imgY, width: CW, height: imgH, color: rgb(1, 1, 1) });

          // Draw illustration (fit mode inside its box)
          drawImageFit(pg, img, imgX, imgY, CW, imgH);

          // Subtle shadow border — 4 lines
          const bc = rgb(0.72, 0.65, 0.5);
          pg.drawLine({ start: { x: imgX,      y: imgY },      end: { x: imgX + CW, y: imgY },      thickness: 1, color: bc });
          pg.drawLine({ start: { x: imgX + CW, y: imgY },      end: { x: imgX + CW, y: imgY + imgH }, thickness: 1, color: bc });
          pg.drawLine({ start: { x: imgX + CW, y: imgY + imgH }, end: { x: imgX,    y: imgY + imgH }, thickness: 1, color: bc });
          pg.drawLine({ start: { x: imgX,      y: imgY + imgH }, end: { x: imgX,    y: imgY },      thickness: 1, color: bc });

          y = imgY - 16; // text starts below illustration
        }

        // ── Body text ────────────────────────────────────────
        for (const line of lines) {
          if (y <= SAFE_BOTTOM) {
            // Overflow page
            pageNum++;
            pg = pdfDoc.addPage([w, h]);
            pg.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0.995, 0.978, 0.95) });
            pg.drawRectangle({ x: 0, y: h - 40, width: w, height: 40, color: rgb(0.93, 0.82, 0.45) });
            pg.drawText(safeStr(`Chapter ${num}: ${title}`), {
              x: MARGIN, y: h - 26, size: 10, font, color: rgb(0.4, 0.25, 0.05),
            });
            drawHLine(pg, h - 42, 0, w, 1, rgb(0.85, 0.70, 0.22));
            drawFooter(pg, pageNum, w, MARGIN, font);
            y = h - 56;
          }
          if (line === "") { y -= BODY_LH * 0.55; continue; }
          pg.drawText(safeStr(line), {
            x: MARGIN, y, size: BODY_SIZE, font, color: rgb(0.1, 0.08, 0.03),
          });
          y -= BODY_LH;
        }

        // ── Vocabulary notes ─────────────────────────────────
        if (slot === pageCount - 1 && Array.isArray(vocab) && vocab.length && y > SAFE_BOTTOM + 50) {
          y -= 10;
          drawHLine(pg, y, MARGIN, w - MARGIN, 0.5, rgb(0.8, 0.7, 0.4));
          y -= 16;
          pg.drawText("Vocabulary", {
            x: MARGIN, y, size: 11, font: boldFont, color: rgb(0.25, 0.45, 0.15),
          });
          y -= 15;
          for (const v of vocab) {
            if (y < SAFE_BOTTOM) break;
            pg.drawText(`• ${safeStr(v)}`, {
              x: MARGIN + 8, y, size: 10, font, color: rgb(0.25, 0.2, 0.05),
            });
            y -= 14;
          }
        }

      } else {
        // ════════════════════════════════════════════
        // LAYOUT: TEXT-OVERLAY (full-page illustration,
        //         text in translucent box at bottom)
        // ════════════════════════════════════════════
        if (img) {
          // Full-bleed illustration
          drawImageCover(pg, img, 0, 0, w, h);
        }

        // Translucent text box at bottom (bottom 50% of page)
        const boxH = Math.round(h * 0.50);
        const boxY = 0;
        pg.drawRectangle({
          x: 0, y: boxY, width: w, height: boxH,
          color: rgb(0.98, 0.96, 0.88), opacity: 0.91,
        });
        drawHLine(pg, boxY + boxH, 0, w, 1.5, rgb(0.85, 0.70, 0.22));

        let y = boxY + boxH - 22;
        for (const line of lines) {
          if (y <= boxY + 20) break; // don't overflow the box
          if (line === "") { y -= BODY_LH * 0.5; continue; }
          pg.drawText(safeStr(line), {
            x: MARGIN, y, size: BODY_SIZE, font, color: rgb(0.1, 0.08, 0.03),
          });
          y -= BODY_LH;
        }
      }
    } // end slot loop
  } // end chapter loop

  // ════════════════════════════════════════════════════════════
  // BACK COVER
  // ════════════════════════════════════════════════════════════
  {
    pageNum++;
    const pg = pdfDoc.addPage([w, h]);

    if (coverBackImg) {
      drawImageCover(pg, coverBackImg, 0, 0, w, h);
      pg.drawRectangle({ x: 0, y: 0, width: w, height: 44, color: rgb(0, 0, 0), opacity: 0.50 });
      pg.drawText("Created with NoorStudio", {
        x: MARGIN, y: 14, size: 9, font, color: rgb(1, 1, 1),
      });
    } else {
      // Text-only back cover
      pg.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb(0.99, 0.96, 0.88) });
      pg.drawRectangle({ x: 0, y: h - 100, width: w, height: 100, color: rgb(0.93, 0.82, 0.45) });
      pg.drawRectangle({ x: 0, y: 0,       width: w, height: 100, color: rgb(0.93, 0.82, 0.45) });

      // "The End"
      const endText = "The End";
      let ew = 150; try { ew = boldFont.widthOfTextAtSize(endText, 36); } catch {}
      pg.drawText(endText, {
        x: w / 2 - ew / 2, y: h / 2 + 10,
        size: 36, font: boldFont, color: rgb(0.18, 0.13, 0.03),
      });

      drawStars(pg, w / 2, h / 2 - 22, font, 5);

      if (moral) {
        const mLines = wrapLines(`"${moral}"`, font, 12, CW - 20);
        let my = h / 2 - 52;
        for (const l of mLines.slice(0, 3)) {
          if (!l) continue;
          let lw2 = CW; try { lw2 = font.widthOfTextAtSize(l, 12); } catch {}
          pg.drawText(safeStr(l), {
            x: w / 2 - lw2 / 2, y: my,
            size: 12, font, color: rgb(0.25, 0.18, 0.05),
          });
          my -= 18;
        }
      }

      if (author) {
        const byLine = `by ${author}`;
        let bw2 = 80; try { bw2 = font.widthOfTextAtSize(byLine, 13); } catch {}
        pg.drawText(byLine, {
          x: w / 2 - bw2 / 2, y: 66,
          size: 13, font, color: rgb(0.3, 0.22, 0.05),
        });
      }
      pg.drawText("Created with NoorStudio", {
        x: MARGIN, y: 14, size: 8, font, color: rgb(0.55, 0.45, 0.2),
      });
    }
  }

  console.log(`[pdf] Done — ${pageNum} pages, ${chapters.length} chapters, ${Object.keys(illImgs).length} illustrated.`);
  return await pdfDoc.save({ useObjectStreams: false });
}