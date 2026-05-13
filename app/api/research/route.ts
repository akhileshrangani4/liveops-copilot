import { generateText, tool } from "ai";
import { z } from "zod";
import { model } from "@/lib/ai";
import { catalog, searchListings, findListing } from "@/lib/data";
import { record } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const t0 = Date.now();
  const { query } = (await req.json()) as { query: string };

  const tools = {
    search_catalog: tool({
      description: "Search the seller's catalog by keyword (brand, model, tag, sku).",
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const results = searchListings(query).slice(0, 8);
        record({
          kind: "tool_call",
          actor: "ai",
          summary: `search_catalog("${query}") -> ${results.length} results`,
          payload: { query, results: results.map((r) => r.sku) },
        });
        return { results };
      },
    }),
    get_listing: tool({
      description: "Get full detail on one listing by SKU.",
      parameters: z.object({ sku: z.string() }),
      execute: async ({ sku }) => {
        const listing = findListing(sku);
        record({
          kind: "tool_call",
          actor: "ai",
          summary: `get_listing("${sku}") -> ${listing ? "ok" : "missing"}`,
          payload: { sku },
        });
        return { listing: listing ?? null };
      },
    }),
    list_featured: tool({
      description: "List currently featured listings.",
      parameters: z.object({}),
      execute: async () => {
        const featured = catalog.listings.filter((l) => l.featured);
        return { featured };
      },
    }),
  };

  const result = await generateText({
    model: model(),
    tools,
    maxSteps: 5,
    system: `You are a research assistant for a live-commerce seller. Use the tools to gather facts from the catalog. Produce a tight markdown brief (under 200 words) summarizing relevant inventory, pricing, alternatives, and any concerns (stock, condition, pricing vs MSRP). Do NOT fabricate SKUs.`,
    prompt: query,
  });

  const latencyMs = Date.now() - t0;
  record({
    kind: "tool_call",
    actor: "ai",
    summary: `research: "${query.slice(0, 60)}" (${result.steps.length} steps, ${latencyMs}ms)`,
    payload: { query, steps: result.steps.length, latencyMs },
  });

  return Response.json({ brief: result.text, steps: result.steps.length, latencyMs });
}
