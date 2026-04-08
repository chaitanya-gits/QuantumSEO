import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, normalize } from "node:path";
import { URL } from "node:url";
import { createRequire } from "node:module";
import {
  initializeSearchEngine as initializeLocalSearchEngine,
  indexUrls as indexLocalUrls,
  getSearchEngineStatus as getLocalSearchEngineStatus,
  search as searchLocalIndex
} from "./local-search-engine.mjs";
import {
  initializeSearchEngine as initializePostgresSearchEngine,
  indexUrls as indexPostgresUrls,
  getSearchEngineStatus as getPostgresSearchEngineStatus,
  search as searchPostgresIndex
} from "./postgres-search-engine.mjs";
import { geocodeAddress, reverseGeocode } from "./google-geocode.mjs";

const require = createRequire(import.meta.url);
const googleTrends = require("google-trends-api");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3000");
const root = process.cwd();
const liveSearchCache = new Map();
const liveSearchTtlMs = 1000 * 60 * 5;
const searchApiTimeoutMs = 8000;
const searchApiMaxAttempts = 2;
const liveSearchResultLimit = 15;
let activeSearchEngine = {
  mode: "local",
  initialize: initializeLocalSearchEngine,
  indexUrls: indexLocalUrls,
  getStatus: getLocalSearchEngineStatus,
  search: searchLocalIndex
};

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8"
};

async function loadDotEnv() {
  const envPath = join(root, ".env");
  try {
    await access(envPath, constants.F_OK);
  } catch {
    return;
  }

  const raw = await readFile(envPath, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const splitIndex = trimmed.indexOf("=");
    if (splitIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, splitIndex).trim();
    const value = trimmed.slice(splitIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
}

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

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCachedLiveSearch(query) {
  const key = normalizeWhitespace(query).toLowerCase();
  const cached = liveSearchCache.get(key);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.timestamp > liveSearchTtlMs) {
    liveSearchCache.delete(key);
    return null;
  }

  return cached.payload;
}

function setCachedLiveSearch(query, payload) {
  const key = normalizeWhitespace(query).toLowerCase();
  liveSearchCache.set(key, {
    payload,
    timestamp: Date.now()
  });
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

function cleanText(value) {
  if (!value) return "";
  return normalizeWhitespace(
    value
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\b(cookie|sign in|subscribe|advertisement|menu|navigation)\b/gi, "")
      .replace(/[|]{2,}/g, " ")
  );
}

function summarizeResult(result) {
  const content = cleanText(result.content || result.raw_content);
  if (!content) return "insufficient data";
  const sentences = content.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = sentences.slice(0, 2).join(" ");
  const limited = summary || content.slice(0, 280);
  return limited.length > 320 ? `${limited.slice(0, 317)}...` : limited;
}

function getCredibilityBoost(url) {
  return Object.entries(domainBoosts).reduce((score, [pattern, boost]) => (url.includes(pattern) ? score + boost : score), 0);
}

function getRecencyBoost(publishedDate) {
  if (!publishedDate) return 0;
  const publishedAt = new Date(publishedDate).getTime();
  if (Number.isNaN(publishedAt)) return 0;
  const ageDays = (Date.now() - publishedAt) / (1000 * 60 * 60 * 24);
  if (ageDays <= 30) return 0.2;
  if (ageDays <= 180) return 0.1;
  return 0;
}

async function fetchWikipediaSummary(query) {
  const searchUrl = new URL("https://en.wikipedia.org/w/rest.php/v1/search/title");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("limit", "1");

  const searchResponse = await fetch(searchUrl, {
    headers: {
      "User-Agent": "QuantumSEO/1.0"
    }
  });

  if (!searchResponse.ok) {
    return null;
  }

  const searchData = await searchResponse.json();
  const topPage = searchData.pages?.[0];
  if (!topPage?.key) {
    return null;
  }

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topPage.key)}`;
  const summaryResponse = await fetch(summaryUrl, {
    headers: {
      "User-Agent": "QuantumSEO/1.0"
    }
  });

  if (!summaryResponse.ok) {
    return null;
  }

  const summaryData = await summaryResponse.json();
  const extract = cleanText(summaryData.extract);
  if (!extract) {
    return null;
  }

  return {
    title: cleanText(summaryData.title) || topPage.title || query,
    url: summaryData.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(topPage.key)}`,
    summary: extract.length > 420 ? `${extract.slice(0, 417)}...` : extract
  };
}

