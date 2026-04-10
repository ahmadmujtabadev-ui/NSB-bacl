// server/lib/puppeteerPdf.js
// Renders an array of HTML page strings to JPEG screenshots via Puppeteer,
// then assembles them into a single PDF using pdf-lib.
//
// Puppeteer settings:
//   viewport: 750×1000 @ deviceScaleFactor=2  (retina — 1500×2000 actual pixels)
//   screenshot: JPEG quality 95, clipped to 750×1000 logical px
//   waitUntil: 'domcontentloaded' (avoids timeout on remote images/fonts CDN)
//              + bounded font-ready wait + image-decode wait
//
// PDF output:
//   Page size: 432pt × 576pt  (6" × 8" = 152.4mm × 203.2mm)
//   No margins — images bleed to edge

import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const VIEWPORT_W  = 750;
const VIEWPORT_H  = 1000;
const SCALE       = 2;    // retina rendering for crisp output

// 6" × 8" in PDF points (1 inch = 72 pt)
const PDF_W_PT = 6 * 72;  // 432 pt
const PDF_H_PT = 8 * 72;  // 576 pt

/** Resolves after `ms` milliseconds — used as a ceiling on font/image waits. */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Renders an array of HTML strings into a single PDF Buffer.
 *
 * @param {string[]} htmlPages   — one HTML string per book page
 * @returns {Promise<Buffer>}    — the assembled PDF
 */
export async function renderHtmlPagesToPdf(htmlPages) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',   // sharper text rendering
      '--force-color-profile=srgb',
    ],
  });

  const jpegBuffers = [];

  try {
    const tab = await browser.newPage();

    await tab.setViewport({
      width:             VIEWPORT_W,
      height:            VIEWPORT_H,
      deviceScaleFactor: SCALE,
    });

    for (let i = 0; i < htmlPages.length; i++) {
      const html = htmlPages[i];

      // Use 'domcontentloaded' — avoids hanging on slow/blocked remote resources
      // (Google Fonts CDN, Cloudinary image URLs) that prevent networkidle0.
      await tab.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });

      // Wait for fonts AND images, but cap at 8 s so one slow asset can't block export.
      await Promise.race([
        Promise.all([
          // Google Fonts glyphs
          tab.evaluateHandle(() => document.fonts.ready),
          // Remote images decode
          tab.evaluate(() =>
            Promise.all(
              Array.from(document.images).map((img) =>
                img.complete
                  ? Promise.resolve()
                  : new Promise((r) => { img.onload = r; img.onerror = r; }),
              ),
            ),
          ),
        ]),
        delay(8_000), // ceiling: never wait more than 8 s per page
      ]);

      const buffer = await tab.screenshot({
        type:            'jpeg',
        quality:         95,
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
    await browser.close();
  }

  // ── Assemble into one PDF with pdf-lib ────────────────────────────────────
  const pdfDoc = await PDFDocument.create();

  for (const jpegBuf of jpegBuffers) {
    const jpegImage = await pdfDoc.embedJpg(jpegBuf);
    const page = pdfDoc.addPage([PDF_W_PT, PDF_H_PT]);

    // Draw image to fill the page (no margins — bleed to edge)
    page.drawImage(jpegImage, {
      x:      0,
      y:      0,
      width:  PDF_W_PT,
      height: PDF_H_PT,
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
