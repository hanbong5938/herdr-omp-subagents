import { Buffer } from "node:buffer";
import type { ActiveAgent, ModelIdentity } from "./types.ts";

/** Herdr's per-token limit; role (18) + ordinal + model (26) rows stay well under it. */
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

/**
 * Parenthesized short label for the root session's model. Absent until the root
 * attaches, so the sidebar clears instead of showing a stale or guessed model.
 */
export function formatMainModel(main?: ModelIdentity): string | undefined {
  return main ? `(${modelLabel(main.modelId)})` : undefined;
}

/**
 * One label per sidebar row, at most `maxRows` including the overflow row. When
 * more agents are active than rows allowed, the last row becomes `+N` for the
 * ones not shown.
 */
export function formatAgents(agents: readonly ActiveAgent[], maxRows: number): string[] {
  if (maxRows <= 0) return [];
  const items = agents.map(agent => ({
    id: agent.id,
    role: shorten(clean(agent.role).replace(/[:#]/g, "-") || "unknown", 18),
    model: modelLabel(agent.modelId),
  })).sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.role, (counts.get(item.role) ?? 0) + 1);
  const ordinals = new Map<string, number>();
  const labels = items.map(item => {
    const ordinal = (ordinals.get(item.role) ?? 0) + 1;
    ordinals.set(item.role, ordinal);
    return `${item.role}${counts.get(item.role)! > 1 ? `#${ordinal}` : ""}:${item.model}`;
  });
  if (labels.length <= maxRows) return labels;
  const shown = maxRows - 1;
  return [...labels.slice(0, shown), `+${labels.length - shown}`];
}
