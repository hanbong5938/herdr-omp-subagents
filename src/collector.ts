import path from "node:path";

import type { ActiveAgent, AgentSnapshot, ModelIdentity } from "./types.ts";

/**
 * Structural subset of OMP's process-global agent registry
 * (`packages/coding-agent/src/registry/agent-registry.ts` in v18.1.20). The
 * plugin reaches the real object through `pi.pi.AgentRegistry.global()` at
 * runtime, so nothing here imports the coding-agent package.
 */
export type RegistryAgentKind = "main" | "sub" | "advisor";

export type RegistryAgentStatus = "running" | "idle" | "parked" | "aborted";

export interface RegistrySession {
  /** True while a turn is in flight; corroborates a `running` status. */
  readonly isStreaming: boolean;
  /** Live session model, authoritative over any persisted history. */
  readonly model?: { readonly provider?: string; readonly id?: string };
  readonly sessionManager: {
    getSessionId(): string | null | undefined;
    getSessionFile(): string | null | undefined;
  };
}

export interface RegistryAgentRef {
  readonly id: string;
  /** Agent type for live subagents (`agentDisplayName: agent.name` in `task/executor.ts`). */
  readonly displayName?: string;
  readonly kind: RegistryAgentKind;
  readonly parentId?: string;
  readonly status: RegistryAgentStatus;
  /** Null exactly when parked/aborted. */
  readonly session: RegistrySession | null;
  /** Transcript path; the lineage token for "belongs to this root". */
  readonly sessionFile?: string | null;
  /** Transcript-derived identity, hydrated only for persisted/parked refs. */
  readonly history?: { readonly agent?: string };
}

export interface AgentRegistryLike {
  list(): RegistryAgentRef[];
  get(id: string): RegistryAgentRef | undefined;
  /** Whether a `running` claim is corroborated by the ref's live session. */
  isRunning(ref: RegistryAgentRef): boolean;
  onChange(listener: (event: unknown) => void): () => void;
}

export interface AgentObserver {
  /**
   * Current root model (absent until the root attaches) and its active
   * descendants, deepest-last.
   */
  snapshot(): AgentSnapshot;
  /** Recollect; invokes the change callback only when the reported value moved. */
  refresh(): void;
  /** Unsubscribe; later refreshes and registry events are inert. */
  dispose(): void;
}

/**
 * Whether the session that asked owns the root of the observed tree.
 *
 * `pending` is the normal startup state: `createAgentSession` registers the
 * root ref with `session: null` before the `AgentSession` exists and only
 * attaches it at the end of construction, so the root is unidentifiable for a
 * moment even on a fully supported build.
 */
export type RootStatus = "owner" | "foreign" | "pending";

/** Defensive bound on the parent walk; the registry tree is far shallower. */
const MAX_ANCESTRY_DEPTH = 64;

const UNKNOWN_ROLE = "unknown";

export function resolveRootStatus(registry: AgentRegistryLike, rootSessionId: string): RootStatus {
  if (!rootSessionId) return "pending";
  let foreign = false;
  for (const ref of registry.list()) {
    if (ref.session?.sessionManager.getSessionId() !== rootSessionId) continue;
    if (ref.kind === "main") return "owner";
    // A non-main ref owning this very session means this extension copy was
    // loaded by a subagent: it observes and publishes nothing. Checked after
    // every ref, so registry order cannot mistake a root for a child.
    foreign = true;
  }
  return foreign ? "foreign" : "pending";
}

/**
 * Upstream's own lineage rule (`sessionFileBelongsToRoot` in
 * `registry/persisted-agents.ts`): a session tree's transcripts live under the
 * root transcript's artifact directory.
 */
function belongsToRoot(sessionFile: string, rootSessionFile: string): boolean {
  const file = path.resolve(sessionFile);
  const root = path.resolve(rootSessionFile);
  if (file === root) return true;
  const artifactRoot = root.endsWith(".jsonl") ? root.slice(0, -".jsonl".length) : root;
  return file.startsWith(`${artifactRoot}${path.sep}`);
}

/**
 * Role as the registry knows it. Live subagent refs carry no `history.agent`
 * (`setHistory` runs for persisted transcripts only), so the agent type comes
 * from `displayName`, which `createAgentSession` defaults to the bare kind
 * when no name was supplied — that names no role. Never derived from a model.
 */
function roleOf(ref: RegistryAgentRef): string {
  const historical = ref.history?.agent?.trim();
  if (historical) return historical;
  const display = ref.displayName?.trim();
  return display && display !== ref.kind ? display : UNKNOWN_ROLE;
}

/**
 * Distance from the root, or -1 when lineage to this exact root is unproven —
 * a missing ancestor, an advisor branch, or a subtree hanging off another root
 * (a second top-level session, or a previous generation of this one).
 */
