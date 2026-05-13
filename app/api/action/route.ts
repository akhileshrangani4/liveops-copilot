import { executeAction } from "@/lib/state";
import type { ActionRequest } from "@/lib/guardrails";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as { action: ActionRequest; actor?: "ai" | "operator" };
  const result = executeAction(body.action, body.actor ?? "operator");
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
