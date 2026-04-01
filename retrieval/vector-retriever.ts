import { Pool } from "pg";
import { embedQuery } from "../crawler/embedder.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface VectorSearchResult {
  url: string;
  title: string;
  body: string;
  score: number;
  rank: number;
}

export async function vectorSearch(query: string, topK = 100): Promise<VectorSearchResult[]> {
  const queryVec = await embedQuery(query);
  const vecString = `[${queryVec.join(",")}]`;

  const result = await pool.query<{
    url: string;
    title: string;
    body_snippet: string;
    pagerank: number;
    cosine_score: string | number;
  }>(
    `SELECT url, title, body_snippet, pagerank,
       1 - (embedding <=> $1::vector) AS cosine_score
     FROM page_embeddings
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vecString, topK],
  );

  return result.rows.map((row, rank) => ({
    url: row.url,
    title: row.title,
    body: row.body_snippet,
    score: Number.parseFloat(String(row.cosine_score)),
    rank,
  }));
}
