import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { moleculeToolDescriptors } from "../dist/src/index.js";

const mode = process.argv[2];
if (mode !== "generate" && mode !== "check") {
  throw new Error("Usage: node scripts/eval-corpus-v0.mjs <generate|check>");
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const corpusRoot = path.join(repoRoot, "eval-corpus", "v0");
const taskRoot = path.join(corpusRoot, "tasks");
const serverEntry = path.join(repoRoot, "dist", "src", "cli", "main.js");

const tasks = [
  {
    id: "mb-edit-puc19-mcs-insert",
    title: "pUC19 MCS NotI insert with bla CDS frame preserved",
    category: "sequence_edit",
    moleculeId: "mol_puc19",
    sourceInput: path.join(repoRoot, "fixtures", "genbank", "puc19.gb"),
    inputFileName: "puc19.gb",
    edit: { operation: "insert", start: 402, sequence: "GCGGCCGC" },
    expectedChecks: {
      finalRevision: 1,
      finalLength: 2694,
      contextStart: 396,
      contextEnd: 409,
      editedRegion: "GAATTCGCGGCCGC",
      notISite: { start: 402, end: 409 },
      noCdsFrameshift: true,
    },
    render: { outputPath: "reports/maps/mb-edit-puc19-mcs-insert.svg", showPrimers: false, showGuides: false },
  },
  {
    id: "mb-edit-puc19-laczalpha-frameshift",
    title: "pUC19 lacZalpha frame proxy reports MCS insertion frameshift",
    category: "sequence_edit",
    moleculeId: "mol_puc19_laczalpha_cds",
    inputFileName: "puc19-laczalpha-cds.gb",
    edit: { operation: "insert", start: 402, sequence: "GCGGCCGC" },
    expectedChecks: {
      finalRevision: 1,
      finalLength: 2694,
      contextStart: 396,
      contextEnd: 409,
      editedRegion: "GAATTCGCGGCCGC",
      lacZalphaFrameProxy: {
        beforeSegments: [{ start: 238, end: 681, strand: "-" }],
        afterSegments: [{ start: 238, end: 689, strand: "-" }],
      },
      blaAfterSegments: [{ start: 1637, end: 2425, strand: "-" }],
    },
    render: { outputPath: "reports/maps/mb-edit-puc19-laczalpha-frameshift.svg", showPrimers: false, showGuides: false },
    variant: "laczalpha_frame_proxy",
  },
];

if (mode === "generate") {
  await generateCorpus();
} else {
  await checkCorpus();
}

async function generateCorpus() {
  await fs.mkdir(taskRoot, { recursive: true });
  const manifestTasks = [];
  for (const task of tasks) {
    const generated = await runTask(task);
    await writeTaskFiles(task, generated);
    manifestTasks.push({
      id: task.id,
      title: task.title,
      path: `tasks/${task.id}/task.json`,
      category: task.category,
      requiredTools: generated.requiredTools,
      expectedSummaryPath: `tasks/${task.id}/expected/summary.json`,
    });
  }

  const descriptorDigest = descriptorSurfaceDigest();
  const manifest = {
    schema: "datalox.molecule.eval-corpus",
    version: "0.1.0",
    createdAt: "2026-07-20T00:00:00.000Z",
    packageName: "@datalox/molecule-biology",
    requiredToolSurface: {
      toolCount: moleculeToolDescriptors.length,
      requiredTools: [...new Set(tasks.flatMap(requiredToolsForTask))].sort(),
      descriptorDigest,
    },
    artifactHashAlgorithm: "sha256",
    tasks: manifestTasks,
  };
  await writeJson(path.join(corpusRoot, "corpus.manifest.json"), manifest);
  await fs.writeFile(path.join(corpusRoot, "README.md"), corpusReadme(), "utf8");
  console.log(JSON.stringify({ ok: true, mode, tasks: tasks.map((task) => task.id) }, null, 2));
}

async function checkCorpus() {
  const manifest = await readJson(path.join(corpusRoot, "corpus.manifest.json"));
  assertEqual(manifest.schema, "datalox.molecule.eval-corpus", "manifest schema");
  assertEqual(manifest.requiredToolSurface.toolCount, moleculeToolDescriptors.length, "tool surface count");
  assertEqual(manifest.requiredToolSurface.descriptorDigest, descriptorSurfaceDigest(), "tool descriptor digest");
  const results = [];
  for (const task of tasks) {
    const generated = await runTask(task);
    const expectedSummary = await readJson(path.join(taskRoot, task.id, "expected", "summary.json"));
    const expectedArtifacts = await readJson(path.join(taskRoot, task.id, "expected", "artifacts.json"));
    const expectedTaskManifest = await readJson(path.join(taskRoot, task.id, "task.json"));
    assertDeepEqual(generated.summary, expectedSummary, `${task.id} expected summary`);
    assertDeepEqual(generated.artifactsManifest, expectedArtifacts, `${task.id} expected artifacts`);
    assertDeepEqual(generated.taskManifest, expectedTaskManifest, `${task.id} task manifest`);
    for (const artifact of generated.summary.artifacts) {
      const expectedPath = path.join(taskRoot, task.id, artifact.path);
      const expectedHash = await sha256File(expectedPath);
      assertEqual(artifact.sha256, expectedHash, `${task.id} checked-in artifact hash`);
    }
    results.push({ id: task.id, ok: true });
  }
  console.log(JSON.stringify({ ok: true, mode, taskCount: results.length, results }, null, 2));
}

async function runTask(task) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `mol-eval-${task.id}-`));
  const stagedInput = path.join(workspaceDir, "imports", task.inputFileName);
  await fs.mkdir(path.dirname(stagedInput), { recursive: true });
  await fs.writeFile(stagedInput, await inputContentForTask(task), "utf8");
  const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
  const client = await connectedClient();
  try {
    const open = await callTool(client, "open_sequence", {
      inputPath: stagedInput,
      workspaceDir,
      format: "genbank",
      moleculeId: task.moleculeId,
    });

    const preTranslation = task.variant === "laczalpha_frame_proxy"
      ? await callTool(client, "translate_region", {
          workspacePath,
          moleculeId: task.moleculeId,
          start: 238,
          end: 681,
          strand: "-",
        })
      : undefined;

    const edit = await callTool(client, "edit_sequence", {
      workspacePath,
      moleculeId: task.moleculeId,
      expectedRevision: open.revision,
      ...task.edit,
    });

    const validate = await callTool(client, "validate_workspace", {
      workspacePath,
      checkSequenceDigests: true,
    });
    const context = await callTool(client, "get_sequence_context", {
      workspacePath,
      moleculeId: task.moleculeId,
      start: task.expectedChecks.contextStart,
      end: task.expectedChecks.contextEnd,
      includeSequence: true,
    });
    const sites = task.id === "mb-edit-puc19-mcs-insert"
      ? await callTool(client, "find_restriction_sites", {
          workspacePath,
          moleculeId: task.moleculeId,
          enzymes: ["NotI"],
        })
      : undefined;
    const postTranslation = task.variant === "laczalpha_frame_proxy"
      ? await callTool(client, "translate_region", {
          workspacePath,
          moleculeId: task.moleculeId,
          start: 238,
          end: 689,
          strand: "-",
        })
      : undefined;

    const cutSites = sites ? sites.data.sites.map((site) => ({ enzyme: site.enzyme, position: site.cutPosition })) : [];
    const firstMap = await callTool(client, "render_plasmid_map", {
      workspacePath,
      moleculeId: task.moleculeId,
      cutSites,
      outputPath: task.render.outputPath,
      showPrimers: task.render.showPrimers,
      showGuides: task.render.showGuides,
    });
    const firstMapBytes = await fs.readFile(firstMap.data.outputPath);
    const secondMap = await callTool(client, "render_plasmid_map", {
      workspacePath,
      moleculeId: task.moleculeId,
      cutSites,
      outputPath: `${task.render.outputPath}.determinism.svg`,
      showPrimers: task.render.showPrimers,
      showGuides: task.render.showGuides,
    });
    const secondMapBytes = await fs.readFile(secondMap.data.outputPath);
    if (!firstMapBytes.equals(secondMapBytes)) {
      throw new Error(`${task.id}: render_plasmid_map is not byte-deterministic`);
    }

    const artifactHash = sha256Buffer(firstMapBytes);
    const artifactRelativePath = "artifacts/plasmid-map.svg";
    const summary = buildSummary(task, {
      edit,
      validate,
      context,
      sites,
      preTranslation,
      postTranslation,
      artifactHash,
      artifactRelativePath,
    });
    const artifactsManifest = {
      taskId: task.id,
      artifacts: summary.artifacts,
    };
    return {
      workspaceDir,
      requiredTools: requiredToolsForTask(task),
      taskManifest: await taskManifest(task),
      summary,
      artifactsManifest,
      observations: selectedObservations(task, { open, edit, validate, context, sites, preTranslation, postTranslation, firstMap }),
      artifacts: [{ relativePath: artifactRelativePath, bytes: firstMapBytes }],
    };
  } finally {
    await client.close();
  }
}

