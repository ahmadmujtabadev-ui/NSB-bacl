import { LOCAL_CHARACTER_SPECS } from './localCharacterSpecs.js';

const PALETTES = {
  cover:        { bg: ['#1e5282', '#2e82c2', '#4ea2e2'], accent: '#FFD700', text: '#FFFFFF' },
  illustration: { bg: ['#FFF3E0', '#FFE0B2', '#FFCC80'], accent: '#E65100', text: '#BF360C' },
  portrait:     { bg: ['#FCE4EC', '#F8BBD9', '#F48FB1'], accent: '#C2185B', text: '#880E4F' },
};

function truncate(text, max) {
  const s = text.replace(/\n/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function cornerOrnaments(w, h, color) {
  return [{ x: 30, y: 30 }, { x: w - 30, y: 30 }, { x: 30, y: h - 30 }, { x: w - 30, y: h - 30 }]
    .map(p => `<g transform="translate(${p.x},${p.y})">
      <circle r="25" fill="none" stroke="${color}" stroke-width="2"/>
      <circle r="15" fill="none" stroke="${color}" stroke-width="1.5"/>
      <circle r="7"  fill="${color}" opacity="0.3"/>
    </g>`).join('');
}

function characterSVG(char, x, y, scale) {
  const h = scale * 0.3, bh = scale * 0.5;
  return `<g transform="translate(${x},${y})">
    <ellipse cx="0" cy="${bh*0.4}" rx="${h*0.8}" ry="${bh*0.5}" fill="${char.clothingColor}"/>
    <circle cx="0" cy="-${h*0.5}" r="${h}" fill="${char.skinTone}"/>
    ${char.hijabColor !== 'none'
      ? `<ellipse cx="0" cy="-${h*0.7}" rx="${h*1.1}" ry="${h*0.9}" fill="${char.hijabColor}"/>
         <ellipse cx="0" cy="-${h*0.3}" rx="${h*0.95}" ry="${h*0.7}" fill="${char.skinTone}"/>`
      : `<ellipse cx="0" cy="-${h*0.8}" rx="${h*0.9}" ry="${h*0.5}" fill="${char.hairColor}"/>`}
    <circle cx="-${h*0.25}" cy="-${h*0.5}" r="${h*0.08}" fill="#3D2817"/>
    <circle cx="${h*0.25}"  cy="-${h*0.5}" r="${h*0.08}" fill="#3D2817"/>
    <path d="M-${h*0.15},-${h*0.25} Q0,-${h*0.15} ${h*0.15},-${h*0.25}" stroke="#3D2817" stroke-width="2" fill="none"/>
    <text x="0" y="${bh*0.7}" font-family="Arial" font-size="12" fill="#333" text-anchor="middle" font-weight="bold">${char.name}</text>
  </g>`;
}

/**
 * Generate a simple SVG illustration as a data-URL.
 * @param {string} description
 * @param {string} task  'illustration' | 'cover' | 'portrait'
 * @param {{ width: number, height: number }} size
 */
export function generateLocalIllustration(description, task = 'illustration', size = { width: 800, height: 600 }) {
  const { width: w, height: h } = size;
  const p = PALETTES[task] || PALETTES.illustration;
  const desc = description.toLowerCase();

  let chars = '';
  let cx = w * 0.3;
  for (const [key, spec] of Object.entries(LOCAL_CHARACTER_SPECS)) {
    if (desc.includes(key)) {
      chars += characterSVG(spec, cx, h * 0.55, h * 0.35);
      cx += w * 0.25;
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   style="stop-color:${p.bg[0]}"/>
      <stop offset="50%"  style="stop-color:${p.bg[1]}"/>
      <stop offset="100%" style="stop-color:${p.bg[2]}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="15" y="15" width="${w-30}" height="${h-30}" fill="none" stroke="${p.accent}" stroke-width="3" rx="10"/>
  <rect x="25" y="25" width="${w-50}" height="${h-50}" fill="none" stroke="${p.accent}" stroke-width="1.5" rx="8" stroke-dasharray="10,5"/>
  ${cornerOrnaments(w, h, p.accent)}
  ${chars}
  <rect x="40" y="${h-100}" width="${w-80}" height="65" fill="white" fill-opacity="0.85" rx="8"/>
  <text x="${w/2}" y="${h-62}" font-family="Georgia,serif" font-size="13" fill="${p.text}" text-anchor="middle">${truncate(description, 60)}</text>
  <text x="${w/2}" y="${h-42}" font-family="Georgia,serif" font-size="11" fill="${p.text}" text-anchor="middle" opacity="0.6">NoorStudio</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
