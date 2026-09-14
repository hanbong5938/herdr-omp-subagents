import { execFile } from "node:child_process";
import { SOURCE, type PaneBinding } from "./types.ts";

/** Query the host rather than reading Herdr's private installation database. */
export function isPluginEnabled(binding: PaneBinding): Promise<boolean> {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  execFile(binding.herdrBin, ["plugin", "list", "--json"], {
    env: { ...process.env, HERDR_SOCKET_PATH: binding.socketPath },
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  }, (error, stdout) => {
    if (error) { reject(error); return; }
    try {
      const response = JSON.parse(stdout);
      if (response.error || !Array.isArray(response.result?.plugins)) {
        throw new Error("Herdr returned no plugin registry");
      }
      resolve(response.result.plugins.some((plugin: { plugin_id?: string; enabled?: boolean }) =>
        plugin.plugin_id === SOURCE && plugin.enabled === true));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return promise;
}
