import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import herdrSubagents from "../extension.ts";
import { observeAgents, type AgentRegistryLike, type RegistryAgentRef } from "../src/collector.ts";
import { formatAgents, formatMainModel, MAX_TOKEN_BYTES } from "../src/format.ts";
import { createReporter, type Reporter } from "../src/reporter.ts";
import { createSettingsReader } from "../src/settings.ts";
import {
  DEFAULT_MAX_ROWS, HEARTBEAT_MS, MAIN_MODEL_TOKEN, MAX_ROWS, ROW_TOKENS, TTL_MS, type AgentSnapshot,
} from "../src/types.ts";

const OPUS = { provider: "anthropic", modelId: "claude-opus-5-5" };

function agent(id: string, parentId?: string, file = `/sessions/root/${id}.jsonl`): RegistryAgentRef {
  return {
    id, ...(parentId ? { parentId } : {}), kind: parentId ? "sub" : "main",
    displayName: "scout", status: "running", sessionFile: file,
    session: { isStreaming: true, model: { provider: "google", id: "gemini-3-flash" },
      sessionManager: { getSessionId: () => id, getSessionFile: () => file } },
  };
}

/** A root that finished its turn: idle, not streaming, still the main agent. */
function idleRoot(model?: { provider: string; id: string }): RegistryAgentRef {
  const base = agent("Main", undefined, "/sessions/root.jsonl");
  return {
    ...base, status: "idle",
    session: { isStreaming: false, ...(model ? { model } : {}), sessionManager: base.session!.sessionManager },
  };
}

function registryOf(refs: Map<string, RegistryAgentRef>) {
  const listeners = new Set<(event: unknown) => void>();
  const registry: AgentRegistryLike = {
    list: () => [...refs.values()], get: id => refs.get(id),
    isRunning: ref => ref.status === "running" && ref.session?.isStreaming === true,
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const emit = () => { for (const listener of listeners) listener({}); };
  return { registry, listeners, emit };
}

test("only live descendants of the current transcript survive restart, model changes and completion", () => {
  const root = agent("Main", undefined, "/sessions/root.jsonl");
  const refs = new Map([
    ["Main", root], ["child", agent("child", "Main")],
    ["nested", agent("nested", "child", "/sessions/root/child/nested.jsonl")],
    ["old", agent("old", "Main", "/sessions/old/old.jsonl")],
    ["foreign", agent("foreign", "Other", "/sessions/other/foreign.jsonl")],
    ["advisor", { ...agent("advisor", "Main"), kind: "advisor" as const }],
    ["idle", { ...agent("idle", "Main"), status: "idle" as const }],
  ]);
  const { registry, listeners, emit } = registryOf(refs);
  const observer = observeAgents(registry, "Main", () => {});
  expect(observer.snapshot().main).toEqual({ provider: "google", modelId: "gemini-3-flash" });
  expect(observer.snapshot().agents.map(row => row.id)).toEqual(["child", "nested"]);
  const child = refs.get("child")!;
  refs.set("child", { ...child, session: { ...child.session!, model: { provider: "anthropic", id: "claude-sonnet-4-6" } } });
  observer.refresh();
  expect(observer.snapshot().agents.find(row => row.id === "child")?.modelId).toBe("claude-sonnet-4-6");
  refs.set("child", { ...refs.get("child")!, status: "idle" });
  emit();
  expect(observer.snapshot().agents.map(row => row.id)).toEqual(["nested"]);
  refs.set("nested", { ...refs.get("nested")!, status: "aborted", session: null });
  observer.refresh();
  expect(formatAgents(observer.snapshot().agents, DEFAULT_MAX_ROWS)).toEqual([]);
  refs.set("child", { ...child, session: { isStreaming: true, sessionManager: child.session!.sessionManager } });
  observer.refresh();
  expect(formatAgents(observer.snapshot().agents, DEFAULT_MAX_ROWS)).toEqual(["scout:?"]);
  observer.dispose();
  expect(listeners.size).toBe(0);
});

test("an idle root with no children still reports each model switch, and only real switches", () => {
  const refs = new Map([
    ["Main", idleRoot({ provider: "anthropic", id: "claude-opus-5-5" })],
    ["done", { ...agent("done", "Main"), status: "idle" as const }],
  ]);
  const { registry, emit } = registryOf(refs);
  const seen: AgentSnapshot[] = [];
  const observer = observeAgents(registry, "Main", snapshot => seen.push(snapshot));
  expect(observer.snapshot()).toEqual({ main: OPUS, agents: [] });
  expect(formatMainModel(observer.snapshot().main)).toBe("(opus-5-5)");

  emit();
  observer.refresh();
  expect(seen).toHaveLength(0);

  refs.set("Main", idleRoot({ provider: "anthropic", id: "claude-sonnet-4-6" }));
  emit();
  expect(seen).toEqual([{ main: { provider: "anthropic", modelId: "claude-sonnet-4-6" }, agents: [] }]);
  expect(formatMainModel(seen[0]!.main)).toBe("(sonnet-4-6)");

  refs.set("Main", idleRoot({ provider: "google", id: "gemini-3-flash" }));
  observer.refresh();
  expect(seen.map(snapshot => formatMainModel(snapshot.main))).toEqual(["(sonnet-4-6)", "(flash-3)"]);
  observer.dispose();
});

test("an unattached root clears the main model while an attached root of unknown model shows (?)", () => {
  const attached = idleRoot();
  const refs = new Map<string, RegistryAgentRef>([["Main", { ...attached, session: null }]]);
  const { registry } = registryOf(refs);
  const seen: AgentSnapshot[] = [];
  const observer = observeAgents(registry, "Main", snapshot => seen.push(snapshot));
  expect(observer.snapshot().main).toBeUndefined();
  expect(formatMainModel(observer.snapshot().main)).toBeUndefined();

  refs.set("Main", attached);
  observer.refresh();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.main).toEqual({});
  expect(formatMainModel(seen[0]!.main)).toBe("(?)");

  refs.set("Main", idleRoot({ provider: "anthropic", id: "claude-opus-5-5" }));
  observer.refresh();
  expect(seen.at(-1)!.main).toEqual(OPUS);

  refs.set("Main", { ...attached, session: null });
  observer.refresh();
  expect(seen).toHaveLength(3);
  expect(seen.at(-1)!.main).toBeUndefined();
  expect(formatMainModel(seen.at(-1)!.main)).toBeUndefined();
  observer.dispose();
});

