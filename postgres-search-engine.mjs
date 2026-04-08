import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

const userAgent = "QuantumSEO/1.0";
let poolClient = null;

const fillerWords = new Set(["a", "an", "about", "for", "from", "how", "i", "me", "please", "search", "show", "tell", "the", "to", "want", "what"]);
const synonymMap = {
  ai: ["artificial intelligence", "llm"],
  api: ["developer docs", "reference"],
  seo: ["search engine optimization", "ranking"],
  search: ["search api", "web search"]
};

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanText(value) {
  if (!value) {
    return "";
  }

  return normalizeWhitespace(
    value
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\b(cookie|sign in|subscribe|advertisement|menu|navigation)\b/gi, " ")
      .replace(/[|]{2,}/g, " ")
  );
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(value) {
  return cleanText(
    decodeHtmlEntities(
      value
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
        .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
        .replace(/<header[\s\S]*?<\/header>/gi, " ")
        .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function summarizeText(value) {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return "insufficient data";
  }

  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = sentences.slice(0, 2).join(" ");
  const limited = summary || cleaned.slice(0, 280);
  return limited.length > 320 ? `${limited.slice(0, 317)}...` : limited;
}

function classifyIntent(query) {
  const lower = query.toLowerCase();
  if (/(buy|price|pricing|deal|coupon|subscribe|order|book|hire)/.test(lower)) return "transactional";
  if (/(official site|login|homepage|docs|documentation|github|download)/.test(lower)) return "navigational";
  if (/(compare|research|deep dive|analysis|benchmark|survey|pros and cons|architecture)/.test(lower)) return "research/deep dive";
  return "informational";
}

function buildSearchQueries(query, intent) {
  const normalized = normalizeWhitespace(query);
  const tokens = normalized.split(/\s+/).map((token) => token.replace(/[^\w.-]/g, "")).filter(Boolean);
  const condensed = tokens.filter((token) => !fillerWords.has(token.toLowerCase()));
  const expansions = condensed.flatMap((token) => synonymMap[token.toLowerCase()] ?? []);
  const searchQueries = new Set([normalized]);

  if (condensed.length > 0) searchQueries.add(condensed.join(" "));
  if (expansions.length > 0) searchQueries.add([...condensed, ...expansions].join(" "));
  if (intent === "research/deep dive") searchQueries.add(`${condensed.join(" ")} comparison analysis`.trim());

  return Array.from(searchQueries).filter(Boolean).slice(0, 3);
}

function tokenizeQuery(query) {
  return normalizeWhitespace(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function buildOrTsQuery(queryTokens) {
  const sanitizedTokens = queryTokens
    .map((token) => token.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean);

  if (sanitizedTokens.length === 0) {
    return "";
  }

  return sanitizedTokens.join(" | ");
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  html.replace(/<a[^>]+href=["']([^"'#]+)["']/gi, (_, href) => {
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (isHttpUrl(absolute)) {
        links.add(absolute);
      }
    } catch {
      return "";
    }
    return "";
  });
  return Array.from(links).slice(0, 100);
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} with status ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`Unsupported content type for ${url}: ${contentType}`);
  }

  return response.text();
}

async function fetchHtmlWithBrowser(url) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      userAgent
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    const title = await page.title();
    const body = await page.evaluate(() => {
      const removeSelectors = ["nav", "footer", "script", "style", "header", "aside"];
      removeSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => element.remove());
      });

      return document.body.innerText.replace(/\s+/g, " ").trim();
    });

    const outboundLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => anchor.href)
        .filter((href) => href.startsWith("http"))
        .slice(0, 100)
    );

    return {
      title,
      body: cleanText(body),
      outboundLinks
    };
  } finally {
    await browser.close();
  }
}

function buildStubDocument(url, seedQuery = "") {
  const parsed = new URL(url);
  const title = cleanText(parsed.hostname.replace(/^www\./, ""));
  const pathTokens = parsed.pathname
    .split("/")
    .map((segment) => cleanText(decodeURIComponent(segment)))
    .filter(Boolean);
  const body = cleanText(
    [title, seedQuery, ...pathTokens].filter(Boolean).join(" ")
  ) || title;
  const summary = summarizeText(body);

  return {
    url,
    title: title || url,
    body,
    summary,
    outboundLinks: [],
    embedding: null,
    updatedAt: new Date().toISOString(),
    lastSeedQuery: seedQuery
  };
}

async function embedText(text) {
  return null;
}

async function crawlUrl(url, seedQuery = "") {
  let title = "";
  let body = "";
  let outboundLinks = [];

  try {
    const html = await fetchHtml(url);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = cleanText(decodeHtmlEntities(titleMatch?.[1] ?? "")) || new URL(url).hostname;
    body = stripHtml(html).slice(0, 12000);
    outboundLinks = extractLinks(html, url);
  } catch (fetchError) {
    try {
      const browserResult = await fetchHtmlWithBrowser(url);
      title = cleanText(browserResult.title) || new URL(url).hostname;
      body = browserResult.body.slice(0, 12000);
      outboundLinks = browserResult.outboundLinks;
    } catch (browserError) {
      console.error(`Browser crawl fallback failed for ${url}. Using stub document.`, browserError);
      return buildStubDocument(url, seedQuery);
    }
  }

  const summary = summarizeText(body);
  const embedding = await embedText(`${title}\n\n${summary}`);

  return {
    url,
    title,
    body,
    summary,
    outboundLinks,
    embedding,
    updatedAt: new Date().toISOString(),
    lastSeedQuery: seedQuery
  };
}