function depthFromRoot(
  ref: RegistryAgentRef,
  byId: ReadonlyMap<string, RegistryAgentRef>,
  rootId: string,
): number {
  let cursor = ref;
  for (let depth = 1; depth <= MAX_ANCESTRY_DEPTH; depth++) {
    const parentId = cursor.parentId;
    if (!parentId) return -1;
    if (parentId === rootId) return depth;
    const parent = byId.get(parentId);
    if (!parent || parent.kind !== "sub") return -1;
    cursor = parent;
  }
  return -1;
}

function collect(registry: AgentRegistryLike, rootSessionId: string): AgentSnapshot {
  const refs = registry.list();
  const byId = new Map<string, RegistryAgentRef>();
  let root: RegistryAgentRef | undefined;
  for (const ref of refs) {
    byId.set(ref.id, ref);
    if (ref.kind === "main" && ref.session?.sessionManager.getSessionId() === rootSessionId) root = ref;
  }
  if (!root) return { agents: [] };
  // The root's own live session model, read regardless of status: an idle
  // root is still the main agent. Children never stand in for it.
  const main: ModelIdentity = {};
  const rootModel = root.session?.model;
  if (rootModel?.provider) main.provider = rootModel.provider;
  if (rootModel?.id) main.modelId = rootModel.id;
  // The root ref outlives a session switch: its `sessionManager` re-points at
  // the new session while `parentId` links from the previous generation's
  // children still name it. The live transcript path is what separates the two.
  const rootFile = root.session?.sessionManager.getSessionFile();

  const rows: Array<{ depth: number; agent: ActiveAgent }> = [];
  for (const ref of refs) {
    // The root itself and advisor transcripts are never reported.
    if (ref.kind !== "sub") continue;
    // `isRunning` requires status `running` AND a live streaming session, which
    // drops parked corpses, finished-but-idle refs and history-only ghosts.
    if (!registry.isRunning(ref)) continue;
    const depth = depthFromRoot(ref, byId, root.id);
    if (depth < 0) continue;
    // A revived child keeps its original transcript path, so a refugee from an
    // earlier root is rejected here even while it streams. An unpersisted root
    // (or a child with no transcript yet) has no lineage token to check, and
    // the parent chain above already tied it to this root.
    const refFile = ref.session?.sessionManager.getSessionFile() ?? ref.sessionFile;
    if (rootFile && refFile && !belongsToRoot(refFile, rootFile)) continue;
    const agent: ActiveAgent = { id: ref.id, role: roleOf(ref) };
    if (ref.parentId !== undefined) agent.parentId = ref.parentId;
    // Unknown model keeps the row: an active descendant is still active.
    const model = ref.session?.model;
    if (model?.provider) agent.provider = model.provider;
    if (model?.id) agent.modelId = model.id;
    rows.push({ depth, agent });
  }
  rows.sort((a, b) => a.depth - b.depth || (a.agent.id < b.agent.id ? -1 : a.agent.id > b.agent.id ? 1 : 0));
  return { main, agents: rows.map(row => row.agent) };
}

/** Identity of a reported snapshot, for change detection. */
function identity(snapshot: AgentSnapshot): string {
  const main = snapshot.main;
  // Absent (unattached) and `{}` (attached, unknown model) must differ.
  let key = main ? `+${main.provider ?? ""}\u0000${main.modelId ?? ""}\u0002` : "-\u0002";
  for (const agent of snapshot.agents) {
    key += `${agent.id}\u0000${agent.parentId ?? ""}\u0000${agent.role}\u0000${agent.provider ?? ""}\u0000${agent.modelId ?? ""}\u0001`;
  }
  return key;
}

function copySnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  const agents = snapshot.agents.slice();
  return snapshot.main ? { main: { ...snapshot.main }, agents } : { agents };
}

/**
 * Observe the root model and every active descendant of the session
 * identified by `rootSessionId`. `onChange` fires only when the reported
 * value actually moved — the root attaching or switching `/model`, the set of
 * descendants, their lineage or a live child model.
 */
export function observeAgents(
  registry: AgentRegistryLike,
  rootSessionId: string,
  onChange: (snapshot: AgentSnapshot) => void,
): AgentObserver {
  let disposed = false;
  let current = collect(registry, rootSessionId);
  let currentIdentity = identity(current);

  function refresh(): void {
    if (disposed) return;
    const next = collect(registry, rootSessionId);
    const nextIdentity = identity(next);
    if (nextIdentity === currentIdentity) return;
    current = next;
    currentIdentity = nextIdentity;
    onChange(copySnapshot(current));
  }

  // Registry events (register/status/metadata/remove) are the low-latency edge;
  // the caller's own timer covers what the registry never emits, such as a
  // live model switch inside an already-running agent.
  const unsubscribe = registry.onChange(refresh);

  return {
    snapshot: () => copySnapshot(current),
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      current = { agents: [] };
      currentIdentity = identity(current);
    },
  };
}
