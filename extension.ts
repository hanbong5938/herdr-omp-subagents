import process from "node:process";

import { isPluginEnabled } from "./src/activation.ts";
import {
  type AgentObserver,
  type AgentRegistryLike,
  observeAgents,
  resolveRootStatus,
} from "./src/collector.ts";
import { formatAgents } from "./src/format.ts";
import { createReporter, type Reporter } from "./src/reporter.ts";
import { HEARTBEAT_MS, type ActiveAgent, type PaneBinding } from "./src/types.ts";

/**
 * Model switches inside an already-running agent emit no registry event, so the
 * tree is recollected on a timer as well as on registry churn.
 */
const REFRESH_MS = 1_000;

const COMMAND = "herdr-subagents";

const LABEL = "Herdr Subagent Models";

/** Opaque managed-timer handle (Bun `Timer`). */
type HostTimer = unknown;

interface HostLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Structural subset of `ExtensionContext` — the host injects the real object,
 * so the plugin declares only what it touches and imports no OMP package.
 */
interface HostContext {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
  sessionManager: { getSessionId(): string | null | undefined };
  /** Managed timer: a throw is contained instead of killing the session. */
  setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): HostTimer;
  clearTimer(timer: HostTimer): void;
}

/** Structural subset of `ExtensionAPI`. */
interface HostApi {
  logger: HostLogger;
  /** `pi-coding-agent` exports; probed for the agent registry. */
  pi: unknown;
  on(
    event: "session_start" | "session_switch" | "session_shutdown",
    handler: (event: unknown, ctx: HostContext) => void | Promise<void>,
  ): void;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: HostContext) => Promise<void> },
  ): void;
  setLabel(label: string): void;
}

/** One serial writer per pane survives extension reloads and session switches. */
interface Publisher {
  token: object;
  reporter: Reporter;
  onError: (error: Error) => void;
}

const CLAIM_HOST = globalThis as unknown as {
  __herdrOmpSubagentPublishers__?: Map<string, Publisher>;
};

function publishers(): Map<string, Publisher> {
  return (CLAIM_HOST.__herdrOmpSubagentPublishers__ ??= new Map());
}

/** The pane this OMP process runs in, as exported by `herdr`. */
function resolveBinding(): PaneBinding | null {
  const paneId = process.env.HERDR_PANE_ID?.trim();
  const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
  if (!paneId || !socketPath) return null;
  return { paneId, socketPath, herdrBin: process.env.HERDR_BIN_PATH?.trim() || "herdr" };
}

function isRegistry(value: unknown): value is AgentRegistryLike {
  const candidate = value as Partial<AgentRegistryLike> | null | undefined;
  return (
    !!candidate &&
    typeof candidate.list === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.isRunning === "function" &&
    typeof candidate.onChange === "function"
  );
}

/** Confirmed in OMP 18.1.20; capability detection avoids private imports. */
function resolveRegistry(exports: unknown): AgentRegistryLike | null {
  const sdk = exports as { AgentRegistry?: { global?: () => unknown } } | null | undefined;
  const registryClass = sdk?.AgentRegistry;
  if (!registryClass || typeof registryClass.global !== "function") return null;
  const registry = registryClass.global();
  return isRegistry(registry) ? registry : null;
}

function describe(agent: ActiveAgent): string {
  const model = `${agent.provider ?? "unknown"}/${agent.modelId ?? "unknown"}`;
  return `${agent.id} · ${agent.role} · ${model}${agent.parentId ? ` · parent ${agent.parentId}` : ""}`;
}

/**
 * Owns the lifecycle: bind to the pane, observe this session's descendants,
 * and publish the token while Herdr keeps the plugin enabled.
 */
class Bridge {
  /** Invalidates every timer tick, observer callback and in-flight check. */
  #generation = 0;
  #token = {};
  #claimKey = "";
  #ctx: HostContext | null = null;
  #binding: PaneBinding | null = null;
  #registry: AgentRegistryLike | null = null;
  #observer: AgentObserver | null = null;
  #reporter: Reporter | null = null;
  #timers: HostTimer[] = [];
  #rootSessionId = "";
  #claimed = false;
  #enabled = false;
  #activationInFlight = false;
  /** Newest formatted token value, kept current even while disabled. */
  #desired: string | null = null;
  #state = "not started";
  #activationError: string | null = null;
  #reportError: string | null = null;
  #warnedUnsupported = false;

  constructor(private readonly pi: HostApi) {}

