import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { observeAgents, type AgentRegistryLike, type RegistryAgentRef } from "../src/collector.ts";
import { formatAgents, MAX_TOKEN_BYTES } from "../src/format.ts";
import { createReporter } from "../src/reporter.ts";

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
  expect(formatAgents(observer.snapshot())).toBeNull();
  refs.set("child", { ...child, session: { isStreaming: true, sessionManager: child.session!.sessionManager } });
  observer.refresh();
  expect(formatAgents(observer.snapshot())).toContain("scout:?");
  observer.dispose();
  expect(listeners.size).toBe(0);
});

test("labels retain unknown model identity, distinguish duplicates and bound hostile Unicode input", () => {
  expect(formatAgents([{ id: "a", role: "task", modelId: "ACME.Experimental-v2" }])).toBe("[task:ACME.Experimental-v2]");
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: String(i).padStart(2, "0"), role: "\x1b[31mscout\x1b[0m\n\u202e", modelId: "模型😀".repeat(20),
  }));
  const value = formatAgents(rows)!;
  expect(value).toContain("scout#1:");
  expect(value).toMatch(/\+\d+\]$/);
  expect(Buffer.byteLength(value)).toBeLessThanOrEqual(MAX_TOKEN_BYTES);
  expect(value).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
  expect(formatAgents([...rows].reverse())).toBe(value);
});

test("a slow old write cannot overtake a new value or the final clear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-publisher-"));
  const binary = join(dir, "herdr");
  const sink = join(dir, "value.json");
  const socketPath = join(dir, "barrier");
  const ready = Promise.withResolvers<Socket>();
  const server = createServer(socket => ready.resolve(socket));
  server.listen(socketPath);
  await once(server, "listening");
  writeFileSync(binary, `#!/usr/bin/env bun
import { connect } from 'node:net';
import { once } from 'node:events';
const args = process.argv.slice(2);
const token = args.indexOf('--token');
const value = token < 0 ? null : args[token + 1].slice('subagents='.length);
if (value === 'first') {
  const socket = connect(${JSON.stringify(socketPath)});
  await once(socket, 'data');
  socket.end();
}
await Bun.write(${JSON.stringify(sink)}, JSON.stringify(value));
if (value === 'applied-but-lost') process.exit(1);
console.log(JSON.stringify({result:{}}));
`);
  chmodSync(binary, 0o700);
  const errors: Error[] = [];
  const reporter = createReporter({ paneId: "test:p1", socketPath: join(dir, "socket"), herdrBin: binary }, error => errors.push(error));
  try {
    reporter.set("first");
    const first = reporter.flush();
    const held = await ready.promise;
    reporter.set(null);
    reporter.set("latest; $(not-a-command)");
    held.end("continue");
    await reporter.flush();
    await first;
    expect(JSON.parse(readFileSync(sink, "utf8"))).toBe("latest; $(not-a-command)");
    reporter.set(null);
    await reporter.flush();
    reporter.set("applied-but-lost");
    await reporter.flush();
    expect(JSON.parse(readFileSync(sink, "utf8"))).toBe("applied-but-lost");
    reporter.set(null);
    await reporter.flush();
    expect(JSON.parse(readFileSync(sink, "utf8"))).toBeNull();
    await reporter.dispose();
    expect(JSON.parse(readFileSync(sink, "utf8"))).toBeNull();
    expect(errors).toHaveLength(1);
  } finally {
    await reporter.dispose();
    const closed = once(server, "close");
    server.close();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
