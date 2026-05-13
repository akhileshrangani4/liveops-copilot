"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Listing } from "@/lib/data";
import type { AuditEntry, GuardrailReport } from "@/lib/audit";

type Toast = {
  id: string;
  kind: "ok" | "err" | "info";
  message: string;
};

type StructuredResearch = {
  title: string;
  brief?: string;
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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [viewers, setViewers] = useState(0);
  const [reactions, setReactions] = useState<{ id: string; emoji: string; left: number }[]>([]);
  const [gmv, setGmv] = useState(0);
  const scriptIdx = useRef(0);
  const chatRef = useRef<HTMLDivElement>(null);

  // Viewer presence simulation: ramps up when stream starts, drifts.
  useEffect(() => {
    if (!running) {
      // gentle decay when stopped
      const i = setInterval(() => setViewers((v) => Math.max(0, v - Math.ceil(v * 0.1))), 600);
      return () => clearInterval(i);
    }
    const i = setInterval(() => {
      setViewers((v) => {
        const target = 240 + Math.floor(Math.sin(Date.now() / 5000) * 60);
        const delta = Math.sign(target - v) * Math.max(1, Math.floor(Math.abs(target - v) * 0.15));
        return Math.max(0, v + delta + (Math.random() > 0.7 ? Math.floor(Math.random() * 5) - 2 : 0));
      });
    }, 400);
    return () => clearInterval(i);
  }, [running]);

  function fireReaction(emoji: string) {
    const id = crypto.randomUUID();
    const left = 10 + Math.random() * 70;
    setReactions((cur) => [...cur, { id, emoji, left }]);
    setTimeout(() => setReactions((cur) => cur.filter((r) => r.id !== id)), 2400);
  }

  function pushToast(t: Omit<Toast, "id">) {
    const id = crypto.randomUUID();
    setToasts((cur) => [...cur, { ...t, id }]);
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 4000);
  }

  async function refetchState() {
    const r = await fetch("/api/state").then((r) => r.json());
    setCatalog(r);
  }

  async function refetchAudit() {
    const r = await fetch("/api/audit").then((r) => r.json());
    setAudit(r.entries);
  }

  // Audit poll (tight: 800ms while running, 2s idle)
  useEffect(() => {
    const interval = running ? 800 : 2000;
    const i = setInterval(refetchAudit, interval);
    refetchAudit();
    return () => clearInterval(i);
  }, [running]);

  // State poll (tight: 1s)
  useEffect(() => {
    const i = setInterval(refetchState, 1000);
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

  async function sendReply(msgId: string, s: Suggestion, auto: boolean, editedReply?: string) {
    const m = messages.find((x) => x.id === msgId)!;
    const reply = editedReply ?? s.reply;
    const r = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reply,
        forSku: s.forSku ?? undefined,
        offerPriceUsd: s.offerPriceUsd ?? undefined,
        viewer: { user: m.user, text: m.text },
        auto,
      }),
    });
    const ok = r.ok;
    if (editedReply) {
      pushToast({ kind: ok ? "ok" : "err", message: ok ? "Edited reply sent" : "Edit blocked by guardrails" });
    }
    setMessages((cur) =>
      cur.map((x) =>
        x.id === msgId
          ? { ...x, status: ok ? "answered" : "blocked", suggestion: editedReply ? { ...s, reply: editedReply } : x.suggestion }
          : x,
      ),
    );
    if (ok) {
      // Simulated revenue + viewer reactions on each successful reply
      const lift = s.intent === "negotiation" ? 220 : s.intent === "price_question" || s.intent === "availability" ? 80 : 25;
      setGmv((g) => g + lift);
      ["❤️", "🔥", "👀", "💯", "🛒"].slice(0, 1 + Math.floor(Math.random() * 3)).forEach((e, i) =>
        setTimeout(() => fireReaction(e), i * 120),
      );
    }
    refetchAudit();
  }

  async function ignoreMsg(msgId: string) {
    setMessages((cur) =>
      cur.map((x) => (x.id === msgId ? { ...x, status: "ignored" } : x)),
    );
  }

  async function doAction(action: any) {
    const key = `${action.type}:${action.sku}`;
    setBusyAction(key);
    // simulated GMV bump for successful agentic writes
    const liftByType: Record<string, number> = { push_listing: 40, swap_featured: 60, markdown: 30, stock_adjust: 0 };
    try {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, actor: "operator" }),
      });
      const body = await res.json();
      if (res.ok) {
        pushToast({ kind: "ok", message: body.message ?? `${action.type} done` });
        const lift = liftByType[action.type] ?? 0;
        if (lift) setGmv((g) => g + lift);
        if (action.type === "push_listing" || action.type === "swap_featured") {
          ["🛒", "🔥"].forEach((e, i) => setTimeout(() => fireReaction(e), i * 100));
        }
      } else {
        pushToast({
          kind: "err",
          message:
            body.guardrails?.violations?.[0]?.message ?? body.message ?? "Action blocked",
        });
      }
      await Promise.all([refetchState(), refetchAudit()]);
    } catch (e: any) {
      pushToast({ kind: "err", message: e?.message ?? "Network error" });
    } finally {
      setBusyAction(null);
    }
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
        brief: r.brief ?? r.structured?.brief ?? "",
        structured: r.structured,
        ms: r.latencyMs,
      });
      pushToast({
        kind: "info",
        message: `Research returned ${r.structured?.listings?.length ?? 0} listings in ${r.latencyMs}ms`,
      });
    } finally {
      setResearching(false);
    }
  }

  const stats = useMemo(() => {
    const answered = messages.filter((m) => m.status === "answered").length;
    const blocked = messages.filter((m) => m.status === "blocked").length;
    const pending = messages.filter((m) => m.status === "pending").length;
    const handled = messages.filter((m) => m.status !== "pending").length;
    const total = messages.length;
    const coverage = total ? Math.round((handled / total) * 100) : 0;
    const latencies = messages.map((m) => m.suggestion?.latencyMs).filter((x): x is number => !!x);
    const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const autoSent = messages.filter((m) => m.status === "answered" && m.suggestion?.autoReplySafe).length;
    const autoRate = answered ? Math.round((autoSent / answered) * 100) : 0;
    return { answered, blocked, pending, avgMs, coverage, autoRate, total, handled };
  }, [messages]);

  return (
    <>
    <Toaster toasts={toasts} />
    <ReactionLayer reactions={reactions} />
    <div className="flex flex-col h-screen text-sm">
    <HudBar
      running={running}
      viewers={viewers}
      gmv={gmv}
      stats={stats}
      showTitle={SCRIPT.show.title}
    />
    <div className="grid grid-cols-12 gap-3 p-3 flex-1 min-h-0">
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
              onSend={(s, edited) => sendReply(m.id, s, false, edited)}
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
              <ListingRow
                key={l.sku}
                listing={l}
                onAction={doAction}
                busyAction={busyAction}
              />
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
                  busyAction={busyAction}
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
    </div>
    </>
  );
}

