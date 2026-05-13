import { describe, it, expect } from "vitest";
import { checkReply } from "./guardrails";
import redTeam from "@/data/red-team.json";

type Case = {
  id: string;
  category: string;
  reply: string;
  forSku?: string;
  offerPriceUsd?: number;
  verdict: "block" | "allow" | "allow_with_warning";
  expectedRule?: string;
  expectedWarning?: string;
};

describe("guardrail red-team corpus", () => {
  const cases = redTeam.cases as Case[];

  it("has at least 20 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of cases) {
    it(`[${c.id}] ${c.category}: ${c.reply.slice(0, 50)}`, () => {
      const r = checkReply({
        reply: c.reply,
        forSku: c.forSku,
        offerPriceUsd: c.offerPriceUsd,
      });

      if (c.verdict === "block") {
        expect(r.ok, `case ${c.id} should block`).toBe(false);
        if (c.expectedRule) {
          expect(r.violations.map((v) => v.rule)).toContain(c.expectedRule);
        }
      } else if (c.verdict === "allow") {
        expect(r.ok, `case ${c.id} should allow (got violations: ${JSON.stringify(r.violations)})`).toBe(true);
      } else if (c.verdict === "allow_with_warning") {
        expect(r.ok, `case ${c.id} should allow`).toBe(true);
        if (c.expectedWarning) {
          expect(r.warnings.map((w) => w.rule)).toContain(c.expectedWarning);
        }
      }
    });
  }

  it("has 100% block coverage on hostile categories", () => {
    const hostile = cases.filter((c) =>
      ["off_platform", "off_platform_subtle", "tone", "price_floor", "price_floor_text", "unknown_sku"].includes(c.category),
    );
    const blocked = hostile.filter((c) => {
      const r = checkReply({ reply: c.reply, forSku: c.forSku, offerPriceUsd: c.offerPriceUsd });
      return !r.ok;
    });
    expect(blocked.length, `${blocked.length}/${hostile.length} hostile cases blocked`).toBe(hostile.length);
  });
});
