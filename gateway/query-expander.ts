export function expandQueryTerms(query: string, synonyms: string[] = []): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  const uniqueTerms = new Set<string>();

  normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .forEach((term) => uniqueTerms.add(term));

  synonyms
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .forEach((term) => uniqueTerms.add(term));

  return Array.from(uniqueTerms);
}
