import { checkReply } from "@/lib/guardrails";
import { record } from "@/lib/audit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    reply: string;
    forSku?: string;
    offerPriceUsd?: number;
    viewer: { user: string; text: string };
    auto: boolean;
  };

  const g = checkReply({
    reply: body.reply,
    forSku: body.forSku,
    offerPriceUsd: body.offerPriceUsd,
  });

  if (!g.ok) {
    record({
      kind: "reply_blocked",
      actor: body.auto ? "ai" : "operator",
      summary: `Blocked send: ${g.violations.map((v) => v.rule).join(", ")}`,
      payload: body,
      guardrails: g,
    });
    return Response.json({ ok: false, guardrails: g }, { status: 422 });
  }

  record({
    kind: "reply_sent",
    actor: body.auto ? "ai" : "operator",
    summary: `to ${body.viewer.user}: ${body.reply.slice(0, 80)}`,
    payload: body,
    guardrails: g,
  });

  return Response.json({ ok: true, guardrails: g });
}
