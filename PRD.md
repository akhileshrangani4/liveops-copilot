# LiveOps Copilot — PRD

## Problem
eBay Live sellers run understaffed shows. One operator simultaneously moderates
chat, answers product questions, manages listings, adjusts inventory, and drives
conversion in real time. Viewer questions go unanswered, prices drift outside
policy, and abusive chat slips through.

## Wedge
An **operator copilot**, not a replacement. Single seller surface that:
1. Triages every viewer message into intent + drafted reply, grounded in seller catalog.
2. Gates every reply through a guardrail stack (price, availability, policy, tone, off-platform).
3. Exposes one-click and (when safe) auto-pilot listing and inventory actions, also guardrailed.
4. Surfaces on-demand product research that pulls real catalog facts on stream.
5. Logs every AI decision into an audit trail for post-show review.

## Copilot → agentic automation ladder

| Tier | What the AI does | What the operator does | Confidence required |
|---|---|---|---|
| 0 — Observe | Tags each viewer message by intent | Reads chat | None |
| 1 — Draft | Drafts a reply, shows guardrail status | Approves / edits / ignores | Guardrails pass |
| 2 — Auto-send | Sends low-risk replies (sizing, shipping, availability) | Reviews audit trail post-show | Guardrails pass + `autoReplySafe`=true + intent in safe set |
| 3 — Auto-act | Pushes a listing when a viewer asks "show me the X" | Reviews audit trail | Guardrails pass + SKU match high confidence |
| 4 — Auto-negotiate | Counters at policy floor when a price is offered | Approves negotiation envelope at show start | Guardrails pass + offer within seller's pre-set envelope |

This prototype implements tiers 0–3 with Tier 4 represented as a guardrail
violation (`price_below_floor`) that surfaces an operator approval request.

## Pilot design

- **3–5 eBay Live sellers**, recruited via eBay Live category managers. Mix:
  one sneakers, one trading cards, one vintage apparel, one collectibles.
- **2-week shadow phase**: copilot suggests, never auto-sends. We instrument
  agreement rate (operator-accepted suggestions / total suggestions) and latency.
- **2-week activate phase**: Tier 2 on for "safe" intents. Operator can pull the
  fire-alarm to revert to shadow.
- **Success bar to graduate to pilot**: ≥70% suggestion acceptance, p95 reply
  latency <2s, zero guardrail-bypass incidents.

## MVP module scope (12 weeks)

| Module | In MVP | Cut |
|---|---|---|
| Chat ingestion + reply draft | ✅ | — |
| Guardrail stack (price/availability/policy/tone/off-platform) | ✅ | — |
| Listing/inventory actions: push, feature, markdown, stock adjust | ✅ | Multi-warehouse inventory |
| Product research with **generative UI** (structured cards + inline action buttons) | ✅ | External market-comp scraping |
| Audit trail UI + replay | ✅ | Long-term audit warehouse |
| Voice-driven host narration | — | post-MVP |
| Cross-seller policy library | — | post-MVP |
| Multi-show orchestration | — | post-MVP |

## Co-build model with eBay

- eBay supplies Live API access (chat WS, listings, inventory, policies, viewer presence).
- eBay supplies pilot sellers and category-manager sponsor.
- We supply the operator UX, model orchestration, guardrail stack, audit infra.
- Shared roadmap review every 2 weeks. eBay owns merchant-facing T&Cs; we own
  copilot product surface and AI behavior.

## Success metrics

| Metric | Definition | Target by end of pilot |
|---|---|---|
| GMV per show | Sum of order value attributed to live show | +25% vs. seller's 4-week pre-pilot baseline |
| Operator load | Active interactions per minute (replies typed + actions taken manually) | -40% vs. baseline (copilot absorbs the rote) |
| Reply coverage | Viewer messages answered / total messages | ≥85% (vs. ~50% baseline) |
| Reply latency | p95 time from viewer message to outbound reply | <2s |
| Auto-pilot safety | Guardrail-blocked sends / total sends + zero post-hoc operator overrides on auto-sent replies | 100% block coverage on injected red-team set |

## Risks & open questions

- **Hallucinated stock**: model claims an item is available when it isn't. Mitigated by guardrails referencing live catalog state, not the prompt.
- **Tone drift on long shows**: stale context windows lead to repetition or off-brand voice. Mitigated by per-message stateless draft + recent-window context only.
- **eBay API rate limits on chat**: assumption is dedicated allowlist for pilot. Open with eBay partner.
- **Operator UX overload**: three-pane is dense. Real users may want a single column or compact mode. Pilot will surface.