test("a copy loaded by a subagent never borrows the root model or its rows", () => {
  const refs = new Map([
    ["Main", idleRoot({ provider: "anthropic", id: "claude-opus-5-5" })],
    ["child", agent("child", "Main")],
    ["nested", agent("nested", "child", "/sessions/root/child/nested.jsonl")],
  ]);
  const { registry, emit } = registryOf(refs);
  const seen: AgentSnapshot[] = [];
  const observer = observeAgents(registry, "child", snapshot => seen.push(snapshot));
  expect(observer.snapshot()).toEqual({ agents: [] });
  refs.set("Main", idleRoot({ provider: "anthropic", id: "claude-sonnet-4-6" }));
  emit();
  expect(seen).toHaveLength(0);
  expect(observer.snapshot().main).toBeUndefined();
  observer.dispose();
});

test("a session switch shows the root model with only the new transcript's children", () => {
  let sessionId = "Main";
  let sessionFile = "/sessions/root.jsonl";
  const root: RegistryAgentRef = {
    id: "Main", kind: "main", displayName: "main", status: "idle", sessionFile,
    session: { isStreaming: false, model: { provider: "anthropic", id: "claude-opus-5-5" },
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } },
  };
  const refs = new Map([["Main", root], ["old", agent("old", "Main")]]);
  const { registry, emit } = registryOf(refs);
  const staleSeen: AgentSnapshot[] = [];
  const stale = observeAgents(registry, "Main", snapshot => staleSeen.push(snapshot));
  expect(stale.snapshot().main).toEqual(OPUS);
  expect(stale.snapshot().agents.map(row => row.id)).toEqual(["old"]);

  sessionId = "Next";
  sessionFile = "/sessions/next.jsonl";
  refs.set("fresh", agent("fresh", "Main", "/sessions/next/fresh.jsonl"));
  emit();
  expect(staleSeen).toEqual([{ agents: [] }]);

  const next = observeAgents(registry, "Next", () => {});
  expect(next.snapshot().main).toEqual(OPUS);
  expect(next.snapshot().agents.map(row => row.id)).toEqual(["fresh"]);
  stale.dispose();
  next.dispose();
});

