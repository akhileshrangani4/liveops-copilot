# LiveOps Copilot — TDD

## Real-time ingestion architecture

```
       eBay Live              Operator Console (Next.js)              Anthropic API
   ┌────────────────┐       ┌──────────────────────────────┐       ┌──────────────┐
   │ Chat WebSocket │──────▶│  /api/ingest (SSE → client)  │       │              │
   │ Catalog API    │──────▶│  /api/state                  │──────▶│ claude-sonnet│
   │ Inventory API  │◀──────│  /api/action  (write)        │       │   -4-5       │
   │ Listings API   │◀──────│  /api/send    (write)        │       │              │
   └────────────────┘       └──────┬───────────────────────┘       └──────────────┘
                                   │
                                   ▼
                            ┌──────────────┐
                            │  Guardrails  │  pure functions
                            └──────┬───────┘
                                   ▼
                            ┌──────────────┐
                            │ Audit log    │  append-only, pub/sub
                            └──────────────┘
```

Prototype runs all of this in one Next.js process with in-memory state. MVP swap-ins:

- Chat ingest: Redis Streams (one stream per show). SSE for client subscription.
- Catalog state: Postgres + Redis cache (5s TTL on read paths, write-through on writes).
- Audit log: append-only Postgres table partitioned by show, mirrored to S3 nightly.

## Catalog grounding and retrieval

For the prototype, catalogs are small (5 listings); we inject the full catalog
snapshot into the reply-suggestion system prompt. No vector store needed.

**Scale-up plan** (per seller, 1k–50k SKUs):
- BM25 over SKU + title + tags + brand (Postgres `pg_trgm` or Tantivy). Use top-20 hits as candidate context.
- Vector embedding (Voyage or text-embedding-3-large) over `title + description + condition` for semantic matches (alternatives, "show me something like X").
- Hybrid retrieval: BM25 ∪ vector, dedupe by SKU, re-rank by recency + featured + stock.
- Cache: per-show, pre-warm the top-200 listings by viewer-attention heuristic.

The system prompt always includes seller policies in full (small, high-signal,
mutates rarely) and only the retrieved listing slice (large, dynamic).

## Guardrail stack

Layered, fail-closed. Every reply and every write passes through the relevant checks before any side-effect.

| Layer | Rules (sample) | Severity |
|---|---|---|
| Off-platform | Venmo/CashApp/PayPal.me, phone, email, "my address", "pickup", "DM me" | block |
| Tone | Insults, profanity, hostility | block |
| Price floor | Quoted price < `listing.price_usd × (1 − discount_floor_pct)` | block |
| Markdown ceiling | Markdown price < `listing.price_usd × (1 − max_markdown_pct)` | block |
| Inventory truth | SKU referenced is active and `stock > 0`; warn otherwise | warn (reply) / block (action) |
| Policy falsehood | "Same-day shipping", "overnight free" when policy says 1 business day | warn |
| Unknown SKU | Reply or action references SKU not in catalog | block |

Implementation: `lib/guardrails.ts`, ~150 lines, pure functions, no model
calls. Each invocation returns `{ ok, violations, warnings }`. UI renders
violations as red badges, warnings as amber. Operator can override warnings,
never violations.

**Why pure functions, not an LLM judge**: deterministic, sub-1ms, auditable, no
prompt injection surface. The LLM proposes; deterministic code disposes.

**Red-team set** (built post-MVP): 200 adversarial viewer messages designed to
elicit guardrail violations (price baiting, off-platform requests, SKU
hallucination triggers, etc.). Guardrail coverage must be 100% on this set.

## Audit trail for agentic writes

Every of these emits an audit entry:

| Kind | Trigger |
|---|---|
| `reply_suggested` | Model proposes a reply |
| `reply_sent` | Operator or auto-pilot sends |
| `reply_blocked` | Guardrails reject a send attempt |
| `action_executed` | `push_listing`, `swap_featured`, `markdown`, `stock_adjust` |
| `action_blocked` | Guardrails reject a write |
| `tool_call` | Research-agent tool invocation |

