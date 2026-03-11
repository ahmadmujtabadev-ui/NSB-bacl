/**
 * @typedef {Object} TextRequest
 * @property {string} system
 * @property {string} prompt
 * @property {number} maxOutputTokens
 * @property {string} [stage]
 * @property {string} [projectId]
 * @property {string} [attemptId]
 */

/**
 * @typedef {Object} TextResponse
 * @property {string} text
 * @property {{ inputTokens: number, outputTokens: number }} [usage]
 * @property {string} provider
 */

/**
 * @typedef {'illustration'|'cover'|'portrait'|'pose-sheet'} ImageTask
 *
 * @typedef {Object} ImageRequest
 * @property {ImageTask} task
 * @property {string} prompt
 * @property {string[]} [references]   - Cloudinary URLs to use as img2img references
 * @property {string} [style]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [count]
 * @property {number} [seed]
 * @property {number} [referenceStrength]
 * @property {string} [projectId]
 * @property {string} [attemptId]
 * @property {string} [traceId]
 * @property {4|8|12} [poseCount]
 */

/**
 * @typedef {Object} ImageResponse
 * @property {string} imageUrl
 * @property {Record<string,unknown>} [providerMeta]
 * @property {string} provider
 */

/**
 * @typedef {Object} UniverseContext
 * @property {import('../../../models/Project.js').Project} project
 * @property {import('../../../models/Universe.js').Universe} universe
 * @property {import('../../../models/Character.js').Character[]} characters
 * @property {import('../../../models/KnowledgeBase.js').KnowledgeBase|null} kb
 */
