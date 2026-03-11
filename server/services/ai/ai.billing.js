/**
 * Credit costs per AI stage (per call, not per book).
 * Chapters and humanize costs are PER CHAPTER — multiply by chapterCount in the route.
 */
export const STAGE_CREDIT_COSTS = {
  outline:       3,   // fixed per book
  chapter:       2,   // per chapter
  humanize:      1,   // per chapter
  illustrations: 4,   // per chapter (3 variants)
  cover:         5,   // fixed per book (front + back)
  layout:        0,   // no charge
  export:        4,   // fixed per export (2 PDF + 2 EPUB)
  portrait:      2,   // character portrait generation
  poseSheet:     3,   // character pose sheet (12 poses)
};

/**
 * Max images allowed per stage to prevent runaway generation.
 */
export const IMAGE_LIMITS = {
  illustrations: 3,  // variants per chapter
  cover: 2,          // front + back
  portrait: 1,
  poseSheet: 1,
};
