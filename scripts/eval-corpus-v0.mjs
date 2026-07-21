import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { moleculeToolDescriptors, reverseComplement } from "../dist/src/index.js";

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
  {
    id: "mb-digest-puc19-hindiii-xhoi",
    title: "pUC19 diagnostic digest gel distinguishes insert orientation",
    category: "digest",
    moleculeIds: ["mol_empty", "mol_forward", "mol_reverse"],
    expectedChecks: {
      finalRevision: 2,
      selectedPair: ["HindIII", "XhoI"],
      fragments: {
        mol_empty: [2686],
        mol_forward: [480, 2885],
        mol_reverse: [284, 3081],
      },
    },
  },
  {
    id: "mb-assembly-restriction-ligation",
    title: "EcoRI/BamHI restriction ligation produces a GenBank artifact",
    category: "assembly",
    moleculeIds: ["mol_vector_eval", "mol_insert_eval"],
    expectedChecks: {
      finalRevision: 1,
      productLength: 50,
      regeneratedSites: ["GAATTC", "GGATCC"],
    },
  },
  {
    id: "mb-crispr-puc19-ngg",
    title: "SpCas9 guide design persists one selected local guide and report",
    category: "crispr",
    moleculeId: "mol_crispr_eval",
    expectedChecks: {
      finalRevision: 1,
      guide: {
        id: "grna_eval_1",
        sequence: "ACGTACGTACGTACGTACGT",
        pam: "AGG",
        start: 1,
        end: 20,
        pamStart: 21,
        pamEnd: 23,
        gcPercent: 50,
      },
    },
  },
  {
    id: "mb-mrna-il27-validation",
    title: "Valid mRNA construct exports a translated protein FASTA",
    category: "mrna",
    moleculeId: "mol_mrna_eval",
    expectedChecks: {
      finalRevision: 0,
      validationSummary: "valid",
      proteinId: "il27_proxy",
      aminoAcids: "MAAA*",
      proteinLength: 4,
      stopTrimmed: true,
    },
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
  if (task.category === "digest") return runDigestTask(task);
  if (task.category === "assembly") return runAssemblyTask(task);
  if (task.category === "crispr") return runCrisprTask(task);
  if (task.category === "mrna") return runMrnaTask(task);
  return runSequenceEditTask(task);
}

async function runSequenceEditTask(task) {
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

async function runDigestTask(task) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `mol-eval-${task.id}-`));
  const staged = await stageTaskInputs(task, workspaceDir);
  const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
  const client = await connectedClient();
  try {
    const emptyOpen = await callTool(client, "open_sequence", {
      inputPath: staged.get("puc19-empty.gb"),
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_empty",
    });
    const forwardOpen = await callTool(client, "open_sequence", {
      inputPath: staged.get("puc19-forward.gb"),
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_forward",
      expectedRevision: emptyOpen.revision,
    });
    const reverseOpen = await callTool(client, "open_sequence", {
      inputPath: staged.get("puc19-reverse.gb"),
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_reverse",
      expectedRevision: forwardOpen.revision,
    });
    const digests = {};
    for (const moleculeId of task.moleculeIds) {
      digests[moleculeId] = await callTool(client, "simulate_digest", {
        workspacePath,
        moleculeId,
        enzymes: task.expectedChecks.selectedPair,
      });
    }
    const validate = await callTool(client, "validate_workspace", { workspacePath, checkSequenceDigests: true });
    const lanes = task.moleculeIds.map((moleculeId) => ({
      label: digestLaneLabel(moleculeId),
      fragments: digestFragmentSizes(digests[moleculeId]).map((size) => ({ size })),
    }));
    const gelArgs = {
      workspacePath,
      gelId: "eval_diagnostic_digest",
      lanes,
      customLadder: [100, 250, 500, 1000, 2000, 3000, 5000],
      outputPath: "reports/gels/eval-diagnostic-digest.svg",
    };
    const gel = await callTool(client, "render_digest_gel", gelArgs);
    const gelBytes = await fs.readFile(gel.data.outputPath);
    const gelAgain = await callTool(client, "render_digest_gel", { ...gelArgs, outputPath: "reports/gels/eval-diagnostic-digest.det.svg" });
    const gelAgainBytes = await fs.readFile(gelAgain.data.outputPath);
    assertByteEqual(gelBytes, gelAgainBytes, `${task.id}: render_digest_gel`);

    const artifactHash = sha256Buffer(gelBytes);
    const summary = buildDigestSummary(task, { reverseOpen, digests, validate, artifactHash });
    return taskRunResult(task, summary, {
      observations: normalizeDigestObservations({ emptyOpen, forwardOpen, reverseOpen, digests, validate, gel }),
      artifacts: [{ relativePath: "artifacts/digest-gel.svg", bytes: gelBytes }],
    });
  } finally {
    await client.close();
  }
}

