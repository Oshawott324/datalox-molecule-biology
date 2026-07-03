import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(repoRoot, "dist/src/cli/main.js");

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mol-mcp-smoke-"));
const inputPath = path.join(workspaceDir, "input.fa");
await fs.writeFile(inputPath, ">mcp smoke\nACGTRYSWKMBDHVN\n", "utf8");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry, "mcp-server"],
  cwd: repoRoot,
});
const client = new Client({ name: "molecule-biology-mcp-smoke", version: "0.1.0" });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  assertTool(tools, "open_sequence");
  assertTool(tools, "get_sequence_context");
  assertTool(tools, "reverse_complement");
  assertTool(tools, "render_plasmid_map");
  assertTool(tools, "render_digest_gel");
  assertTool(tools, "simulate_assembly");
  assertTool(tools, "design_primers");
  assertTool(tools, "design_grnas");

  const reverse = envelope(await client.callTool({
    name: "reverse_complement",
    arguments: { sequence: "ACGTRYSWKMBDHVN" },
  }));
  assertEqual(reverse.ok, true, "reverse_complement ok");
  assertEqual(reverse.data?.reverseComplement, "NBDHVKMWSRYACGT", "reverse_complement result");
  assertAgentContract(reverse, "reverse_complement");

  const open = envelope(await client.callTool({
    name: "open_sequence",
    arguments: {
      inputPath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_mcp_smoke",
    },
  }));
  assertEqual(open.ok, true, "open_sequence ok");
  assertEqual(open.revision, 0, "open_sequence revision");
  assertEqual(open.data?.previousRevision, 0, "open_sequence previousRevision");
  assertEqual(open.data?.revision, 0, "open_sequence data revision");
  assertAgentContract(open, "open_sequence");
  assertNextAction(open, "get_sequence_context");

  const context = envelope(await client.callTool({
    name: "get_sequence_context",
    arguments: {
      workspacePath: open.workspacePath,
      moleculeId: "mol_mcp_smoke",
      includeSequence: true,
    },
  }));
  assertEqual(context.ok, true, "get_sequence_context ok");
  assertEqual(context.data?.sequence, "ACGTRYSWKMBDHVN", "get_sequence_context sequence");
  assertAgentContract(context, "get_sequence_context");
  assertNextAction(context, "validate_workspace");

  const unknown = envelope(await client.callTool({
    name: "missing_tool",
    arguments: {},
  }));
  assertEqual(unknown.ok, false, "unknown tool ok");
  assertEqual(unknown.error?.code, "INVALID_ARGUMENT", "unknown tool code");

  await assertProtocolRejectsNonObjectArguments(client);

  const summary = {
    ok: true,
    toolCount: tools.tools.length,
    workspacePath: open.workspacePath,
    checks: [
      "tools/list",
      "reverse_complement",
      "open_sequence",
      "get_sequence_context",
      "unknown_tool_invalid_argument",
      "non_object_arguments_protocol_rejection",
    ],
  };
  console.log(JSON.stringify(summary, null, 2));
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

function assertTool(result, name) {
  if (!Array.isArray(result.tools) || !result.tools.some((tool) => tool.name === name)) {
    throw new Error(`Expected MCP tool '${name}' to be listed`);
  }
}

function assertAgentContract(result, toolName) {
  if (!isRecord(result.agentContract) || result.agentContract.version !== 1) {
    throw new Error(`${toolName} did not return an agentContract`);
  }
}

function assertNextAction(result, expectedTool) {
  if (!isRecord(result.nextAction) || result.nextAction.tool !== expectedTool) {
    throw new Error(`Expected nextAction '${expectedTool}', got ${JSON.stringify(result.nextAction)}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function assertProtocolRejectsNonObjectArguments(client) {
  try {
    await client.callTool({
      name: "reverse_complement",
      arguments: "ACGT",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("expected record") || message.includes("expected object")) return;
    throw new Error(`Expected protocol schema rejection for non-object arguments, got: ${message}`);
  }
  throw new Error("Expected protocol schema rejection for non-object arguments");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
