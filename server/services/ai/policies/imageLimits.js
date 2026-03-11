import { IMAGE_LIMITS } from '../ai.billing.js';

/**
 * Validate that the requested image count doesn't exceed limits.
 * @param {'illustration'|'cover'|'portrait'|'pose-sheet'} task
 * @param {number} requestedCount
 * @returns {{ ok: boolean, limit: number }}
 */
export function checkImageLimit(task, requestedCount) {
  const map = {
    illustration: IMAGE_LIMITS.illustrations,
    cover:        IMAGE_LIMITS.cover,
    portrait:     IMAGE_LIMITS.portrait,
    'pose-sheet': IMAGE_LIMITS.poseSheet,
  };
  const limit = map[task] ?? 1;
  return { ok: requestedCount <= limit, limit };
}
