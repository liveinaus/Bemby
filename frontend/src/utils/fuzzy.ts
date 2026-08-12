// Client-side fuzzy scoring, kept in step with the server's backend/src/db/fuzzy.ts so a
// list ranks the same whether it is filtered here or by the API.

// Scores how well a single token matches the haystack. 0 = no match; higher = better.
// Substring matches beat subsequence matches; earlier and tighter matches score higher.
function scoreToken(token: string, hay: string): number {
  if (!token) return 1;

  const idx = hay.indexOf(token);
  if (idx >= 0) return 1000 - Math.min(idx, 400);

  let hayPos = 0;
  let firstPos = -1;
  let lastPos = -1;
  for (const ch of token) {
    const found = hay.indexOf(ch, hayPos);
    if (found < 0) return 0;
    if (firstPos < 0) firstPos = found;
    lastPos = found;
    hayPos = found + 1;
  }
  const spread = lastPos - firstPos + 1;
  return Math.max(1, 400 - (spread - token.length) * 5 - Math.min(firstPos, 100));
}

// Multi-word query: every whitespace-separated token must match somewhere in the haystack.
export function fuzzyScore(needle: string, haystack: string): number {
  if (!needle.trim()) return 1;
  if (!haystack) return 0;

  const hay = haystack.toLowerCase();
  let total = 0;
  for (const token of needle.toLowerCase().split(/\s+/).filter(Boolean)) {
    const s = scoreToken(token, hay);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}