async function discoverSeedUrls(query) {
  const urls = new Set();

  try {
    const wikipediaUrl = new URL("https://en.wikipedia.org/w/rest.php/v1/search/title");
    wikipediaUrl.searchParams.set("q", query);
    wikipediaUrl.searchParams.set("limit", "3");

    const response = await fetch(wikipediaUrl, {
      headers: { "User-Agent": userAgent }
    });

    if (response.ok) {
      const data = await response.json();
      for (const page of data.pages ?? []) {
        if (page.key) {
          urls.add(`https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`);
        }
      }
    }
  } catch {
  }

  if (process.env.TAVILY_API_KEY || process.env.SEARCH_API_KEY) {
    try {
      const response = await fetch(
        process.env.TAVILY_API_URL ?? process.env.SEARCH_API_URL ?? "https://api.tavily.com/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY ?? process.env.SEARCH_API_KEY,
            query,
            search_depth: "advanced",
            max_results: 5,
            include_answer: false,
            include_raw_content: false,
            topic: "general"
          })
        }
      );

      if (response.ok) {
        const data = await response.json();
        for (const result of data.results ?? []) {
          if (result.url) {
            urls.add(result.url);
          }
        }
      }
    } catch {
    }
  }

  return Array.from(urls).filter(isHttpUrl).slice(0, 6);
}

async function runQuery(text, values = []) {
  if (!poolClient && process.env.DATABASE_URL) {
    poolClient = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  const pool = poolClient;
  if (!pool) {
    throw new Error("DATABASE_URL is required for the Postgres search engine.");
  }

  return pool.query(text, values);
}

function buildVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

async function ensureSchema() {
  const schemaPath = join(process.cwd(), "infrastructure", "sql", "search-schema.sql");
  const schemaSql = await readFile(schemaPath, "utf8");
  await runQuery(schemaSql);
}

async function upsertPageDocument(doc) {
  await runQuery(
    `INSERT INTO pages (
       url,
       title,
       body,
       summary,
       last_seed_query,
       outbound_links,
       search_document,
       crawled_at,
       updated_at
     )
     VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6::jsonb,
       setweight(to_tsvector('english', coalesce($2, '')), 'A')
         || setweight(to_tsvector('english', coalesce($4, '')), 'B')
         || setweight(to_tsvector('english', coalesce($3, '')), 'C'),
       NOW(),
       $7::timestamptz
     )
     ON CONFLICT (url)
     DO UPDATE SET
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       summary = EXCLUDED.summary,
       last_seed_query = EXCLUDED.last_seed_query,
       outbound_links = EXCLUDED.outbound_links,
       search_document = EXCLUDED.search_document,
       updated_at = EXCLUDED.updated_at,
       crawled_at = NOW()`,
    [doc.url, doc.title, doc.body, doc.summary, doc.lastSeedQuery, JSON.stringify(doc.outboundLinks), doc.updatedAt]
  );

  if (doc.embedding) {
    await runQuery(
      `INSERT INTO page_embeddings (url, embedding, model, updated_at)
       VALUES ($1, $2::vector, $3, $4::timestamptz)
       ON CONFLICT (url)
       DO UPDATE SET
         embedding = EXCLUDED.embedding,
         model = EXCLUDED.model,
         updated_at = EXCLUDED.updated_at`,
      [doc.url, buildVectorLiteral(doc.embedding), "text-embedding-3-small", doc.updatedAt]
    );
  }

  await runQuery(
    `INSERT INTO page_links (source_url, target_url)
     SELECT $1, link
     FROM jsonb_array_elements_text($2::jsonb) AS link
     ON CONFLICT DO NOTHING`,
    [doc.url, JSON.stringify(doc.outboundLinks)]
  );
}

function fuseResults(lexicalRows, vectorRows, limit = 5) {
  const fused = new Map();
  const add = (row, source, rank) => {
    const existing = fused.get(row.url) ?? {
      title: row.title,
      url: row.url,
      summary: row.summary,
      lexicalScore: 0,
      vectorScore: 0,
      score: 0,
      sources: new Set()
    };

    if (source === "lexical") {
      existing.lexicalScore += Number(row.score ?? 0) + 1 / (20 + rank);
    } else {
      existing.vectorScore += Number(row.score ?? 0) + 1 / (60 + rank);
    }
    existing.sources.add(source);
    fused.set(row.url, existing);
  };

  lexicalRows.forEach((row, index) => add(row, "lexical", index));
  vectorRows.forEach((row, index) => add(row, "vector", index));

  return Array.from(fused.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((result) => ({
      ...result,
      score: result.lexicalScore * 3 + result.vectorScore * 0.35
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ title, url, summary, score, sources }) => ({
      title,
      url,
      summary,
      score,
      sources: Array.from(sources)
    }));
}

function buildFinalAnswer(sources) {
  if (sources.length === 0) {
    return "insufficient data";
  }

  const combined = sources.slice(0, 3).map((source) => source.summary).filter(Boolean).join(" ");
  if (!combined) {
    return "insufficient data";
  }

  const answer = normalizeWhitespace(combined);
  return answer.length > 650 ? `${answer.slice(0, 647)}...` : answer;
}

async function lexicalSearch(query, limit = 10) {
  const normalizedQuery = normalizeWhitespace(query);
  const queryTokens = tokenizeQuery(normalizedQuery);
  const orTsQuery = buildOrTsQuery(queryTokens);

  if (!orTsQuery) {
    return [];
  }

  const result = await runQuery(
    `SELECT
       p.url,
       p.title,
       p.summary,
       (
         CASE
            WHEN lower(p.title) = lower($1) THEN 12
           WHEN lower(p.title) LIKE lower($2) THEN 8
           ELSE 0
         END
         + COALESCE((
             SELECT COUNT(*)
             FROM unnest($3::text[]) AS token
             WHERE lower(p.title) LIKE '%' || token || '%'
           ), 0) * 4
         + COALESCE((
             SELECT COUNT(*)
             FROM unnest($3::text[]) AS token
             WHERE lower(coalesce(p.summary, '') || ' ' || coalesce(p.body, '')) LIKE '%' || token || '%'
           ), 0) * 1.5
         + ts_rank_cd(p.search_document, to_tsquery('english', $4))
       ) AS score
     FROM pages p
     WHERE p.search_document @@ to_tsquery('english', $4)
      ORDER BY score DESC, p.updated_at DESC
     LIMIT $5`,
    [normalizedQuery, `%${normalizedQuery}%`, queryTokens, orTsQuery, limit]
  );

  return result.rows;
}

async function vectorSearch(query, limit = 10) {
  const embedding = await embedText(query);
  if (!embedding) {
    return [];
  }

  const result = await runQuery(
    `SELECT
       p.url,
       p.title,
       p.summary,
       1 - (e.embedding <=> $1::vector) AS score
     FROM page_embeddings e
     JOIN pages p ON p.url = e.url
     ORDER BY e.embedding <=> $1::vector
     LIMIT $2`,
    [buildVectorLiteral(embedding), limit]
  );

  return result.rows;
}

export async function initializeSearchEngine() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the Postgres search engine.");
  }

  await ensureSchema();
}

