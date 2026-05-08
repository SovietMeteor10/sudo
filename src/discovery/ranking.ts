export function scoreHandle(handle: string, query: string): number | null {
  if (handle === query) return 0;
  if (handle.startsWith(query)) return 1;
  if (handle.includes(query)) return 2;
  if (isSubsequence(query, handle)) return 3;
  return null;
}

export type DiscoveryRankingCounts = {
  recommend_count: number;
  downrank_count: number;
  reply_count: number;
  repost_count: number;
  report_count: number;
  recent_recommend_count_24h: number;
  recent_downrank_count_24h: number;
  recent_reply_count_24h: number;
  recent_repost_count_24h: number;
  recent_report_count_24h: number;
};

export type DiscoveryRankingResult = {
  hot_score: number;
  rising_score: number;
  explanation: string;
};

export function scoreDiscoveryPost(
  createdAt: string,
  counts: DiscoveryRankingCounts
): DiscoveryRankingResult {
  const ageHours = Math.max(1, hoursSince(createdAt));
  const hotRaw = (
    counts.recommend_count * 3
    + counts.repost_count * 4
    + counts.reply_count * 2
    - counts.downrank_count * 2
    - counts.report_count * 8
  ) / Math.pow(ageHours + 2, 1.2);

  const risingRaw = (
    counts.recent_recommend_count_24h * 3
    + counts.recent_repost_count_24h * 4
    + counts.recent_reply_count_24h * 2
    - counts.recent_downrank_count_24h * 2
    - counts.recent_report_count_24h * 8
  );

  return {
    hot_score: roundScore(hotRaw),
    rising_score: roundScore(risingRaw),
    explanation: explainDiscoveryRanking(counts)
  };
}

function explainDiscoveryRanking(counts: DiscoveryRankingCounts): string {
  if (counts.recent_recommend_count_24h > 0 || counts.recent_repost_count_24h > 0 || counts.recent_reply_count_24h > 0) {
    const pieces = [
      counts.recent_recommend_count_24h > 0 ? `${counts.recent_recommend_count_24h} recommendation${counts.recent_recommend_count_24h === 1 ? "" : "s"}` : null,
      counts.recent_repost_count_24h > 0 ? `${counts.recent_repost_count_24h} repost${counts.recent_repost_count_24h === 1 ? "" : "s"}` : null,
      counts.recent_reply_count_24h > 0 ? `${counts.recent_reply_count_24h} repl${counts.recent_reply_count_24h === 1 ? "y" : "ies"}` : null
    ].filter((piece): piece is string => piece !== null);
    return `Rising because ${joinEnglish(pieces)} recently.`;
  }

  if (counts.report_count > 0) {
    return `Ranked lower because it has ${counts.report_count} report${counts.report_count === 1 ? "" : "s"}.`;
  }

  const positives = [
    counts.recommend_count > 0 ? `${counts.recommend_count} recommendation${counts.recommend_count === 1 ? "" : "s"}` : null,
    counts.reply_count > 0 ? `${counts.reply_count} repl${counts.reply_count === 1 ? "y" : "ies"}` : null,
    counts.repost_count > 0 ? `${counts.repost_count} repost${counts.repost_count === 1 ? "" : "s"}` : null
  ].filter((piece): piece is string => piece !== null);

  if (positives.length > 0) {
    return `Popular because it has ${joinEnglish(positives)}.`;
  }

  return "Ranked by transparent reaction counts and age.";
}

function hoursSince(createdAt: string): number {
  const created = new Date(createdAt).valueOf();
  if (Number.isNaN(created)) return 1;
  return Math.max(1, (Date.now() - created) / 3_600_000);
}

function roundScore(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}

function joinEnglish(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor++;
    if (cursor === needle.length) return true;
  }

  return false;
}
