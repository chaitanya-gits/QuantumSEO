import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

const dataDirectory = join(process.cwd(), ".data");
const storePath = join(dataDirectory, "search-store.json");
const userAgent = "QuantumSEO/1.0";
const fillerWords = new Set(["a", "an", "about", "for", "from", "how", "i", "me", "please", "search", "show", "tell", "the", "to", "want", "what"]);
const domainBoosts = {
  ".edu": 0.35,
  ".gov": 0.4,
  "arxiv.org": 0.3,
  "docs.": 0.2,
  "github.com": 0.15,
  "nature.com": 0.25,
  "openai.com": 0.2,
  "wikipedia.org": 0.1
};
const synonymMap = {
  ai: ["artificial intelligence", "llm"],
  api: ["developer docs", "reference"],
  seo: ["search engine optimization", "ranking"],
  search: ["search api", "web search"]
};

let initialized = false;
let persistChain = Promise.resolve();
const documents = new Map();
const termDocumentFrequency = new Map();
const postingsByTerm = new Map();
const docLengths = new Map();
const inboundLinkCounts = new Map();

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

function tokenize(value) {
  return cleanText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
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

function getCredibilityBoost(url) {
  return Object.entries(domainBoosts).reduce((score, [pattern, boost]) => (url.includes(pattern) ? score + boost : score), 0);
}

function getRecencyBoost(timestamp) {
  if (!timestamp) return 0;
  const publishedAt = new Date(timestamp).getTime();
  if (Number.isNaN(publishedAt)) return 0;
  const ageDays = (Date.now() - publishedAt) / (1000 * 60 * 60 * 24);
  if (ageDays <= 1) return 0.35;
  if (ageDays <= 7) return 0.2;
  if (ageDays <= 30) return 0.1;
  return 0;
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

function rebuildIndexes() {
  termDocumentFrequency.clear();
  postingsByTerm.clear();
  docLengths.clear();
  inboundLinkCounts.clear();

  for (const [url, doc] of documents.entries()) {
    const tokens = tokenize(`${doc.title} ${doc.body}`);
    docLengths.set(url, tokens.length || 1);

    const termCounts = new Map();
    for (const token of tokens) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }

    for (const [token, count] of termCounts.entries()) {
      termDocumentFrequency.set(token, (termDocumentFrequency.get(token) ?? 0) + 1);
      if (!postingsByTerm.has(token)) {
        postingsByTerm.set(token, new Map());
      }
      postingsByTerm.get(token).set(url, count);
    }

    for (const link of doc.outboundLinks ?? []) {
      inboundLinkCounts.set(link, (inboundLinkCounts.get(link) ?? 0) + 1);
    }
  }
}

async function persistStore() {
  const payload = JSON.stringify({
    documents: Array.from(documents.values()).sort((left, right) => left.url.localeCompare(right.url))
  }, null, 2);

  persistChain = persistChain.then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(storePath, payload, "utf8");
  });

  await persistChain;
}

