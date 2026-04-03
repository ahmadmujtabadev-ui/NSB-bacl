/**
 * DEFAULT_COVER_TEMPLATES
 * 10 distinct book-cover visual styles. The selected template's promptDirective
 * is injected into every cover-generation prompt via buildCoverKbBlock().
 */
export const DEFAULT_COVER_TEMPLATES = [
  {
    _id: "ct_classic_children",
    name: "Classic Children's Adventure",
    style: "classic-children",
    palette: ["#FFD700", "#FF6B35", "#4FC3F7", "#81C784"],
    description: "Bright, joyful colors with bold rounded fonts and a playful character center",
    promptDirective:
      "COVER TEMPLATE — CLASSIC CHILDREN'S ADVENTURE: Bright vivid children's book illustration; vibrant warm yellows, oranges, and sky blue; bold playful rounded typography feel in the layout; cheerful expressive character; colorful simple shapes and elements; high saturation; welcoming friendly mood. Think Kube Publishing junior range — sunlit, safe, inviting.",
    typography: "Bold rounded — Fredoka One, Baloo Bhaijaan",
    composition: "Character centered lower half, big expressive sky background, playful floating elements",
    atmosphere: "Bright joyful sunshine, warm golden light, safe familiar world",
  },
  {
    _id: "ct_epic_cinematic",
    name: "Epic Cinematic",
    style: "epic-cinematic",
    palette: ["#1A1A2E", "#16213E", "#533483", "#E94560"],
    description: "Dark dramatic backgrounds with silhouetted hero and cinematic lighting",
    promptDirective:
      "COVER TEMPLATE — EPIC CINEMATIC: Cinematic book cover; dramatic dark purple and midnight blue sky; character silhouetted or edge-lit with dramatic rim lighting; epic wide-angle composition; deep atmosphere with volumetric fog; glowing title zone treatment; sense of scale and adventure matching published YA/MG fantasy novels. Rich, moody, emotionally intense.",
    typography: "Bold condensed serif — Cinzel, Trajan, Bebas Neue",
    composition: "Character in lower center against vast dramatic landscape, 40% dramatic sky above",
    atmosphere: "Cinematic dramatic lighting, purple dusk sky, atmospheric fog depth, epic scale",
  },
  {
    _id: "ct_islamic_heritage",
    name: "Islamic Heritage",
    style: "islamic-heritage",
    palette: ["#1B6CA8", "#C9A84C", "#2D6A4F", "#F0EBD8"],
    description: "Rich teal and gold with Islamic geometric patterns, arabesque borders and crescent motif",
    promptDirective:
      "COVER TEMPLATE — ISLAMIC HERITAGE: Rich teal and warm gold color palette; ornate Islamic geometric border pattern subtly integrated into the scene; arabesque or mashrabiya decorative elements in the environment; crescent moon motif in sky; elegant calligraphic-feel title zone; mosque arch or Islamic architectural element visible in background; warm amber golden-hour glow; dignified and culturally rich visual that honors Islamic artistic heritage.",
    typography: "Elegant serif — Cormorant Garamond, Scheherazade New, Amiri",
    composition: "Character framed by Islamic arch or geometric environment, crescent moon in sky, decorative architectural depth",
    atmosphere: "Warm golden hour, dignified and rich, Islamic cultural heritage feel",
  },
  {
    _id: "ct_vintage_ornate",
    name: "Vintage Ornate",
    style: "vintage-ornate",
    palette: ["#2C1810", "#C9A84C", "#8B6914", "#F5E6C8"],
    description: "Dark rich background with ornate gold illustration framing — classical and prestigious",
    promptDirective:
      "COVER TEMPLATE — VINTAGE ORNATE: Dark rich chocolate-brown or deep maroon background; central illustration scene with warm candlelight quality; the overall feel should match a prestigious classical illustrated book — think ornamental gold inlay, aged richness, heraldic dignity; warm amber light sources inside the scene; sophisticated and timeless. NOT a modern cover — deliberately classical, museum-quality.",
    typography: "Classical decorative serif — Trajan, Cinzel Decorative, IM Fell English",
    composition: "Central focal illustration with formal symmetrical layout, rich layered dark background",
    atmosphere: "Rich dark classical, candlelight warmth, prestigious antique collector's edition feel",
  },
  {
    _id: "ct_modern_minimal",
    name: "Modern Minimal",
    style: "modern-minimal",
    palette: ["#FFFFFF", "#1A1A1A", "#F5A623", "#E8E8E8"],
    description: "Clean light background with a single bold geometric accent — sophisticated and contemporary",
    promptDirective:
      "COVER TEMPLATE — MODERN MINIMAL: Clean off-white or light background; single bold geometric shape (large circle, arc, or abstract brushstroke) as the dominant visual element; restrained 2-3 color palette; maximum use of negative space; contemporary design poster aesthetic; character integrated as a clean graphical element; no visual clutter. Think Scandinavian design — confident simplicity.",
    typography: "Modern geometric — Futura, Montserrat, Gill Sans MT",
    composition: "Large geometric shape as focal element, character as clean graphical focal point, strong white space",
    atmosphere: "Clean contemporary, sophisticated simplicity, strong visual tension through contrast",
  },
  {
    _id: "ct_watercolor_dream",
    name: "Watercolor Dream",
    style: "watercolor-dream",
    palette: ["#B5D5C5", "#F9C784", "#E8A598", "#C3B8E8"],
    description: "Soft pastel watercolor washes with organic botanical shapes and whimsical feel",
    promptDirective:
      "COVER TEMPLATE — WATERCOLOR DREAM: Soft pastel watercolor washes and textures throughout; hand-painted organic natural shapes; botanical elements (leaves, flowers, olive branches) softly surrounding the character; dreamy ethereal mood; visible paint brushstroke texture; translucent color layers overlapping; warm cream or blush background tone; whimsical, gentle, handcrafted feel that evokes a cozy illustrated picture book.",
    typography: "Handwritten or organic — Caveat, Pacifico, Sacramento, Reenie Beanie",
    composition: "Character gently surrounded by flowing botanical watercolor elements, soft blended background",
    atmosphere: "Dreamy soft pastels, gentle whimsy, handcrafted warmth, magical and safe",
  },
  {
    _id: "ct_night_sky",
    name: "Night Sky",
    style: "night-sky",
    palette: ["#0B0D2E", "#1A2456", "#C9A84C", "#E8E8FF"],
    description: "Deep midnight navy with starfield, glowing crescent moon and mystical atmosphere",
    promptDirective:
      "COVER TEMPLATE — NIGHT SKY: Deep midnight navy blue sky filling most of the canvas; starfield or galaxy texture stretching overhead; prominent glowing crescent moon high in the sky; distant mosque silhouette or minaret at the horizon glowing warmly; magical luminous elements (glowing particles, soft light rays); cool deep blues and purples with warm gold accents creating beautiful contrast; mystical, awe-inspiring, spiritually resonant atmosphere.",
    typography: "Elegant luminous serif — Cormorant Garamond, Crimson Pro, EB Garamond",
    composition: "Character in lower third, vast starry sky dominates upper portion, crescent moon prominent, glowing horizon",
    atmosphere: "Magical night, deep cool blues and purples, warm gold glow, mystical and awe-inspiring",
  },
  {
    _id: "ct_storybook_warm",
    name: "Storybook Warm",
    style: "storybook-warm",
    palette: ["#F5A623", "#D4781E", "#8B4513", "#FFF3E0"],
    description: "Warm amber and golden tones with cozy illustrated feel and classic storybook character",
    promptDirective:
      "COVER TEMPLATE — STORYBOOK WARM: Warm amber, golden, and burnt orange color tones; cozy richly illustrated feel matching classic award-winning picture books; warm firelight or sunset atmosphere; inviting friendly mood where the character feels like a trusted friend; illustrated botanical or nature elements around the edges (leaves, stars, vines); the overall warmth should make readers feel immediately safe and drawn in.",
    typography: "Friendly warm serif — Lora, Playfair Display, Libre Baskerville",
    composition: "Character in warm lit scene with cozy environmental storytelling elements around them",
    atmosphere: "Warm cozy golden firelight, inviting classic storybook mood, safe and enchanting",
  },
  {
    _id: "ct_bold_typography",
    name: "Bold Typography",
    style: "bold-typography",
    palette: ["#F5F5F5", "#1A1A1A", "#E63946", "#2B2D42"],
    description: "Oversized bold graphic title as the dominant design element — striking and modern",
    promptDirective:
      "COVER TEMPLATE — BOLD TYPOGRAPHY: Graphic design poster aesthetic; strong color blocking with 2-3 high-contrast colors; the composition should feel like a graphic design piece rather than a traditional illustration — bold shapes, strong diagonals, deliberate use of pattern or texture as background; character integrated as a graphic element within the composition rather than placed in front of a scene; powerful visual impact. Contemporary editorial energy.",
    typography: "Ultra-bold display — Anton, Bebas Neue, Impact, Black Han Sans",
    composition: "Bold graphic composition with strong color blocks, character integrated as part of the graphic system",
    atmosphere: "Bold graphic power, high contrast, contemporary editorial, confident and striking",
  },
  {
    _id: "ct_nature_adventure",
    name: "Nature & Adventure",
    style: "nature-adventure",
    palette: ["#2D6A4F", "#52B788", "#F9C784", "#1B4332"],
    description: "Lush greens with outdoor landscape, forest or garden setting and adventure mood",
    promptDirective:
      "COVER TEMPLATE — NATURE & ADVENTURE: Lush green forest, garden or outdoor landscape; rich botanical environment with layered foliage; dappled golden sunlight filtering through leaves creating beautiful light play; adventure and exploration mood; character shown in dynamic outdoor action within the natural setting; organic flowing natural composition; rich earthy greens, warm golds, and clear blues; growth, discovery, and life theme throughout.",
    typography: "Adventurous natural — Cabin, Nunito, Oswald, Raleway",
    composition: "Character exploring in lush layered landscape, forest or garden as expansive deep background",
    atmosphere: "Vibrant lush green nature, warm sunshine dappling through foliage, adventure and discovery",
  },
];
