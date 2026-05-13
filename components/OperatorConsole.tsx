"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Listing } from "@/lib/data";
import type { AuditEntry, GuardrailReport } from "@/lib/audit";

type StructuredResearch = {
  title: string;
  listings: {
    sku: string;
    why: string;
    recommendedAction: "push_listing" | "swap_featured" | "markdown" | "none";
    markdownPriceUsd: number | null;
  }[];
  summary: string;
};
import chatScript from "@/data/chat-script.json";

type ChatMsg = {
  id: string;
  user: string;
  text: string;
  ts: number;
  suggestion?: Suggestion;
  status: "pending" | "answered" | "ignored" | "blocked";
  loading?: boolean;
};

type Suggestion = {
  reply: string;
  forSku: string | null;
  offerPriceUsd: number | null;
  intent: string;
  autoReplySafe: boolean;
  reasoning: string;
  guardrails: GuardrailReport;
  latencyMs: number;
};

const SCRIPT = chatScript as {
  show: { id: string; title: string; host: string };
  messages: { delayMs: number; user: string; text: string }[];
};

export default function OperatorConsole({ initialState }: { initialState: Catalog }) {
  const [catalog, setCatalog] = useState<Catalog>(initialState);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [running, setRunning] = useState(false);
  const [autoReply, setAutoReply] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [research, setResearch] = useState<{
    query: string;
    brief: string;
    structured?: StructuredResearch;
    ms: number;
  } | null>(null);
  const [researchQuery, setResearchQuery] = useState("");
  const [researching, setResearching] = useState(false);
  const scriptIdx = useRef(0);
  const chatRef = useRef<HTMLDivElement>(null);

  // Audit poll
  useEffect(() => {
    const i = setInterval(async () => {
      const r = await fetch("/api/audit").then((r) => r.json());
      setAudit(r.entries);
    }, 1500);
    return () => clearInterval(i);
  }, []);

  // State poll
  useEffect(() => {
    const i = setInterval(async () => {
      const r = await fetch("/api/state").then((r) => r.json());
      setCatalog(r);
    }, 2000);
    return () => clearInterval(i);
  }, []);

  // Scroll to bottom on new msg
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  // Drive chat script
  useEffect(() => {
    if (!running) return;
    if (scriptIdx.current >= SCRIPT.messages.length) {
      setRunning(false);
      return;
    }
    const next = SCRIPT.messages[scriptIdx.current];
    const timer = setTimeout(() => {
      const msg: ChatMsg = {
        id: crypto.randomUUID(),
        user: next.user,
        text: next.text,
        ts: Date.now(),
        status: "pending",
        loading: true,
      };
      setMessages((m) => [...m, msg]);
      scriptIdx.current += 1;
      requestSuggestion(msg);
    }, next.delayMs);
    return () => clearTimeout(timer);
  }, [running, messages.length]);

  async function requestSuggestion(msg: ChatMsg) {
    try {
      const recent = messages.slice(-6).map((m) => ({ user: m.user, text: m.text }));
      const r = await fetch("/api/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewerMessage: { user: msg.user, text: msg.text }, recentMessages: recent }),
      }).then((r) => r.json());
      const suggestion: Suggestion = r;
      setMessages((cur) =>
        cur.map((m) => (m.id === msg.id ? { ...m, suggestion, loading: false } : m)),
      );

      // Auto-reply path
      if (autoReply && suggestion.autoReplySafe && suggestion.guardrails.ok) {
        await sendReply(msg.id, suggestion, true);
      } else if (!suggestion.guardrails.ok) {
        setMessages((cur) =>
          cur.map((m) => (m.id === msg.id ? { ...m, status: "blocked" } : m)),
        );
      }
    } catch (e: any) {
      setMessages((cur) =>
        cur.map((m) => (m.id === msg.id ? { ...m, loading: false } : m)),
      );
    }
  }

  async function sendReply(msgId: string, s: Suggestion, auto: boolean) {
    const m = messages.find((x) => x.id === msgId)!;
    const r = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reply: s.reply,
        forSku: s.forSku ?? undefined,
        offerPriceUsd: s.offerPriceUsd ?? undefined,
        viewer: { user: m.user, text: m.text },
        auto,
      }),
    });
    const ok = r.ok;
    setMessages((cur) =>
      cur.map((x) => (x.id === msgId ? { ...x, status: ok ? "answered" : "blocked" } : x)),
    );
  }

  async function ignoreMsg(msgId: string) {
    setMessages((cur) =>
      cur.map((x) => (x.id === msgId ? { ...x, status: "ignored" } : x)),
    );
  }

  async function doAction(action: any) {
    await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, actor: "operator" }),
    });
  }

  async function runResearch() {
    if (!researchQuery.trim()) return;
    setResearching(true);
    try {
      const r = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: researchQuery }),
      }).then((r) => r.json());
      setResearch({
        query: researchQuery,
        brief: r.brief,
        structured: r.structured,
        ms: r.latencyMs,
      });
    } finally {
      setResearching(false);
    }
  }

  const stats = useMemo(() => {
    const answered = messages.filter((m) => m.status === "answered").length;
    const blocked = messages.filter((m) => m.status === "blocked").length;
    const pending = messages.filter((m) => m.status === "pending").length;
    const latencies = messages.map((m) => m.suggestion?.latencyMs).filter((x): x is number => !!x);
    const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    return { answered, blocked, pending, avgMs };
  }, [messages]);

  return (
    <div className="grid grid-cols-12 gap-3 p-3 h-screen text-sm">
      {/* Left: chat */}
      <section className="col-span-4 flex flex-col bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
        <header className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <div className="font-semibold text-zinc-100">{SCRIPT.show.title}</div>
            <div className="text-xs text-zinc-400">Host: {SCRIPT.show.host} · {catalog.seller.name}</div>
          </div>
          <button
            onClick={() => setRunning((r) => !r)}
            className={`px-3 py-1 rounded text-xs font-medium ${running ? "bg-red-500/20 text-red-300" : "bg-emerald-500/20 text-emerald-300"}`}
          >
            {running ? "Stop stream" : "Start stream"}
          </button>
        </header>
        <div ref={chatRef} className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
          {messages.length === 0 && (
            <div className="text-zinc-500 text-xs">Press Start to begin scripted viewer chat.</div>
          )}
          {messages.map((m) => (
            <MessageCard
              key={m.id}
              msg={m}
              onSend={(s) => sendReply(m.id, s, false)}
              onIgnore={() => ignoreMsg(m.id)}
            />
          ))}
        </div>
        <footer className="px-3 py-2 border-t border-zinc-800 flex items-center justify-between text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoReply}
              onChange={(e) => setAutoReply(e.target.checked)}
            />
            <span>Auto-reply when safe</span>
          </label>
          <div className="text-zinc-400">
            answered {stats.answered} · blocked {stats.blocked} · pending {stats.pending} · avg {stats.avgMs}ms
          </div>
        </footer>
      </section>

      {/* Center: catalog + actions */}
      <section className="col-span-5 flex flex-col gap-3 overflow-hidden">
        <div className="flex-1 bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden flex flex-col">
          <header className="px-3 py-2 border-b border-zinc-800 font-semibold">Inventory & actions</header>
          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
            {catalog.listings.map((l) => (
              <ListingRow key={l.sku} listing={l} onAction={doAction} />
            ))}
          </div>
        </div>

        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">On-demand product research</div>
            {research && (
              <div className="text-xs text-zinc-400">{research.ms}ms · {research.query}</div>
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              placeholder="e.g. alternatives to AJ4 Bred for size 11 buyer"
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs"
            />
            <button
              disabled={researching}
              onClick={runResearch}
              className="px-3 py-1 bg-blue-500/20 text-blue-300 rounded text-xs disabled:opacity-50"
            >
              {researching ? "Researching…" : "Research"}
            </button>
          </div>
          {research && (
            <div className="mt-2 space-y-2">
              {research.structured && (
                <ResearchResult
                  result={research.structured}
                  catalog={catalog}
                  onAction={doAction}
                />
              )}
              <details className="text-xs text-zinc-400">
                <summary className="cursor-pointer hover:text-zinc-200">Raw brief</summary>
                <pre className="mt-1 whitespace-pre-wrap bg-zinc-950 border border-zinc-800 rounded p-2 max-h-40 overflow-y-auto scrollbar-thin">
                  {research.brief}
                </pre>
              </details>
            </div>
          )}
        </div>
      </section>

      {/* Right: audit */}
      <section className="col-span-3 bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden flex flex-col">
        <header className="px-3 py-2 border-b border-zinc-800 font-semibold flex justify-between">
          Audit trail
          <span className="text-xs text-zinc-400 font-normal">{audit.length} events</span>
        </header>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-1">
          {audit.map((e) => (
            <AuditRow key={e.id} entry={e} />
          ))}
        </div>
      </section>
    </div>
  );
}

function MessageCard({
  msg,
  onSend,
  onIgnore,
}: {
  msg: ChatMsg;
  onSend: (s: Suggestion) => void;
  onIgnore: () => void;
}) {
  const s = msg.suggestion;
  const blocked = s && !s.guardrails.ok;
  const ringClass = blocked
    ? "border-red-500/40"
    : msg.status === "answered"
      ? "border-emerald-500/30"
      : "border-zinc-800";

  return (
    <div className={`rounded border ${ringClass} bg-zinc-950 p-2`}>
      <div className="flex items-center gap-2">
        <span className="font-medium text-zinc-300">{msg.user}</span>
        <span className="text-zinc-500 text-xs">{new Date(msg.ts).toLocaleTimeString()}</span>
        <span
          className={`ml-auto text-[10px] uppercase tracking-wide ${
            msg.status === "answered"
              ? "text-emerald-400"
              : msg.status === "blocked"
                ? "text-red-400"
                : msg.status === "ignored"
                  ? "text-zinc-500"
                  : "text-amber-400"
          }`}
        >
          {msg.status}
        </span>
      </div>
      <div className="text-zinc-200 mt-1">{msg.text}</div>

      {msg.loading && (
        <div className="mt-2 text-xs text-zinc-500 animate-pulse">Drafting reply…</div>
      )}

      {s && (
        <div className="mt-2 border-t border-zinc-800 pt-2 space-y-2">
          <div className="text-[11px] text-zinc-400 flex flex-wrap gap-2">
            <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">{s.intent}</span>
            {s.forSku && (
              <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">SKU {s.forSku}</span>
            )}
            {s.offerPriceUsd !== null && (
              <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">${s.offerPriceUsd}</span>
            )}
            <span className="ml-auto text-zinc-500">{s.latencyMs}ms</span>
          </div>
          <div className="text-zinc-100 italic">"{s.reply}"</div>
          <div className="text-[11px] text-zinc-500">{s.reasoning}</div>

          <GuardrailBadges report={s.guardrails} />

          {msg.status === "pending" && (
            <div className="flex gap-2">
              <button
                disabled={blocked}
                onClick={() => onSend(s)}
                className="px-2 py-1 bg-emerald-500/20 text-emerald-300 rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {blocked ? "Blocked" : "Send"}
              </button>
              <button
                onClick={onIgnore}
                className="px-2 py-1 bg-zinc-800 text-zinc-300 rounded text-xs"
              >
                Ignore
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GuardrailBadges({ report }: { report: GuardrailReport }) {
  if (report.ok && report.warnings.length === 0) {
    return <div className="text-[10px] text-emerald-400">✓ All guardrails passed</div>;
  }
  return (
    <div className="space-y-1">
      {report.violations.map((v, i) => (
        <div key={`v${i}`} className="text-[10px] text-red-300">
          ⛔ <span className="font-mono">{v.rule}</span>: {v.message}
        </div>
      ))}
      {report.warnings.map((w, i) => (
        <div key={`w${i}`} className="text-[10px] text-amber-300">
          ⚠ <span className="font-mono">{w.rule}</span>: {w.message}
        </div>
      ))}
    </div>
  );
}

function ListingRow({
  listing,
  onAction,
}: {
  listing: Listing;
  onAction: (a: any) => void;
}) {
  const [mdOpen, setMdOpen] = useState(false);
  const [mdPrice, setMdPrice] = useState(listing.price_usd);
  return (
    <div className={`p-2 rounded border ${listing.featured ? "border-amber-500/40 bg-amber-500/5" : "border-zinc-800 bg-zinc-950"}`}>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="text-zinc-100">
            {listing.title} {listing.featured && <span className="text-amber-300 text-xs">★ featured</span>}
          </div>
          <div className="text-xs text-zinc-400">
            {listing.sku} · size {listing.size} · {listing.condition} · ${listing.price_usd}
            {listing.msrp_usd && <span className="text-zinc-600"> (msrp ${listing.msrp_usd})</span>}
            · stock {listing.stock} {!listing.active && <span className="text-red-400">inactive</span>}
          </div>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => onAction({ type: "push_listing", sku: listing.sku })}
            className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-300 rounded"
          >
            Push
          </button>
          <button
            onClick={() => onAction({ type: "swap_featured", sku: listing.sku })}
            className="text-xs px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded"
          >
            Feature
          </button>
          <button
            onClick={() => setMdOpen((o) => !o)}
            className="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded"
          >
            Markdown
          </button>
          <button
            onClick={() => onAction({ type: "stock_adjust", sku: listing.sku, delta: 1 })}
            className="text-xs px-2 py-0.5 bg-zinc-800 text-zinc-300 rounded"
          >
            +1
          </button>
          <button
            onClick={() => onAction({ type: "stock_adjust", sku: listing.sku, delta: -1 })}
            className="text-xs px-2 py-0.5 bg-zinc-800 text-zinc-300 rounded"
          >
            -1
          </button>
        </div>
      </div>
      {mdOpen && (
        <div className="mt-2 flex gap-2 items-center text-xs">
          <span className="text-zinc-400">New price $</span>
          <input
            type="number"
            value={mdPrice}
            onChange={(e) => setMdPrice(Number(e.target.value))}
            className="w-24 bg-zinc-950 border border-zinc-800 rounded px-2 py-0.5"
          />
          <button
            onClick={() => {
              onAction({ type: "markdown", sku: listing.sku, new_price_usd: mdPrice });
              setMdOpen(false);
            }}
            className="px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

function ResearchResult({
  result,
  catalog,
  onAction,
}: {
  result: StructuredResearch;
  catalog: Catalog;
  onAction: (a: any) => void;
}) {
  return (
    <div className="space-y-2 bg-gradient-to-b from-blue-500/5 to-transparent border border-blue-500/20 rounded p-2">
      <div className="text-sm font-semibold text-blue-200">{result.title}</div>
      <div className="text-xs text-zinc-300">{result.summary}</div>
      <div className="space-y-1.5">
        {result.listings.map((r) => {
          const listing = catalog.listings.find((l) => l.sku === r.sku);
          if (!listing) {
            return (
              <div key={r.sku} className="text-[11px] text-red-300 italic">
                ⚠ Model referenced unknown SKU {r.sku} — filtered.
              </div>
            );
          }
          return (
            <ResearchListingCard
              key={r.sku}
              listing={listing}
              why={r.why}
              recommendedAction={r.recommendedAction}
              markdownPriceUsd={r.markdownPriceUsd}
              onAction={onAction}
            />
          );
        })}
      </div>
    </div>
  );
}

function ResearchListingCard({
  listing,
  why,
  recommendedAction,
  markdownPriceUsd,
  onAction,
}: {
  listing: Listing;
  why: string;
  recommendedAction: "push_listing" | "swap_featured" | "markdown" | "none";
  markdownPriceUsd: number | null;
  onAction: (a: any) => void;
}) {
  const actionLabel: Record<typeof recommendedAction, string> = {
    push_listing: "Push to viewers",
    swap_featured: "Make featured",
    markdown: markdownPriceUsd ? `Mark down to $${markdownPriceUsd}` : "Markdown",
    none: "",
  };
  const handle = () => {
    if (recommendedAction === "none") return;
    if (recommendedAction === "markdown" && markdownPriceUsd != null) {
      onAction({ type: "markdown", sku: listing.sku, new_price_usd: markdownPriceUsd });
    } else if (recommendedAction === "push_listing" || recommendedAction === "swap_featured") {
      onAction({ type: recommendedAction, sku: listing.sku });
    }
  };

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <div className="text-xs text-zinc-100 font-medium">{listing.title}</div>
          <div className="text-[10px] text-zinc-500 font-mono">
            {listing.sku} · ${listing.price_usd} · stock {listing.stock}
            {!listing.active && " · inactive"}
          </div>
          <div className="text-[11px] text-zinc-400 mt-1">{why}</div>
        </div>
        {recommendedAction !== "none" && (
          <button
            onClick={handle}
            className="text-[11px] px-2 py-1 bg-blue-500/30 hover:bg-blue-500/40 text-blue-100 rounded whitespace-nowrap"
          >
            {actionLabel[recommendedAction]}
          </button>
        )}
      </div>
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const color =
    entry.kind === "reply_blocked" || entry.kind === "action_blocked"
      ? "text-red-300"
      : entry.kind === "action_executed"
        ? "text-emerald-300"
        : entry.kind === "reply_sent"
          ? "text-blue-300"
          : "text-zinc-300";
  return (
    <div className="text-xs border-l-2 border-zinc-700 pl-2 py-0.5">
      <div className={`${color} font-mono`}>
        [{new Date(entry.ts).toLocaleTimeString()}] {entry.kind} · {entry.actor}
      </div>
      <div className="text-zinc-400">{entry.summary}</div>
    </div>
  );
}
