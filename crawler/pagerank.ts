export interface Graph {
  [url: string]: string[];
}

export function computePageRank(
  graph: Graph,
  dampingFactor = 0.85,
  iterations = 50,
): Record<string, number> {
  const nodes = Object.keys(graph);
  const count = nodes.length;

  if (count === 0) {
    return {};
  }

  let scores: Record<string, number> = {};
  nodes.forEach((node) => {
    scores[node] = 1 / count;
  });

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next: Record<string, number> = {};
    nodes.forEach((node) => {
      next[node] = (1 - dampingFactor) / count;
    });

    for (const node of nodes) {
      const outLinks = graph[node] ?? [];
      const contribution = scores[node] / (outLinks.length || 1);

      outLinks.forEach((target) => {
        if (next[target] !== undefined) {
          next[target] += dampingFactor * contribution;
        }
      });
    }

    scores = next;
  }

  return scores;
}

export async function getPageRanks(urls: string[]): Promise<Record<string, number>> {
  return urls.reduce<Record<string, number>>((accumulator, url) => {
    accumulator[url] = 0;
    return accumulator;
  }, {});
}
