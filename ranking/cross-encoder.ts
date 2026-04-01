import { CohereClient } from "cohere-ai";

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY ?? "" });

export interface RerankInput {
  url: string;
  title: string;
  body: string;
  score: number;
}

export async function rerankWithCrossEncoder(
  query: string,
  candidates: RerankInput[],
  topN = 10,
): Promise<RerankInput[]> {
  const response = await cohere.rerank({
    model: "rerank-english-v3.0",
    query,
    documents: candidates.map((candidate) => `${candidate.title}\n\n${candidate.body.slice(0, 500)}`),
    topN,
    returnDocuments: false,
  });

  return response.results.map((result) => ({
    ...candidates[result.index],
    score: result.relevanceScore,
  }));
}
