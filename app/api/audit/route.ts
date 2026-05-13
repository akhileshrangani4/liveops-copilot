import { list } from "@/lib/audit";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ entries: list() });
}
