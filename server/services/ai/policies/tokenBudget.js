/**
 * Per-stage token budgets for Claude.
 * maxPromptTokens: reject request early if prompt exceeds this.
 * maxOutputTokens: cap Claude's response.
 */
export const AI_TOKEN_BUDGETS = {
  outline:       { maxPromptTokens: 4000,  maxOutputTokens: 2000 },
  chapter:       { maxPromptTokens: 6000,  maxOutputTokens: 3000 },
  humanize:      { maxPromptTokens: 8000,  maxOutputTokens: 3000 },
  illustrations: { maxPromptTokens: 2000,  maxOutputTokens: 500  },
  cover:         { maxPromptTokens: 2000,  maxOutputTokens: 500  },
};

/**
 * Rough token estimate: 1 token ≈ 4 characters.
 * @param {string} text
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}
