import { Buffer } from "node:buffer";
import type { ActiveAgent } from "./types.ts";

/** Conservative byte budget also satisfies Herdr's 80-character limit. */
export const MAX_TOKEN_BYTES = 80;

function clean(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\s]+/gu, " ")
    .trim();
}

function shorten(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = "";
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes - 3) break;
    result += char;
    used += size;
  }
  return `${result}…`;
}

/** Only known model families are abbreviated; unknown identities stay literal. */
function modelLabel(modelId?: string): string {
  const id = clean(modelId ?? "");
  if (!id) return "?";
  const claude = /^(?:anthropic\/)?claude-((?:sonnet|opus|haiku)-[\d][\w.-]*)$/.exec(id);
  if (claude) return shorten(claude[1]!, 26);
  const gemini = /^(?:google\/)?gemini-(\d+(?:\.\d+)?)-(flash|pro)([\w.-]*)$/.exec(id);
  if (gemini) return shorten(`${gemini[2]}-${gemini[1]}${gemini[3]}`, 26);
  return shorten(id, 26);
}

export function formatAgents(agents: readonly ActiveAgent[]): string | null {
  if (agents.length === 0) return null;
  const items = agents.map(agent => ({
    id: agent.id,
    role: shorten(clean(agent.role).replace(/[\[\]|:#]/g, "-") || "unknown", 18),
    model: modelLabel(agent.modelId).replace(/[\[\]|]/g, "-"),
  })).sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.role, (counts.get(item.role) ?? 0) + 1);
  const ordinals = new Map<string, number>();
  const labels = items.map(item => {
    const ordinal = (ordinals.get(item.role) ?? 0) + 1;
    ordinals.set(item.role, ordinal);
    return `${item.role}${counts.get(item.role)! > 1 ? `#${ordinal}` : ""}:${item.model}`;
  });
  let body = "";
  let shown = 0;
  for (let i = 0; i < labels.length; i++) {
    const next = body ? `${body} | ${labels[i]}` : labels[i]!;
    const remaining = labels.length - i - 1;
    const candidate = `[${next}${remaining ? ` | +${remaining}` : ""}]`;
    if (Buffer.byteLength(candidate) > MAX_TOKEN_BYTES) break;
    body = next;
    shown++;
    if (!remaining) return candidate;
  }
  return `[${body}${body ? " | " : ""}+${labels.length - shown}]`;
}
