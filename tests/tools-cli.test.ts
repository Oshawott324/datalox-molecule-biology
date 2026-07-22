import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/main.js";
import {
  handleGetSequenceContext,
  handleListMolecules,
  handleOpenSequence,
  handleValidateWorkspace,
  type ToolResultEnvelope,
} from "../src/index.js";
import { stageFixture } from "./support/fixtures.js";

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-tools-"));
}

describe("tool handlers and CLI parity", () => {
  it("reports optional dependency status through doctor", async () => {
    const cli = await runCli(["doctor"]);
    const envelope = JSON.parse(cli.stdout) as ToolResultEnvelope;

    expect(cli.exitCode).toBe(0);
    expect(envelope).toMatchObject({
      ok: true,
      tool: "doctor",
      data: {
        package: "@datalox/molecule-biology",
        runtime: {
          nodeVersion: expect.stringMatching(/^v\d+/),
          platform: expect.any(String),
          arch: expect.any(String),
          cwd: expect.any(String),
        },
        optionalDependencies: {
          primer3_core: {
            name: "primer3_core",
            command: "primer3_core",
            requiredFor: ["design_primers"],
            available: expect.any(Boolean),
            install: {
              macos: "brew install primer3",
              linux: "sudo apt-get install primer3",
              windows: expect.stringContaining("WSL or Docker"),
            },
          },
        },
      },
    });
  });

  it("matches direct handler output for a CLI command", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const open = await handleOpenSequence({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
    });
    expect(open.ok).toBe(true);

    const direct = await handleListMolecules({ workspaceDir });
    const cli = await runCli(["list-molecules", path.join(workspaceDir, "molecule.workspace.json")]);

    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout) as ToolResultEnvelope).toEqual(direct);
  });

  it("runs edit-sequence through the CLI", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const open = await handleOpenSequence({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_single",
    });
    expect(open.ok).toBe(true);

    const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
    const cli = await runCli([
      "edit-sequence",
      "--workspace-path",
      workspacePath,
      "--molecule-id",
      "mol_single",
      "--expected-revision",
      "0",
      "--operation",
      "insert",
      "--start",
      "5",
      "--sequence",
      "TT",
    ]);

    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout) as ToolResultEnvelope).toMatchObject({
      ok: true,
      tool: "edit_sequence",
      data: {
        moleculeId: "mol_single",
        delta: 2,
      },
      nextAction: {
        tool: "validate_workspace",
      },
    });
  });

  it("runs open-sequence -> validate -> list-molecules -> context through handlers", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const open = await handleOpenSequence({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_single",
    });
    expect(open).toMatchObject({ ok: true, tool: "open_sequence" });

    const validate = await handleValidateWorkspace({ workspaceDir });
    expect(validate).toMatchObject({
      ok: true,
      tool: "validate_workspace",
      agentContract: {
        version: 1,
        forbiddenActions: expect.arrayContaining(["do_not_patch_workspace_json_directly"]),
      },
      data: {
        workspacePath: path.join(workspaceDir, "molecule.workspace.json"),
        valid: true,
        issues: [],
      },
    });

    const listed = await handleListMolecules({ workspaceDir });
    expect(listed).toMatchObject({
      ok: true,
      data: {
        revision: 0,
        molecules: [expect.objectContaining({ id: "mol_single", length: 15 })],
      },
    });

    const context = await handleGetSequenceContext({
      workspaceDir,
      moleculeId: "mol_single",
      start: 1,
      end: 4,
      strand: "+",
      includeSequence: true,
    });
    expect(context).toMatchObject({
      ok: true,
      tool: "get_sequence_context",
      data: {
        molecule: expect.objectContaining({ id: "mol_single" }),
        region: { start: 1, end: 4, strand: "+", length: 4 },
        sequence: "ACGT",
      },
    });
  });

  it("returns a nonzero CLI result for ok:false envelopes", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const cli = await runCli(["validate", path.join(workspaceDir, "molecule.workspace.json")]);

    expect(cli.exitCode).toBe(1);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      ok: false,
      tool: "validate_workspace",
      error: { code: "FILE_NOT_FOUND" },
    });
  });

  it("runs revision-safe feature writes through the CLI", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const open = await handleOpenSequence({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_single",
    });
    expect(open.ok).toBe(true);

    const featurePath = path.join(workspaceDir, "feature.json");
    await fs.writeFile(featurePath, JSON.stringify({
      id: "feat_cli",
      moleculeId: "mol_single",
      name: "cli feature",
      type: "misc_feature",
      segments: [{ start: 1, end: 4, strand: "+" }],
    }), "utf8");

    const cli = await runCli([
      "upsert-feature",
      path.join(workspaceDir, "molecule.workspace.json"),
      "--expected-revision",
      "0",
      "--feature",
      featurePath,
    ]);

    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      ok: true,
      tool: "upsert_feature",
      revision: 1,
      data: { featureId: "feat_cli", action: "created" },
      nextAction: { tool: "validate_workspace" },
    });
  });

  it("runs deterministic biology tools through the CLI", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const inputPath = path.join(workspaceDir, "enzyme.fa");
    await fs.writeFile(inputPath, ">enzyme\nAAAAGAATTCAAGCTTGGATCCAAAA\n", "utf8");
    const open = await handleOpenSequence({
      inputPath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_enzyme",
    });
    expect(open.ok).toBe(true);

    const sites = await runCli([
      "find-restriction-sites",
      path.join(workspaceDir, "molecule.workspace.json"),
      "--molecule",
      "mol_enzyme",
      "--enzymes",
      "EcoRI,BamHI",
    ]);
    const translated = await runCli([
      "translate-region",
      path.join(workspaceDir, "molecule.workspace.json"),
      "--molecule",
      "mol_enzyme",
      "--start",
      "1",
      "--end",
      "6",
    ]);

    expect(sites.exitCode).toBe(0);
    expect(JSON.parse(sites.stdout)).toMatchObject({
      ok: true,
      tool: "find_restriction_sites",
      data: {
        sites: [
          expect.objectContaining({ enzyme: "EcoRI" }),
          expect.objectContaining({ enzyme: "BamHI" }),
        ],
      },
    });
    expect(translated.exitCode).toBe(0);
    expect(JSON.parse(translated.stdout)).toMatchObject({
      ok: true,
      tool: "translate_region",
      data: { aminoAcids: "KR" },
    });
  });

  it("wires blast-sequence through the CLI without reaching NCBI for validation errors", async () => {
    const cli = await runCli([
      "blast-sequence",
      "--sequence",
      "ACGTACGTACGTACGTACGTACGTACGTAC",
      "--database",
      "nr",
      "--program",
      "blastn",
    ]);

    expect(cli.exitCode).toBe(1);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      ok: false,
      tool: "blast_sequence",
      error: {
        code: "INVALID_ARGUMENT",
        details: {
          database: "nr",
          program: "blastn",
        },
      },
    });
  });

  it("runs simulate-assembly through the CLI with a JSON input payload", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const vectorPath = path.join(workspaceDir, "vector.gb");
    const insertPath = path.join(workspaceDir, "insert.fa");
    await fs.writeFile(
      vectorPath,
      circularGenBank(
        "AAAA" + "GAATTC" + "CCCCCCCCCCCCCC" + "GGATCC" + "TTTTTTTTTTTTTTTTTTTT",
        "cli_vector",
      ),
      "utf8",
    );
    await fs.writeFile(
      insertPath,
      ">cli_insert\n" + "AAAA" + "GAATTC" + "GGGGGGGGGGGGGG" + "GGATCC" + "AAAA\n",
      "utf8",
    );
    const vectorOpen = await handleOpenSequence({
      inputPath: vectorPath,
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_cli_vector",
    });
    expect(vectorOpen.ok).toBe(true);
    const insertOpen = await handleOpenSequence({
      inputPath: insertPath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_cli_insert",
      expectedRevision: 0,
    });
    expect(insertOpen.ok).toBe(true);

    const payloadPath = path.join(workspaceDir, "simulate-assembly.json");
    await fs.writeFile(payloadPath, JSON.stringify({
      workspacePath: path.join(workspaceDir, "molecule.workspace.json"),
      method: "restriction_ligation",
      vector: { moleculeId: "mol_cli_vector", leftEnzyme: "EcoRI", rightEnzyme: "BamHI" },
      insert: {
        moleculeId: "mol_cli_insert",
        leftEnzyme: "EcoRI",
        rightEnzyme: "BamHI",
        orientation: "forward",
      },
      product: { moleculeId: "mol_cli_product", name: "cli_product" },
    }), "utf8");

    const cli = await runCli(["simulate-assembly", "--input", payloadPath]);
    const envelope = JSON.parse(cli.stdout) as ToolResultEnvelope;

    expect(cli.exitCode).toBe(0);
    expect(envelope).toMatchObject({
      ok: true,
      tool: "simulate_assembly",
      data: {
        candidates: [
          {
            candidateId: "candidate_forward",
            length: 50,
          },
        ],
      },
      artifacts: [expect.objectContaining({ kind: "genbank" })],
      nextAction: { tool: "open_sequence" },
    });
  });
});

function circularGenBank(sequence: string, name: string): string {
  return [
    `LOCUS       ${name.padEnd(12)} ${sequence.length} bp    DNA     circular SYN 03-JUL-2026`,
    `DEFINITION  ${name}.`,
    "FEATURES             Location/Qualifiers",
    "ORIGIN",
    `        1 ${sequence.toLowerCase()}`,
    "//",
    "",
  ].join("\n");
}
