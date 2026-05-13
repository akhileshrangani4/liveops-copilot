import { catalog } from "./data";
import { record } from "./audit";
import { checkAction, type ActionRequest } from "./guardrails";

type MutableCatalog = typeof catalog;

const state: MutableCatalog = JSON.parse(JSON.stringify(catalog));

export function getState() {
  return state;
}

export function executeAction(
  req: ActionRequest,
  actor: "ai" | "operator",
): { ok: boolean; message: string; guardrails: ReturnType<typeof checkAction> } {
  const g = checkAction(req);
  if (!g.ok) {
    record({
      kind: "action_blocked",
      actor,
      summary: `Blocked ${req.type} on ${req.sku}: ${g.violations.map((v) => v.message).join("; ")}`,
      payload: req,
      guardrails: g,
    });
    return { ok: false, message: g.violations.map((v) => v.message).join("; "), guardrails: g };
  }

  const listing = state.listings.find((l) => l.sku === req.sku)!;
  let message = "";

  switch (req.type) {
    case "push_listing":
      message = `Pushed ${listing.title} to viewers (highlighted on stream).`;
      break;
    case "swap_featured":
      state.listings.forEach((l) => (l.featured = false));
      listing.featured = true;
      message = `${listing.title} is now the featured item.`;
      break;
    case "markdown": {
      const old = listing.price_usd;
      listing.price_usd = req.new_price_usd;
      message = `Marked down ${listing.sku} from $${old} to $${req.new_price_usd}.`;
      break;
    }
    case "stock_adjust": {
      const old = listing.stock;
      listing.stock = old + req.delta;
      message = `Stock for ${listing.sku}: ${old} -> ${listing.stock}.`;
      break;
    }
  }

  record({
    kind: "action_executed",
    actor,
    summary: message,
    payload: req,
    guardrails: g,
  });

  return { ok: true, message, guardrails: g };
}
