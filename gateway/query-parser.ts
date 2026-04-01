import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ParsedQuery {
  intent: "navigational" | "informational" | "transactional" | "local";
  entities: string[];
  expandedTerms: string[];
  correctedQuery: string;
  isQuestion: boolean;
}

export async function parseQuery(rawQuery: string): Promise<ParsedQuery> {
  const response = await client.messages.create({
    model: "claude-opus-4-1",
    max_tokens: 300,
    system: "You are a search query analyzer. Return only valid JSON.",
    messages: [
      {
        role: "user",
        content: `Analyze this search query and return JSON:

Query: "${rawQuery}"

Return exactly this structure:
{
  "intent": "navigational|informational|transactional|local",
  "entities": ["list", "of", "key", "entities"],
  "expandedTerms": ["synonyms", "related", "terms", "to", "add"],
  "correctedQuery": "spell-corrected version of the query",
  "isQuestion": true|false
}`,
      },
    ],
  });

  const firstBlock = response.content[0];
  if (firstBlock.type !== "text") {
    throw new Error("Anthropic response did not contain text.");
  }

  return JSON.parse(firstBlock.text) as ParsedQuery;
}
