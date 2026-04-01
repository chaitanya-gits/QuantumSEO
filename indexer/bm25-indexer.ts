import { Client } from "@elastic/elasticsearch";

const es = new Client({ node: process.env.ELASTICSEARCH_URL });

export interface IndexedDocument {
  url: string;
  title: string;
  body: string;
  pagerank: number;
  crawledAt: string;
}

export interface RankedDocument {
  url: string;
  title: string;
  body: string;
  score: number;
  rank: number;
}

export async function createSearchIndex(): Promise<void> {
  await es.indices.create({
    index: "web_pages",
    settings: {
      analysis: {
        analyzer: {
          search_analyzer: {
            type: "custom",
            tokenizer: "standard",
            filter: ["lowercase", "stop", "porter_stem"],
          },
        },
      },
      similarity: { bm25: { type: "BM25", k1: 1.5, b: 0.75 } },
    },
    mappings: {
      properties: {
        url: { type: "keyword" },
        title: { type: "text", analyzer: "search_analyzer", boost: 3 },
        body: { type: "text", analyzer: "search_analyzer" },
        pagerank: { type: "float" },
        crawledAt: { type: "date" },
      },
    },
  });
}

export async function indexDocument(doc: IndexedDocument): Promise<void> {
  await es.index({ index: "web_pages", id: doc.url, document: doc });
}

export async function bm25Search(query: string, topK = 100): Promise<RankedDocument[]> {
  const result = await es.search<IndexedDocument>({
    index: "web_pages",
    size: topK,
    query: {
      function_score: {
        query: {
          multi_match: {
            query,
            fields: ["title^3", "body"],
            type: "best_fields",
            fuzziness: "AUTO",
          },
        },
        functions: [
          {
            script_score: {
              script: {
                source: "_score * Math.log(1 + doc['pagerank'].value)",
              },
            },
          },
        ],
      },
    },
    _source: ["url", "title", "body", "pagerank"],
  });

  return result.hits.hits.map((hit, rank) => ({
    url: hit._source?.url ?? "",
    title: hit._source?.title ?? "",
    body: hit._source?.body ?? "",
    score: hit._score ?? 0,
    rank,
  }));
}