test("rows retain unknown model identity, distinguish duplicates, fold overflow and bound hostile Unicode input", () => {
  expect(formatAgents([{ id: "a", role: "task", modelId: "ACME.Experimental-v2" }], MAX_ROWS)).toEqual(["task:ACME.Experimental-v2"]);
  const four = Array.from({ length: 4 }, (_, i) => ({ id: String(i), role: "task", modelId: "claude-opus-5-5" }));
  expect(formatAgents(four, MAX_ROWS)).toEqual(["task#1:opus-5-5", "task#2:opus-5-5", "task#3:opus-5-5", "task#4:opus-5-5"]);
  const agents = Array.from({ length: 20 }, (_, i) => ({
    id: String(i).padStart(2, "0"), role: "\x1b[31mscout\x1b[0m\n\u202e", modelId: "模型😀".repeat(20),
  }));
  const rows = formatAgents(agents, MAX_ROWS);
  expect(rows).toHaveLength(MAX_ROWS);
  expect(rows[0]).toStartWith("scout#1:");
  expect(rows.at(-1)).toBe(`+${agents.length - MAX_ROWS + 1}`);
  for (const row of rows) {
    expect(Buffer.byteLength(row)).toBeLessThanOrEqual(MAX_TOKEN_BYTES);
    expect(row).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
  }
  expect(formatAgents([...agents].reverse(), MAX_ROWS)).toEqual(rows);
});

test("maxRows bounds the child rows including the +N row and +N counts every hidden agent", () => {
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: String(i).padStart(2, "0"), role: "task", modelId: "claude-opus-5-5",
  }));
  const labels = (n: number) => Array.from({ length: n }, (_, i) => `task#${i + 1}:opus-5-5`);

  expect(formatAgents(tasks(3), 0)).toEqual([]);
  expect(formatAgents(tasks(1), 1)).toEqual(["task:opus-5-5"]);
  expect(formatAgents(tasks(2), 1)).toEqual(["+2"]);
  for (const max of [DEFAULT_MAX_ROWS, 8, MAX_ROWS]) {
    expect(formatAgents([], max)).toEqual([]);
    expect(formatAgents(tasks(1), max)).toEqual(["task:opus-5-5"]);
    expect(formatAgents(tasks(max), max)).toEqual(labels(max));
    // One agent over the limit hides two: the overflow row takes a slot.
    expect(formatAgents(tasks(max + 1), max)).toEqual([...labels(max - 1), "+2"]);
  }
  expect(formatAgents(tasks(12), 4)).toEqual([...labels(3), "+9"]);
  expect(formatAgents(tasks(12), 8)).toEqual([...labels(7), "+5"]);
  expect(formatAgents(tasks(12), 13)).toEqual(labels(12));
});

test("the main model label clears when absent, keeps unknown identities and bounds hostile input", () => {
  expect(formatMainModel(undefined)).toBeUndefined();
  expect(formatMainModel({})).toBe("(?)");
  expect(formatMainModel({ provider: "anthropic" })).toBe("(?)");
  expect(formatMainModel({ provider: "acme", modelId: "\x1b[0m\u200b\n" })).toBe("(?)");
  expect(formatMainModel(OPUS)).toBe("(opus-5-5)");
  expect(formatMainModel({ modelId: "ACME.Experimental-v2" })).toBe("(ACME.Experimental-v2)");
  const hostile = formatMainModel({ provider: "acme", modelId: `\x1b]0;title\x07\x1b[31m${"模型😀\u202e".repeat(20)}` })!;
  expect(hostile).toStartWith("(模型😀");
  expect(hostile).toEndWith(")");
  expect(Buffer.byteLength(hostile)).toBeLessThanOrEqual(MAX_TOKEN_BYTES);
  expect(hostile).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]|title/u);
});