  /** (Re)bind to the session `ctx` describes. Safe to call repeatedly. */
  async start(ctx: HostContext): Promise<void> {
    await this.stop();
    const generation = this.#generation;
    this.#ctx = ctx;

    const binding = resolveBinding();
    if (!binding) {
      this.#state = "inactive: no Herdr pane (HERDR_PANE_ID/HERDR_SOCKET_PATH unset)";
      return;
    }
    const registry = resolveRegistry(this.pi.pi);
    if (!registry) {
      this.#reportUnsupported(ctx);
      return;
    }
    const rootSessionId = ctx.sessionManager.getSessionId() ?? "";
    if (!rootSessionId) {
      this.#state = "inactive: session id unavailable";
      return;
    }

    this.#binding = binding;
    this.#registry = registry;
    this.#rootSessionId = rootSessionId;
    this.#state = "waiting for the root agent to attach";
    this.#observer = observeAgents(registry, rootSessionId, agents => {
      if (generation !== this.#generation) return;
      this.#desired = formatAgents(agents);
      this.#publish();
    });
    // A managed timer isolates a rejected callback result, so every async
    // branch below is returned rather than dropped.
    this.#timers.push(ctx.setInterval(() => this.#tick(generation), REFRESH_MS));
    this.#timers.push(ctx.setInterval(() => this.#checkActivation(generation), HEARTBEAT_MS));
    // The root ref is usually attached by the time `session_start` fires; when it
    // is, ownership resolves here instead of one tick later.
    await this.#tick(generation);
  }

  /** Release the pane token (owner only) and stop observing. */
  async stop(): Promise<void> {
    await this.#teardown("stopped", true);
  }

  /** `/herdr-subagents`: exact current identities plus binding and gate state. */
  report(ctx: HostContext): void {
    const binding = this.#binding;
    const lines = [
      binding
        ? `pane ${binding.paneId} · socket ${binding.socketPath} · cli ${binding.herdrBin}`
        : "pane: unbound",
      `state: ${this.#state}`,
    ];
    if (this.#claimed) {
      lines.push(`herdr plugin: ${this.#enabled ? "enabled" : "disabled or unreachable"}`);
      lines.push(`token: ${this.#desired === null ? "cleared" : this.#desired}`);
    }
    if (this.#activationError) lines.push(`activation check: ${this.#activationError}`);
    if (this.#reportError) lines.push(`last report error: ${this.#reportError}`);

    const agents = this.#observer?.snapshot() ?? [];
    if (agents.length === 0) {
      lines.push("no active subagents");
    } else {
      for (const agent of agents) lines.push(describe(agent));
    }
    const severity = this.#activationError || this.#reportError ? "warning" : "info";
    ctx.ui.notify(lines.join("\n"), this.#registry ? severity : "warning");
  }

  async #tick(generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    const ctx = this.#ctx;
    const registry = this.#registry;
    const observer = this.#observer;
    if (!ctx || !registry || !observer) return;

    // `/resume`, `/reload`, branch and fork all re-point the session manager at
    // another id; the old root and its token are no longer ours to publish.
    if ((ctx.sessionManager.getSessionId() ?? "") !== this.#rootSessionId) {
      await this.start(ctx);
      return;
    }

    let claimedNow = false;
    if (!this.#claimed) {
      const status = resolveRootStatus(registry, this.#rootSessionId);
      // A subagent session loaded this extension too: it must never publish or
      // clear the pane's token, and nothing about it will change later.
      if (status === "foreign") {
        await this.#teardown("inactive: subagent session, the root session publishes", false);
        return;
      }
      if (status === "pending") return;
      this.#claim();
      claimedNow = true;
    }
    if (publishers().get(this.#claimKey)?.token !== this.#token) {
      await this.#teardown("inactive: superseded by a newer extension instance", false);
      return;
    }
    observer.refresh();
    // Gate the first publish on Herdr's own view of the plugin rather than
    // waiting out a heartbeat; a token left behind by a previous process is
    // cleared through the same path.
    if (claimedNow) await this.#checkActivation(generation);
  }

  #claim(): void {
    const binding = this.#binding;
    const observer = this.#observer;
    if (!binding || !observer) return;
    this.#claimKey = `${binding.socketPath}\u0000${binding.paneId}`;
    const onError = (error: Error) => {
      this.#reportError = error.message;
      this.pi.logger.warn("herdr-subagents: pane report failed", { error: error.message });
    };
    let publisher = publishers().get(this.#claimKey);
    if (!publisher) {
      const entry: Publisher = {
        token: this.#token,
        reporter: createReporter(binding, error => entry.onError(error)),
        onError,
      };
      publisher = entry;
      publishers().set(this.#claimKey, entry);
    } else {
      publisher.token = this.#token;
      publisher.onError = onError;
    }
    this.#claimed = true;
    this.#state = "publishing";
    this.#reporter = publisher.reporter;
    this.#reporter.set(null);
    // Agents may already be running (session switch mid-run, late attach), and
    // those never produced a change callback.
    this.#desired = formatAgents(observer.snapshot());
  }

  #publish(): void {
    const reporter = this.#reporter;
    if (!reporter || !this.#enabled) return;
    if (publishers().get(this.#claimKey)?.token !== this.#token) return;
    reporter.set(this.#desired);
  }

  /**
   * Herdr can disable or unlink the plugin while the OMP extension stays
   * installed, so enablement is re-read before every heartbeat: disabled
   * clears the token, re-enabled restores the current snapshot, and no reload
   * is needed either way.
   */
  async #checkActivation(generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    const binding = this.#binding;
    const reporter = this.#reporter;
    if (!binding || !reporter || !this.#claimed || this.#activationInFlight) return;
    if (publishers().get(this.#claimKey)?.token !== this.#token) return;
    this.#activationInFlight = true;
    try {
      const enabled = await isPluginEnabled(binding);
      // Shutdown or a session switch raced the check: its process is gone.
      if (generation !== this.#generation || publishers().get(this.#claimKey)?.token !== this.#token) return;
      this.#activationError = null;
      this.#enabled = enabled;
      this.#state = enabled ? "publishing" : "idle: plugin disabled in Herdr";
      reporter.set(enabled ? this.#desired : null);
      reporter.heartbeat();
    } catch (error) {
      if (generation !== this.#generation) return;
      // Stop refreshing rather than hammering an unreachable host: the token
      // carries a TTL, so a stale value expires on its own.
      this.#enabled = false;
      this.#state = "idle: activation check failed";
      this.#activationError = error instanceof Error ? error.message : String(error);
      this.pi.logger.warn("herdr-subagents: plugin activation check failed", {
        error: this.#activationError,
      });
    } finally {
      if (generation === this.#generation) this.#activationInFlight = false;
    }
  }

  async #teardown(state: string, clearToken: boolean): Promise<void> {
    this.#generation++;
    const ctx = this.#ctx;
    for (const timer of this.#timers.splice(0)) ctx?.clearTimer(timer);
    this.#observer?.dispose();
    this.#observer = null;
    this.#registry = null;
    this.#binding = null;
    this.#desired = null;
    this.#enabled = false;
    this.#activationInFlight = false;
    this.#state = state;
    const reporter = this.#reporter;
    this.#reporter = null;
    const publisher = publishers().get(this.#claimKey);
    const ownsPublisher = this.#claimed && publisher?.token === this.#token;
    this.#claimed = false;
    if (ownsPublisher && clearToken && reporter) {
      // Keep the writer alive but idle. A new owner reuses its queue, so this
      // clear cannot arrive after that owner's newer value.
      publisher.token = {};
      reporter.set(null);
      await reporter.flush();
    }
  }

  #reportUnsupported(ctx: HostContext): void {
    this.#state = "unsupported: this OMP runtime does not expose the required AgentRegistry API";
    if (this.#warnedUnsupported) return;
    this.#warnedUnsupported = true;
    this.pi.logger.warn("herdr-subagents: disabled, AgentRegistry SDK export is missing", {
      required: "AgentRegistry.global/list/get/isRunning/onChange",
    });
    ctx.ui.notify(
      `Herdr subagent models are disabled: this OMP runtime does not expose the required AgentRegistry API. Run /${COMMAND} for details.`,
      "warning",
    );
  }
}

export default function herdrSubagents(pi: HostApi): void {
  const bridge = new Bridge(pi);
  pi.setLabel(LABEL);
  pi.on("session_start", (_event, ctx) => bridge.start(ctx));
  pi.on("session_switch", (_event, ctx) => bridge.start(ctx));
  pi.on("session_shutdown", () => bridge.stop());
  pi.registerCommand(COMMAND, {
    description: "Show the live subagent identities reported to the Herdr sidebar",
    handler: async (_args, ctx) => {
      bridge.report(ctx);
    },
  });
}
