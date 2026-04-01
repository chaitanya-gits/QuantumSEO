type SearchIntent = "informational" | "navigational" | "transactional" | "research/deep dive";

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
}

export interface SearchSource {
  title: string;
  url: string;
  summary: string;
}

export interface SearchAgentResponse {
  query: string;
  search_queries: string[];
  sources: SearchSource[];
  final_answer: string;
}

const fillerWords = new Set([
  "a",
  "an",
  "about",
  "for",
  "from",
  "how",
  "i",
  "me",
  "please",
  "search",
  "show",
  "tell",
  "the",
  "to",
  "want",
  "what",
]);

const domainBoosts: Record<string, number> = {
  ".edu": 0.35,
  ".gov": 0.4,
  "arxiv.org": 0.3,
  "docs.": 0.2,
  "github.com": 0.15,
  "nature.com": 0.25,
  "openai.com": 0.2,
  "wikipedia.org": 0.1,
};

const synonymMap: Record<string, string[]> = {
  ai: ["artificial intelligence", "llm"],
  api: ["developer docs", "reference"],
  seo: ["search engine optimization", "ranking"],
  tavily: ["search api", "web search"],
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function classifyIntent(query: string): SearchIntent {
  const lower = query.toLowerCase();

  if (/(buy|price|pricing|deal|coupon|subscribe|order|book|hire)/.test(lower)) {
    return "transactional";
  }

  if (/(official site|login|homepage|docs|documentation|github|download)/.test(lower)) {
    return "navigational";
  }

  if (/(compare|research|deep dive|analysis|benchmark|survey|pros and cons|architecture)/.test(lower)) {
    return "research/deep dive";
  }

  return "informational";
}

function buildSearchQueries(query: string, intent: SearchIntent): string[] {
  const normalized = normalizeWhitespace(query);
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/[^\w.-]/g, ""))
    .filter((token) => token.length > 0);

  const condensed = tokens.filter((token) => !fillerWords.has(token.toLowerCase()));
  const expansions = condensed.flatMap((token) => synonymMap[token.toLowerCase()] ?? []);

  const searchQueries = new Set<string>();
  searchQueries.add(normalized);

  if (condensed.length > 0) {
    searchQueries.add(condensed.join(" "));
  }

  if (expansions.length > 0) {
    searchQueries.add([...condensed, ...expansions].join(" "));
  }

  if (intent === "research/deep dive") {
    searchQueries.add(`${condensed.join(" ")} comparison analysis`.trim());
  }

  return Array.from(searchQueries).filter(Boolean).slice(0, 3);
}

function cleanText(value: string | undefined): string {
  if (!value) {
    return "";
  }

  return normalizeWhitespace(
    value
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\b(cookie|sign in|subscribe|advertisement|menu|navigation)\b/gi, "")
      .replace(/[|]{2,}/g, " "),
  );
}

function summarizeResult(result: TavilySearchResult): string {
  const content = cleanText(result.content || result.raw_content);
  if (!content) {
    return "insufficient data";
  }

  const sentences = content.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = sentences.slice(0, 2).join(" ");
  const limited = summary || content.slice(0, 280);
  return limited.length > 320 ? `${limited.slice(0, 317)}...` : limited;
}

function getCredibilityBoost(url: string): number {
  return Object.entries(domainBoosts).reduce((score, [pattern, boost]) => {
    return url.includes(pattern) ? score + boost : score;
  }, 0);
}

function getRecencyBoost(publishedDate?: string): number {
  if (!publishedDate) {
    return 0;
  }

  const publishedAt = new Date(publishedDate).getTime();
  if (Number.isNaN(publishedAt)) {
    return 0;
  }

  const ageDays = (Date.now() - publishedAt) / (1000 * 60 * 60 * 24);
  if (ageDays <= 30) {
    return 0.2;
  }
  if (ageDays <= 180) {
    return 0.1;
  }
  return 0;
}

async function callTavilySearch(searchQuery: string): Promise<TavilySearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is required.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: searchQuery,
      search_depth: "advanced",
      max_results: 5,
      include_answer: false,
      include_raw_content: true,
      topic: "general",
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed with status ${response.status}.`);
  }

  const data = (await response.json()) as TavilySearchResponse;
  return data.results ?? [];
}

function rankAndSummarizeResults(results: TavilySearchResult[]): SearchSource[] {
  const deduped = new Map<string, SearchSource & { rankScore: number }>();

  results.forEach((result) => {
    const title = cleanText(result.title) || "Untitled source";
    const url = result.url || "";
    if (!url) {
      return;
    }

    const summary = summarizeResult(result);
    const rankScore = (result.score ?? 0) + getCredibilityBoost(url) + getRecencyBoost(result.published_date);
    const existing = deduped.get(url);

    if (!existing || rankScore > existing.rankScore) {
      deduped.set(url, { title, url, summary, rankScore });
    }
  });

  return Array.from(deduped.values())
    .sort((left, right) => right.rankScore - left.rankScore)
    .slice(0, 5)
    .map(({ title, url, summary }) => ({ title, url, summary }));
}

function buildFinalAnswer(sources: SearchSource[]): string {
  if (sources.length === 0) {
    return "insufficient data";
  }

  const combined = sources
    .slice(0, 3)
    .map((source) => source.summary)
    .filter((summary) => summary !== "insufficient data")
    .join(" ");

  if (!combined) {
    return "insufficient data";
  }

  const answer = normalizeWhitespace(combined);
  return answer.length > 650 ? `${answer.slice(0, 647)}...` : answer;
}

export async function runExternalSearchAgent(query: string): Promise<SearchAgentResponse> {
  const intent = classifyIntent(query);
  const searchQueries = buildSearchQueries(query, intent);
  const searchResponses = await Promise.all(searchQueries.map((searchQuery) => callTavilySearch(searchQuery)));
  const flattenedResults = searchResponses.flat();
  const sources = rankAndSummarizeResults(flattenedResults);

  return {
    query: normalizeWhitespace(query),
    search_queries: searchQueries,
    sources,
    final_answer: buildFinalAnswer(sources),
  };
}