function buildSummary(task, result) {
  const checks = [
    passCheck("length_after_insert", result.edit.data.lengthAfter, task.expectedChecks.finalLength),
    passCheck("workspace_validation_ok", result.validate.data.valid, true),
    passCheck("inserted_noti_site_present", result.context.data.sequence, task.expectedChecks.editedRegion),
  ];
  if (task.id === "mb-edit-puc19-mcs-insert") {
    const notISite = result.sites.data.sites.find((site) => site.enzyme === "NotI");
    checks.push(passCheck("noti_site_unique", result.sites.data.sites.length, 1));
    checks.push(passCheck("noti_site_coordinates", { start: notISite.start, end: notISite.end }, task.expectedChecks.notISite));
    checks.push(passCheck("no_cds_frameshift", hasAnyCdsFrameshift(result.edit), false));
  } else {
    const proxyImpact = impactByFeatureName(result.edit, "lacZalpha_frame_proxy");
    const blaImpact = impactByFeatureName(result.edit, "bla");
    checks.push(passCheck("laczalpha_frame_proxy_frameshift_reported", proxyImpact.frameShifted === true, true));
    checks.push(passCheck("laczalpha_frame_proxy_before_segments", proxyImpact.beforeSegments, task.expectedChecks.lacZalphaFrameProxy.beforeSegments));
    checks.push(passCheck("laczalpha_frame_proxy_after_segments", proxyImpact.afterSegments, task.expectedChecks.lacZalphaFrameProxy.afterSegments));
    checks.push(passCheck("bla_after_segments", blaImpact.afterSegments, task.expectedChecks.blaAfterSegments));
    checks.push(passCheck("bla_no_frameshift", blaImpact.frameShifted === true, false));
    checks.push(passCheck("translation_checked_outside_edit_sequence", {
      beforePartialTerminalCodon: result.preTranslation.data.partialTerminalCodon ?? null,
      afterPartialTerminalCodon: result.postTranslation.data.partialTerminalCodon ?? null,
    }, {
      beforePartialTerminalCodon: null,
      afterPartialTerminalCodon: "GC",
    }));
  }
  return {
    taskId: task.id,
    ok: true,
    workspace: {
      finalRevision: result.edit.revision,
      moleculeIds: [task.moleculeId],
    },
    checks,
    artifacts: [
      {
        id: task.id === "mb-edit-puc19-mcs-insert" ? "edited_plasmid_map" : "edited_laczalpha_plasmid_map",
        kind: "plasmid_map",
        path: "artifacts/plasmid-map.svg",
        sha256: result.artifactHash,
        mimeType: "image/svg+xml",
      },
    ],
  };
}

