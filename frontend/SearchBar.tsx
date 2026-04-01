import { useEffect, useRef, useState } from "react";

interface SearchResult {
  url: string;
  title: string;
  body: string;
  score: number;
}

interface AIAnswer {
  answer: string;
  citations: string[];
  confidence: "high" | "medium" | "low";
  relatedQueries: string[];
}

interface SearchResponse {
  query: string;
  intent: string;
  results: SearchResult[];
  aiAnswer: AIAnswer | null;
  totalCandidates: number;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return debouncedValue;
}

export function SearchBar() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const fetchSuggestions = async () => {
      if (debouncedQuery.trim().length < 2) {
        setSuggestions([]);
        return;
      }

      const result = await fetch(`/api/suggest?q=${encodeURIComponent(debouncedQuery)}`);
      const data = (await result.json()) as { suggestions?: string[] };
      setSuggestions(data.suggestions ?? []);
    };

    void fetchSuggestions();
  }, [debouncedQuery]);

  const handleSearch = async (nextQuery: string) => {
    if (!nextQuery.trim()) {
      return;
    }

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setSuggestions([]);

    try {
      const result = await fetch(`/api/search?q=${encodeURIComponent(nextQuery)}`, {
        signal: abortRef.current.signal,
      });
      const data = (await result.json()) as SearchResponse;
      setResponse(data);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error(error);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="search-container">
      <div className="search-input-wrapper">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void handleSearch(query);
            }
          }}
          placeholder="Search anything..."
          aria-label="Search"
          aria-autocomplete="list"
          aria-controls="suggestions-list"
        />
        <button onClick={() => void handleSearch(query)} disabled={loading}>
          {loading ? "..." : "Search"}
        </button>
      </div>

      {suggestions.length > 0 && (
        <ul id="suggestions-list" role="listbox">
          {suggestions.map((suggestion) => (
            <li
              key={suggestion}
              role="option"
              onClick={() => {
                setQuery(suggestion);
                void handleSearch(suggestion);
              }}
            >
              {suggestion}
            </li>
          ))}
        </ul>
      )}

      {response?.aiAnswer && (
        <div className="ai-answer" role="article" aria-label="AI-generated answer">
          <div className="ai-badge">AI Answer</div>
          <p>{response.aiAnswer.answer}</p>
          <div className="citations">
            {response.aiAnswer.citations.map((url) => (
              <a key={url} href={url} rel="noreferrer noopener">
                {new URL(url).hostname}
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="results-list" role="list">
        {response?.results.map((result) => (
          <article key={result.url} className="result-card" role="listitem">
            <a href={result.url} className="result-url">
              {result.url}
            </a>
            <h3 className="result-title">
              <a href={result.url}>{result.title}</a>
            </h3>
            <p className="result-snippet">{result.body.slice(0, 200)}…</p>
          </article>
        ))}
      </div>

      {response?.aiAnswer?.relatedQueries && (
        <div className="related-queries">
          <strong>Related:</strong>
          {response.aiAnswer.relatedQueries.map((relatedQuery) => (
            <button
              key={relatedQuery}
              onClick={() => {
                setQuery(relatedQuery);
                void handleSearch(relatedQuery);
              }}
            >
              {relatedQuery}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