async function loadStore() {
  if (initialized) {
    return;
  }

  initialized = true;

  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    for (const doc of parsed.documents ?? []) {
      documents.set(doc.url, doc);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  rebuildIndexes();
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

async function crawlUrl(url, seedQuery = "") {
  const html = await fetchHtml(url);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanText(decodeHtmlEntities(titleMatch?.[1] ?? "")) || new URL(url).hostname;
  const body = stripHtml(html).slice(0, 12000);
  const outboundLinks = extractLinks(html, url);
  const previous = documents.get(url);
  const crawledAt = new Date().toISOString();

  return {
    url,
    title,
    body,
    summary: summarizeText(body),
    outboundLinks,
    crawledAt: previous?.crawledAt ?? crawledAt,
    updatedAt: crawledAt,
    lastSeedQuery: seedQuery || previous?.lastSeedQuery || ""
  };
}

async function ingestUrls(urls, seedQuery = "") {
  await loadStore();

  const uniqueUrls = Array.from(new Set(urls.filter(isHttpUrl)));
  const ingested = [];
  const errors = [];

  for (const url of uniqueUrls) {
    try {
      const doc = await crawlUrl(url, seedQuery);
      documents.set(url, doc);
      ingested.push(doc);
    } catch (error) {
      errors.push({
        url,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (ingested.length > 0) {
    rebuildIndexes();
    await persistStore();
  }

  return { ingested, errors };
}

function scoreDocument(term, queryTermCount, docUrl, titleTokens, totalDocs, averageDocLength) {
  const posting = postingsByTerm.get(term);
  if (!posting) {
    return 0;
  }

  const tf = posting.get(docUrl) ?? 0;
  if (tf === 0) {
    return 0;
  }

  const df = termDocumentFrequency.get(term) ?? 0;
  const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
  const docLength = docLengths.get(docUrl) ?? 1;
  const k1 = 1.5;
  const b = 0.75;
  const lexical = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / averageDocLength))));
  const titleBoost = titleTokens.includes(term) ? 1.8 : 1;
  return lexical * titleBoost * queryTermCount;
}

function searchOwnedDocuments(query, limit = 5) {
  const normalizedQuery = normalizeWhitespace(query);
  const intent = classifyIntent(normalizedQuery);
  const searchQueries = buildSearchQueries(normalizedQuery, intent);
  const scores = new Map();
  const totalDocs = documents.size || 1;
  const averageDocLength = Array.from(docLengths.values()).reduce((sum, value) => sum + value, 0) / totalDocs || 1;

  for (const searchQuery of searchQueries) {
    const queryTerms = tokenize(searchQuery);
    const queryTermCounts = new Map();

    for (const term of queryTerms) {
      queryTermCounts.set(term, (queryTermCounts.get(term) ?? 0) + 1);
    }

    for (const [term, queryTermCount] of queryTermCounts.entries()) {
      const posting = postingsByTerm.get(term);
      if (!posting) {
        continue;
      }

      for (const docUrl of posting.keys()) {
        const doc = documents.get(docUrl);
        if (!doc) {
          continue;
        }

        const titleTokens = tokenize(doc.title);
        const lexicalScore = scoreDocument(term, queryTermCount, docUrl, titleTokens, totalDocs, averageDocLength);
        const current = scores.get(docUrl) ?? 0;
        scores.set(docUrl, current + lexicalScore);
      }
    }
  }

  return Array.from(scores.entries())
    .map(([url, lexicalScore]) => {
      const doc = documents.get(url);
      const score = lexicalScore
        + getCredibilityBoost(url)
        + getRecencyBoost(doc.updatedAt)
        + 0.08 * Math.log(1 + (inboundLinkCounts.get(url) ?? 0));

      return {
        title: doc.title || "Untitled source",
        url,
        summary: doc.summary || summarizeText(doc.body),
        score,
        crawledAt: doc.updatedAt
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function buildFinalAnswer(sources) {
  if (sources.length === 0) return "insufficient data";
  const combined = sources
    .slice(0, 3)
    .map((source) => source.summary)
    .filter((summary) => summary !== "insufficient data")
    .join(" ");

  if (!combined) return "insufficient data";
  const answer = normalizeWhitespace(combined);
  return answer.length > 650 ? `${answer.slice(0, 647)}...` : answer;
}

async function fetchWikipediaSeed(query) {
  const searchUrl = new URL("https://en.wikipedia.org/w/rest.php/v1/search/title");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("limit", "3");

  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": userAgent
    }
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return (data.pages ?? [])
    .map((page) => page.key ? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}` : "")
    .filter(Boolean)
    .slice(0, 3);
}

async function fetchSearchApiSeeds(query) {
  const apiKey = process.env.TAVILY_API_KEY ?? process.env.SEARCH_API_KEY;
  const searchApiUrl = process.env.TAVILY_API_URL ?? process.env.SEARCH_API_URL ?? "https://api.tavily.com/search";
  if (!apiKey) {
    return [];
  }

  const response = await fetch(searchApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "advanced",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      topic: "general"
    })
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return (data.results ?? []).map((item) => item.url).filter(Boolean);
}

async function discoverSeedUrls(query) {
  const [wikipediaSeeds, searchApiSeeds] = await Promise.all([
    fetchWikipediaSeed(query).catch(() => []),
    fetchSearchApiSeeds(query).catch(() => [])
  ]);

  return Array.from(new Set([...wikipediaSeeds, ...searchApiSeeds])).slice(0, 6);
}

export async function initializeSearchEngine() {
  await loadStore();
}

export async function indexUrls(urls, options = {}) {
  return ingestUrls(urls, options.seedQuery ?? "");
}

export async function getSearchEngineStatus() {
  await loadStore();
  const allDocuments = Array.from(documents.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    documentCount: allDocuments.length,
    lastUpdatedAt: allDocuments[0]?.updatedAt ?? null,
    documents: allDocuments.slice(0, 10).map((doc) => ({
      url: doc.url,
      title: doc.title,
      updatedAt: doc.updatedAt,
      lastSeedQuery: doc.lastSeedQuery
    }))
  };
}

export async function search(query, options = {}) {
  await loadStore();

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
  let sources = searchOwnedDocuments(normalizedQuery, 5);

  if (sources.length < 3 && options.seed === true) {
    const seedUrls = await discoverSeedUrls(normalizedQuery);
    if (seedUrls.length > 0) {
      await ingestUrls(seedUrls, normalizedQuery);
      sources = searchOwnedDocuments(normalizedQuery, 5);
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
