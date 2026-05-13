export type AuditEntry = {
  id: string;
  ts: number;
  kind:
    | "reply_suggested"
    | "reply_sent"
    | "reply_blocked"
    | "action_executed"
    | "action_blocked"
    | "guardrail_check"
    | "tool_call";
  actor: "ai" | "operator" | "system";
  summary: string;
  payload?: unknown;
  guardrails?: GuardrailReport;
};

export type GuardrailViolation = {
  rule: string;
  severity: "block" | "warn";
  message: string;
};

export type GuardrailReport = {
  ok: boolean;
  violations: GuardrailViolation[];
  warnings: GuardrailViolation[];
  rewritten?: string;
};

const log: AuditEntry[] = [];
const subscribers = new Set<(e: AuditEntry) => void>();

export function record(entry: Omit<AuditEntry, "id" | "ts">): AuditEntry {
  const full: AuditEntry = {
    ...entry,
    id: crypto.randomUUID(),
    ts: Date.now(),
  };
  log.push(full);
  if (log.length > 500) log.shift();
  for (const sub of subscribers) {
    try {
      sub(full);
    } catch {}
  }
  return full;
}

export function list(): AuditEntry[] {
  return [...log].reverse();
}

export function subscribe(fn: (e: AuditEntry) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
