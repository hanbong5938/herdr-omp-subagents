import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DEFAULT_MAX_ROWS, MAX_ROWS, SOURCE, type PaneBinding } from "./types.ts";

export interface SettingsReader {
  /** Resolved `config.json` path; undefined until Herdr reports the plugin config directory. */
  readonly path: string | undefined;
  /** Current maxRows; failures keep the last valid value and are reported once until they change. */
  read(): Promise<number>;
}

/** Ask Herdr, because the OMP process does not necessarily inherit HERDR_PLUGIN_CONFIG_DIR. */
function resolveConfigDir(binding: PaneBinding): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(binding.herdrBin, ["plugin", "config-dir", SOURCE], {
    env: { ...process.env, HERDR_SOCKET_PATH: binding.socketPath },
    timeout: 2_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  }, (error, stdout) => {
    if (error) { reject(error); return; }
    const dir = stdout.trim();
    if (!isAbsolute(dir) || dir.includes("\n")) {
      reject(new Error(`Herdr returned an invalid plugin config directory: ${JSON.stringify(dir)}`));
      return;
    }
    resolve(dir);
  });
  return promise;
}

function parseMaxRows(text: string, path: string): number {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config) || !("maxRows" in config)) {
    throw new Error(`${path}: expected a JSON object with maxRows`);
  }
  const maxRows = config.maxRows;
  if (typeof maxRows !== "number" || !Number.isInteger(maxRows) || maxRows < 0 || maxRows > MAX_ROWS) {
    throw new Error(`${path}: maxRows must be an integer from 0 to ${MAX_ROWS}, got ${JSON.stringify(maxRows)}`);
  }
  return maxRows;
}

/** `initialMaxRows` seeds the value kept by failures: the caller's last valid limit. */
export function createSettingsReader(
  binding: PaneBinding,
  onError: (error: Error) => void,
  initialMaxRows: number,
): SettingsReader {
  let path: string | undefined;
  let maxRows = initialMaxRows;
  let reported: string | undefined;
  let pending: Promise<number> | undefined;

  const report = (error: unknown): void => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (failure.message === reported) return;
    reported = failure.message;
    onError(failure);
  };

  const load = async (): Promise<number> => {
    if (path === undefined) {
      try {
        path = join(await resolveConfigDir(binding), "config.json");
      } catch (error) {
        report(error);
        return maxRows;
      }
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        maxRows = DEFAULT_MAX_ROWS;
        reported = undefined;
        return maxRows;
      }
      report(error);
      return maxRows;
    }
    try {
      maxRows = parseMaxRows(text, path);
      reported = undefined;
    } catch (error) {
      report(error);
    }
    return maxRows;
  };

  return {
    get path() { return path; },
    read() {
      // Overlapping callers share one resolution/read instead of racing the CLI.
      pending ??= load().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
