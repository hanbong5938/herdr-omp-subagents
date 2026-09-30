import process from "node:process";

import { isPluginEnabled } from "./src/activation.ts";
import {
  type AgentObserver,
  type AgentRegistryLike,
  observeAgents,
  resolveRootStatus,
} from "./src/collector.ts";
import { formatAgents, formatMainModel } from "./src/format.ts";
import { createReporter, type Reporter } from "./src/reporter.ts";
import { createSettingsReader, type SettingsReader } from "./src/settings.ts";
import {
  DEFAULT_MAX_ROWS,
  HEARTBEAT_MS,
  type ActiveAgent,
  type AgentSnapshot,
  type DisplayState,
  type ModelIdentity,
  type PaneBinding,
} from "./src/types.ts";

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

/** Versioned: a reload must not reuse a reporter built for an older token contract. */
const CLAIM_HOST = globalThis as unknown as {
  __herdrOmpSubagentPublishersV3__?: Map<string, Publisher>;
};

function publishers(): Map<string, Publisher> {
  return (CLAIM_HOST.__herdrOmpSubagentPublishersV3__ ??= new Map());
}

/** Clears the main model and every child row. */
const CLEARED: DisplayState = { rows: [] };

function render(snapshot: AgentSnapshot, maxRows: number): DisplayState {
  const rows = formatAgents(snapshot.agents, maxRows);
  const mainModel = formatMainModel(snapshot.main);
  return mainModel === undefined ? { rows } : { mainModel, rows };
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

/** Confirmed in OMP 18.1.20 and 18.4.1; capability detection avoids private imports. */
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
 * Owns the lifecycle: bind to the pane, observe this session's root model and
 * descendants, and publish the tokens while Herdr keeps the plugin enabled.
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
  /** Created by the owner only, so a subagent's copy never spawns the CLI. */
  #settings: SettingsReader | null = null;
  #timers: HostTimer[] = [];
  #rootSessionId = "";
  #claimed = false;
  #enabled = false;
  #activationInFlight = false;
  /** Newest formatted sidebar state, kept current even while disabled. */
  #desired: DisplayState = CLEARED;
  /** Effective child-row limit from the plugin config, last valid read. */
  #maxRows = DEFAULT_MAX_ROWS;
  #state = "not started";
  #activationError: string | null = null;
  #reportError: string | null = null;
  #settingsError: string | null = null;
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
    this.#observer = observeAgents(registry, rootSessionId, snapshot => {
      if (generation !== this.#generation) return;
      this.#desired = render(snapshot, this.#maxRows);
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

  /** Release the pane rows (owner only) and stop observing. */
  async stop(): Promise<void> {
    await this.#teardown("stopped", true);
  }

  /** `/herdr-subagents`: exact current identities plus binding, settings and gate state. */
  report(ctx: HostContext): void {
    const binding = this.#binding;
    const lines = [
      binding
        ? `pane ${binding.paneId} · socket ${binding.socketPath} · cli ${binding.herdrBin}`
        : "pane: unbound",
      `state: ${this.#state}`,
      `max rows: ${this.#maxRows} · config ${this.#settings?.path ?? "unresolved"}`,
    ];
    if (this.#claimed) {
      const { mainModel, rows } = this.#desired;
      lines.push(`herdr plugin: ${this.#enabled ? "enabled" : "disabled or unreachable"}`);
      lines.push(`main token: ${mainModel ?? "cleared"}`);
      lines.push(`rows: ${rows.length === 0 ? "cleared" : rows.join(" / ")}`);
    }
    if (this.#activationError) lines.push(`activation check: ${this.#activationError}`);
    if (this.#settingsError) lines.push(`last settings error: ${this.#settingsError}`);
    if (this.#reportError) lines.push(`last report error: ${this.#reportError}`);

    const { main, agents } = this.#observer?.snapshot() ?? { agents: [] };
    lines.push(main
      ? `main: ${main.provider ?? "unknown"}/${main.modelId ?? "unknown"}`
      : "main: root agent not attached");
    if (agents.length === 0) {
      lines.push("no active subagents");
    } else {
      for (const agent of agents) lines.push(describe(agent));
    }
    const severity = this.#activationError || this.#settingsError || this.#reportError ? "warning" : "info";
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
    // Gate the first publish on Herdr's own view of the plugin and on the
    // configured row limit rather than waiting out a heartbeat; a token left
    // behind by a previous process is cleared through the same path.
    if (claimedNow) await this.#checkActivation(generation);
  }

  #claim(): void {
    const binding = this.#binding;
    const observer = this.#observer;
    if (!binding || !observer) return;
    const generation = this.#generation;
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
    // The reader reports each distinct failure once and keeps its last valid
    // value, seeded with this bridge's, so a bad config never gates activation
    // and a session switch never falls back to the default.
    this.#settings = createSettingsReader(binding, error => {
      if (generation !== this.#generation) return;
      this.#settingsError = error.message;
      this.pi.logger.warn("herdr-subagents: plugin settings unreadable", { error: error.message });
    }, this.#maxRows);
    this.#claimed = true;
    this.#state = "publishing";
    this.#reporter = publisher.reporter;
    this.#reporter.set(CLEARED);
    // Agents may already be running (session switch mid-run, late attach), and
    // those never produced a change callback.
    this.#desired = render(observer.snapshot(), this.#maxRows);
  }

  #publish(): void {
    const reporter = this.#reporter;
    if (!reporter || !this.#enabled) return;
    if (publishers().get(this.#claimKey)?.token !== this.#token) return;
    reporter.set(this.#desired);
  }

  /**
   * Herdr can disable or unlink the plugin, or its config can change, while
   * the OMP extension stays installed, so both are re-read before every
   * heartbeat: disabled clears the tokens, re-enabled restores the current
   * snapshot, a new row limit reformats it, and no reload is needed.
   */
  async #checkActivation(generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    const binding = this.#binding;
    const reporter = this.#reporter;
    const settings = this.#settings;
    const observer = this.#observer;
    if (!binding || !reporter || !settings || !observer || !this.#claimed || this.#activationInFlight) return;
    if (publishers().get(this.#claimKey)?.token !== this.#token) return;
    this.#activationInFlight = true;
    try {
      // Independent failures: a bad config keeps the last valid limit, and an
      // unreachable host does not discard a freshly read one.
      const [activation, maxRows] = await Promise.allSettled([isPluginEnabled(binding), settings.read()]);
      // Shutdown, a session switch or a newer owner raced the check: its result is stale.
      if (generation !== this.#generation || publishers().get(this.#claimKey)?.token !== this.#token) return;
      if (maxRows.status === "fulfilled") {
        this.#maxRows = maxRows.value;
      } else {
        this.#settingsError = maxRows.reason instanceof Error ? maxRows.reason.message : String(maxRows.reason);
      }
      this.#desired = render(observer.snapshot(), this.#maxRows);
      if (activation.status === "rejected") {
        // Stop refreshing rather than hammering an unreachable host: the tokens
        // carry a TTL, so a stale value expires on its own.
        this.#enabled = false;
        this.#state = "idle: activation check failed";
        const error = activation.reason;
        this.#activationError = error instanceof Error ? error.message : String(error);
        this.pi.logger.warn("herdr-subagents: plugin activation check failed", {
          error: this.#activationError,
        });
        return;
      }
      const enabled = activation.value;
      this.#activationError = null;
      this.#enabled = enabled;
      this.#state = enabled ? "publishing" : "idle: plugin disabled in Herdr";
      reporter.set(enabled ? this.#desired : CLEARED);
      reporter.heartbeat();
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
    this.#settings = null;
    this.#desired = CLEARED;
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
      reporter.set(CLEARED);
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
    description: "Show the main model, row limit and live subagent identities reported to the Herdr sidebar",
    handler: async (_args, ctx) => {
      bridge.report(ctx);
    },
  });
}
