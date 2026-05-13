import { checkReply } from "@/lib/guardrails";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    reply: string;
    forSku?: string;
    offerPriceUsd?: number;
  };
  return Response.json(checkReply(body));
}
