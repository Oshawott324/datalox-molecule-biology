import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(repoRoot, "dist/src/cli/main.js");
const launchCwd = await fs.mkdtemp(path.join(os.tmpdir(), "mol-mcp-cwd-launch-"));
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mol-mcp-cwd-workspace-"));
const inputPath = path.join(workspaceDir, "input.fa");
await fs.writeFile(inputPath, ">cwd smoke\nACGTACGTACGT\n", "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry, "mcp-server"],
  cwd: launchCwd,
});
const client = new Client({ name: "molecule-biology-mcp-cwd-smoke", version: "0.1.0" });

try {
  await client.connect(transport);

  const open = envelope(await client.callTool({
    name: "open_sequence",
    arguments: {
      inputPath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_mcp_cwd_smoke",
    },
  }));
  assertEqual(open.ok, true, "open_sequence ok");
  assertEqual(open.workspacePath, path.join(workspaceDir, "molecule.workspace.json"), "workspacePath");

  const context = envelope(await client.callTool({
    name: "get_sequence_context",
    arguments: {
      workspacePath: open.workspacePath,
      moleculeId: "mol_mcp_cwd_smoke",
      includeSequence: true,
    },
  }));
  assertEqual(context.ok, true, "get_sequence_context ok");
  assertEqual(context.data?.sequence, "ACGTACGTACGT", "sequence");

  console.log(JSON.stringify({
    ok: true,
    launchCwd,
    workspacePath: open.workspacePath,
    checks: ["mcp_server_launches_from_non_repo_cwd", "open_sequence", "get_sequence_context"],
  }, null, 2));
} finally {
  await client.close();
}

function envelope(result) {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.find((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string")?.text
    : undefined;
  if (text === undefined) throw new Error("MCP result did not include a structured or text envelope");
  return JSON.parse(text);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
