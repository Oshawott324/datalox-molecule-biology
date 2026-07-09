import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  createReplayRecorder,
  packReplayBundle,
  recordToolCall,
  reverseComplement,
  verifyReplayBundle,
} from "../dist/src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mol-diagnostic-digest-demo-"));
const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
const pUC19Path = path.join(repoRoot, "fixtures/genbank/puc19.gb");
const insertPath = path.join(repoRoot, "fixtures/fasta/datalox_insert_v1.fa");
const stagedPuc19Path = await stageInputFile(pUC19Path, path.join(workspaceDir, "imports", "puc19.gb"));

const expectedSelectedPair = ["HindIII", "XhoI"];
const candidatePairs = [
  ["HindIII", "XhoI"],
  ["XbaI", "XhoI"],
  ["PstI", "XhoI"],
];
const expectedFragments = {
  mol_empty: [2686],
  mol_forward: [480, 2885],
  mol_reverse: [284, 3081],
};

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(repoRoot, "dist/src/cli/main.js"), "mcp-server"],
  cwd: repoRoot,
});
const client = new Client({ name: "molecule-diagnostic-digest-demo", version: "0.1.0" });
const recorder = createReplayRecorder();

try {
  await client.connect(transport);

  const emptyOpen = await recordMcpTool("open_sequence", {
    inputPath: stagedPuc19Path,
    workspaceDir,
    format: "genbank",
    moleculeId: "mol_empty",
  });
  const pUC19 = await recordMcpTool("get_sequence_context", {
    workspacePath,
    moleculeId: "mol_empty",
    includeSequence: true,
  });

  const insert = await readFastaSequence(insertPath);
  assertEqual(insert.length, 700, "insert length");
  const vector = assertString(pUC19.data?.sequence, "mol_empty sequence");
  const forwardSequence = `${vector.slice(0, 396)}${insert}${vector.slice(417)}`;
  const reverseSequence = `${vector.slice(0, 396)}${reverseComplement(insert)}${vector.slice(417)}`;
  assertEqual(forwardSequence.length, 3365, "forward construct length");
  assertEqual(reverseSequence.length, 3365, "reverse construct length");

  const forwardPath = path.join(workspaceDir, "mol_forward.gb");
  const reversePath = path.join(workspaceDir, "mol_reverse.gb");
  await fs.writeFile(forwardPath, formatCircularGenBank("mol_forward", "pUC19 payload forward orientation-control construct", forwardSequence), "utf8");
  await fs.writeFile(reversePath, formatCircularGenBank("mol_reverse", "pUC19 payload reverse orientation-control construct", reverseSequence), "utf8");

  const forwardOpen = await recordMcpTool("open_sequence", {
    inputPath: forwardPath,
    workspaceDir,
    format: "genbank",
    moleculeId: "mol_forward",
    expectedRevision: emptyOpen.revision,
  });
  await recordMcpTool("open_sequence", {
    inputPath: reversePath,
    workspaceDir,
    format: "genbank",
    moleculeId: "mol_reverse",
    expectedRevision: forwardOpen.revision,
  });

  const moleculeIds = ["mol_empty", "mol_forward", "mol_reverse"];
  const selectedSites = {};
  const candidateResults = [];
  const digestsByPair = {};

  for (const pair of candidatePairs) {
    const pairKey = pair.join("+");
    digestsByPair[pairKey] = {};
    const row = { pair: pairKey, fragmentsByMolecule: {} };
    for (const moleculeId of moleculeIds) {
      const digest = await recordMcpTool("simulate_digest", {
        workspacePath,
        moleculeId,
        enzymes: pair,
      });
      const fragments = sortedFragmentSizes(digest);
      row.fragmentsByMolecule[moleculeId] = fragments;
      digestsByPair[pairKey][moleculeId] = digest;
    }
    row.score = candidateScore(row.fragmentsByMolecule);
    candidateResults.push(row);
  }

  const selectedCandidate = selectCandidate(candidateResults);
  const selectedPair = selectedCandidate.pair.split("+");
  assertArrayEqual(selectedPair, expectedSelectedPair, "selected enzyme pair");
  for (const candidate of candidateResults) {
    candidate.verdict = candidate.pair === selectedCandidate.pair ? "selected" : "candidate";
  }
  const selectedDigests = digestsByPair[selectedCandidate.pair];

  for (const [moleculeId, expected] of Object.entries(expectedFragments)) {
    assertArrayEqual(sortedFragmentSizes(selectedDigests[moleculeId]), expected, `${moleculeId} ${selectedPair.join("+")} fragments`);
  }

  for (const moleculeId of moleculeIds) {
    selectedSites[moleculeId] = await recordMcpTool("find_restriction_sites", {
      workspacePath,
      moleculeId,
      enzymes: selectedPair,
    });
  }

  const gel = await recordMcpTool("render_digest_gel", {
    workspacePath,
    gelId: "diagnostic_digest",
    lanes: [
      { label: "Empty vector", fragments: fragmentsForLane(selectedDigests.mol_empty) },
      { label: "Forward orientation", fragments: fragmentsForLane(selectedDigests.mol_forward) },
      { label: "Reverse orientation", fragments: fragmentsForLane(selectedDigests.mol_reverse) },
    ],
    customLadder: [100, 250, 500, 1000, 2000, 3000, 5000],
  });

  const maps = {};
  for (const moleculeId of moleculeIds) {
    maps[moleculeId] = await recordMcpTool("render_plasmid_map", {
      workspacePath,
      moleculeId,
      cutSites: cutSitesFromEnvelope(selectedSites[moleculeId]),
      showPrimers: false,
      outputPath: `reports/maps/${moleculeId}.diagnostic.svg`,
    });
  }

  await recordMcpTool("validate_workspace", { workspacePath });

  const bundle = await packReplayBundle(recorder, { workspaceDir, workspacePath });
  const verification = await verifyReplayBundle(bundle.bundlePath);
  if (!verification.ok) {
    throw new Error(`Replay verification failed: ${verification.issues.join("; ")}`);
  }

  const summary = {
    ok: verification.ok,
    workspaceDir,
    workspacePath,
    scenario: "pUC19 diagnostic digest orientation-control demo",
    insert: {
      id: "datalox_insert_v1",
      length: insert.length,
      xhoICutPosition: 250,
    },
    selectedPair,
    selectionRule: "maximize_min_orientation_small_band_then_small_band_difference",
    candidateResults,
    expectedFragments,
    gelArtifact: gel.artifacts?.[0],
    mapArtifacts: Object.fromEntries(Object.entries(maps).map(([moleculeId, envelope]) => [moleculeId, envelope.artifacts?.[0]])),
    bundlePath: bundle.bundlePath,
    recordCount: verification.recordCount,
    tools: bundle.manifest.summary.tools,
  };

  console.log(cameraSummary(summary));
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

async function stageInputFile(sourcePath, stagedPath) {
  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  await fs.copyFile(sourcePath, stagedPath);
  return stagedPath;
}

async function readFastaSequence(filePath) {
  return (await fs.readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith(">"))
    .join("")
    .toUpperCase();
}

function formatCircularGenBank(name, description, sequence) {
  const origin = sequence.toLowerCase().match(/.{1,60}/g)
    .map((line, index) => `${String(index * 60 + 1).padStart(9)} ${line.match(/.{1,10}/g).join(" ")}`)
    .join("\n");
  return `LOCUS       ${name.padEnd(14).slice(0, 14)} ${String(sequence.length).padStart(7)} bp    DNA    circular 01-JAN-2026
DEFINITION  ${description}.
FEATURES             Location/Qualifiers
     source          1..${sequence.length}
                     /organism="synthetic construct"
     misc_feature    397..1096
                     /label="datalox_insert_v1"
ORIGIN
${origin}
//
`;
}

function sortedFragmentSizes(envelope) {
  const fragments = envelope.data?.fragments;
  if (!Array.isArray(fragments)) throw new Error(`Missing digest fragments in ${envelope.tool}`);
  return fragments.map((fragment) => fragment.size).sort((left, right) => left - right);
}

function fragmentsForLane(envelope) {
  return sortedFragmentSizes(envelope).map((size) => ({ size }));
}

function cutSitesFromEnvelope(envelope) {
  const sites = envelope.data?.sites;
  if (!Array.isArray(sites)) throw new Error(`Missing restriction sites in ${envelope.tool}`);
  return sites.map((site) => ({ enzyme: site.enzyme, position: site.cutPosition }));
}

function candidateScore(fragmentsByMolecule) {
  const forwardSmall = smallBand(fragmentsByMolecule.mol_forward);
  const reverseSmall = smallBand(fragmentsByMolecule.mol_reverse);
  const emptyBandCount = fragmentsByMolecule.mol_empty.length;
  return {
    passes: emptyBandCount === 1 && forwardSmall >= 250 && reverseSmall >= 250 && Math.abs(forwardSmall - reverseSmall) >= 150,
    forwardSmall,
    reverseSmall,
    smallBandDifference: Math.abs(forwardSmall - reverseSmall),
    minOrientationSmallBand: Math.min(forwardSmall, reverseSmall),
  };
}

function selectCandidate(candidateResults) {
  const passing = candidateResults.filter((candidate) => candidate.score.passes);
  if (passing.length === 0) throw new Error("No diagnostic digest candidate passed the acceptance rule");
  return [...passing].sort((left, right) => (
    right.score.minOrientationSmallBand - left.score.minOrientationSmallBand
    || right.score.smallBandDifference - left.score.smallBandDifference
    || left.pair.localeCompare(right.pair)
  ))[0];
}

function smallBand(fragments) {
  const candidates = fragments.filter((size) => size < 1000);
  if (candidates.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...candidates);
}

function cameraSummary(summary) {
  return `Replay verified
Scenario: ${summary.scenario}
Insert:   datalox_insert_v1, 700 bp payload, XhoI at insert cut position 250
Enzyme pair: ${summary.selectedPair.join(" + ")}

Molecule   Size    HindIII+XhoI fragments
empty      2686    [${summary.expectedFragments.mol_empty.join(", ")}]
forward    3365    [${summary.expectedFragments.mol_forward.join(", ")}]
reverse    3365    [${summary.expectedFragments.mol_reverse.join(", ")}]

Gel artifact: ${summary.gelArtifact?.path}
Map artifacts: ${Object.values(summary.mapArtifacts).map((artifact) => artifact?.path).filter(Boolean).join(", ")}
Replay bundle verified
Bundle: ${summary.bundlePath}
`;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function assertArrayEqual(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: expected [${expected.join(", ")}], received [${actual.join(", ")}]`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
