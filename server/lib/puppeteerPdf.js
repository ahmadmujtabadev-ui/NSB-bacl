// server/lib/puppeteerPdf.js
// Renders an array of HTML page strings to a single PDF using Puppeteer's
// native tab.pdf() — bypasses pdf-lib embedJpg entirely, so the 17MB offset
// overflow can never occur regardless of resolution or page count.
//
// pdf-lib is ONLY used for the final merge step (adds ~100 bytes/page, safe).
//
// FIXES vs previous version:
// ✅ No JPEG screenshot → no pdf-lib offset overflow
// ✅ Full resolution preserved (Chrome renders vector, not pixel JPEG)
// ✅ Text is selectable/searchable in the output PDF
// ✅ Fonts rendered natively by Chrome (no rasterization artifacts)
// ✅ Single browser instance reused across all pages
// ✅ Font preloading + broken image repair preserved from previous version

import { PDFDocument } from 'pdf-lib';

// On Vercel use chromium-min with a remote Chromium pack; locally use the full puppeteer bundle.
const IS_VERCEL = !!process.env.VERCEL;
const DEFAULT_CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar';

async function launchBrowser() {
  if (IS_VERCEL) {
    const [{ default: chromium }, { default: puppeteerCore }] = await Promise.all([
      import('@sparticuz/chromium-min'),
      import('puppeteer-core'),
    ]);

    const chromiumPackUrl = process.env.CHROMIUM_REMOTE_EXEC_PATH || DEFAULT_CHROMIUM_PACK_URL;

    return puppeteerCore.launch({
      args: puppeteerCore.defaultArgs({ args: chromium.args, headless: 'shell' }),
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(chromiumPackUrl),
      headless: 'shell',
    });
  }
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch({
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
}

// ─── Platform configs ─────────────────────────────────────────────────────────
// Viewport dims at 96 dpi; PDF dims are the Puppeteer paper size.
// KDP/IngramSpark children's books are square 8.5×8.5 in (with 0.125" bleed
// the physical PDF is 8.75×8.75 in). Apple Books stays portrait 6×8 in.

export const PLATFORM_PDF_CONFIGS = {
  kdp: {
    viewportW: 840,           // 8.75 in × 96 dpi (bleed included)
    viewportH: 840,
    pdfWidth:  '8.75in',      // trimSize + bleed on all four edges
    pdfHeight: '8.75in',
  },
  apple: {
    viewportW: 576,           // 6 in × 96 dpi
    viewportH: 768,
    pdfWidth:  '6in',
    pdfHeight: '8in',
  },
  ingram: {
    viewportW: 840,
    viewportH: 840,
    pdfWidth:  '8.75in',
    pdfHeight: '8.75in',
  },
};

const DEFAULT_PLATFORM = PLATFORM_PDF_CONFIGS.kdp;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Converts an array of HTML strings (one per page) into a single multi-page PDF buffer.
 *
 * @param {string[]} htmlPages    - Array of self-contained HTML strings from renderPageHtml.js
 * @param {string}   _templateId  - Unused here; kept for API compatibility
 * @param {string}   platformId   - 'kdp' | 'apple' | 'ingram' — controls page size
 * @returns {Promise<Buffer>}     - Raw PDF bytes ready to stream/save
 */
export async function renderHtmlPagesToPdf(htmlPages, _templateId = 'classic', platformId = 'kdp') {
  const pCfg = PLATFORM_PDF_CONFIGS[platformId] ?? DEFAULT_PLATFORM;

  // ── Launch ONE browser for all pages ───────────────────────────────────────
  const browser = await launchBrowser();

  // Collect one single-page PDF buffer per HTML page
  const pdfChunks = [];

  try {
    const tab = await browser.newPage();

    // Allow cross-origin Cloudinary image requests
    await tab.setExtraHTTPHeaders({ Accept: 'image/*, */*' });

    await tab.setViewport({
      width:             pCfg.viewportW,
      height:            pCfg.viewportH,
      deviceScaleFactor: 1,  // no effect on PDF quality, keep at 1 to avoid excess memory
    });

    tab.setDefaultNavigationTimeout(0);

    // ── Per-page render loop ─────────────────────────────────────────────────
    for (let i = 0; i < htmlPages.length; i++) {
      const html = htmlPages[i];

      try {
        await tab.setContent(html, {
          waitUntil: 'load',
          timeout: 0,
        });

        // Wait for fonts and images — with a 15s ceiling per page
        await Promise.race([
          tab.evaluate(async () => {
            const fontsAttr = document.body.getAttribute('data-fonts') || '';
            const pageFonts = fontsAttr
              .split(',')
              .map((f) => f.trim())
              .filter(Boolean);

            const WEIGHTS = ['400', '700'];
            const STYLES = ['normal', 'italic'];

            const fontLoads = [];
            for (const family of pageFonts) {
              for (const weight of WEIGHTS) {
                for (const style of STYLES) {
                  const spec = `${style} ${weight} 16px "${family}"`;
                  fontLoads.push(document.fonts.load(spec).catch(() => null));
                }
              }
            }

            // Force-reload any broken/not-yet-loaded images
            const allImgs = Array.from(document.images);
            const imageLoads = allImgs.map(
              (img) =>
                new Promise((resolve) => {
                  if (img.complete && img.naturalWidth > 0) { resolve(null); return; }
                  img.addEventListener('load',  resolve, { once: true });
                  img.addEventListener('error', resolve, { once: true });
                  const src = img.src;
                  img.src = '';
                  img.src = src;
                })
            );

            await Promise.all([
              ...fontLoads,
              ...imageLoads,
              document.fonts.ready,
            ]);
          }),
          delay(15000),
        ]);

        // Extra paint delay for GPU rasterization
        await delay(800);

        const pdfBuffer = await tab.pdf({
          width:           pCfg.pdfWidth,
          height:          pCfg.pdfHeight,
          printBackground: true,
          margin:          { top: 0, bottom: 0, left: 0, right: 0 },
          pageRanges:      '1',
        });

        pdfChunks.push(Buffer.from(pdfBuffer));
        console.log(
          `[puppeteerPdf] Page ${i + 1}/${htmlPages.length} rendered (${(
            pdfBuffer.byteLength / 1024
          ).toFixed(1)} KB)`
        );
      } catch (error) {
        console.error(`[puppeteerPdf] Failed on page ${i + 1}:`, error);
        throw error;
      }
    }

  } finally {
    // Always close the browser, even if a page throws
    await browser.close();
  }

  // ── Merge all single-page PDFs into one document ──────────────────────────
  // pdf-lib is ONLY used here for page-copying, which adds a tiny fixed amount
  // of bytes per page — the offset overflow that affected embedJpg cannot occur.
  console.log(`[puppeteerPdf] Merging ${pdfChunks.length} pages into final PDF…`);

  const merged = await PDFDocument.create();

  for (const chunk of pdfChunks) {
    const src = await PDFDocument.load(chunk);
    const [page] = await merged.copyPages(src, [0]);
    merged.addPage(page);
  }

  const finalBytes = await merged.save();
  console.log(`[puppeteerPdf] Final PDF: ${(finalBytes.byteLength / 1024).toFixed(1)} KB, ${pdfChunks.length} pages`);

  return Buffer.from(finalBytes);
}

// // server/lib/puppeteerPdf.js
// // Renders an array of HTML page strings to JPEG screenshots via Puppeteer,
// // then assembles them into a single PDF using pdf-lib.
// //
// // FIXES:
// // 7. Font preloading — reads data-fonts from body and calls document.fonts.load()
// //    for each required font before screenshotting.
// // +  Paint delay increased to 800ms for font rasterization time.
// // +  waitUntil: 'load' — waits for ALL resources to finish or error.
// // +  Single browser instance reused across all pages (faster).
// // +  Force-reload broken images after setContent.

// import puppeteer from 'puppeteer';
// import { PDFDocument } from 'pdf-lib';

// const VIEWPORT_W = 750;
// const VIEWPORT_H = 1000;
// const SCALE      = 2;

// const PDF_W_PT = 6 * 72;   // 432 pt
// const PDF_H_PT = 8 * 72;   // 576 pt

// const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// // All font families the editor can use — used for explicit font loading
// const ALL_EDITOR_FONTS = [
//   'Fredoka One', 'Baloo 2', 'Nunito', 'Poppins', 'Playfair Display',
//   'Raleway', 'Amiri', 'Cairo', 'Merriweather', 'Lato', 'Oswald',
//   'Montserrat', 'Dancing Script', 'Pacifico', 'Cinzel',
// ];

// export async function renderHtmlPagesToPdf(htmlPages, _templateId = 'classic') {
//   // ── Launch ONE browser for all pages ─────────────────────────────────────
//   const browser = await puppeteer.launch({
//     headless: 'new',
//     args: [
//       '--no-sandbox',
//       '--disable-setuid-sandbox',
//       '--disable-dev-shm-usage',
//       '--disable-gpu',
//       '--font-render-hinting=none',
//       '--force-color-profile=srgb',
//       '--disable-web-security',
//       '--allow-running-insecure-content',
//       '--ignore-certificate-errors',
//     ],
//   });

//   const jpegBuffers = [];

//   try {
//     const tab = await browser.newPage();

//     // Allow cross-origin Cloudinary image requests
//     await tab.setExtraHTTPHeaders({ 'Accept': 'image/*, */*' });

//     await tab.setViewport({
//       width:             VIEWPORT_W,
//       height:            VIEWPORT_H,
//       deviceScaleFactor: SCALE,
//     });

//     tab.setDefaultNavigationTimeout(0);

//     for (let i = 0; i < htmlPages.length; i++) {
//       const html = htmlPages[i];

//       // 'load' fires once when ALL resources have finished or errored
//       // (unlike networkidle2 which resets on every new request)
//       await tab.setContent(html, {
//         waitUntil: 'load',
//         timeout:   30_000,
//       });

//       // ── FIX 7: Explicit font loading + broken image repair ─────────────
//       await Promise.race([
//         tab.evaluate(async () => {
//           // Read which fonts this page actually needs from data-fonts attribute
//           const fontsAttr = document.body.getAttribute('data-fonts') || '';
//           const pageFonts = fontsAttr
//             .split(',')
//             .map(f => f.trim())
//             .filter(Boolean);

//           // Weights and styles to preload for each font
//           const WEIGHTS  = ['400', '700'];
//           const STYLES   = ['normal', 'italic'];

//           // Force-load each font variant explicitly
//           const fontLoads = [];
//           for (const family of pageFonts) {
//             for (const weight of WEIGHTS) {
//               for (const style of STYLES) {
//                 const spec = `${style} ${weight} 16px "${family}"`;
//                 fontLoads.push(
//                   document.fonts.load(spec).catch(() => null)
//                 );
//               }
//             }
//           }

//           // Repair any broken images (CORS timing, CDN cold cache)
//           const imageRepairs = Array.from(document.images)
//             .filter(img => !img.complete || img.naturalWidth === 0)
//             .map(img => new Promise(resolve => {
//               img.addEventListener('load',  resolve, { once: true });
//               img.addEventListener('error', resolve, { once: true });
//               const src = img.src;
//               img.src = '';
//               img.src = src;
//             }));

//           await Promise.all([
//             ...fontLoads,
//             ...imageRepairs,
//             document.fonts.ready,
//           ]);
//         }),
//         delay(12_000), // hard ceiling — never wait more than 12s per page
//       ]);

//       // FIX 7 — Extra paint delay for font rasterization (increased from 400ms)
//       await delay(800);

//       const buffer = await tab.screenshot({
//         type:           'jpeg',
//         quality:        95,
//         clip: { x: 0, y: 0, width: VIEWPORT_W, height: VIEWPORT_H },
//         omitBackground: false,
//       });

//       jpegBuffers.push(buffer);
//     }
//   } finally {
//     await browser.close();
//   }

//   // ── Assemble PDF ──────────────────────────────────────────────────────────
//   const pdfDoc = await PDFDocument.create();

//   for (const jpegBuf of jpegBuffers) {
//     const jpegImage = await pdfDoc.embedJpg(jpegBuf);
//     const pdfPage   = pdfDoc.addPage([PDF_W_PT, PDF_H_PT]);
//     pdfPage.drawImage(jpegImage, {
//       x: 0, y: 0,
//       width:  PDF_W_PT,
//       height: PDF_H_PT,
//     });
//   }

//   return Buffer.from(await pdfDoc.save());
// }