test("maxRows comes from the Herdr plugin config dir, resets when deleted and keeps the last good value on errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-settings-"));
  const binary = join(dir, "herdr");
  const log = join(dir, "calls.log");
  const down = join(dir, "down");
  const socketPath = join(dir, "socket");
  const configDir = join(dir, "plugins", "config", "omp-subagents");
  const configFile = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(down, "");
  writeFileSync(binary, `#!/usr/bin/env bun
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (existsSync(${JSON.stringify(down)})) { console.error('error: herdr server is not running'); process.exit(1); }
if (process.env.HERDR_SOCKET_PATH !== ${JSON.stringify(socketPath)} || args.join(' ') !== 'plugin config-dir omp-subagents') process.exit(2);
console.log(${JSON.stringify(configDir)});
`);
  chmodSync(binary, 0o700);
  const errors: Error[] = [];
  const reader = createSettingsReader(
    { paneId: "test:p1", socketPath, herdrBin: binary }, error => errors.push(error), DEFAULT_MAX_ROWS,
  );
  const write = (config: unknown) => writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config));
  try {
    expect(reader.path).toBeUndefined();
    // Herdr unreachable: default rows, reported, and the next read retries.
    expect(await reader.read()).toBe(DEFAULT_MAX_ROWS);
    expect(reader.path).toBeUndefined();
    expect(errors).toHaveLength(1);
    rmSync(down);

    // No config file yet is the normal state, not an error.
    expect(await reader.read()).toBe(DEFAULT_MAX_ROWS);
    expect(reader.path).toBe(configFile);
    expect(errors).toHaveLength(1);

    write({ maxRows: 8 });
    expect(await reader.read()).toBe(8);
    // Out of range is rejected, never clamped to MAX_ROWS.
    write({ maxRows: MAX_ROWS + 1 });
    expect(await reader.read()).toBe(8);
    expect(errors).toHaveLength(2);

    write({ maxRows: 0 });
    expect(await reader.read()).toBe(0);
    expect(errors).toHaveLength(2);
    write({ maxRows: 2.5 });
    expect(await reader.read()).toBe(0);
    expect(errors).toHaveLength(3);
    for (const invalid of [{ maxRows: "6" }, { maxRows: -1 }, { rows: 6 }, [6], "{\"maxRows\":"]) {
      write(invalid);
      expect(await reader.read()).toBe(0);
    }

    write({ maxRows: MAX_ROWS });
    expect(await reader.read()).toBe(MAX_ROWS);
    const beforeReadError = errors.length;
    rmSync(configFile);
    mkdirSync(configFile);
    expect(await reader.read()).toBe(MAX_ROWS);
    expect(errors.length).toBeGreaterThan(beforeReadError);

    const beforeDeletion = errors.length;
    rmSync(configFile, { recursive: true });
    expect(await reader.read()).toBe(DEFAULT_MAX_ROWS);
    expect(errors).toHaveLength(beforeDeletion);
    // One failed resolution plus one successful one; file reads never re-ask Herdr.
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface HerdrCall {
  set: string[];
  cleared: string[];
  ttl?: number;
}

/**
 * Fake `herdr`: `plugin list` reports this plugin enabled, `plugin config-dir`
 * names a per-fixture directory, and report-metadata applies tokens to a JSON
 * sink and logs each call. While `down` is set every `plugin` query fails. A
 * write whose first row is `first` blocks until the test releases it.
 */
async function fakeHerdr(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const binary = join(dir, "herdr");
  const sink = join(dir, "tokens.json");
  const log = join(dir, "calls.log");
  const barrierPath = join(dir, "barrier");
  const down = join(dir, "down");
  const configDir = join(dir, "plugins", "config", "omp-subagents");
  const configFile = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  const held = Promise.withResolvers<Socket>();
  const server = createServer(socket => held.resolve(socket));
  server.listen(barrierPath);
  await once(server, "listening");
  writeFileSync(binary, `#!/usr/bin/env bun
import { connect } from 'node:net';
import { once } from 'node:events';
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'plugin') {
  if (existsSync(${JSON.stringify(down)})) { console.error('error: herdr server is not running'); process.exit(1); }
  const command = args.join(' ');
  if (command === 'plugin list --json') console.log(JSON.stringify({result:{plugins:[{plugin_id:'omp-subagents',enabled:true}]}}));
  else if (command === 'plugin config-dir omp-subagents') console.log(${JSON.stringify(configDir)});
  else process.exit(2);
} else {
  const file = Bun.file(${JSON.stringify(sink)});
  const tokens = (await file.exists()) ? await file.json() : {};
  const call = { set: [], cleared: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token') { const [name, ...rest] = args[++i].split('='); tokens[name] = rest.join('='); call.set.push(name); }
    if (args[i] === '--clear-token') { delete tokens[args[++i]]; call.cleared.push(args[i]); }
    if (args[i] === '--ttl-ms') call.ttl = Number(args[++i]);
  }
  if (tokens.subagents_1 === 'first') {
    const socket = connect(${JSON.stringify(barrierPath)});
    await once(socket, 'data');
    socket.end();
  }
  await Bun.write(file, JSON.stringify(tokens));
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + '\\n');
  if (tokens.subagents_1 === 'applied-but-lost') process.exit(1);
  console.log(JSON.stringify({result:{}}));
}
`);
  chmodSync(binary, 0o700);
  return {
    binding: { paneId: "test:p1", socketPath: join(dir, "socket"), herdrBin: binary },
    held: held.promise,
    configFile,
    writeConfig: (config: unknown) =>
      writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config)),
    setReachable: (reachable: boolean) => reachable ? rmSync(down, { force: true }) : writeFileSync(down, ""),
    published: (): Record<string, string> => existsSync(sink) ? JSON.parse(readFileSync(sink, "utf8")) : {},
    calls: (): HerdrCall[] => existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
      : [],
    async close() {
      const closed = once(server, "close");
      server.close();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a reader seeded with the last valid maxRows keeps it through first failures until deletion resets it", async () => {
  const herdr = await fakeHerdr("herdr-seeded-settings-");
  const reader = createSettingsReader(herdr.binding, () => {}, 8);
  try {
    // Herdr unreachable before the config directory was ever resolved.
    herdr.setReachable(false);
    expect(await reader.read()).toBe(8);
    expect(reader.path).toBeUndefined();
    herdr.setReachable(true);

    // Resolved, but the config cannot be read.
    mkdirSync(herdr.configFile);
    expect(await reader.read()).toBe(8);
    expect(reader.path).toBe(herdr.configFile);
    rmSync(herdr.configFile, { recursive: true });

    herdr.writeConfig({ maxRows: MAX_ROWS + 1 });
    expect(await reader.read()).toBe(8);

    // No config at all is the documented default, not a failure.
    rmSync(herdr.configFile);
    expect(await reader.read()).toBe(DEFAULT_MAX_ROWS);
  } finally {
    await herdr.close();
  }
});

