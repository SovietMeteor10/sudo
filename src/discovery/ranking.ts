export function scoreHandle(handle: string, query: string): number | null {
  if (handle === query) return 0;
  if (handle.startsWith(query)) return 1;
  if (handle.includes(query)) return 2;
  if (isSubsequence(query, handle)) return 3;
  return null;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor++;
    if (cursor === needle.length) return true;
  }

  return false;
}
