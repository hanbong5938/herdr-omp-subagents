export interface ActiveAgent {
  id: string;
  parentId?: string;
  role: string;
  provider?: string;
  modelId?: string;
}

export interface PaneBinding {
  paneId: string;
  socketPath: string;
  herdrBin: string;
}

export const SOURCE = "omp-subagents";
/**
 * One sidebar row per agent: `$subagents_1` … `$subagents_4`. Herdr hides
 * unreported tokens and empty rows, so idle panes show nothing.
 */
export const ROW_TOKENS = ["subagents_1", "subagents_2", "subagents_3", "subagents_4"] as const;
export const TTL_MS = 15_000;
export const HEARTBEAT_MS = 5_000;