test("a slow old write cannot overtake a new value or the final clear", async () => {
  const herdr = await fakeHerdr("herdr-publisher-");
  const errors: Error[] = [];
  const reporter = createReporter(herdr.binding, error => errors.push(error));
  try {
    reporter.set({ rows: ["first", "second"] });
    const first = reporter.flush();
    const held = await herdr.held;
    reporter.set({ rows: [] });
    reporter.set({ rows: ["latest; $(not-a-command)"] });
    held.end("continue");
    await reporter.flush();
    await first;
    // A shorter row set clears the slots the previous one filled.
    expect(herdr.published()).toEqual({ subagents_1: "latest; $(not-a-command)" });
    reporter.set({ rows: [] });
    await reporter.flush();
    reporter.set({ rows: ["applied-but-lost"] });
    await reporter.flush();
    expect(herdr.published()).toEqual({ subagents_1: "applied-but-lost" });
    reporter.set({ rows: [] });
    await reporter.flush();
    expect(herdr.published()).toEqual({});
    await reporter.dispose();
    expect(herdr.published()).toEqual({});
    expect(errors).toHaveLength(1);
  } finally {
    await reporter.dispose();
    await herdr.close();
  }
});

test("the main model and every row slot move together through shrink, main-only TTL refresh and disposal", async () => {
  const herdr = await fakeHerdr("herdr-main-model-");
  const errors: Error[] = [];
  const reporter = createReporter(herdr.binding, error => errors.push(error));
  const eight = ["first", "b", "c", "d", "e", "f", "g", "+5"];
  try {
    reporter.set({ mainModel: "(opus-5-5)", rows: eight });
    const first = reporter.flush();
    const held = await herdr.held;
    // maxRows shrinks from 8 to 4 and the root switches model while the old write hangs.
    reporter.set({ mainModel: "(opus-5-5)", rows: ["b", "c", "d", "+9"] });
    reporter.set({ mainModel: "(sonnet-4-6)", rows: ["b", "c", "d", "+9"] });
    held.end("continue");
    await reporter.flush();
    await first;
    expect(herdr.published()).toEqual({
      [MAIN_MODEL_TOKEN]: "(sonnet-4-6)", subagents_1: "b", subagents_2: "c", subagents_3: "d", subagents_4: "+9",
    });
    expect(herdr.calls()).toHaveLength(2);

    // The last child finished: the idle root alone keeps the pane alive.
    reporter.set({ mainModel: "(sonnet-4-6)", rows: [] });
    await reporter.flush();
    expect(herdr.published()).toEqual({ [MAIN_MODEL_TOKEN]: "(sonnet-4-6)" });
    expect(herdr.calls().at(-1)!.ttl).toBe(TTL_MS);
    const beforeHeartbeat = herdr.calls().length;
    reporter.heartbeat();
    await reporter.flush();
    expect(herdr.calls()).toHaveLength(beforeHeartbeat + 1);
    expect(herdr.calls().at(-1)!.ttl).toBe(TTL_MS);
    expect(herdr.published()).toEqual({ [MAIN_MODEL_TOKEN]: "(sonnet-4-6)" });

    reporter.set({ mainModel: "(haiku-4-5)", rows: [] });
    await reporter.flush();
    expect(herdr.published()).toEqual({ [MAIN_MODEL_TOKEN]: "(haiku-4-5)" });

    await reporter.dispose();
    expect(herdr.published()).toEqual({});
    const everyToken = [MAIN_MODEL_TOKEN, ...ROW_TOKENS].sort();
    expect(herdr.calls().at(-1)!.cleared.sort()).toEqual(everyToken);
    // Each call addresses the main token and all child slots at once.
    for (const call of herdr.calls()) expect([...call.set, ...call.cleared].sort()).toEqual(everyToken);
    expect(errors).toEqual([]);
  } finally {
    await reporter.dispose();
    await herdr.close();
  }
});