async function runAssemblyTask(task) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `mol-eval-${task.id}-`));
  const staged = await stageTaskInputs(task, workspaceDir);
  const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
  const client = await connectedClient();
  try {
    const vectorOpen = await callTool(client, "open_sequence", {
      inputPath: staged.get("eval-vector.gb"),
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_vector_eval",
    });
    const insertOpen = await callTool(client, "open_sequence", {
      inputPath: staged.get("eval-insert.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_insert_eval",
      expectedRevision: vectorOpen.revision,
    });
    const assemblyArgs = {
      workspacePath,
      method: "restriction_ligation",
      vector: { moleculeId: "mol_vector_eval", leftEnzyme: "EcoRI", rightEnzyme: "BamHI" },
      insert: { moleculeId: "mol_insert_eval", leftEnzyme: "EcoRI", rightEnzyme: "BamHI", orientation: "forward" },
      product: { moleculeId: "mol_eval_product", name: "eval_product", topology: "circular" },
    };
    const assembly = await callTool(client, "simulate_assembly", assemblyArgs);
    const artifactBytes = await fs.readFile(assembly.artifacts[0].path);
    const assemblyAgain = await callTool(client, "simulate_assembly", assemblyArgs);
    const artifactAgainBytes = await fs.readFile(assemblyAgain.artifacts[0].path);
    assertByteEqual(artifactBytes, artifactAgainBytes, `${task.id}: simulate_assembly GenBank artifact`);
    const validate = await callTool(client, "validate_workspace", { workspacePath, checkSequenceDigests: true });

    const summary = buildAssemblySummary(task, { insertOpen, assembly, validate, artifactHash: sha256Buffer(artifactBytes) });
    return taskRunResult(task, summary, {
      observations: normalizeAssemblyObservations({ vectorOpen, insertOpen, assembly, validate }),
      artifacts: [{ relativePath: "artifacts/assembly-product.gb", bytes: artifactBytes }],
    });
  } finally {
    await client.close();
  }
}

async function runCrisprTask(task) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `mol-eval-${task.id}-`));
  const staged = await stageTaskInputs(task, workspaceDir);
  const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
  const client = await connectedClient();
  try {
    const open = await callTool(client, "open_sequence", {
      inputPath: staged.get("crispr-source.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: task.moleculeId,
    });
    const design = await callTool(client, "design_grnas", {
      workspacePath,
      moleculeId: task.moleculeId,
      targetRegion: { start: 1, end: 20 },
      options: { strand: "+" },
    });
    const guide = guideRecordFromCandidate(task.moleculeId, task.expectedChecks.guide, design.data.candidates[0]);
    const upsert = await callTool(client, "upsert_grna", {
      workspacePath,
      expectedRevision: open.revision,
      guide,
    });
    const validate = await callTool(client, "validate_workspace", { workspacePath, checkSequenceDigests: true });
    const reportArgs = {
      workspacePath,
      guideIds: [guide.id],
      outputPath: "reports/guides/eval-guide.md",
    };
    const report = await callTool(client, "export_grna_report", reportArgs);
    const reportBytes = await fs.readFile(report.artifacts[0].path);
    const reportAgain = await callTool(client, "export_grna_report", { ...reportArgs, outputPath: "reports/guides/eval-guide.det.md" });
    const reportAgainBytes = await fs.readFile(reportAgain.artifacts[0].path);
    assertByteEqual(reportBytes, reportAgainBytes, `${task.id}: export_grna_report`);

    const summary = buildCrisprSummary(task, { upsert, design, validate, report, artifactHash: sha256Buffer(reportBytes) });
    return taskRunResult(task, summary, {
      observations: normalizeCrisprObservations({ open, design, upsert, validate, report }),
      artifacts: [{ relativePath: "artifacts/grna-report.md", bytes: reportBytes }],
    });
  } finally {
    await client.close();
  }
}

