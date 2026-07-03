import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { designGrnas, scanSpCas9Guides } from "../src/core/crispr.js";
import { runCli } from "../src/cli/main.js";
import { handleDesignGrnas, importSequenceFile } from "../src/index.js";

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-crispr-"));
}

async function writeFasta(workspaceDir: string, filename: string, id: string, sequence: string): Promise<string> {
  const inputPath = path.join(workspaceDir, filename);
  await fs.writeFile(inputPath, `>${id}\n${sequence}\n`, "utf8");
  return inputPath;
}

describe("CR1 SpCas9 guide design", () => {
  it("pins plus-strand NGG guide coordinates and sequence", () => {
    const sequence = "ACGTACGTACGTACGTACGTAGGAAAAAACCATTTTCCCCAAAAGGGGTTTT";
    const guides = scanSpCas9Guides(sequence, { start: 1, end: 20 }, { strand: "+" });

    expect(guides).toHaveLength(1);
    expect(guides[0]).toMatchObject({
      sequence: "ACGTACGTACGTACGTACGT",
      pam: "AGG",
      strand: "+",
      start: 1,
      end: 20,
      pamStart: 21,
      pamEnd: 23,
      gcPercent: 50,
      seedRegionMaxHomopolymer: 1,
      passingFilters: true,
      filterFailures: [],
    });
  });

  it("pins minus-strand CCN guide coordinates and reverse-complement guide sequence", () => {
    const sequence = "ACGTACGTACGTACGTACGTAGGAAAAAACCATTTTCCCCAAAAGGGGTTTT";
    const guides = scanSpCas9Guides(sequence, { start: 33, end: 52 }, { strand: "-" });

    expect(guides).toHaveLength(1);
    expect(guides[0]).toMatchObject({
      sequence: "AAAACCCCTTTTGGGGAAAA",
      pam: "TGG",
      strand: "-",
      start: 33,
      end: 52,
      pamStart: 30,
      pamEnd: 32,
      gcPercent: 40,
      seedRegionMaxHomopolymer: 4,
      passingFilters: true,
      filterFailures: [],
    });
  });

  it("marks GC and seed homopolymer filter failures without inventing scores", () => {
    const lowGc = scanSpCas9Guides("AAAAAAAAAAAAAAAAAAAAAGG", { start: 1, end: 20 }, { gcRange: [40, 70] });
    expect(lowGc[0]).toMatchObject({
      gcPercent: 0,
      passingFilters: false,
      filterFailures: expect.arrayContaining(["GC_OUT_OF_RANGE", "SEED_HOMOPOLYMER_TOO_LONG"]),
    });
  });

  it("reports workspace-scale off-target hits and excludes the on-target site", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const sourcePath = await writeFasta(workspaceDir, "source.fa", "source", "ACGTACGTACGTACGTACGTAGGAAAA");
    const offTargetPath = await writeFasta(workspaceDir, "offtarget.fa", "offtarget", "TTTTACGTACGTACGTACGTTCATAGGTTTT");

    const sourceImport = await importSequenceFile({
      inputPath: sourcePath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_source",
    });
    await importSequenceFile({
      inputPath: offTargetPath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_offtarget",
      expectedRevision: sourceImport.revision,
    });

    const result = await designGrnas({
      workspacePath: sourceImport.workspacePath,
      moleculeId: "mol_source",
      targetRegion: { start: 1, end: 20 },
      options: {
        offTargetMoleculeIds: ["mol_source", "mol_offtarget"],
        maxOffTargetMismatches: 2,
      },
    });

    expect(result).toMatchObject({
      moleculeId: "mol_source",
      pamType: "SpCas9",
      offTargetScope: "workspace_molecules_only",
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].offTargets).toEqual([
      {
        moleculeId: "mol_offtarget",
        start: 5,
        end: 24,
        strand: "+",
        pam: "AGG",
        mismatches: 2,
        seedMismatches: 2,
      },
    ]);
  });

  it("returns CR1 candidates through the tool handler", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const sourcePath = await writeFasta(workspaceDir, "source.fa", "source", "ACGTACGTACGTACGTACGTAGGAAAA");
    const sourceImport = await importSequenceFile({
      inputPath: sourcePath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_source",
    });

    const result = await handleDesignGrnas({
      workspacePath: sourceImport.workspacePath,
      moleculeId: "mol_source",
      targetRegion: { start: 1, end: 20 },
    });

    expect(result).toMatchObject({
      ok: true,
      tool: "design_grnas",
      data: {
        workspacePath: sourceImport.workspacePath,
        moleculeId: "mol_source",
        offTargetScope: "workspace_molecules_only",
        candidates: [
          expect.objectContaining({
            sequence: "ACGTACGTACGTACGTACGT",
            pam: "AGG",
          }),
        ],
      },
    });
  });

  it("runs design-grnas through the CLI", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const sourcePath = await writeFasta(workspaceDir, "source.fa", "source", "ACGTACGTACGTACGTACGTAGGAAAA");
    const sourceImport = await importSequenceFile({
      inputPath: sourcePath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_source",
    });

    const result = await runCli([
      "design-grnas",
      sourceImport.workspacePath,
      "--molecule-id",
      "mol_source",
      "--target-start",
      "1",
      "--target-end",
      "20",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      tool: "design_grnas",
      data: {
        candidates: [expect.objectContaining({ pam: "AGG", strand: "+" })],
      },
    });
  });

  it("rejects unsupported CR1 options and wraparound target regions", () => {
    expect(() => scanSpCas9Guides("ACGTACGTACGTACGTACGTAGG", { start: 20, end: 1 })).toThrow("targetRegion coordinates are invalid.");
  });
});