type Host = Parameters<typeof herdrSubagents>[0];
type HostEvent = Parameters<Host["on"]>[0];
type HostHandler = Parameters<Host["on"]>[1];
type HostCtx = Parameters<HostHandler>[1];

/**
 * The OMP host surface the extension touches. Managed intervals never fire on
 * their own: `fire` runs every live one with a period once and awaits it.
 */
function fakeHost(registry: AgentRegistryLike, sessionId: () => string) {
  const handlers = new Map<HostEvent, HostHandler>();
  const timers = new Map<object, { callback: () => unknown; ms: number | undefined }>();
  const ctx: HostCtx = {
    ui: { notify() {} },
    sessionManager: { getSessionId: sessionId },
    setInterval(callback, ms) {
      const handle = {};
      timers.set(handle, { callback: () => callback(), ms });
      return handle;
    },
    clearTimer(handle) { timers.delete(handle as object); },
  };
  const host: Host = {
    logger: { warn() {} },
    pi: { AgentRegistry: { global: () => registry } },
    on(event, handler) { handlers.set(event, handler); },
    registerCommand() {},
    setLabel() {},
  };
  return {
    host,
    timers,
    emit: async (event: HostEvent) => { await handlers.get(event)?.({}, ctx); },
    fire: async (ms: number) => {
      await Promise.all([...timers.values()].filter(timer => timer.ms === ms).map(timer => timer.callback()));
    },
  };
}

/** The pane writer the extension keeps across reloads and session switches. */
const PUBLISHER_HOST = globalThis as unknown as {
  __herdrOmpSubagentPublishersV3__?: Map<string, { reporter: Reporter }>;
};