async function runMrnaTask(task) {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `mol-eval-${task.id}-`));
  const staged = await stageTaskInputs(task, workspaceDir);
  const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
  const client = await connectedClient();
  try {
    const open = await callTool(client, "open_sequence", {
      inputPath: staged.get("il27-proxy-mrna.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: task.moleculeId,
    });
    const elements = mrnaElements();
    const construct = await callTool(client, "validate_mrna_construct", {
      workspacePath,
      moleculeId: task.moleculeId,
      templateType: "mrna",
      elements,
    });
    const validate = await callTool(client, "validate_workspace", { workspacePath, checkSequenceDigests: true });
    const proteinArgs = {
      workspacePath,
      moleculeId: task.moleculeId,
      cdsStart: 11,
      cdsEnd: 25,
      proteinId: task.expectedChecks.proteinId,
      outputPath: "reports/proteins/il27-proxy.fa",
    };
    const protein = await callTool(client, "export_protein_fasta", proteinArgs);
    const proteinBytes = await fs.readFile(protein.artifacts[0].path);
    const proteinAgain = await callTool(client, "export_protein_fasta", { ...proteinArgs, outputPath: "reports/proteins/il27-proxy.det.fa" });
    const proteinAgainBytes = await fs.readFile(proteinAgain.artifacts[0].path);
    assertByteEqual(proteinBytes, proteinAgainBytes, `${task.id}: export_protein_fasta`);

    const summary = buildMrnaSummary(task, { open, construct, validate, protein, artifactHash: sha256Buffer(proteinBytes) });
    return taskRunResult(task, summary, {
      observations: normalizeMrnaObservations({ open, construct, validate, protein }),
      artifacts: [{ relativePath: "artifacts/protein.fa", bytes: proteinBytes }],
    });
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

function buildDigestSummary(task, result) {
  const observedFragments = Object.fromEntries(task.moleculeIds.map((moleculeId) => [
    moleculeId,
    digestFragmentSizes(result.digests[moleculeId]),
  ]));
  const checks = [
    passCheck("workspace_validation_ok", result.validate.data.valid, true),
    passCheck("selected_enzyme_pair", task.expectedChecks.selectedPair, ["HindIII", "XhoI"]),
    passCheck("digest_fragments", observedFragments, task.expectedChecks.fragments),
  ];
  return {
    taskId: task.id,
    ok: true,
    workspace: {
      finalRevision: result.reverseOpen.revision,
      moleculeIds: task.moleculeIds,
    },
    checks,
    artifacts: [{
      id: "diagnostic_digest_gel",
      kind: "gel",
      path: "artifacts/digest-gel.svg",
      sha256: result.artifactHash,
      mimeType: "image/svg+xml",
    }],
  };
}

function buildAssemblySummary(task, result) {
  const candidate = result.assembly.data.candidates[0];
  const regeneratedSites = candidate.junctions
    .map((junction) => junction.regeneratedRecognitionSequence)
    .filter((value) => typeof value === "string");
  const checks = [
    passCheck("workspace_validation_ok", result.validate.data.valid, true),
    passCheck("candidate_count", result.assembly.data.candidates.length, 1),
    passCheck("product_length", candidate.length, task.expectedChecks.productLength),
    passCheck("candidate_orientation", candidate.orientation, "forward"),
    passCheck("regenerated_recognition_sites", regeneratedSites, task.expectedChecks.regeneratedSites),
    passCheck("workspace_not_mutated_by_simulation", result.assembly.revision, result.insertOpen.revision),
  ];
  return {
    taskId: task.id,
    ok: true,
    workspace: {
      finalRevision: result.insertOpen.revision,
      moleculeIds: task.moleculeIds,
    },
    checks,
    artifacts: [{
      id: "restriction_ligation_product",
      kind: "genbank",
      path: "artifacts/assembly-product.gb",
      sha256: result.artifactHash,
      mimeType: "chemical/x-genbank",
    }],
  };
}

function buildCrisprSummary(task, result) {
  const candidate = result.design.data.candidates[0];
  const checks = [
    passCheck("workspace_validation_ok", result.validate.data.valid, true),
    passCheck("candidate_count", result.design.data.candidates.length, 1),
    passCheck("selected_guide_sequence", candidate.sequence, task.expectedChecks.guide.sequence),
    passCheck("selected_guide_coordinates", {
      start: candidate.start,
      end: candidate.end,
      pamStart: candidate.pamStart,
      pamEnd: candidate.pamEnd,
    }, {
      start: task.expectedChecks.guide.start,
      end: task.expectedChecks.guide.end,
      pamStart: task.expectedChecks.guide.pamStart,
      pamEnd: task.expectedChecks.guide.pamEnd,
    }),
    passCheck("guide_upsert_revision", result.upsert.revision, task.expectedChecks.finalRevision),
    passCheck("cr1_omits_efficacy_score", candidate.rankingEvidence.efficacyScoreIncluded, false),
    passCheck("report_omits_detailed_off_target_hits", result.report.data.reportsDetailedOffTargetHits, false),
  ];
  return {
    taskId: task.id,
    ok: true,
    workspace: {
      finalRevision: result.upsert.revision,
      moleculeIds: [task.moleculeId],
    },
    checks,
    artifacts: [{
      id: "selected_grna_report",
      kind: "markdown",
      path: "artifacts/grna-report.md",
      sha256: result.artifactHash,
      mimeType: "text/markdown",
    }],
  };
}

function buildMrnaSummary(task, result) {
  const checks = [
    passCheck("workspace_validation_ok", result.validate.data.valid, true),
    passCheck("mrna_construct_summary", result.construct.data.summary, task.expectedChecks.validationSummary),
    passCheck("mrna_construct_fail_count", result.construct.data.failCount, 0),
    passCheck("mrna_construct_warning_count", result.construct.data.warningCount, 0),
    passCheck("protein_amino_acids", result.protein.data.aminoAcids, task.expectedChecks.aminoAcids),
    passCheck("protein_length_stop_trimmed", {
      proteinLength: result.protein.data.proteinLength,
      stopTrimmed: result.protein.data.stopTrimmed,
    }, {
      proteinLength: task.expectedChecks.proteinLength,
      stopTrimmed: task.expectedChecks.stopTrimmed,
    }),
  ];
  return {
    taskId: task.id,
    ok: true,
    workspace: {
      finalRevision: result.open.revision,
      moleculeIds: [task.moleculeId],
    },
    checks,
    artifacts: [{
      id: "translated_protein_fasta",
      kind: "protein_fasta",
      path: "artifacts/protein.fa",
      sha256: result.artifactHash,
      mimeType: "text/x-fasta",
    }],
  };
}

async function writeTaskFiles(task, generated) {
  const root = path.join(taskRoot, task.id);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "inputs"), { recursive: true });
  await fs.mkdir(path.join(root, "expected"), { recursive: true });
  await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
  for (const input of await taskInputFiles(task)) {
    await fs.writeFile(path.join(root, "inputs", input.fileName), input.content, "utf8");
  }
  await writeJson(path.join(root, "task.json"), generated.taskManifest);
  await writeJson(path.join(root, "expected", "summary.json"), generated.summary);
  await writeJson(path.join(root, "expected", "tool-observations.json"), generated.observations);
  await writeJson(path.join(root, "expected", "artifacts.json"), generated.artifactsManifest);
  for (const artifact of generated.artifacts) {
    await fs.writeFile(path.join(root, artifact.relativePath), artifact.bytes);
  }
}

