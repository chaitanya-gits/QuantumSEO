export interface SearchResult {
  url: string;
  title: string;
  body: string;
  score: number;
  rank: number;
}

export interface FusedResult extends SearchResult {
  rrfScore: number;
  pagerankScore: number;
  sources: ("bm25" | "vector" | "expanded-bm25")[];
}

export function reciprocalRankFusion(
  lists: SearchResult[][],
  pageranks: Record<string, number>,
  k = 60,
  pagerankWeight = 0.15,
): FusedResult[] {
  const scoreMap = new Map<string, FusedResult>();
  const sourceLabels: FusedResult["sources"][number][] = ["bm25", "vector", "expanded-bm25"];

  lists.forEach((list, listIndex) => {
    list.forEach((result, rank) => {
      const rrfContribution = 1 / (k + rank);

      if (!scoreMap.has(result.url)) {
        scoreMap.set(result.url, {
          ...result,
          rrfScore: 0,
          pagerankScore: pageranks[result.url] ?? 0,
          sources: [],
        });
      }

      const entry = scoreMap.get(result.url)!;
      entry.rrfScore += rrfContribution;
      entry.sources.push(sourceLabels[listIndex] ?? "bm25");
    });
  });

  return Array.from(scoreMap.values())
    .map((result) => ({
      ...result,
      score: result.rrfScore + pagerankWeight * Math.log(1 + result.pagerankScore),
    }))
    .sort((left, right) => right.score - left.score);
}
