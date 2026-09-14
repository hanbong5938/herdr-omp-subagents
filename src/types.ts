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
export const TOKEN = "subagents";
export const TTL_MS = 15_000;
export const HEARTBEAT_MS = 5_000;
