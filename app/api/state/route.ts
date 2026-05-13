import { getState } from "@/lib/state";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(getState());
}
