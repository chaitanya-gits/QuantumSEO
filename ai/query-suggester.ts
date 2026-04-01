import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function suggestRelatedQueries(query: string): Promise<string[]> {
  const response = await client.messages.create({
    model: "claude-opus-4-1",
    max_tokens: 120,
    system: "Return only a JSON array of three short related search queries.",
    messages: [{ role: "user", content: query }],
  });

  const firstBlock = response.content[0];
  if (firstBlock.type !== "text") {
    throw new Error("Anthropic response did not contain text.");
  }

  return JSON.parse(firstBlock.text) as string[];
}
