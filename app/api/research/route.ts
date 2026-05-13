import { generateText, generateObject, tool } from "ai";
import { z } from "zod";
import { model } from "@/lib/ai";
import { catalog, searchListings, findListing } from "@/lib/data";
import { record } from "@/lib/audit";

const StructuredResearch = z.object({
  title: z.string().describe("Short title for the research result."),
  listings: z
    .array(
      z.object({
        sku: z.string(),
        why: z.string().describe("One sentence on why this listing is relevant."),
        recommendedAction: z
          .enum(["push_listing", "swap_featured", "markdown", "none"])
          .describe("Suggested operator action."),
        markdownPriceUsd: z
          .number()
          .nullable()
          .describe("Suggested markdown price if recommendedAction is markdown, else null."),
      }),
    )
    .max(5)
    .describe("Top relevant listings (max 5). Only include SKUs that exist in the catalog."),
  summary: z.string().describe("2-3 sentence summary the operator can read on stream."),
});

export type StructuredResearchResult = z.infer<typeof StructuredResearch>;

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
    system: `You are a research assistant for a live-commerce seller. Use the tools to gather facts from the catalog. Produce a tight markdown brief (under 150 words) summarizing relevant inventory, pricing, alternatives, and any concerns. Do NOT fabricate SKUs.`,
    prompt: query,
  });

  const structured = await generateObject({
    model: model(),
    schema: StructuredResearch,
    system: `Convert the research brief into structured form. Only include SKUs that appear verbatim in the brief AND in this catalog: ${catalog.listings.map((l) => l.sku).join(", ")}. For recommendedAction: "push_listing" if a clear opportunity, "markdown" if pricing is high vs comparable, "swap_featured" if it should be the headline item, "none" otherwise. If markdown, propose a price within the seller's 25% max markdown ceiling.`,
    prompt: `Query: ${query}\n\nBrief:\n${result.text}`,
  });

  const latencyMs = Date.now() - t0;
  record({
    kind: "tool_call",
    actor: "ai",
    summary: `research: "${query.slice(0, 60)}" (${result.steps.length} steps, ${structured.object.listings.length} listings, ${latencyMs}ms)`,
    payload: { query, steps: result.steps.length, latencyMs },
  });

  return Response.json({
    brief: result.text,
    structured: structured.object,
    steps: result.steps.length,
    latencyMs,
  });
}
