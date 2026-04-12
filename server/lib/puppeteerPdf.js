// server/lib/puppeteerPdf.js
// Renders an array of HTML page strings to JPEG screenshots via Puppeteer,
// then assembles them into a single PDF using pdf-lib.
//
// FIXES:
// 7. Font preloading — reads data-fonts from body and calls document.fonts.load()
//    for each required font before screenshotting.
// +  Paint delay increased to 800ms for font rasterization time.
// +  waitUntil: 'load' — waits for ALL resources to finish or error.
// +  Single browser instance reused across all pages (faster).
// +  Force-reload broken images after setContent.

import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';

const VIEWPORT_W = 750;
const VIEWPORT_H = 1000;
const SCALE      = 2;

const PDF_W_PT = 6 * 72;   // 432 pt
const PDF_H_PT = 8 * 72;   // 576 pt

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// All font families the editor can use — used for explicit font loading
const ALL_EDITOR_FONTS = [
  'Fredoka One', 'Baloo 2', 'Nunito', 'Poppins', 'Playfair Display',
  'Raleway', 'Amiri', 'Cairo', 'Merriweather', 'Lato', 'Oswald',
  'Montserrat', 'Dancing Script', 'Pacifico', 'Cinzel',
];

export async function renderHtmlPagesToPdf(htmlPages, _templateId = 'classic') {
  // ── Launch ONE browser for all pages ─────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
      '--force-color-profile=srgb',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
    ],
  });

  const jpegBuffers = [];

  try {
    const tab = await browser.newPage();

    // Allow cross-origin Cloudinary image requests
    await tab.setExtraHTTPHeaders({ 'Accept': 'image/*, */*' });

    await tab.setViewport({
      width:             VIEWPORT_W,
      height:            VIEWPORT_H,
      deviceScaleFactor: SCALE,
    });

    tab.setDefaultNavigationTimeout(30_000);

    for (let i = 0; i < htmlPages.length; i++) {
      const html = htmlPages[i];

      // 'load' fires once when ALL resources have finished or errored
      // (unlike networkidle2 which resets on every new request)
      await tab.setContent(html, {
        waitUntil: 'load',
        timeout:   30_000,
      });

      // ── FIX 7: Explicit font loading + broken image repair ─────────────
      await Promise.race([
        tab.evaluate(async () => {
          // Read which fonts this page actually needs from data-fonts attribute
          const fontsAttr = document.body.getAttribute('data-fonts') || '';
          const pageFonts = fontsAttr
            .split(',')
            .map(f => f.trim())
            .filter(Boolean);

          // Weights and styles to preload for each font
          const WEIGHTS  = ['400', '700'];
          const STYLES   = ['normal', 'italic'];

          // Force-load each font variant explicitly
          const fontLoads = [];
          for (const family of pageFonts) {
            for (const weight of WEIGHTS) {
              for (const style of STYLES) {
                const spec = `${style} ${weight} 16px "${family}"`;
                fontLoads.push(
                  document.fonts.load(spec).catch(() => null)
                );
              }
            }
          }

          // Repair any broken images (CORS timing, CDN cold cache)
          const imageRepairs = Array.from(document.images)
            .filter(img => !img.complete || img.naturalWidth === 0)
            .map(img => new Promise(resolve => {
              img.addEventListener('load',  resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
              const src = img.src;
              img.src = '';
              img.src = src;
            }));

          await Promise.all([
            ...fontLoads,
            ...imageRepairs,
            document.fonts.ready,
          ]);
        }),
        delay(12_000), // hard ceiling — never wait more than 12s per page
      ]);

      // FIX 7 — Extra paint delay for font rasterization (increased from 400ms)
      await delay(800);

      const buffer = await tab.screenshot({
        type:           'jpeg',
        quality:        95,
        clip: { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H },
        omitBackground: false,
      });

      jpegBuffers.push(buffer);
    }
  } finally {
    await browser.close();
  }

  // ── Assemble PDF ──────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create();

  for (const jpegBuf of jpegBuffers) {
    const jpegImage = await pdfDoc.embedJpg(jpegBuf);
    const pdfPage   = pdfDoc.addPage([PDF_W_PT, PDF_H_PT]);
    pdfPage.drawImage(jpegImage, {
      x: 0, y: 0,
      width:  PDF_W_PT,
      height: PDF_H_PT,
    });
  }

  return Buffer.from(await pdfDoc.save());
}