function HudBar({
  running,
  viewers,
  gmv,
  stats,
  showTitle,
}: {
  running: boolean;
  viewers: number;
  gmv: number;
  stats: { coverage: number; avgMs: number; blocked: number; autoRate: number; handled: number; total: number };
  showTitle: string;
}) {
  return (
    <header className="flex items-center gap-4 px-4 py-2 bg-zinc-950 border-b border-zinc-800">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full ${running ? "bg-red-500 pulse-ring" : "bg-zinc-600"}`}
        />
        <span className="text-xs uppercase tracking-wider text-zinc-400">
          {running ? "Live" : "Off-air"}
        </span>
      </div>
      <div className="text-zinc-200 text-xs font-medium truncate flex-1">{showTitle}</div>
      <HudStat label="Viewers" value={viewers.toLocaleString()} accent="text-pink-300" />
      <HudStat label="GMV" value={`$${gmv.toLocaleString()}`} accent="text-emerald-300" />
      <HudStat label="Coverage" value={`${stats.coverage}%`} sub={`${stats.handled}/${stats.total}`} accent="text-blue-300" />
      <HudStat label="Auto-reply" value={`${stats.autoRate}%`} accent="text-amber-300" />
      <HudStat label="Avg latency" value={`${stats.avgMs}ms`} accent={stats.avgMs > 0 && stats.avgMs < 2000 ? "text-emerald-300" : "text-zinc-300"} />
      <HudStat label="Blocked" value={`${stats.blocked}`} accent={stats.blocked > 0 ? "text-red-300" : "text-zinc-300"} />
    </header>
  );
}

function HudStat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="text-right leading-tight">
      <div className={`text-sm font-semibold tabular-nums ${accent ?? "text-zinc-100"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
        {sub && <span className="ml-1 text-zinc-600">({sub})</span>}
      </div>
    </div>
  );
}

function ReactionLayer({
  reactions,
}: {
  reactions: { id: string; emoji: string; left: number }[];
}) {
  return (
    <div className="fixed inset-0 pointer-events-none z-40">
      {reactions.map((r) => (
        <div
          key={r.id}
          className="absolute text-2xl"
          style={{
            left: `${r.left}%`,
            bottom: "30%",
            animation: "floatUp 2.4s ease-out forwards",
          }}
        >
          {r.emoji}
        </div>
      ))}
    </div>
  );
}

function Toaster({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto px-3 py-2 rounded shadow-lg text-xs max-w-sm animate-[slideIn_0.2s_ease-out] ${
            t.kind === "ok"
              ? "bg-emerald-500/90 text-emerald-50"
              : t.kind === "err"
                ? "bg-red-500/90 text-red-50"
                : "bg-zinc-700/90 text-zinc-50"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

function MessageCard({
  msg,
  onSend,
  onIgnore,
}: {
  msg: ChatMsg;
  onSend: (s: Suggestion, editedReply?: string) => void;
  onIgnore: () => void;
}) {
  const s = msg.suggestion;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState("");
  const [recheckReport, setRecheckReport] = useState<GuardrailReport | null>(null);
  const recheckTimer = useRef<NodeJS.Timeout | null>(null);

  // Typewriter reveal on first appearance
  useEffect(() => {
    if (!s) return;
    setDraft(s.reply);
    if (editing) {
      setRevealed(s.reply);
      return;
    }
    setRevealed("");
    let i = 0;
    const tick = () => {
      i = Math.min(i + Math.max(1, Math.floor(s.reply.length / 30)), s.reply.length);
      setRevealed(s.reply.slice(0, i));
      if (i < s.reply.length) {
        timer = setTimeout(tick, 18);
      }
    };
    let timer: NodeJS.Timeout = setTimeout(tick, 0);
    return () => clearTimeout(timer);
  }, [s?.reply]);

  useEffect(() => {
    if (!editing || !s) return;
    if (recheckTimer.current) clearTimeout(recheckTimer.current);
    recheckTimer.current = setTimeout(async () => {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reply: draft,
          forSku: s.forSku ?? undefined,
          offerPriceUsd: s.offerPriceUsd ?? undefined,
        }),
      }).then((r) => r.json());
      setRecheckReport(res);
    }, 300);
    return () => {
      if (recheckTimer.current) clearTimeout(recheckTimer.current);
    };
  }, [draft, editing, s]);
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
          {editing ? (
            <div className="space-y-1">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                className="w-full text-zinc-100 bg-zinc-950 border border-zinc-700 rounded p-2 text-sm focus:outline-none focus:border-blue-500/50"
                autoFocus
              />
              <div className="text-[10px] text-zinc-500">
                {draft.length} chars · live guardrail check
              </div>
            </div>
          ) : (
            <div
              className="text-zinc-100 italic cursor-text hover:bg-zinc-900/50 rounded px-1 -mx-1"
              onClick={() => msg.status === "pending" && setEditing(true)}
              title={msg.status === "pending" ? "Click to edit" : ""}
            >
              "{revealed || s.reply}"
              {revealed && revealed.length < s.reply.length && (
                <span className="text-blue-400 animate-pulse">▍</span>
              )}
            </div>
          )}
          <div className="text-[11px] text-zinc-500">{s.reasoning}</div>

          <GuardrailBadges report={editing && recheckReport ? recheckReport : s.guardrails} />

          {msg.status === "pending" && (
            <div className="flex gap-2 items-center">
              {!editing && (
                <button
                  onClick={() => setEditing(true)}
                  className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs"
                >
                  Edit
                </button>
              )}
              {editing && (
                <button
                  onClick={() => {
                    setDraft(s.reply);
                    setEditing(false);
                    setRecheckReport(null);
                  }}
                  className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs"
                >
                  Cancel
                </button>
              )}
              <button
                disabled={editing ? !(recheckReport?.ok ?? false) : blocked}
                onClick={() => {
                  const reply = editing ? draft : s.reply;
                  onSend(s, editing ? draft : undefined);
                  setEditing(false);
                }}
                className="px-2 py-1 bg-emerald-500/30 hover:bg-emerald-500/40 text-emerald-200 rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {editing
                  ? recheckReport?.ok
                    ? "Send edit"
                    : "Edit blocked"
                  : blocked
                    ? "Blocked"
                    : "Send"}
              </button>
              {!editing && (
                <button
                  onClick={onIgnore}
                  className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs"
                >
                  Ignore
                </button>
              )}
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
  busyAction,
}: {
  listing: Listing;
  onAction: (a: any) => void;
  busyAction: string | null;
}) {
  const [mdOpen, setMdOpen] = useState(false);
  const [mdPrice, setMdPrice] = useState(listing.price_usd);
  const isBusy = (type: string) => busyAction === `${type}:${listing.sku}`;
  const anyBusy = busyAction?.endsWith(`:${listing.sku}`) ?? false;
  return (
    <div className={`p-2 rounded border transition-colors ${listing.featured ? "border-amber-500/40 bg-amber-500/5" : "border-zinc-800 bg-zinc-950"} ${anyBusy ? "opacity-70" : ""}`}>
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
            disabled={anyBusy}
            onClick={() => onAction({ type: "push_listing", sku: listing.sku })}
            className="text-xs px-2 py-0.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded disabled:opacity-40"
          >
            {isBusy("push_listing") ? "…" : "Push"}
          </button>
          <button
            disabled={anyBusy}
            onClick={() => onAction({ type: "swap_featured", sku: listing.sku })}
            className="text-xs px-2 py-0.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded disabled:opacity-40"
          >
            {isBusy("swap_featured") ? "…" : "Feature"}
          </button>
          <button
            onClick={() => setMdOpen((o) => !o)}
            className="text-xs px-2 py-0.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded"
          >
            Markdown
          </button>
          <button
            disabled={anyBusy}
            onClick={() => onAction({ type: "stock_adjust", sku: listing.sku, delta: 1 })}
            className="text-xs px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded disabled:opacity-40"
          >
            +1
          </button>
          <button
            disabled={anyBusy}
            onClick={() => onAction({ type: "stock_adjust", sku: listing.sku, delta: -1 })}
            className="text-xs px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded disabled:opacity-40"
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
  busyAction,
}: {
  result: StructuredResearch;
  catalog: Catalog;
  onAction: (a: any) => void;
  busyAction: string | null;
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
              busyAction={busyAction}
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
  busyAction,
}: {
  listing: Listing;
  why: string;
  recommendedAction: "push_listing" | "swap_featured" | "markdown" | "none";
  markdownPriceUsd: number | null;
  onAction: (a: any) => void;
  busyAction: string | null;
}) {
  const busy = busyAction?.endsWith(`:${listing.sku}`) ?? false;
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
            disabled={busy}
            onClick={handle}
            className="text-[11px] px-2 py-1 bg-blue-500/30 hover:bg-blue-500/40 text-blue-100 rounded whitespace-nowrap disabled:opacity-50"
          >
            {busy ? "…" : actionLabel[recommendedAction]}
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
