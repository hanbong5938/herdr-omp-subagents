import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { observeAgents, type AgentRegistryLike, type RegistryAgentRef } from "../src/collector.ts";
import { formatAgents, MAX_TOKEN_BYTES } from "../src/format.ts";
import { createReporter } from "../src/reporter.ts";
import { ROW_TOKENS } from "../src/types.ts";

function agent(id: string, parentId?: string, file = `/sessions/root/${id}.jsonl`): RegistryAgentRef {
  return {
    id, ...(parentId ? { parentId } : {}), kind: parentId ? "sub" : "main",
    displayName: "scout", status: "running", sessionFile: file,
    session: { isStreaming: true, model: { provider: "google", id: "gemini-3-flash" },
      sessionManager: { getSessionId: () => id, getSessionFile: () => file } },
  };
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
  const listeners = new Set<(event: unknown) => void>();
  const registry: AgentRegistryLike = {
    list: () => [...refs.values()], get: id => refs.get(id),
    isRunning: ref => ref.status === "running" && ref.session?.isStreaming === true,
    onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const observer = observeAgents(registry, "Main", () => {});
  expect(observer.snapshot().map(row => row.id)).toEqual(["child", "nested"]);
  const child = refs.get("child")!;
  refs.set("child", { ...child, session: { ...child.session!, model: { provider: "anthropic", id: "claude-sonnet-4-6" } } });
  observer.refresh();
  expect(observer.snapshot().find(row => row.id === "child")?.modelId).toBe("claude-sonnet-4-6");
  refs.set("child", { ...refs.get("child")!, status: "idle" });
  for (const listener of listeners) listener({});
  expect(observer.snapshot().map(row => row.id)).toEqual(["nested"]);
  refs.set("nested", { ...refs.get("nested")!, status: "aborted", session: null });
  observer.refresh();
  expect(formatAgents(observer.snapshot())).toEqual([]);
  refs.set("child", { ...child, session: { isStreaming: true, sessionManager: child.session!.sessionManager } });
  observer.refresh();
  expect(formatAgents(observer.snapshot())).toEqual(["scout:?"]);
  observer.dispose();
  expect(listeners.size).toBe(0);
});

test("rows retain unknown model identity, distinguish duplicates, fold overflow and bound hostile Unicode input", () => {
  expect(formatAgents([{ id: "a", role: "task", modelId: "ACME.Experimental-v2" }])).toEqual(["task:ACME.Experimental-v2"]);
  const four = Array.from({ length: 4 }, (_, i) => ({ id: String(i), role: "task", modelId: "claude-opus-5-5" }));
  expect(formatAgents(four)).toEqual(["task#1:opus-5-5", "task#2:opus-5-5", "task#3:opus-5-5", "task#4:opus-5-5"]);
  const agents = Array.from({ length: 20 }, (_, i) => ({
    id: String(i).padStart(2, "0"), role: "\x1b[31mscout\x1b[0m\n\u202e", modelId: "模型😀".repeat(20),
  }));
  const rows = formatAgents(agents);
  expect(rows).toHaveLength(ROW_TOKENS.length);
  expect(rows[0]).toStartWith("scout#1:");
  expect(rows.at(-1)).toBe(`+${agents.length - ROW_TOKENS.length + 1}`);
  for (const row of rows) {
    expect(Buffer.byteLength(row)).toBeLessThanOrEqual(MAX_TOKEN_BYTES);
    expect(row).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
  }
  expect(formatAgents([...agents].reverse())).toEqual(rows);
});

test("a slow old write cannot overtake a new value or the final clear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-publisher-"));
  const binary = join(dir, "herdr");
  const sink = join(dir, "tokens.json");
  const socketPath = join(dir, "barrier");
  const ready = Promise.withResolvers<Socket>();
  const server = createServer(socket => ready.resolve(socket));
  server.listen(socketPath);
  await once(server, "listening");
  writeFileSync(binary, `#!/usr/bin/env bun
import { connect } from 'node:net';
import { once } from 'node:events';
const args = process.argv.slice(2);
const file = Bun.file(${JSON.stringify(sink)});
const tokens = (await file.exists()) ? await file.json() : {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--token') { const [name, ...rest] = args[++i].split('='); tokens[name] = rest.join('='); }
  if (args[i] === '--clear-token') delete tokens[args[++i]];
}
if (tokens.subagents_1 === 'first') {
  const socket = connect(${JSON.stringify(socketPath)});
  await once(socket, 'data');
  socket.end();
}
await Bun.write(file, JSON.stringify(tokens));
if (tokens.subagents_1 === 'applied-but-lost') process.exit(1);
console.log(JSON.stringify({result:{}}));
`);
  chmodSync(binary, 0o700);
  const errors: Error[] = [];
  const reporter = createReporter({ paneId: "test:p1", socketPath: join(dir, "socket"), herdrBin: binary }, error => errors.push(error));
  try {
    const published = () => JSON.parse(readFileSync(sink, "utf8"));
    reporter.set(["first", "second"]);
    const first = reporter.flush();
    const held = await ready.promise;
    reporter.set([]);
    reporter.set(["latest; $(not-a-command)"]);
    held.end("continue");
    await reporter.flush();
    await first;
    // A shorter row set clears the slots the previous one filled.
    expect(published()).toEqual({ subagents_1: "latest; $(not-a-command)" });
    reporter.set([]);
    await reporter.flush();
    reporter.set(["applied-but-lost"]);
    await reporter.flush();
    expect(published()).toEqual({ subagents_1: "applied-but-lost" });
    reporter.set([]);
    await reporter.flush();
    expect(published()).toEqual({});
    await reporter.dispose();
    expect(published()).toEqual({});
    expect(errors).toHaveLength(1);
  } finally {
    await reporter.dispose();
    const closed = once(server, "close");
    server.close();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