async function writeTaskFiles(task, generated) {
  const root = path.join(taskRoot, task.id);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "inputs"), { recursive: true });
  await fs.mkdir(path.join(root, "expected"), { recursive: true });
  await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
  await fs.writeFile(path.join(root, "inputs", task.inputFileName), await inputContentForTask(task), "utf8");
  await writeJson(path.join(root, "task.json"), generated.taskManifest);
  await writeJson(path.join(root, "expected", "summary.json"), generated.summary);
  await writeJson(path.join(root, "expected", "tool-observations.json"), generated.observations);
  await writeJson(path.join(root, "expected", "artifacts.json"), generated.artifactsManifest);
  for (const artifact of generated.artifacts) {
    await fs.writeFile(path.join(root, artifact.relativePath), artifact.bytes);
  }
}

async function taskManifest(task) {
  const inputContent = await inputContentForTask(task);
  return {
    schema: "datalox.molecule.eval-task",
    version: "0.1.0",
    id: task.id,
    title: task.title,
    category: task.category,
    objective: task.id === "mb-edit-puc19-mcs-insert"
      ? "Import authentic pUC19, insert a NotI payload after EcoRI in the MCS, validate the workspace, and render the edited plasmid map."
      : "Import pUC19 with a benchmark-only lacZalpha CDS proxy, insert the same NotI payload, and verify the proxy frameshift is reported.",
    constraints: [
      "Use public MCP tools only.",
      "Do not patch molecule.workspace.json directly.",
      "Call validate_workspace with checkSequenceDigests=true after edit_sequence.",
      "Do not infer amino-acid consequences from edit_sequence alone.",
    ],
    inputs: [
      {
        id: task.id === "mb-edit-puc19-mcs-insert" ? "puc19" : "puc19_laczalpha_cds",
        path: `inputs/${task.inputFileName}`,
        kind: "genbank",
        sha256: sha256String(inputContent),
        source: task.variant === "laczalpha_frame_proxy"
          ? "Derived from fixtures/genbank/puc19.gb by adding benchmark-only lacZalpha_frame_proxy CDS; sequence is unchanged."
          : "Repo fixture copied from fixtures/genbank/puc19.gb.",
      },
    ],
    toolPlan: requiredToolsForTask(task).map((tool, index) => ({
      step: index + 1,
      tool,
      purpose: purposeForTool(task, tool),
      required: true,
    })),
    expected: {
      summaryPath: "expected/summary.json",
      toolObservationsPath: "expected/tool-observations.json",
      artifactsPath: "expected/artifacts.json",
    },
    grading: {
      mode: "exact_json_subset",
      artifactHashRequired: true,
    },
    caveats: task.variant === "laczalpha_frame_proxy"
      ? ["lacZalpha_frame_proxy is a benchmark-only CDS annotation and is not claimed as the authentic NCBI feature model."]
      : ["The authentic fixture annotates lacZalpha as a non-CDS gene feature, so this task only asserts bla CDS frame preservation."],
  };
}

