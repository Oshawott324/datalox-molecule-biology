import path from "node:path";

import { startSequenceEditorServer, type SequenceEditorServer, type SequenceEditorServerOptions } from "./server.js";

export type OpenSequenceEditorResult = {
  url: string;
  workspacePath: string;
  reused: boolean;
};

/**
 * One live editor per resolved workspace path. Repeated open_sequence_editor
 * calls for the same workspace reuse the running server instead of leaking a
 * new HTTP listener and port on every call. The map holds the in-flight startup
 * promise so concurrent calls for the same workspace still converge on a single
 * server; a failed startup is evicted so the next call can retry.
 */
const managedServers = new Map<string, Promise<SequenceEditorServer>>();

export async function openSequenceEditor(options: SequenceEditorServerOptions): Promise<OpenSequenceEditorResult> {
  const key = path.resolve(options.workspacePath);
  let pending = managedServers.get(key);
  let reused = true;
  if (pending === undefined) {
    reused = false;
    pending = startSequenceEditorServer(options);
    managedServers.set(key, pending);
    pending.catch(() => managedServers.delete(key));
  }
  const server = await pending;
  return {
    url: server.url,
    workspacePath: server.workspacePath,
    reused,
  };
}

export async function closeManagedSequenceEditors(): Promise<void> {
  const pending = Array.from(managedServers.values());
  managedServers.clear();
  await Promise.all(pending.map(async (entry) => {
    try {
      await (await entry).close();
    } catch {
      // A server that already failed to start or close has nothing to clean up.
    }
  }));
}

export { startSequenceEditorServer };
export type { SequenceEditorServer, SequenceEditorServerOptions };
