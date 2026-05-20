import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { importSequenceFile, MoleculeError, parseFasta, readWorkspace, sequenceDigest } from "../src/index.js";

const fixturesRoot = path.resolve("fixtures");

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-import-"));
}

describe("sequence import", () => {
  it("keeps FASTA sequence digests stable across line wrapping", () => {
    const [wrapped] = parseFasta(">same\nACGT\nACGT\n");
    const [unwrapped] = parseFasta(">same\nACGTACGT\n");

    expect(sequenceDigest(wrapped.sequence)).toBe(sequenceDigest(unwrapped.sequence));
  });

  it("rejects empty FASTA records", () => {
    expect(() => parseFasta(">empty\n")).toThrow(MoleculeError);
  });

  it("imports a single FASTA record as one molecule", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
    });
    const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });

    expect(result.ok).toBe(true);
    expect(result.revision).toBe(0);
    expect(workspace.molecules).toHaveLength(1);
    expect(workspace.molecules[0]).toMatchObject({
      name: "single plasmid",
      sourceFormat: "fasta",
      length: 15,
      sequenceDigest: sequenceDigest("ACGTRYSWKMBDHVN"),
    });
    await expect(fs.stat(path.join(workspaceDir, workspace.molecules[0].path))).resolves.toBeTruthy();
  });

  it("imports a multi-record FASTA as multiple molecules", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "fasta/multi.fa"),
      workspaceDir,
    });
    const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });

    expect(result.moleculeIds).toHaveLength(2);
    expect(workspace.molecules.map((molecule) => molecule.name)).toEqual(["alpha", "beta"]);
    expect(workspace.molecules.map((molecule) => molecule.sequenceDigest)).toEqual([
      sequenceDigest("ACGTACGT"),
      sequenceDigest("TTGGAACC"),
    ]);
  });

  it("requires expected revision when importing into an existing workspace", async () => {
    const workspaceDir = await tempWorkspaceDir();
    await importSequenceFile({
      inputPath: path.join(fixturesRoot, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
    });

    await expect(
      importSequenceFile({
        inputPath: path.join(fixturesRoot, "fasta/multi.fa"),
        workspaceDir,
        format: "fasta",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects stale expected revision on existing workspace import", async () => {
    const workspaceDir = await tempWorkspaceDir();
    await importSequenceFile({
      inputPath: path.join(fixturesRoot, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
    });

    await expect(
      importSequenceFile({
        inputPath: path.join(fixturesRoot, "fasta/multi.fa"),
        workspaceDir,
        format: "fasta",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  it("increments revision when importing into an existing workspace with expected revision", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const first = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
    });
    const second = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "fasta/multi.fa"),
      workspaceDir,
      format: "fasta",
      expectedRevision: first.revision,
    });
    const workspace = await readWorkspace(second.workspacePath, { checkSequenceDigests: true });

    expect(second.previousRevision).toBe(0);
    expect(second.revision).toBe(1);
    expect(workspace.molecules).toHaveLength(3);
  });

  it("rejects invalid FASTA symbols", async () => {
    const workspaceDir = await tempWorkspaceDir();

    await expect(
      importSequenceFile({
        inputPath: path.join(fixturesRoot, "fasta/invalid-symbol.fa"),
        workspaceDir,
      }),
    ).rejects.toMatchObject({ code: "ALPHABET_MISMATCH" });
  });

  it("imports a linear GenBank record with features and qualifiers", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "genbank/linear.gb"),
      workspaceDir,
    });
    const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });

    expect(workspace.molecules[0]).toMatchObject({
      name: "pLinear",
      sourceFormat: "genbank",
      topology: "linear",
      length: 30,
      description: "Linear test plasmid.",
    });
    expect(workspace.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moleculeId: workspace.molecules[0].id,
          name: "alpha",
          type: "gene",
          segments: [{ start: 1, end: 6, strand: "+" }],
          qualifiers: { gene: "alpha" },
        }),
        expect.objectContaining({
          name: "peptide",
          type: "CDS",
          segments: [{ start: 10, end: 18, strand: "+" }],
        }),
      ]),
    );
  });

  it("imports a circular GenBank record as circular", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "genbank/circular.gb"),
      workspaceDir,
    });
    const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });

    expect(workspace.molecules[0].topology).toBe("circular");
  });

  it("imports GenBank join coordinates as multiple ordered segments", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "genbank/join.gb"),
      workspaceDir,
    });
    const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });

    expect(workspace.features[0]).toMatchObject({
      name: "joined",
      segments: [
        { start: 1, end: 4, strand: "+" },
        { start: 10, end: 12, strand: "+" },
      ],
    });
  });

  it("imports reverse-complement GenBank features with reverse strand segments", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "genbank/reverse-complement.gb"),
      workspaceDir,
    });
    const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });

    expect(workspace.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "rev",
          segments: [{ start: 5, end: 12, strand: "-" }],
        }),
        expect.objectContaining({
          name: "rev_join",
          segments: [
            { start: 2, end: 4, strand: "-" },
            { start: 15, end: 18, strand: "-" },
          ],
        }),
      ]),
    );
  });

  it("rejects unsupported fuzzy GenBank coordinates with a structured parser error", async () => {
    const workspaceDir = await tempWorkspaceDir();

    await expect(
      importSequenceFile({
        inputPath: path.join(fixturesRoot, "genbank/fuzzy.gb"),
        workspaceDir,
      }),
    ).rejects.toBeInstanceOf(MoleculeError);
    await expect(
      importSequenceFile({
        inputPath: path.join(fixturesRoot, "genbank/fuzzy.gb"),
        workspaceDir,
      }),
    ).rejects.toMatchObject({
      code: "PARSE_ERROR",
      details: { location: "<1..10" },
    });
  });
});
