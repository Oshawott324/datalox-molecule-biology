import { startSequenceEditorServer, type SequenceEditorServer, type SequenceEditorServerOptions } from "./server.js";

export type OpenSequenceEditorResult = {
  url: string;
  workspacePath: string;
};

const managedServers = new Map<string, SequenceEditorServer>();

export async function openSequenceEditor(options: SequenceEditorServerOptions): Promise<OpenSequenceEditorResult> {
  const server = await startSequenceEditorServer(options);
  managedServers.set(server.url, server);
  return {
    url: server.url,
    workspacePath: server.workspacePath,
  };
}

export async function closeManagedSequenceEditors(): Promise<void> {
  const servers = Array.from(managedServers.values());
  managedServers.clear();
  await Promise.all(servers.map((server) => server.close()));
}

export { startSequenceEditorServer };
export type { SequenceEditorServer, SequenceEditorServerOptions };
