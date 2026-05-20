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

const fixturesRoot = path.resolve("fixtures");

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-tools-"));
}

describe("tool handlers and CLI parity", () => {
  it("matches direct handler output for a CLI command", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const open = await handleOpenSequence({
      inputPath: path.join(fixturesRoot, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
    });
    expect(open.ok).toBe(true);

    const direct = await handleListMolecules({ workspaceDir });
    const cli = await runCli(["list-molecules", path.join(workspaceDir, "molecule.workspace.json")]);

    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout) as ToolResultEnvelope).toEqual(direct);
  });

  it("runs open-sequence -> validate -> list-molecules -> context through handlers", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const open = await handleOpenSequence({
      inputPath: path.join(fixturesRoot, "fasta/single.fa"),
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
      inputPath: path.join(fixturesRoot, "fasta/single.fa"),
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
});