function selectedObservations(task, observations) {
  const normalized = {
    open_sequence: observations.open ? {
      ok: observations.open.ok,
      tool: observations.open.tool,
      revision: observations.open.revision,
      moleculeIds: observations.open.data.moleculeIds,
    } : undefined,
    translate_region_before: observations.preTranslation ? normalizeTranslation(observations.preTranslation) : undefined,
    edit_sequence: observations.edit ? {
      ok: observations.edit.ok,
      tool: observations.edit.tool,
      previousRevision: observations.edit.previousRevision,
      revision: observations.edit.revision,
      moleculeId: observations.edit.data.moleculeId,
      operation: observations.edit.data.operation,
      lengthBefore: observations.edit.data.lengthBefore,
      lengthAfter: observations.edit.data.lengthAfter,
      delta: observations.edit.data.delta,
      featureImpact: observations.edit.data.featureImpact.map(normalizeFeatureImpact),
    } : undefined,
    validate_workspace: observations.validate ? {
      ok: observations.validate.ok,
      tool: observations.validate.tool,
      revision: observations.validate.revision,
      validationOk: observations.validate.data.valid,
      issueCount: observations.validate.data.issues.length,
    } : undefined,
    get_sequence_context: observations.context ? {
      ok: observations.context.ok,
      tool: observations.context.tool,
      moleculeId: observations.context.data.molecule.id,
      region: observations.context.data.region,
      sequence: observations.context.data.sequence,
    } : undefined,
    find_restriction_sites: observations.sites ? {
      ok: observations.sites.ok,
      tool: observations.sites.tool,
      sites: observations.sites.data.sites.map((site) => ({
        enzyme: site.enzyme,
        start: site.start,
        end: site.end,
        cutPosition: site.cutPosition,
      })),
      sitesTotalCount: observations.sites.data.sitesTotalCount,
      sitesTruncated: observations.sites.data.sitesTruncated,
    } : undefined,
    translate_region_after: observations.postTranslation ? normalizeTranslation(observations.postTranslation) : undefined,
    render_plasmid_map: observations.firstMap ? {
      ok: observations.firstMap.ok,
      tool: observations.firstMap.tool,
      moleculeId: task.moleculeId,
      artifactKind: observations.firstMap.artifacts?.[0]?.kind,
    } : undefined,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function requiredToolsForTask(task) {
  if (task.id === "mb-edit-puc19-mcs-insert") {
    return ["open_sequence", "edit_sequence", "validate_workspace", "get_sequence_context", "find_restriction_sites", "render_plasmid_map"];
  }
  return ["open_sequence", "translate_region", "edit_sequence", "validate_workspace", "get_sequence_context", "render_plasmid_map"];
}

function purposeForTool(task, tool) {
  const purposes = {
    open_sequence: "Import task input into a fresh workspace.",
    edit_sequence: "Apply the pinned sequence edit through revision-safe tool writes.",
    validate_workspace: "Verify workspace JSON and stored sequence digest consistency.",
    get_sequence_context: "Read the edited sequence region and features.",
    find_restriction_sites: "Verify the inserted NotI restriction site deterministically.",
    translate_region: "Check protein consequence outside edit_sequence.",
    render_plasmid_map: "Render byte-stable plasmid map artifact.",
  };
  return purposes[tool] ?? `Run ${tool}`;
}

async function connectedClient() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverEntry, "mcp-server"],
    cwd: repoRoot,
  });
  const client = new Client({ name: "molecule-eval-corpus-v0", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const parsed = envelope(result);
  if (!parsed.ok) {
    throw new Error(`${name} failed: ${JSON.stringify(parsed.error)}`);
  }
  return parsed;
}

function envelope(result) {
  const text = Array.isArray(result.content)
    ? result.content.find((entry) => entry && entry.type === "text" && typeof entry.text === "string")?.text
    : undefined;
  if (text === undefined) throw new Error("MCP result did not include a text envelope");
  return JSON.parse(text);
}

async function inputContentForTask(task) {
  if (task.variant === "laczalpha_frame_proxy") return lacZalphaProxyContent(await fs.readFile(path.join(repoRoot, "fixtures", "genbank", "puc19.gb"), "utf8"));
  return fs.readFile(task.sourceInput, "utf8");
}

function lacZalphaProxyContent(content) {
  const marker = "     misc_feature    396..452\n";
  const proxy = [
    "     CDS             complement(238..681)",
    "                     /gene=\"lacZalpha_frame_proxy\"",
    "                     /product=\"benchmark-only lacZalpha frame proxy\"",
    "                     /note=\"Benchmark-only CDS proxy spanning MCS; sequence unchanged\"",
  ].join("\n") + "\n";
  if (!content.includes(marker)) throw new Error("Could not find MCS feature marker in pUC19 fixture");
  return content.replace(marker, `${proxy}${marker}`);
}

function passCheck(id, observed, expected) {
  assertDeepEqual(observed, expected, id);
  return { id, status: "pass", observed, expected };
}

function impactByFeatureName(editEnvelope, name) {
  const impact = editEnvelope.data.featureImpact.find((entry) => entry.name === name);
  if (!impact) throw new Error(`Missing featureImpact for ${name}`);
  return impact;
}

function hasAnyCdsFrameshift(editEnvelope) {
  return editEnvelope.data.featureImpact.some((impact) => impact.frameShifted === true);
}

function normalizeTranslation(envelope) {
  return {
    ok: envelope.ok,
    tool: envelope.tool,
    moleculeId: envelope.data.moleculeId,
    region: envelope.data.region,
    nucleotideLength: envelope.data.nucleotideLength,
    aminoAcidLength: envelope.data.aminoAcidLength,
    partialTerminalCodon: envelope.data.partialTerminalCodon ?? null,
  };
}

function normalizeFeatureImpact(impact) {
  return {
    featureId: impact.featureId,
    name: impact.name,
    impact: impact.impact,
    beforeSegments: impact.beforeSegments,
    afterSegments: impact.afterSegments,
    frameShifted: impact.frameShifted ?? false,
    notes: impact.notes ?? [],
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`);
  }
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha256String(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sha256Json(value) {
  return sha256String(JSON.stringify(value));
}

function descriptorSurfaceDigest() {
  return sha256Json([...moleculeToolDescriptors].sort((a, b) => a.name.localeCompare(b.name)));
}

async function sha256File(filePath) {
  return sha256Buffer(await fs.readFile(filePath));
}

function corpusReadme() {
  return `# Molecule Biology Eval Corpus v0

This corpus contains deterministic local tasks for the molecule-biology MCP.

Use:

\`\`\`sh
npm run eval:corpus:v0:check
\`\`\`

The checker verifies checked-in expected JSON and artifact hashes. It does not
regenerate expected files. Regeneration is manual only:

\`\`\`sh
npm run eval:corpus:v0:generate
\`\`\`
`;
}
