export interface ActiveAgent {
  id: string;
  parentId?: string;
  role: string;
  provider?: string;
  modelId?: string;
}

export interface ModelIdentity {
  provider?: string;
  modelId?: string;
}

export interface AgentSnapshot {
  /** Absent until the current root attaches; an empty identity means unknown. */
  main?: ModelIdentity;
  agents: ActiveAgent[];
}

export interface DisplayState {
  mainModel?: string;
  rows: readonly string[];
}

export interface PaneBinding {
  paneId: string;
  socketPath: string;
  herdrBin: string;
}

export const SOURCE = "omp-subagents";
export const MAIN_MODEL_TOKEN = "main_model";
export const DEFAULT_MAX_ROWS = 4;
/** Thirteen child rows leave room for the existing three chrome rows. */
export const MAX_ROWS = 13;
/** Unreported tokens disappear; all slots are cleared when the limit shrinks. */
export const ROW_TOKENS: readonly string[] = Array.from(
  { length: MAX_ROWS }, (_, i) => `subagents_${i + 1}`,
);
export const TTL_MS = 15_000;
export const HEARTBEAT_MS = 5_000;
