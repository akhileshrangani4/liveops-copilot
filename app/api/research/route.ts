import { generateObject } from "ai";
import { z } from "zod";
import { model } from "@/lib/ai";
import { catalog } from "@/lib/data";
import { record } from "@/lib/audit";

const StructuredResearch = z.object({
  title: z.string().describe("Short title for the research result (under 60 chars)."),
  brief: z
    .string()
    .describe(
      "Markdown brief, under 150 words, summarizing relevant inventory, pricing, alternatives, and any concerns. This is shown to the operator as raw text.",
    ),
  listings: z
    .array(
      z.object({
        sku: z.string(),
        why: z.string().describe("One sentence on why this listing is relevant to the query."),
        recommendedAction: z
          .enum(["push_listing", "swap_featured", "markdown", "none"])
          .describe("Suggested operator action."),
        markdownPriceUsd: z
          .number()
          .nullable()
          .describe(
            "Suggested markdown price if recommendedAction is markdown, else null. Must respect 25% max markdown.",
          ),
      }),
    )
    .max(5)
    .describe("Top relevant listings (max 5). SKUs MUST exist in the catalog provided."),
  summary: z.string().describe("2-3 sentence summary the operator can read aloud on stream."),
});

export type StructuredResearchResult = z.infer<typeof StructuredResearch>;

export const runtime = "nodejs";
export const maxDuration = 30;

const CATALOG_SNAPSHOT = catalog.listings
  .map(
    (l) =>
      `- ${l.sku} | ${l.title} | brand ${l.brand} | size ${l.size} | ${l.condition} | $${l.price_usd}${l.msrp_usd ? ` (msrp $${l.msrp_usd})` : ""} | stock ${l.stock}${l.active ? "" : " | INACTIVE"}${l.featured ? " | FEATURED" : ""} | tags: ${l.tags.join(",")} | ${l.description}`,
  )
  .join("\n");

const VALID_SKUS = catalog.listings.map((l) => l.sku);

export async function POST(req: Request) {
  const t0 = Date.now();
  const { query } = (await req.json()) as { query: string };

  const result = await generateObject({
    model: model(),
    schema: StructuredResearch,
    system: `You are a research assistant for ${catalog.seller.name} (eBay Live seller).
The operator will ask a question about their inventory during a live stream.

CATALOG:
${CATALOG_SNAPSHOT}

POLICIES:
- Max markdown: ${catalog.seller.policies.max_markdown_pct}% off listed price.
- Discount floor (negotiation): ${catalog.seller.policies.discount_floor_pct}% off.

Rules:
- Valid SKUs only: ${VALID_SKUS.join(", ")}. Do NOT invent SKUs.
- recommendedAction = "push_listing" if the listing directly answers the question, "swap_featured" if it should be the headline, "markdown" if pricing vs MSRP suggests a deal opportunity AND the listing is active with stock > 0, "none" otherwise.
- If markdown, propose a price that is between (price - 25%) and (price - 5%). Never below 75% of current price.
- Inactive or zero-stock listings: include if they directly match the query (with "none" action) so the operator can acknowledge.
- The "brief" field must be filled — never empty — a tight markdown summary.`,
    prompt: query,
    temperature: 0.3,
  });

  // Defensive filter — drop any SKU the model hallucinated despite instructions.
  const filteredListings = result.object.listings.filter((l) => VALID_SKUS.includes(l.sku));
  const dropped = result.object.listings.length - filteredListings.length;
  const structured = { ...result.object, listings: filteredListings };

  const latencyMs = Date.now() - t0;
  record({
    kind: "tool_call",
    actor: "ai",
    summary: `research: "${query.slice(0, 60)}" -> ${structured.listings.length} listings${dropped ? ` (${dropped} hallucinated SKUs filtered)` : ""} (${latencyMs}ms)`,
    payload: { query, latencyMs, dropped },
  });

  return Response.json({
    brief: structured.brief,
    structured,
    latencyMs,
  });
}
