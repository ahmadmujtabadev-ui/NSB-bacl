// server/lib/puppeteerPdf.js
// Renders an array of HTML page strings to JPEG screenshots via Puppeteer,
// then assembles them into a single PDF using pdf-lib.
//
// Strategy:
//   - Launch ONE browser instance for the entire export (faster — no cold-start per page)
//   - Reuse ONE tab, replacing content with setContent() per page
//   - waitUntil: 'load' — fires once when ALL resources (images, CSS, fonts)
//     have finished loading OR errored. Unlike networkidle2 which resets its
//     500ms counter on every new request (causing timeout with 20+ Cloudinary
//     images loading in parallel), 'load' has a single definitive firing point.
//   - After setContent, re-trigger any broken images and await document.fonts.ready,
//     with a 10s ceiling so one bad asset can't block the whole export
//   - 400 ms paint delay before screenshot so the browser finishes compositing
//
// PDF output: 432pt × 576pt (6" × 8"), no margins, bleed-to-edge.

import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const VIEWPORT_W = 750;
const VIEWPORT_H = 1000;
const SCALE      = 2;       // retina — actual screenshot is 1500 × 2000 px

// 6" × 8" in PDF points (1 inch = 72 pt)
const PDF_W_PT = 6 * 72;   // 432 pt
const PDF_H_PT = 8 * 72;   // 576 pt

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Renders an array of HTML page strings into a single PDF Buffer.
 *
 * @param {string[]} htmlPages   — one self-contained HTML string per book page
 * @param {string}   templateId  — template identifier (threaded through for future use)
 * @returns {Promise<Buffer>}    — assembled PDF
 */
export async function renderHtmlPagesToPdf(htmlPages, _templateId = 'classic') {
  // ── Launch once ───────────────────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',        // sharper sub-pixel glyph rendering
      '--force-color-profile=srgb',
      '--disable-web-security',            // allow cross-origin Cloudinary images
      '--allow-running-insecure-content',  // mixed-content tolerance
      '--ignore-certificate-errors',       // don't block on TLS cert issues
    ],
  });

  const jpegBuffers = [];

  try {
    // ── Single tab, reused across all pages ────────────────────────────────
    const tab = await browser.newPage();

    await tab.setViewport({
      width:             VIEWPORT_W,
      height:            VIEWPORT_H,
      deviceScaleFactor: SCALE,
    });

    for (let i = 0; i < htmlPages.length; i++) {
      const html = htmlPages[i];

      // 'load' fires once when ALL resources (images, fonts, css) have
      // finished loading OR errored — unlike networkidle2 which resets its
      // 500ms counter on every new request and never settles when 20+
      // Cloudinary images are loading in parallel (causing timeout).
      await tab.setContent(html, {
        waitUntil: 'load',
        timeout:   30_000,
      });

      // ── Post-load image repair + font wait ────────────────────────────
      // Some images may fail to decode on first load (CORS timing, CDN cold
      // cache). Force-reload any broken ones, then wait for all glyphs.
      await Promise.race([
        tab.evaluate(() => {
          const repairs = Array.from(document.images)
            .filter((img) => !img.complete || img.naturalWidth === 0)
            .map((img) => new Promise((resolve) => {
              img.addEventListener('load',  resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
              // Reset src to force a fresh network fetch
              const src = img.src;
              img.src = '';
              img.src = src;
            }));

          return Promise.all([
            Promise.all(repairs),
            document.fonts.ready,
          ]);
        }),
        delay(10_000), // ceiling — never wait more than 10 s per page
      ]);

      // Give the compositor 400 ms to paint the final frame before capture
      await delay(400);

      // ── Screenshot ────────────────────────────────────────────────────
      const buffer = await tab.screenshot({
        type:           'jpeg',
        quality:        95,
        clip: {
          x:      0,
          y:      0,
          width:  VIEWPORT_W,
          height: VIEWPORT_H,
        },
        omitBackground: false,
      });

      jpegBuffers.push(buffer);
    }
  } finally {
    // Always close — even on error — so the Chrome process is not orphaned
    await browser.close();
  }

  // ── Assemble PDF with pdf-lib ─────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();

  for (const jpegBuf of jpegBuffers) {
    const jpegImage = await pdfDoc.embedJpg(jpegBuf);
    const pdfPage   = pdfDoc.addPage([PDF_W_PT, PDF_H_PT]);

    // Draw image to fill the full page — no margins, bleed to edge
    pdfPage.drawImage(jpegImage, {
      x:      0,
      y:      0,
      width:  PDF_W_PT,
      height: PDF_H_PT,
    });
  }

  return Buffer.from(await pdfDoc.save());
}
