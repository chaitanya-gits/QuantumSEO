import { getPageRanks } from "../crawler/pagerank.js";

export async function lookupPageRankScores(urls: string[]): Promise<Record<string, number>> {
  return getPageRanks(urls);
}
