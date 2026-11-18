/**
 * Subsequence match — the same shape of matching every quick-open uses: null
 * when `query` is not a subsequence of `candidate`, else a score, lower for
 * a closer match. Shared by the `+` picker and the chat's `@` file mentions.
 */
export function fuzzyScore(candidate: string, query: string): number | null {
  if (query === '') {
    return 0;
  }
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at === -1) {
      return null;
    }
    // Adjacent characters, and matches right after a path separator, are what
    // the user was actually aiming at.
    if (at === previous + 1) {
      score -= 2;
    }
    if (at === 0 || haystack[at - 1] === '/' || haystack[at - 1] === '.') {
      score -= 3;
    }
    score += at - from;
    previous = at;
    from = at + 1;
  }
  return score;
}
