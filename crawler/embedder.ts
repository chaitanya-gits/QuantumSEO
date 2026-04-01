import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const truncated = texts.map((text) => text.slice(0, 8000));

  const response = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: truncated,
    encoding_format: "float",
  });

  return response.data.map((entry) => entry.embedding);
}

export async function embedQuery(query: string): Promise<number[]> {
  const vectors = await embedTexts([query]);
  return vectors[0];
}