Entry shape: `{ id, ts, kind, actor: ai|operator|system, summary, payload, guardrails }`.
Prototype keeps the last 500 in memory. MVP persists to Postgres with a UI for
post-show replay and a CSV export for compliance.

## Latency budgets

| Hop | Budget | Notes |
|---|---|---|
| Viewer message → server | 50ms | Within eBay's WS region |
| Server → Anthropic first byte | 400ms | sonnet-4-5 typical |
| Anthropic → completion (atomic structured output, ~120 tokens) | 800ms | `generateObject` |
| Guardrail check | <1ms | Pure CPU |
| Server → client | 50ms | Local network |
| Client render | 16ms | One react paint |
| **End-to-end p95** | **<2000ms** | Reply rendered to operator |

Optimizations chosen:
- `generateObject` (atomic) over streaming + post-parse — saves a round-trip and simplifies guardrail timing.
- Catalog snapshot in system prompt (cached prefix by Anthropic prompt-caching when enabled).
- Node runtime, single region near the model endpoint.

Optimizations deferred:
- Speculative decoding via parallel haiku-draft + sonnet-arbiter.
- Per-show warm KV cache for the system prompt prefix.

## eBay API integration

For the prototype, we use synthetic fixtures (`data/catalog.json`,
`data/chat-script.json`). MVP integration plan:

| eBay surface | Use |
|---|---|
| Live chat WS | Subscribe per show, dedupe by message id, emit to Redis Stream |
| Browse/Search API | Comp/research depth: query similar listings outside seller catalog |
| Inventory API | `push_listing` / `swap_featured` / `stock_adjust` write paths |
| Sell API: Pricing | `markdown` writes |
| Trading API: Returns/Policies | Read-only into guardrail policy table |
| Notification API | Post-show summary email to seller |

Auth: OAuth 2 user-token flow at install; rotate refresh token per seller.
Rate-limit posture: pessimistic — assume 5 req/s/seller, queue and batch writes.

## Rollback paths

| Failure | Rollback |
|---|---|
| Model 5xx / latency > budget | Fall back to a templated reply ("Thanks! Marco will get to that in a sec.") and mark message as `pending` for manual answer |
| Guardrail panic (any unexpected throw) | Fail closed: block send, log incident, alert |
| Write to eBay fails | Revert local state from audit log; surface red toast to operator with retry |
| Auto-pilot misbehavior detected at runtime (operator hits panic) | Flip global `autoReply=false`; remaining queue moves to manual approval |
| Catalog drift (policy file edited mid-show) | Re-load on next request, but in-flight suggestions use the stale snapshot (acceptable for sub-2s window) |

## Telemetry

Prototype: console-only (`record()` emits to audit log, browser polls every 1.5s).

MVP: OpenTelemetry from each route handler, traces export to Vercel
Observability + Datadog. Key spans: `suggest.model`, `suggest.guardrails`,
`send.guardrails`, `action.guardrails`. Key metrics: `reply_latency_ms` (p50/p95/p99),
`guardrail_block_rate`, `auto_reply_rate`, `operator_override_rate`,
`tool_calls_per_research`.

## Open technical questions

1. **Anthropic prompt-cache hit rate** on the catalog snapshot — depends on cache TTL vs. show pacing. Budget assumes ≥70% hit rate after first request.
2. **Per-show concurrency** — one show = many viewer messages/sec at peak. Need to validate that `generateObject` with sonnet-4-5 holds <2s p95 at 5 RPS sustained per show.
3. **eBay Live chat message dedup semantics** — TBD with eBay partner.
4. **PII redaction before Anthropic call** — viewer messages can contain emails, phone numbers, addresses. Need a pre-call scrubber that hashes-then-passes or rejects.
