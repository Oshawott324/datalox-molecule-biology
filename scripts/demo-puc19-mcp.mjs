import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  createReplayRecorder,
  packReplayBundle,
  recordToolCall,
  verifyReplayBundle,
} from "../dist/src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mol-puc19-mcp-demo-"));
const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
const inputPath = path.join(repoRoot, "fixtures/genbank/puc19.gb");
const moleculeId = "mol_puc19";

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(repoRoot, "dist/src/cli/main.js"), "mcp-server"],
  cwd: repoRoot,
});
const client = new Client({ name: "molecule-puc19-demo", version: "0.1.0" });
const recorder = createReplayRecorder();

try {
  await client.connect(transport);
  await recordMcpTool("open_sequence", {
    inputPath,
    workspaceDir,
    format: "genbank",
    moleculeId,
  });
  await recordMcpTool("get_sequence_context", {
    workspacePath,
    moleculeId,
    includeSequence: false,
  });
  const sites = await recordMcpTool("find_restriction_sites", {
    workspacePath,
    moleculeId,
    enzymes: ["EcoRI", "BamHI", "HindIII", "PstI", "XbaI", "SmaI"],
  });
  const cutSites = Array.isArray(sites.data?.sites)
    ? sites.data.sites.map((site) => ({ enzyme: site.enzyme, position: site.cutPosition }))
    : [];
  const map = await recordMcpTool("render_plasmid_map", {
    workspacePath,
    moleculeId,
    cutSites,
    showPrimers: true,
  });
  await recordMcpTool("validate_workspace", {
    workspacePath,
  });

  const bundle = await packReplayBundle(recorder, { workspaceDir, workspacePath });
  const verification = await verifyReplayBundle(bundle.bundlePath);
  const summary = {
    ok: verification.ok,
    workspaceDir,
    workspacePath,
    moleculeId,
    siteCount: cutSites.length,
    renderedCutSiteCount: Array.isArray(map.data?.renderedCutSites) ? map.data.renderedCutSites.length : undefined,
    mapArtifact: map.artifacts?.[0],
    bundlePath: bundle.bundlePath,
    recordCount: verification.recordCount,
    tools: bundle.manifest.summary.tools,
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close();
}

async function recordMcpTool(toolName, args) {
  return await recordToolCall(recorder, toolName, args, async () => {
    const result = await client.callTool({ name: toolName, arguments: args });
    const envelope = resultEnvelope(result);
    if (!envelope.ok) {
      throw new Error(`${toolName} failed: ${JSON.stringify(envelope.error)}`);
    }
    return envelope;
  });
}

function resultEnvelope(result) {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content.find((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string")?.text
    : undefined;
  if (text === undefined) throw new Error("MCP result did not include a structured or text envelope");
  return JSON.parse(text);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