export async function indexUrls(urls, options = {}) {
  const uniqueUrls = Array.from(new Set((urls ?? []).filter(isHttpUrl)));
  const ingested = [];
  const errors = [];

  for (const url of uniqueUrls) {
    try {
      const doc = await crawlUrl(url, options.seedQuery ?? "");
      await upsertPageDocument(doc);
      ingested.push(doc);
    } catch (error) {
      console.error(`Indexing failed for ${url}.`, error);
      errors.push({
        url,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { ingested, errors };
}

export async function getSearchEngineStatus() {
  const countResult = await runQuery("SELECT COUNT(*)::int AS count FROM pages");
  const docsResult = await runQuery(
    `SELECT url, title, updated_at, last_seed_query
     FROM pages
     ORDER BY updated_at DESC
     LIMIT 10`
  );

  return {
    documentCount: countResult.rows[0]?.count ?? 0,
    lastUpdatedAt: docsResult.rows[0]?.updated_at ?? null,
    documents: docsResult.rows.map((row) => ({
      url: row.url,
      title: row.title,
      updatedAt: row.updated_at,
      lastSeedQuery: row.last_seed_query
    }))
  };
}

export async function search(query, options = {}) {
  const normalizedQuery = normalizeWhitespace(query);
  if (normalizedQuery.length < 2) {
    return {
      query: normalizedQuery,
      search_queries: [normalizedQuery],
      sources: [],
      final_answer: "Type at least 2 characters to search.",
      index_status: await getSearchEngineStatus()
    };
  }

  const intent = classifyIntent(normalizedQuery);
  const searchQueries = buildSearchQueries(normalizedQuery, intent);
  let lexicalRows = await lexicalSearch(normalizedQuery, 10);
  let vectorRows = await vectorSearch(normalizedQuery, 10);
  let sources = fuseResults(lexicalRows, vectorRows, 5);

  if (sources.length < 3 && options.seed === true) {
    const seedUrls = await discoverSeedUrls(normalizedQuery);
    if (seedUrls.length > 0) {
      await indexUrls(seedUrls, { seedQuery: normalizedQuery });
      lexicalRows = await lexicalSearch(normalizedQuery, 10);
      vectorRows = await vectorSearch(normalizedQuery, 10);
      sources = fuseResults(lexicalRows, vectorRows, 5);
    }
  }

  return {
    query: normalizedQuery,
    search_queries: searchQueries,
    sources: sources.map(({ title, url, summary }) => ({ title, url, summary })),
    final_answer: buildFinalAnswer(sources),
    index_status: await getSearchEngineStatus()
  };
}