function rootRef(sessionId: string, model: { provider: string; id: string }): RegistryAgentRef {
  const file = `/sessions/${sessionId}.jsonl`;
  return {
    id: "Main", kind: "main", status: "idle", sessionFile: file,
    session: { isStreaming: false, model, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => file } },
  };
}

/** The sink after a `maxRows` of `shown + 1`: the main model, `shown` role rows and one `+hidden` row. */
function sidebar(mainModel: string, role: string, model: string, shown: number, hidden: number): Record<string, string> {
  const rows = [...Array.from({ length: shown }, (_, i) => `${role}#${i + 1}:${model}`), `+${hidden}`];
  return { [MAIN_MODEL_TOKEN]: mainModel, ...Object.fromEntries(rows.map((row, i) => [ROW_TOKENS[i]!, row])) };
}

test("a session switch while the config is invalid keeps the last valid maxRows, not the default", async () => {
  const herdr = await fakeHerdr("herdr-extension-");
  const envKeys = ["HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH"] as const;
  const savedEnv = envKeys.map(key => [key, process.env[key]] as const);
  process.env.HERDR_PANE_ID = herdr.binding.paneId;
  process.env.HERDR_SOCKET_PATH = herdr.binding.socketPath;
  process.env.HERDR_BIN_PATH = herdr.binding.herdrBin;
  const claimKey = `${herdr.binding.socketPath}\u0000${herdr.binding.paneId}`;

  const refs = new Map<string, RegistryAgentRef>();
  const { registry } = registryOf(refs);
  let sessionId = "";
  /** The root re-points at `session`, running twelve children under its transcript. */
  const enter = (session: string, rootModel: { provider: string; id: string }, role: string, model: { provider: string; id: string }) => {
    sessionId = session;
    refs.clear();
    refs.set("Main", rootRef(session, rootModel));
    for (let n = 1; n <= 12; n++) {
      const id = `${session}-${String(n).padStart(2, "0")}`;
      const base = agent(id, "Main", `/sessions/${session}/${id}.jsonl`);
      refs.set(id, { ...base, displayName: role, session: { ...base.session!, model } });
    }
  };
  const host = fakeHost(registry, () => sessionId);
  herdrSubagents(host.host);
  const settle = async () => { await PUBLISHER_HOST.__herdrOmpSubagentPublishersV3__?.get(claimKey)?.reporter.flush(); };

  try {
    herdr.writeConfig({ maxRows: 8 });
    enter("s1", { provider: "anthropic", id: "claude-opus-5-5" }, "scout", { provider: "google", id: "gemini-3-flash" });
    await host.emit("session_start");
    await settle();
    expect(herdr.published()).toEqual(sidebar("(opus-5-5)", "scout", "flash-3", 7, 5));

    herdr.writeConfig("{\"maxRows\":");
    await host.fire(HEARTBEAT_MS);
    await settle();
    expect(herdr.published()).toEqual(sidebar("(opus-5-5)", "scout", "flash-3", 7, 5));

    // Another root transcript with its own children; the config is still broken.
    enter("s2", { provider: "anthropic", id: "claude-haiku-4-5" }, "reviewer", { provider: "anthropic", id: "claude-sonnet-4-6" });
    await host.emit("session_switch");
    await settle();
    expect(herdr.published()).toEqual(sidebar("(haiku-4-5)", "reviewer", "sonnet-4-6", 7, 5));

    herdr.writeConfig({ maxRows: 4 });
    await host.fire(HEARTBEAT_MS);
    await settle();
    expect(herdr.published()).toEqual(sidebar("(haiku-4-5)", "reviewer", "sonnet-4-6", 3, 9));

    await host.emit("session_shutdown");
    expect(herdr.published()).toEqual({});
    expect(host.timers.size).toBe(0);
  } finally {
    await host.emit("session_shutdown");
    const publishers = PUBLISHER_HOST.__herdrOmpSubagentPublishersV3__;
    const publisher = publishers?.get(claimKey);
    publishers?.delete(claimKey);
    await publisher?.reporter.dispose();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await herdr.close();
  }
});
