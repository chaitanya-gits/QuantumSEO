import express from "express";
import { runExternalSearchAgent } from "../retrieval/external-search-agent.js";

const router = express.Router();

router.get("/search-agent", async (req, res) => {
  const rawQuery = (req.query.q as string | undefined)?.trim();

  if (!rawQuery) {
    return res.status(400).json({
      query: "",
      search_queries: [],
      sources: [],
      final_answer: "insufficient data",
    });
  }

  try {
    const payload = await runExternalSearchAgent(rawQuery);
    return res.json(payload);
  } catch (error) {
    console.error("Search agent error:", error);
    return res.status(500).json({
      query: rawQuery,
      search_queries: [],
      sources: [],
      final_answer: "insufficient data",
    });
  }
});

export default router;
