import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface VectorDocument {
  url: string;
  title: string;
  bodySnippet: string;
  embedding: number[];
  pagerank: number;
}

export async function upsertVectorDocument(doc: VectorDocument): Promise<void> {
  const vector = `[${doc.embedding.join(",")}]`;

  await pool.query(
    `INSERT INTO page_embeddings (url, title, body_snippet, embedding, pagerank)
     VALUES ($1, $2, $3, $4::vector, $5)
     ON CONFLICT (url)
     DO UPDATE SET
       title = EXCLUDED.title,
       body_snippet = EXCLUDED.body_snippet,
       embedding = EXCLUDED.embedding,
       pagerank = EXCLUDED.pagerank`,
    [doc.url, doc.title, doc.bodySnippet, vector, doc.pagerank],
  );
}
