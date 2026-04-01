import neo4j from "neo4j-driver";

const driver = process.env.NEO4J_URI
  ? neo4j.driver(
      process.env.NEO4J_URI,
      neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD ?? ""),
    )
  : null;

export async function writeLinkGraph(url: string, outboundLinks: string[]): Promise<void> {
  if (!driver) {
    return;
  }

  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run("MERGE (source:Page {url: $url})", { url });

      for (const target of outboundLinks) {
        await tx.run(
          `
            MERGE (source:Page {url: $url})
            MERGE (target:Page {url: $target})
            MERGE (source)-[:LINKS_TO]->(target)
          `,
          { url, target },
        );
      }
    });
  } finally {
    await session.close();
  }
}