async function taskManifest(task) {
  const inputs = await taskInputFiles(task);
  return {
    schema: "datalox.molecule.eval-task",
    version: "0.1.0",
    id: task.id,
    title: task.title,
    category: task.category,
    objective: objectiveForTask(task),
    constraints: [
      "Use public MCP tools only.",
      "Do not patch molecule.workspace.json directly.",
      "Call validate_workspace with checkSequenceDigests=true after edit_sequence.",
      "Do not infer amino-acid consequences from edit_sequence alone.",
    ],
    inputs: inputs.map((input) => ({
      id: input.id,
      path: `inputs/${input.fileName}`,
      kind: input.kind,
      sha256: sha256String(input.content),
      source: input.source,
    })),
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
    caveats: caveatsForTask(task),
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

async function taskRunResult(task, summary, options) {
  return {
    requiredTools: requiredToolsForTask(task),
    taskManifest: await taskManifest(task),
    summary,
    artifactsManifest: {
      taskId: task.id,
      artifacts: summary.artifacts,
    },
    observations: options.observations,
    artifacts: options.artifacts,
  };
}

async function stageTaskInputs(task, workspaceDir) {
  const staged = new Map();
  for (const input of await taskInputFiles(task)) {
    const stagedPath = path.join(workspaceDir, "imports", input.fileName);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.writeFile(stagedPath, input.content, "utf8");
    staged.set(input.fileName, stagedPath);
  }
  return staged;
}

async function taskInputFiles(task) {
  if (task.id === "mb-edit-puc19-mcs-insert") {
    return [{
      id: "puc19",
      fileName: task.inputFileName,
      kind: "genbank",
      content: await inputContentForTask(task),
      source: "Repo fixture copied from fixtures/genbank/puc19.gb.",
    }];
  }
  if (task.id === "mb-edit-puc19-laczalpha-frameshift") {
    return [{
      id: "puc19_laczalpha_cds",
      fileName: task.inputFileName,
      kind: "genbank",
      content: await inputContentForTask(task),
      source: "Derived from fixtures/genbank/puc19.gb by adding benchmark-only lacZalpha_frame_proxy CDS; sequence is unchanged.",
    }];
  }
  if (task.id === "mb-digest-puc19-hindiii-xhoi") {
    const pUC19 = await fs.readFile(path.join(repoRoot, "fixtures", "genbank", "puc19.gb"), "utf8");
    const vector = extractGenbankOriginSequence(pUC19);
    const insert = await readFastaSequence(path.join(repoRoot, "fixtures", "fasta", "datalox_insert_v1.fa"));
    const forwardSequence = `${vector.slice(0, 396)}${insert}${vector.slice(417)}`;
    const reverseSequence = `${vector.slice(0, 396)}${reverseComplement(insert)}${vector.slice(417)}`;
    return [
      { id: "puc19_empty", fileName: "puc19-empty.gb", kind: "genbank", content: pUC19, source: "Repo fixture copied from fixtures/genbank/puc19.gb." },
      { id: "puc19_forward", fileName: "puc19-forward.gb", kind: "genbank", content: formatCircularGenBank("mol_forward", "pUC19 payload forward orientation-control construct", forwardSequence), source: "Generated from authentic pUC19 plus fixtures/fasta/datalox_insert_v1.fa in forward orientation." },
      { id: "puc19_reverse", fileName: "puc19-reverse.gb", kind: "genbank", content: formatCircularGenBank("mol_reverse", "pUC19 payload reverse orientation-control construct", reverseSequence), source: "Generated from authentic pUC19 plus reverse-complemented fixtures/fasta/datalox_insert_v1.fa." },
    ];
  }
  if (task.id === "mb-assembly-restriction-ligation") {
    return [
      {
        id: "eval_vector",
        fileName: "eval-vector.gb",
        kind: "genbank",
        content: formatCircularGenBank("mol_vector_eval", "EcoRI BamHI evaluation vector", "AAAA" + "GAATTC" + "CCCCCCCCCCCCCC" + "GGATCC" + "TTTTTTTTTTTTTTTTTTTT"),
        source: "Synthetic circular vector with unique EcoRI and BamHI sites; matches W3 restriction-ligation test geometry.",
      },
      {
        id: "eval_insert",
        fileName: "eval-insert.fa",
        kind: "fasta",
        content: ">mol_insert_eval\nAAAAGAATTCGGGGGGGGGGGGGGGGATCCAAAA\n",
        source: "Synthetic linear insert with unique EcoRI and BamHI sites; matches W3 restriction-ligation test geometry.",
      },
    ];
  }
  if (task.id === "mb-crispr-puc19-ngg") {
    return [{
      id: "crispr_source",
      fileName: "crispr-source.fa",
      kind: "fasta",
      content: ">mol_crispr_eval\nACGTACGTACGTACGTACGTAGGAAAA\n",
      source: "Synthetic local SpCas9 NGG target with one passing plus-strand guide.",
    }];
  }
  if (task.id === "mb-mrna-il27-validation") {
    return [{
      id: "il27_proxy_mrna",
      fileName: "il27-proxy-mrna.fa",
      kind: "fasta",
      content: `>${task.moleculeId}\n${validMrnaSequence()}\n`,
      source: "Synthetic minimal mRNA proxy with ordered 5'UTR, CDS, 3'UTR, Kozak context, stop codon, and polyA signal.",
    }];
  }
  throw new Error(`No task inputs defined for ${task.id}`);
}

function requiredToolsForTask(task) {
  if (task.id === "mb-edit-puc19-mcs-insert") {
    return ["open_sequence", "edit_sequence", "validate_workspace", "get_sequence_context", "find_restriction_sites", "render_plasmid_map"];
  }
  if (task.id === "mb-edit-puc19-laczalpha-frameshift") {
    return ["open_sequence", "translate_region", "edit_sequence", "validate_workspace", "get_sequence_context", "render_plasmid_map"];
  }
  if (task.id === "mb-digest-puc19-hindiii-xhoi") {
    return ["open_sequence", "simulate_digest", "validate_workspace", "render_digest_gel"];
  }
  if (task.id === "mb-assembly-restriction-ligation") {
    return ["open_sequence", "simulate_assembly", "validate_workspace"];
  }
  if (task.id === "mb-crispr-puc19-ngg") {
    return ["open_sequence", "design_grnas", "upsert_grna", "validate_workspace", "export_grna_report"];
  }
  if (task.id === "mb-mrna-il27-validation") {
    return ["open_sequence", "validate_mrna_construct", "validate_workspace", "export_protein_fasta"];
  }
  throw new Error(`No required tools defined for ${task.id}`);
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
    simulate_digest: "Compute deterministic restriction digest fragments.",
    render_digest_gel: "Render byte-stable digest gel artifact.",
    simulate_assembly: "Simulate deterministic restriction-ligation candidates.",
    design_grnas: "Scan deterministic local SpCas9 NGG guide candidates.",
    upsert_grna: "Persist the selected guide through revision-safe workspace write.",
    export_grna_report: "Export byte-stable selected guide report artifact.",
    validate_mrna_construct: "Validate ordered mRNA construct elements and CDS integrity.",
    export_protein_fasta: "Export translated protein FASTA artifact.",
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

function digestFragmentSizes(envelope) {
  return envelope.data.fragments.map((fragment) => fragment.size).sort((left, right) => left - right);
}

function digestLaneLabel(moleculeId) {
  const labels = {
    mol_empty: "Empty vector",
    mol_forward: "Forward orientation",
    mol_reverse: "Reverse orientation",
  };
  return labels[moleculeId] ?? moleculeId;
}

function guideRecordFromCandidate(moleculeId, expected, candidate) {
  return {
    id: expected.id,
    moleculeId,
    name: "selected guide 1",
    sequence: candidate.sequence,
    pam: candidate.pam,
    strand: candidate.strand,
    start: candidate.start,
    end: candidate.end,
    pamStart: candidate.pamStart,
    pamEnd: candidate.pamEnd,
    pamType: "SpCas9",
    gcPercent: candidate.gcPercent,
    seedRegionMaxHomopolymer: candidate.seedRegionMaxHomopolymer,
    offTargetScope: "workspace_molecules_only",
    offTargetHitCount: candidate.offTargets.length,
    rankingEvidence: candidate.rankingEvidence,
    sourceTool: "design_grnas",
  };
}

function objectiveForTask(task) {
  const objectives = {
    "mb-edit-puc19-mcs-insert": "Import authentic pUC19, insert a NotI payload after EcoRI in the MCS, validate the workspace, and render the edited plasmid map.",
    "mb-edit-puc19-laczalpha-frameshift": "Import pUC19 with a benchmark-only lacZalpha CDS proxy, insert the same NotI payload, and verify the proxy frameshift is reported.",
    "mb-digest-puc19-hindiii-xhoi": "Import empty, forward, and reverse pUC19 diagnostic constructs; simulate HindIII+XhoI digests; render one multi-lane gel artifact.",
    "mb-assembly-restriction-ligation": "Import a synthetic EcoRI/BamHI vector and insert, simulate directional restriction ligation, and verify the GenBank product artifact.",
    "mb-crispr-puc19-ngg": "Import a local SpCas9 NGG target, design guides, persist one selected guide, validate the workspace, and export a guide report.",
    "mb-mrna-il27-validation": "Import a minimal mRNA proxy, validate ordered mRNA elements and CDS integrity, then export the translated protein FASTA.",
  };
  return objectives[task.id] ?? task.title;
}

function caveatsForTask(task) {
  const caveats = {
    "mb-edit-puc19-mcs-insert": ["The authentic fixture annotates lacZalpha as a non-CDS gene feature, so this task only asserts bla CDS frame preservation."],
    "mb-edit-puc19-laczalpha-frameshift": ["lacZalpha_frame_proxy is a benchmark-only CDS annotation and is not claimed as the authentic NCBI feature model."],
    "mb-digest-puc19-hindiii-xhoi": ["Forward and reverse construct inputs are deterministic task fixtures generated from authentic pUC19 plus fixtures/fasta/datalox_insert_v1.fa."],
    "mb-assembly-restriction-ligation": ["This task tests shipped restriction-ligation simulation only; Gibson and Golden Gate are not in v0 scope."],
    "mb-crispr-puc19-ngg": ["CR1 reports filter-based guide ranking only; no validated Azimuth/Doench efficacy score is included."],
    "mb-mrna-il27-validation": ["The sequence is a minimal synthetic mRNA proxy for construct-validation behavior, not a therapeutic IL-27 design."],
  };
  return caveats[task.id] ?? [];
}

function extractGenbankOriginSequence(content) {
  const lines = content.split(/\r?\n/);
  const originIndex = lines.findIndex((line) => line.startsWith("ORIGIN"));
  const endIndex = lines.findIndex((line, index) => index > originIndex && line.startsWith("//"));
  if (originIndex === -1 || endIndex === -1) throw new Error("GenBank input does not contain ORIGIN section");
  return lines.slice(originIndex + 1, endIndex)
    .map((line) => line.replace(/[^A-Za-z]/g, ""))
    .join("")
    .toUpperCase();
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
  const insertFeature = sequence.length >= 1096
    ? `     misc_feature    397..1096
                     /label="datalox_insert_v1"
`
    : "";
  return `LOCUS       ${name.padEnd(14).slice(0, 14)} ${String(sequence.length).padStart(7)} bp    DNA    circular 01-JAN-2026
DEFINITION  ${description}.
FEATURES             Location/Qualifiers
     source          1..${sequence.length}
                     /organism="synthetic construct"
${insertFeature}
ORIGIN
${origin}
//
`;
}

function validMrnaSequence() {
  return "TTTTTTTACCATGGCCGCCGCCTAAGGAATAAAGGGGGGG";
}

function mrnaElements() {
  return [
    { type: "five_utr", coordinates: { start: 1, end: 10 } },
    { type: "cds", coordinates: { start: 11, end: 25 } },
    { type: "three_utr", coordinates: { start: 26, end: 40 } },
  ];
}

function assertByteEqual(left, right, label) {
  if (!left.equals(right)) {
    throw new Error(`${label} is not byte-deterministic`);
  }
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

function normalizeDigestObservations(observations) {
  return {
    open_sequence: {
      mol_empty: normalizeOpen(observations.emptyOpen),
      mol_forward: normalizeOpen(observations.forwardOpen),
      mol_reverse: normalizeOpen(observations.reverseOpen),
    },
    simulate_digest: Object.fromEntries(Object.entries(observations.digests).map(([moleculeId, envelope]) => [
      moleculeId,
      {
        ok: envelope.ok,
        tool: envelope.tool,
        fragments: digestFragmentSizes(envelope),
        enzymes: envelope.data.enzymes,
        topology: envelope.data.topology,
      },
    ])),
    validate_workspace: normalizeWorkspaceValidation(observations.validate),
    render_digest_gel: {
      ok: observations.gel.ok,
      tool: observations.gel.tool,
      laneCount: observations.gel.data.laneCount,
      ladder: observations.gel.data.ladder,
      sampleBands: observations.gel.data.bands
        .filter((band) => !band.isLadder)
        .map((band) => ({ laneLabel: band.laneLabel, size: band.size, y: band.y, outOfLadderRange: band.outOfLadderRange })),
      artifactKind: observations.gel.artifacts?.[0]?.kind,
    },
  };
}

function normalizeAssemblyObservations(observations) {
  const candidate = observations.assembly.data.candidates[0];
  return {
    open_sequence: {
      vector: normalizeOpen(observations.vectorOpen),
      insert: normalizeOpen(observations.insertOpen),
    },
    simulate_assembly: {
      ok: observations.assembly.ok,
      tool: observations.assembly.tool,
      revision: observations.assembly.revision,
      candidateCount: observations.assembly.data.candidates.length,
      candidate: {
        candidateId: candidate.candidateId,
        name: candidate.name,
        topology: candidate.topology,
        length: candidate.length,
        orientation: candidate.orientation,
        junctions: candidate.junctions.map((junction) => ({
          endType: junction.endType,
          overhangSequence: junction.overhangSequence,
          regeneratedRecognitionSequence: junction.regeneratedRecognitionSequence ?? null,
        })),
      },
      artifactKind: observations.assembly.artifacts?.[0]?.kind,
    },
    validate_workspace: normalizeWorkspaceValidation(observations.validate),
  };
}

function normalizeCrisprObservations(observations) {
  const candidate = observations.design.data.candidates[0];
  return {
    open_sequence: normalizeOpen(observations.open),
    design_grnas: {
      ok: observations.design.ok,
      tool: observations.design.tool,
      candidateCount: observations.design.data.candidates.length,
      candidate: {
        sequence: candidate.sequence,
        pam: candidate.pam,
        strand: candidate.strand,
        start: candidate.start,
        end: candidate.end,
        pamStart: candidate.pamStart,
        pamEnd: candidate.pamEnd,
        gcPercent: candidate.gcPercent,
        passingFilters: candidate.passingFilters,
        filterFailures: candidate.filterFailures,
        rankingEvidence: candidate.rankingEvidence,
      },
    },
    upsert_grna: {
      ok: observations.upsert.ok,
      tool: observations.upsert.tool,
      revision: observations.upsert.revision,
      guideId: observations.upsert.data.guideId,
      action: observations.upsert.data.action,
    },
    validate_workspace: normalizeWorkspaceValidation(observations.validate),
    export_grna_report: {
      ok: observations.report.ok,
      tool: observations.report.tool,
      guideIds: observations.report.data.guideIds,
      reportedGuideCount: observations.report.data.reportedGuideCount,
      reportsDetailedOffTargetHits: observations.report.data.reportsDetailedOffTargetHits,
      artifactKind: observations.report.artifacts?.[0]?.kind,
    },
  };
}

function normalizeMrnaObservations(observations) {
  return {
    open_sequence: normalizeOpen(observations.open),
    validate_mrna_construct: {
      ok: observations.construct.ok,
      tool: observations.construct.tool,
      summary: observations.construct.data.summary,
      failCount: observations.construct.data.failCount,
      warningCount: observations.construct.data.warningCount,
      checks: observations.construct.data.checks.map((check) => ({
        checkId: check.checkId,
        status: check.status,
        element: check.element ?? null,
      })),
    },
    validate_workspace: normalizeWorkspaceValidation(observations.validate),
    export_protein_fasta: {
      ok: observations.protein.ok,
      tool: observations.protein.tool,
      proteinId: observations.protein.data.proteinId,
      aminoAcids: observations.protein.data.aminoAcids,
      proteinLength: observations.protein.data.proteinLength,
      stopTrimmed: observations.protein.data.stopTrimmed,
      artifactKind: observations.protein.artifacts?.[0]?.kind,
    },
  };
}

function normalizeOpen(envelope) {
  return {
    ok: envelope.ok,
    tool: envelope.tool,
    revision: envelope.revision,
    moleculeIds: envelope.data.moleculeIds,
  };
}

function normalizeWorkspaceValidation(envelope) {
  return {
    ok: envelope.ok,
    tool: envelope.tool,
    revision: envelope.revision,
    validationOk: envelope.data.valid,
    issueCount: envelope.data.issues.length,
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
