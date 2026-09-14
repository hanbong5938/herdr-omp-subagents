import { execFile } from "node:child_process";

import { SOURCE, TOKEN, TTL_MS, type PaneBinding } from "./types.ts";

/** Coalescing window for registry churn; one CLI call per burst. */
const DEBOUNCE_MS = 200;
/** A wedged CLI must never stall the queue, so the child is killed past this. */
const CLI_TIMEOUT_MS = 5_000;

export interface Reporter {
  /** Requests a token value, or `null` to clear it. Debounced and coalesced. */
  set(value: string | null): void;
  /** Refreshes the TTL and retries whatever the last write failed to apply. */
  heartbeat(): void;
  /** Publishes any pending value now and resolves once the queue is idle. */
  flush(): Promise<void>;
  /** Clears the token and stops accepting updates. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Herdr answers with `{"id":...,"result":{...}}` on success and
 * `{"error":{"code","message"},"id":...}` on failure (exit 1, stderr). A future
 * `ok: false` shape is treated as a failure too.
 */
function failureReason(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { ok, error } = parsed as { ok?: unknown; error?: unknown };
  if (error === undefined || error === null) return ok === false ? "herdr rejected the report" : null;
  if (typeof error === "string") return error;

  const { code, message } = error as { code?: unknown; message?: unknown };
  const detail = [code, message].filter((part): part is string => typeof part === "string" && part !== "");
  return detail.length > 0 ? detail.join(": ") : "herdr rejected the report";
}

/**
 * Serial, coalescing publisher for the pane token. At most one `herdr` child is
 * alive at a time and every write reads the newest desired value, so a slow
 * write can never land on top of a newer state.
 */
export function createReporter(binding: PaneBinding, onError: (error: Error) => void): Reporter {
  let desired: string | null = null;
  /** `undefined` while the server state is unknown, so the first write always runs. */
  let published: string | null | undefined;
  /** Open debounce window; every `set` inside it coalesces into one write. */
  let debouncing = false;
  let inFlight: Promise<void> | null = null;
  /** Something changed while a child was running; pump again once it settles. */
  let wake = false;
  /** Heartbeat asked for a write even if the value is unchanged (TTL refresh). */
  let force = false;
  /** Last write failed; wait for the next heartbeat instead of spinning on it. */
  let failed = false;
  let closed = false;
  let disposal: Promise<void> | null = null;

  function notify(error: Error): void {
    try {
      onError(error);
    } catch {
      // A throwing error handler must not take the reporter down with it.
    }
  }

  function report(value: string | null): Promise<string | null> {
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const args = ["pane", "report-metadata", binding.paneId, "--source", SOURCE];
    if (value === null) {
      args.push("--clear-token", TOKEN);
    } else {
      args.push("--token", `${TOKEN}=${value}`, "--ttl-ms", String(TTL_MS));
    }

    // Never throws and never rejects: callers treat a string as the failure reason.
    try {
      execFile(
        binding.herdrBin,
        args,
        {
          env: { ...process.env, HERDR_SOCKET_PATH: binding.socketPath },
          timeout: CLI_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const reason = failureReason(stdout) ?? failureReason(stderr);
          if (!error) {
            resolve(reason);
            return;
          }
          if (reason !== null) {
            resolve(reason);
            return;
          }
          // A killed child means the watchdog fired; stderr is empty in that case.
          if (error.killed) {
            resolve(`timed out after ${CLI_TIMEOUT_MS}ms`);
            return;
          }
          const detail = stderr.trim().split("\n", 1)[0] ?? "";
          resolve(detail === "" ? error.message : detail);
        },
      );
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error));
    }
    return promise;
  }

  function pump(): void {
    if (closed) return;
    if (inFlight) {
      wake = true;
      return;
    }

    const forced = force;
    force = false;
    const value = desired;
    // A forced pass still skips the no-op case of clearing an already-clear token.
    const needed = forced ? value !== null || published !== null : value !== published && !failed;
    if (!needed) return;

    inFlight = (async () => {
      const reason = await report(value);
      if (reason === null) {
        failed = false;
        published = value;
        return;
      }
      // A transport failure may happen after the server applied the write.
      published = undefined;
      failed = desired === value;
      notify(new Error(`herdr report-metadata failed: ${reason}`));
    })();

    void inFlight.then(() => {
      inFlight = null;
      if (!wake && !force) return;
      wake = false;
      pump();
    });
  }

  return {
    set(value: string | null): void {
      if (closed || value === desired) return;
      desired = value;
      // A new value earns a fresh attempt even if the previous one failed.
      failed = false;
      if (debouncing) return;
      debouncing = true;
      setTimeout(() => {
        debouncing = false;
        pump();
      }, DEBOUNCE_MS);
    },

    heartbeat(): void {
      if (closed) return;
      force = true;
      failed = false;
      pump();
    },

    async flush(): Promise<void> {
      // A pending debounce needs no cancelling: its pump is a no-op once published.
      if (!closed) {
        failed = false;
        pump();
      }
      while (inFlight) await inFlight;
    },

    dispose(): Promise<void> {
      disposal ??= (async () => {
        closed = true;
        // `closed` cancels the debounced write; wait out any live child so the
        // clear is the last thing the server sees.
        while (inFlight) await inFlight;
        if (published === null) return;
        const reason = await report(null);
        if (reason !== null) {
          notify(new Error(`herdr clear-token failed: ${reason}`));
          return;
        }
        published = null;
      })();
      return disposal;
    },
  };
}
