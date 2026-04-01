export function applyFreshnessDecay(score: number, crawledAt: string, halfLifeDays = 90): number {
  const crawledAtMs = new Date(crawledAt).getTime();
  if (Number.isNaN(crawledAtMs)) {
    return score;
  }

  const daysSinceCrawl = Math.max(0, (Date.now() - crawledAtMs) / (1000 * 60 * 60 * 24));
  return score * Math.exp(-daysSinceCrawl / halfLifeDays);
}
