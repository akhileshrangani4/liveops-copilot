import type { GuardrailReport } from "./audit";
import { catalog, findListing, type Listing } from "./data";

export type ReplyContext = {
  reply: string;
  referencedSkus?: string[];
  offerPriceUsd?: number;
  forSku?: string;
};

export type ActionRequest =
  | { type: "push_listing"; sku: string }
  | { type: "swap_featured"; sku: string }
  | { type: "markdown"; sku: string; new_price_usd: number }
  | { type: "stock_adjust"; sku: string; delta: number };

const TONE_PATTERNS: RegExp[] = [
  /\b(idiot|stupid|moron|liar|trash)\b/i,
  /\b(shut up|stfu|gtfo)\b/i,
];

const OFF_PLATFORM_PATTERNS: RegExp[] = [
  /\b(venmo|cashapp|cash app|zelle|paypal\.me|paypal me)\b/i,
  /\b(my address|pick up|pickup|meet up|meetup)\b/i,
  /\b(whatsapp|telegram|signal|dm me|text me|call me)\b/i,
  /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/,
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
];

export function checkReply(ctx: ReplyContext): GuardrailReport {
  const violations: GuardrailReport["violations"] = [];
  const warnings: GuardrailReport["warnings"] = [];
  const text = ctx.reply ?? "";

  for (const re of OFF_PLATFORM_PATTERNS) {
    if (re.test(text)) {
      violations.push({
        rule: "off_platform_contact",
        severity: "block",
        message: `Reply attempts off-platform contact (matched ${re}).`,
      });
      break;
    }
  }

  for (const re of TONE_PATTERNS) {
    if (re.test(text)) {
      violations.push({
        rule: "tone_aggressive",
        severity: "block",
        message: "Reply tone is aggressive or insulting.",
      });
      break;
    }
  }

  if (ctx.forSku) {
    const listing = findListing(ctx.forSku);
    if (!listing) {
      violations.push({
        rule: "unknown_sku",
        severity: "block",
        message: `Referenced SKU ${ctx.forSku} does not exist in catalog.`,
      });
    } else {
      if (!listing.active || listing.stock <= 0) {
        warnings.push({
          rule: "out_of_stock",
          severity: "warn",
          message: `${listing.sku} is inactive or out of stock.`,
        });
      }
      const floor =
        listing.price_usd * (1 - catalog.seller.policies.discount_floor_pct / 100);

      if (ctx.offerPriceUsd !== undefined && ctx.offerPriceUsd < floor) {
        violations.push({
          rule: "price_below_floor",
          severity: "block",
          message: `Offer $${ctx.offerPriceUsd} is below floor $${floor.toFixed(2)} for ${listing.sku}.`,
        });
      }

      // Strip policy/threshold phrases so shipping/free-over amounts don't trip the offer check.
      const negotiationText = text.replace(
        /\b(free shipping over|shipping over|free over|orders over|under)\s*\$\s?\d{1,5}/gi,
        "",
      );
      const priceMatches = [...negotiationText.matchAll(/\$\s?(\d{2,5})/g)].map((m) =>
        Number(m[1]),
      );
      for (const p of priceMatches) {
        if (p < floor && p > 10) {
          violations.push({
            rule: "price_below_floor",
            severity: "block",
            message: `Reply quotes $${p} which is below floor $${floor.toFixed(2)} for ${listing.sku}.`,
          });
          break;
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

export function checkAction(req: ActionRequest): GuardrailReport {
  const violations: GuardrailReport["violations"] = [];
  const warnings: GuardrailReport["warnings"] = [];
  const listing = findListing(req.sku);

  if (!listing) {
    violations.push({
      rule: "unknown_sku",
      severity: "block",
      message: `SKU ${req.sku} not in catalog.`,
    });
    return { ok: false, violations, warnings };
  }

  switch (req.type) {
    case "push_listing":
    case "swap_featured":
      if (!listing.active) {
        violations.push({
          rule: "inactive_listing",
          severity: "block",
          message: `Cannot feature inactive listing ${listing.sku}.`,
        });
      }
      if (listing.stock <= 0) {
        warnings.push({
          rule: "zero_stock",
          severity: "warn",
          message: `Featuring ${listing.sku} with 0 stock will frustrate viewers.`,
        });
      }
      break;
    case "markdown": {
      const maxDiscount = catalog.seller.policies.max_markdown_pct;
      const floor = listing.price_usd * (1 - maxDiscount / 100);
      if (req.new_price_usd >= listing.price_usd) {
        violations.push({
          rule: "markdown_not_decrease",
          severity: "block",
          message: `Markdown $${req.new_price_usd} not lower than current $${listing.price_usd}.`,
        });
      }
      if (req.new_price_usd < floor) {
        violations.push({
          rule: "markdown_below_max",
          severity: "block",
          message: `Markdown to $${req.new_price_usd} exceeds max ${maxDiscount}% (floor $${floor.toFixed(2)}).`,
        });
      }
      break;
    }
    case "stock_adjust":
      if (listing.stock + req.delta < 0) {
        violations.push({
          rule: "negative_stock",
          severity: "block",
          message: `Stock adjust would yield negative stock.`,
        });
      }
      if (Math.abs(req.delta) > 50) {
        warnings.push({
          rule: "large_stock_swing",
          severity: "warn",
          message: `Stock delta ${req.delta} unusually large.`,
        });
      }
      break;
  }

  return { ok: violations.length === 0, violations, warnings };
}

export function describeListing(l: Listing): string {
  return `${l.sku} | ${l.title} | $${l.price_usd} | stock ${l.stock}`;
}
