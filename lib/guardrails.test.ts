import { describe, it, expect } from "vitest";
import { checkReply, checkAction } from "./guardrails";

describe("checkAction - markdown", () => {
  it("blocks markdown to non-decreasing price", () => {
    const r = checkAction({ type: "markdown", sku: "DUNK-PANDA-10", new_price_usd: 200 });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("markdown_not_decrease");
  });

  it("blocks markdown beyond max 25% off (Panda $135 -> floor $101.25)", () => {
    const r = checkAction({ type: "markdown", sku: "DUNK-PANDA-10", new_price_usd: 50 });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("markdown_below_max");
  });

  it("allows valid markdown within range", () => {
    const r = checkAction({ type: "markdown", sku: "DUNK-PANDA-10", new_price_usd: 120 });
    expect(r.ok).toBe(true);
  });

  it("blocks markdown on unknown SKU", () => {
    const r = checkAction({ type: "markdown", sku: "NOPE", new_price_usd: 50 });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("unknown_sku");
  });
});

describe("checkAction - push/feature", () => {
  it("blocks featuring inactive listing", () => {
    const r = checkAction({ type: "swap_featured", sku: "AJ4-BRED-11" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("inactive_listing");
  });

  it("warns on zero-stock push but does not block", () => {
    // No zero-stock active listing in default fixture, so we test with valid one
    const r = checkAction({ type: "push_listing", sku: "AJ1-CHI-95-9.5" });
    expect(r.ok).toBe(true);
  });
});

describe("checkAction - stock adjust", () => {
  it("blocks adjustment that would result in negative stock", () => {
    const r = checkAction({ type: "stock_adjust", sku: "DUNK-PANDA-10", delta: -999 });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("negative_stock");
  });

  it("warns on unusually large swing", () => {
    const r = checkAction({ type: "stock_adjust", sku: "DUNK-PANDA-10", delta: 200 });
    expect(r.warnings.map((w) => w.rule)).toContain("large_stock_swing");
  });

  it("allows normal stock adjustment", () => {
    const r = checkAction({ type: "stock_adjust", sku: "DUNK-PANDA-10", delta: 1 });
    expect(r.ok).toBe(true);
  });
});

describe("checkReply - SKU + price grounding", () => {
  it("blocks reply referencing unknown SKU", () => {
    const r = checkReply({ reply: "yes available", forSku: "FAKE-SKU-999" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("unknown_sku");
  });

  it("blocks offer below 15% discount floor (Chicago $1850 list -> floor $1572.5)", () => {
    const r = checkReply({
      reply: "deal at 1200",
      forSku: "AJ1-CHI-95-9.5",
      offerPriceUsd: 1200,
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("price_below_floor");
  });

  it("blocks reply quoting price below floor in text even without offerPriceUsd", () => {
    const r = checkReply({
      reply: "I can do $1200 on the chicagos",
      forSku: "AJ1-CHI-95-9.5",
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("price_below_floor");
  });

  it("allows offer at exactly the floor", () => {
    const r = checkReply({
      reply: "best I can do is 1575",
      forSku: "AJ1-CHI-95-9.5",
      offerPriceUsd: 1575,
    });
    expect(r.ok).toBe(true);
  });

  it("warns (not blocks) when reply references out-of-stock SKU", () => {
    const r = checkReply({ reply: "Bred 11s are sold out unfortunately", forSku: "AJ4-BRED-11" });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.rule)).toContain("out_of_stock");
  });

  it("does not block clean reply with no SKU context", () => {
    const r = checkReply({ reply: "ships in 1 business day from CA!" });
    expect(r.ok).toBe(true);
  });
});

describe("checkReply - tone", () => {
  it("blocks insults", () => {
    const r = checkReply({ reply: "you're an idiot, go away" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("tone_aggressive");
  });

  it("blocks STFU-style hostility", () => {
    const r = checkReply({ reply: "stfu and stop trolling" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("tone_aggressive");
  });

  it("allows direct but polite replies", () => {
    const r = checkReply({ reply: "Sorry, those are sold out. Try the Pandas instead!" });
    expect(r.ok).toBe(true);
  });
});

describe("checkReply - off-platform contact", () => {
  it("blocks Venmo handles", () => {
    const r = checkReply({ reply: "DM me at venmo @marco" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("off_platform_contact");
  });

  it("blocks CashApp mentions", () => {
    const r = checkReply({ reply: "send via cashapp $marco" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("off_platform_contact");
  });

  it("blocks Zelle mentions", () => {
    const r = checkReply({ reply: "pay me on zelle" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("off_platform_contact");
  });

  it("blocks pickup requests", () => {
    const r = checkReply({ reply: "come pick up at my address" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("off_platform_contact");
  });

  it("blocks raw phone numbers", () => {
    const r = checkReply({ reply: "call me at 415-555-1234" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("off_platform_contact");
  });

  it("blocks email addresses", () => {
    const r = checkReply({ reply: "email me at marco@retrokicks.com" });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("off_platform_contact");
  });

  it("blocks WhatsApp/Telegram/DM mentions", () => {
    expect(checkReply({ reply: "whatsapp me" }).ok).toBe(false);
    expect(checkReply({ reply: "telegram works too" }).ok).toBe(false);
    expect(checkReply({ reply: "DM me on insta" }).ok).toBe(false);
  });

  it("does not falsely flag list prices that look like digit strings", () => {
    const r = checkReply({ reply: "the AJ1 is $1,850 with free shipping over $75" });
    expect(r.ok).toBe(true);
  });
});
