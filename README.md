# LiveOps Copilot — AI Fund Builder Challenge

Operator copilot for eBay Live sellers. One operator runs the show; the copilot
handles chat triage, grounded reply drafting, guardrailed agentic writes against
the seller catalog, and on-demand product research.

## Quick start

```bash
pnpm install   # or npm install
cp .env.example .env.local
# add ANTHROPIC_API_KEY=sk-ant-...
pnpm dev
# open http://localhost:3000
```

Click **Start stream** to begin the scripted viewer chat. The copilot drafts a
reply for each message, runs it through the guardrail stack, and either
auto-sends (if "Auto-reply when safe" is on and all guardrails pass) or surfaces
it for one-click operator approval.

## What's in the box

| Surface | Purpose |
|---|---|
| Chat panel (left) | Scripted viewer messages stream in. Each message gets a drafted reply, guardrail badges, and Send/Ignore controls. |
| Inventory & actions (center) | Live catalog with Push / Feature / Markdown / Stock adjust buttons. Every write is guardrail-checked. |
| Research (center, bottom) | Free-form research queries. Runs an agent loop with `search_catalog`, `get_listing`, `list_featured` tools. |
| Audit trail (right) | Every suggestion, send, block, and write — color-coded by kind/actor. |

## Architecture

- Next.js 15 App Router on Node runtime.
- AI SDK 4 + Anthropic (`claude-sonnet-4-5` default; override with `LIVEOPS_MODEL`).
- Reply suggestion: `generateObject` with a Zod schema for atomic, validated output.
- Research: `generateText` with tool-calling loop (max 5 steps).
- Guardrails: pure functions in `lib/guardrails.ts`, run on suggest, send, and action.
- Audit log + mutable catalog state: in-memory singletons (replace with Postgres + Redis Streams in MVP).

## Files

- `lib/guardrails.ts` — multi-layer pre-send and pre-write checks.
- `lib/audit.ts` — append-only audit log with pub/sub.
- `lib/state.ts` — mutable catalog + `executeAction` with guardrail wrap.
- `app/api/suggest/route.ts` — grounded reply generation.
- `app/api/send/route.ts` — guardrail-gated send.
- `app/api/action/route.ts` — guardrail-gated agentic write.
- `app/api/research/route.ts` — tool-calling research agent.
- `components/OperatorConsole.tsx` — three-pane operator UI.

## What I built vs. reused

- **Built from scratch**: every file in this repo. Guardrail rules, schemas, audit, scripted chat, three-pane UX. ~700 lines of TS/TSX + 200 lines of fixtures.
- **Reused**: Next.js App Router, Tailwind, AI SDK 4 (`@ai-sdk/anthropic`, `generateObject`, `generateText`, `tool`), Zod.

## What broke / how I debugged

- AI SDK v4 → v5 cutover noise from build hooks: stayed on v4 (pinned `^4.0.0`) where `generateObject` is the canonical structured-output call.
- Initial guardrail false positives on phone-number regex caught list prices like "$1,850" if regex was too loose — narrowed to a strict 10-digit pattern with separators.
- Research agent occasionally hallucinated SKUs — fixed by tightening the system prompt to "Do NOT fabricate SKUs" and grounding every claim in a `search_catalog`/`get_listing` tool call.

See **PRD.md** and **TDD.md** for product and technical depth.
