import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface SearchResult {
  url: string;
  title: string;
  body: string;
  score: number;
}

export interface AIAnswer {
  answer: string;
  citations: string[];
  confidence: "high" | "medium" | "low";
  relatedQueries: string[];
}

export async function generateAIAnswer(query: string, topResults: SearchResult[]): Promise<AIAnswer> {
  const context = topResults
    .slice(0, 5)
    .map((result, index) => `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.body.slice(0, 800)}`)
    .join("\n\n---\n\n");

  const response = await client.messages.create({
    model: "claude-opus-4-1",
    max_tokens: 600,
    system:
      "You are a search assistant. Answer concisely based only on provided context. Return JSON with keys: answer, citations, confidence, relatedQueries.",
    messages: [
      {
        role: "user",
        content: `Query: ${query}\n\nContext:\n${context}\n\nReturn valid JSON only.`,
      },
    ],
  });

  const firstBlock = response.content[0];
  if (firstBlock.type !== "text") {
    throw new Error("Anthropic response did not contain text.");
  }

  return JSON.parse(firstBlock.text) as AIAnswer;
}