async function callSearchApi(searchQuery) {
  const apiKey = process.env.TAVILY_API_KEY ?? process.env.SEARCH_API_KEY;
  const searchApiUrl = process.env.TAVILY_API_URL ?? process.env.SEARCH_API_URL ?? "https://api.tavily.com/search";
  if (!apiKey) throw new Error("TAVILY_API_KEY or SEARCH_API_KEY is required.");

  let lastError = null;

  for (let attempt = 1; attempt <= searchApiMaxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), searchApiTimeoutMs);

    try {
      const response = await fetch(searchApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: searchQuery,
          search_depth: "advanced",
          max_results: liveSearchResultLimit,
          include_answer: false,
          include_raw_content: true,
          topic: "general"
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Search API failed with status ${response.status}.`);
      }

      const data = await response.json();
      return data.results ?? [];
    } catch (error) {
      lastError = error;
      if (attempt < searchApiMaxAttempts) {
        await delay(250 * attempt);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error("Search API failed.");
}

async function getTrendingTopics() {
  const geo = process.env.TRENDS_GEO ?? "IN";
  const timezoneMinutes = -new Date().getTimezoneOffset();
  const raw = await googleTrends.dailyTrends({
    geo,
    timezone: timezoneMinutes,
    trendDate: new Date()
  });
  const payload = JSON.parse(raw);
  const seen = new Set();

  return (payload.default?.trendingSearchesDays ?? [])
    .flatMap((day) => day.trendingSearches ?? [])
    .map((item) => cleanText(item.title?.query || ""))
    .filter((title) => title.length > 0)
    .filter((title) => title.length <= 80)
    .filter((title) => {
      const key = title.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

function rankAndSummarizeResults(results) {
  const deduped = new Map();

  results.forEach((result) => {
    const title = cleanText(result.title) || "Untitled source";
    const url = result.url || "";
    if (!url) return;

    const summary = summarizeResult(result);
    const rankScore = (result.score ?? 0) + getCredibilityBoost(url) + getRecencyBoost(result.published_date);
    const existing = deduped.get(url);

    if (!existing || rankScore > existing.rankScore) {
      deduped.set(url, { title, url, summary, rankScore });
    }
  });

  return Array.from(deduped.values())
    .sort((left, right) => right.rankScore - left.rankScore)
    .slice(0, liveSearchResultLimit)
    .map(({ title, url, summary }) => ({ title, url, summary }));
}

function buildFinalAnswer(sources) {
  if (sources.length === 0) return "insufficient data";
  const combined = sources.slice(0, 3).map((source) => source.summary).filter((summary) => summary !== "insufficient data").join(" ");
  if (!combined) return "insufficient data";
  const answer = normalizeWhitespace(combined);
  return answer.length > 650 ? `${answer.slice(0, 647)}...` : answer;
}

async function fetchLiveSources(searchQueries) {
  const collected = [];

  for (const searchQuery of searchQueries) {
    try {
      const results = await callSearchApi(searchQuery);
      collected.push(...results);
    } catch (error) {
      console.error(`Live search failed for "${searchQuery}".`, error);
    }
  }

  return rankAndSummarizeResults(collected);
}

async function runOwnedSearchAgent(query) {
  const normalizedQuery = normalizeWhitespace(query);
  if (normalizedQuery.length < 2) {
    return {
      query: normalizedQuery,
      search_queries: [normalizedQuery],
      sources: [],
      final_answer: "Type at least 2 characters to search."
    };
  }

  const cached = getCachedLiveSearch(normalizedQuery);
  if (cached) {
    return cached;
  }

  const intent = classifyIntent(normalizedQuery);
  const liveSearchQueries = buildSearchQueries(normalizedQuery, intent);
  const liveSources = await fetchLiveSources(liveSearchQueries);
  const finalAnswer = buildFinalAnswer(liveSources);
  const payload = {
    query: normalizedQuery,
    search_queries: liveSearchQueries,
    sources: liveSources,
    final_answer: finalAnswer === "insufficient data"
      ? "Live search is temporarily unavailable. Try again in a moment."
      : finalAnswer,
    index_status: await activeSearchEngine.getStatus()
  };

  setCachedLiveSearch(normalizedQuery, payload);
  return payload;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

async function handleStaticRequest(req, res) {
  try {
    const requestPath = req.url === "/" ? "/index.html" : req.url ?? "/index.html";
    const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(root, safePath);
    const data = await readFile(filePath);
    const extension = extname(filePath);

    res.writeHead(200, {
      "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

await loadDotEnv();
if (process.env.DATABASE_URL) {
  activeSearchEngine = {
    mode: "postgres",
    initialize: initializePostgresSearchEngine,
    indexUrls: indexPostgresUrls,
    getStatus: getPostgresSearchEngineStatus,
    search: searchPostgresIndex
  };
}

await activeSearchEngine.initialize();

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);

  if (req.method === "GET" && url.pathname === "/api/search") {
    const rawQuery = url.searchParams.get("q")?.trim() ?? "";
    if (!rawQuery) {
      return sendJson(res, 400, { query: "", search_queries: [], sources: [], final_answer: "insufficient data" });
    }

    try {
      const payload = await runOwnedSearchAgent(rawQuery);
      return sendJson(res, 200, payload);
    } catch (error) {
      console.error("Search error:", error);
      return sendJson(res, 500, { query: rawQuery, search_queries: [], sources: [], final_answer: "insufficient data" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/index") {
    try {
      const body = await readJsonBody(req);
      const urls = Array.isArray(body.urls) ? body.urls : [];
      if (urls.length === 0) {
        return sendJson(res, 400, { message: "Request body must contain a non-empty urls array." });
      }

      const payload = await activeSearchEngine.indexUrls(urls, { seedQuery: typeof body.seedQuery === "string" ? body.seedQuery : "" });
      liveSearchCache.clear();
      return sendJson(res, 200, {
        mode: activeSearchEngine.mode,
        indexed: payload.ingested.length,
        failed: payload.errors.length,
        documents: payload.ingested.map((doc) => ({ url: doc.url, title: doc.title, updatedAt: doc.updatedAt })),
        errors: payload.errors
      });
    } catch (error) {
      console.error("Indexing error:", error);
      return sendJson(res, 500, { message: "Indexing failed." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/index/status") {
    try {
      const status = await activeSearchEngine.getStatus();
      return sendJson(res, 200, { mode: activeSearchEngine.mode, ...status });
    } catch (error) {
      console.error("Index status error:", error);
      return sendJson(res, 500, { message: "Unable to read index status." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/location") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (!query) {
      return sendJson(res, 400, { message: "Query parameter q is required." });
    }

    try {
      const results = await geocodeAddress(query);
      return sendJson(res, 200, { query, results });
    } catch (error) {
      console.error("Location lookup error:", error);
      return sendJson(res, 500, { message: "Location lookup failed." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/location/reverse") {
    const lat = Number(url.searchParams.get("lat"));
    const lng = Number(url.searchParams.get("lng"));
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return sendJson(res, 400, { message: "Valid lat and lng query parameters are required." });
    }

    try {
      const results = await reverseGeocode(lat, lng);
      return sendJson(res, 200, { lat, lng, results });
    } catch (error) {
      console.error("Reverse location lookup error:", error);
      return sendJson(res, 500, { message: "Reverse location lookup failed." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/trending") {
    try {
      const topics = await getTrendingTopics();
      return sendJson(res, 200, { topics });
    } catch (error) {
      console.error("Trending error:", error);
      return sendJson(res, 200, { topics: [] });
    }
  }

  return handleStaticRequest(req, res);
}).listen(port, host, () => {
  console.log(`Quantum SEO available at http://${host}:${port}`);
});
