import { generateObject } from "ai";
import { z } from "zod";
import { model } from "@/lib/ai";
import { catalog } from "@/lib/data";
import { checkReply } from "@/lib/guardrails";
import { record } from "@/lib/audit";

export const runtime = "nodejs";

const ReplySchema = z.object({
  reply: z.string().describe("The text to send to the viewer. Conversational, under 280 chars."),
  forSku: z
    .string()
    .nullable()
    .describe("SKU referenced, or null if generic question."),
  offerPriceUsd: z
    .number()
    .nullable()
    .describe("If the reply quotes or accepts a price, the USD amount. Else null."),
  intent: z.enum([
    "price_question",
    "availability",
    "sizing",
    "shipping",
    "negotiation",
    "research_request",
    "off_topic",
    "off_platform_attempt",
    "abusive",
    "generic",
  ]),
  autoReplySafe: z
    .boolean()
    .describe("True if reply is low-risk and can be sent without operator approval."),
  reasoning: z.string().describe("One sentence on why this reply is appropriate."),
});

function catalogSnapshot() {
  return catalog.listings
    .map(
      (l) =>
        `- ${l.sku} | ${l.title} | size ${l.size} | ${l.condition} | $${l.price_usd}${l.msrp_usd ? ` (msrp $${l.msrp_usd})` : ""} | stock ${l.stock}${l.active ? "" : " | INACTIVE"}${l.featured ? " | FEATURED" : ""}`,
    )
    .join("\n");
}

const SYSTEM = `You are the LiveOps Copilot for ${catalog.seller.name}, an eBay Live seller (rating ${catalog.seller.rating}).
You generate concise replies (under 280 chars) for live-stream chat viewers.

SELLER POLICIES:
- Returns: ${catalog.seller.policies.returns}
- Shipping: ${catalog.seller.policies.shipping}
- Authentication: ${catalog.seller.policies.auth}
- Max negotiation discount: ${catalog.seller.policies.discount_floor_pct}% off listed price.
- Max markdown: ${catalog.seller.policies.max_markdown_pct}% off.

CURRENT CATALOG:
${catalogSnapshot()}

RULES:
- Only quote prices that exist in the catalog or are within ${catalog.seller.policies.discount_floor_pct}% of listed price.
- Never share contact info, addresses, phone, email, or off-platform payment methods.
- Never accept off-platform pickup or contact requests; politely redirect to the eBay listing.
- Do not insult viewers or escalate hostile messages; de-escalate or ignore abusive content.
- If a viewer asks about an inactive or out-of-stock SKU, say so honestly and suggest similar in-stock alternatives.
- Be warm, brief, and useful. Match a live-stream tone, not corporate.
- autoReplySafe=true only when: intent is informational (sizing, shipping, availability), no negotiation, no edge cases.

Return JSON matching the schema.`;

export async function POST(req: Request) {
  const t0 = Date.now();
  const body = await req.json();
  const viewerMsg = body.viewerMessage as { user: string; text: string };
  const recent = (body.recentMessages || []) as { user: string; text: string }[];

  const context = recent
    .slice(-6)
    .map((m) => `${m.user}: ${m.text}`)
    .join("\n");

  const result = await generateObject({
    model: model(),
    schema: ReplySchema,
    system: SYSTEM,
    prompt: `Recent chat:\n${context}\n\nNew viewer message from ${viewerMsg.user}: "${viewerMsg.text}"\n\nGenerate the best reply.`,
    temperature: 0.4,
  });

  const guardrails = checkReply({
    reply: result.object.reply,
    forSku: result.object.forSku ?? undefined,
    offerPriceUsd: result.object.offerPriceUsd ?? undefined,
  });

  const latencyMs = Date.now() - t0;

  record({
    kind: "reply_suggested",
    actor: "ai",
    summary: `${result.object.intent}: ${result.object.reply.slice(0, 80)}${result.object.reply.length > 80 ? "…" : ""}`,
    payload: { viewer: viewerMsg, ...result.object, latencyMs },
    guardrails,
  });

  return Response.json({
    ...result.object,
    guardrails,
    latencyMs,
    autoReplySafe: result.object.autoReplySafe && guardrails.ok && guardrails.warnings.length === 0,
  });
}
