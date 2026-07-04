import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { designGrnas, findWorkspaceOffTargets, normalizeGrnaOptions, scanSpCas9Guides } from "../src/core/crispr.js";
import type { GuideCandidate } from "../src/core/crispr.js";
import { runCli } from "../src/cli/main.js";
import { handleDesignGrnas, handleExportGrnaReport, handleUpsertGrna, importSequenceFile, readWorkspace } from "../src/index.js";
import type { GuideRecord } from "../src/index.js";

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-crispr-"));
}

async function writeFasta(workspaceDir: string, filename: string, id: string, sequence: string): Promise<string> {
  const inputPath = path.join(workspaceDir, filename);
  await fs.writeFile(inputPath, `>${id}\n${sequence}\n`, "utf8");
  return inputPath;
}

function testGuideCandidate(input: Omit<GuideCandidate, "rankingEvidence">): GuideCandidate {
  return {
    ...input,
    rankingEvidence: {
      passingFilters: input.passingFilters,
      filterFailures: [...input.filterFailures],
      offTargetHitCount: input.offTargets.length,
      gcDistanceFrom50: Math.round(Math.abs(input.gcPercent - 50) * 100) / 100,
      guideStart: input.start,
      strand: input.strand,
      efficacyScoreIncluded: false,
    },
  };
}

function guideRecordFromCandidate(moleculeId: string, candidate: GuideCandidate): GuideRecord {
  return {
    id: "grna_selected_1",
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
      rankingEvidence: {
        passingFilters: true,
        filterFailures: [],
        offTargetHitCount: 0,
        gcDistanceFrom50: 0,
        guideStart: 1,
        strand: "+",
        efficacyScoreIncluded: false,
      },
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
      nextAction: {
        tool: "upsert_grna",
        instruction: "Select a candidate, then call upsert_grna with expectedRevision to persist it.",
      },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].rankingEvidence).toMatchObject({
      passingFilters: true,
      filterFailures: [],
      offTargetHitCount: 1,
      gcDistanceFrom50: 0,
      guideStart: 1,
      strand: "+",
      efficacyScoreIncluded: false,
    });
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
        nextAction: {
          tool: "upsert_grna",
          instruction: "Select a candidate, then call upsert_grna with expectedRevision to persist it.",
        },
        candidates: [
          expect.objectContaining({
            sequence: "ACGTACGTACGTACGTACGT",
            pam: "AGG",
            rankingEvidence: expect.objectContaining({
              offTargetHitCount: 0,
              efficacyScoreIncluded: false,
            }),
          }),
        ],
      },
    });
  });

  it("persists a selected guide through upsert_grna after design_grnas", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const sourcePath = await writeFasta(workspaceDir, "source.fa", "source", "ACGTACGTACGTACGTACGTAGGAAAA");
    const sourceImport = await importSequenceFile({
      inputPath: sourcePath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_source",
    });
    const design = await designGrnas({
      workspacePath: sourceImport.workspacePath,
      moleculeId: "mol_source",
      targetRegion: { start: 1, end: 20 },
    });
    const guide = guideRecordFromCandidate("mol_source", design.candidates[0]);

    const upserted = await handleUpsertGrna({
      workspacePath: sourceImport.workspacePath,
      expectedRevision: 0,
      guide,
    });
    const workspace = await readWorkspace(sourceImport.workspacePath, { checkSequenceDigests: true });

    expect(upserted).toMatchObject({
      ok: true,
      tool: "upsert_grna",
      revision: 1,
      data: { guideId: guide.id, action: "created" },
      nextAction: { tool: "validate_workspace" },
    });
    expect(workspace.guides).toEqual([guide]);
  });

  it("exports a Markdown report for selected persisted guides", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const sourcePath = await writeFasta(workspaceDir, "source.fa", "source", "ACGTACGTACGTACGTACGTAGGAAAA");
    const sourceImport = await importSequenceFile({
      inputPath: sourcePath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_source",
    });
    const [candidate] = scanSpCas9Guides("ACGTACGTACGTACGTACGTAGGAAAA", { start: 1, end: 20 }, { strand: "+" });
    const guide = guideRecordFromCandidate("mol_source", candidate);
    await handleUpsertGrna({
      workspacePath: sourceImport.workspacePath,
      expectedRevision: 0,
      guide,
    });

    const report = await handleExportGrnaReport({
      workspacePath: sourceImport.workspacePath,
      guideIds: [guide.id],
      outputPath: "reports/guides/selected.md",
    });

    expect(report).toMatchObject({
      ok: true,
      tool: "export_grna_report",
      data: {
        guideIds: [guide.id],
        relativePath: path.join("reports", "guides", "selected.md"),
        mimeType: "text/markdown",
        reportsDetailedOffTargetHits: false,
      },
      artifacts: [
        {
          kind: "grna_report",
          mimeType: "text/markdown",
        },
      ],
      nextAction: { tool: "validate_workspace" },
    });
    if (!report.ok) throw new Error("expected export_grna_report success");
    const markdown = await fs.readFile(report.artifacts?.[0]?.path ?? "", "utf8");
    expect(markdown).toContain("# gRNA Report");
    expect(markdown).toContain("selected guide 1");
    expect(markdown).toContain("No validated on-target efficacy score is included");
    expect(markdown).toContain("Detailed off-target hit rows are not persisted");
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

  it("runs upsert-grna through the CLI", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const sourcePath = await writeFasta(workspaceDir, "source.fa", "source", "ACGTACGTACGTACGTACGTAGGAAAA");
    const sourceImport = await importSequenceFile({
      inputPath: sourcePath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_source",
    });
    const [candidate] = scanSpCas9Guides("ACGTACGTACGTACGTACGTAGGAAAA", { start: 1, end: 20 }, { strand: "+" });
    const guide = guideRecordFromCandidate("mol_source", candidate);
    const guidePath = path.join(workspaceDir, "guide.json");
    await fs.writeFile(guidePath, `${JSON.stringify(guide, null, 2)}\n`, "utf8");

    const result = await runCli([
      "upsert-grna",
      sourceImport.workspacePath,
      "--expected-revision",
      "0",
      "--guide",
      guidePath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      tool: "upsert_grna",
      data: { guideId: guide.id, action: "created" },
      revision: 1,
    });
  });

  it("runs export-grna-report through the CLI", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const sourcePath = await writeFasta(workspaceDir, "source.fa", "source", "ACGTACGTACGTACGTACGTAGGAAAA");
    const sourceImport = await importSequenceFile({
      inputPath: sourcePath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_source",
    });
    const [candidate] = scanSpCas9Guides("ACGTACGTACGTACGTACGTAGGAAAA", { start: 1, end: 20 }, { strand: "+" });
    const guide = guideRecordFromCandidate("mol_source", candidate);
    await handleUpsertGrna({
      workspacePath: sourceImport.workspacePath,
      expectedRevision: 0,
      guide,
    });

    const result = await runCli([
      "export-grna-report",
      sourceImport.workspacePath,
      "--guide-ids",
      guide.id,
      "--output",
      "reports/guides/cli-report.md",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      tool: "export_grna_report",
      data: {
        guideCount: 1,
        relativePath: path.join("reports", "guides", "cli-report.md"),
      },
    });
  });

  it("rejects unsupported CR1 options and wraparound target regions", () => {
    expect(() => scanSpCas9Guides("ACGTACGTACGTACGTACGTAGG", { start: 20, end: 1 })).toThrow("targetRegion coordinates are invalid.");
  });

  it("fails only SEED_HOMOPOLYMER_TOO_LONG when GC is in range but seed has a long run", () => {
    // Guide: GCGCGCGCAAAAAAAAAAAA — GC=40% (within default [20,80]); seed positions 8-19 = 12 A's (run > 4)
    const guides = scanSpCas9Guides("GCGCGCGCAAAAAAAAAAAAAGG", { start: 1, end: 20 });
    expect(guides).toHaveLength(1);
    expect(guides[0]).toMatchObject({
      gcPercent: 40,
      seedRegionMaxHomopolymer: 12,
      passingFilters: false,
      filterFailures: ["SEED_HOMOPOLYMER_TOO_LONG"],
    });
  });

  it("respects strand option: restricts results to plus or minus strand only", () => {
    // ACGTACGTACGTACGTACGTAGG has one NGG PAM (plus-strand only) and no valid minus-strand CCN
    const seq = "ACGTACGTACGTACGTACGTAGG";
    expect(scanSpCas9Guides(seq, { start: 1, end: 23 }, { strand: "+" })).toHaveLength(1);
    expect(scanSpCas9Guides(seq, { start: 1, end: 23 }, { strand: "-" })).toHaveLength(0);

    // CCAACGTACGTACGTACGTACGT has one CCN PAM (minus-strand only) and no valid plus-strand NGG
    const seqMinus = "CCAACGTACGTACGTACGTACGT";
    expect(scanSpCas9Guides(seqMinus, { start: 1, end: 23 }, { strand: "-" })).toHaveLength(1);
    expect(scanSpCas9Guides(seqMinus, { start: 1, end: 23 }, { strand: "+" })).toHaveLength(0);
  });

  it("excludes off-target hits exceeding maxOffTargetMismatches", () => {
    // off-target sequence: ACGTACGTACGTACGTTCATAGGTTTT has a plus-strand guide at positions 1-20
    // that differs from candidate at positions 16 (A→T) and 18 (G→A) = 2 mismatches
    const candidate = testGuideCandidate({
      sequence: "ACGTACGTACGTACGTACGT",
      pam: "AGG",
      strand: "+" as const,
      start: 1,
      end: 20,
      pamStart: 21,
      pamEnd: 23,
      gcPercent: 50,
      seedRegionMaxHomopolymer: 1,
      offTargets: [],
      passingFilters: true,
      filterFailures: [] as string[],
    });
    const refs = [{ moleculeId: "mol_other", sequence: "ACGTACGTACGTACGTTCATAGGTTTT" }];

    const hitsStrict = findWorkspaceOffTargets(candidate, refs, {
      sourceMoleculeId: "mol_source",
      maxMismatches: 1,
    });
    const hitsPermissive = findWorkspaceOffTargets(candidate, refs, {
      sourceMoleculeId: "mol_source",
      maxMismatches: 2,
    });

    expect(hitsStrict).toHaveLength(0);
    expect(hitsPermissive).toHaveLength(1);
    expect(hitsPermissive[0]).toMatchObject({ moleculeId: "mol_other", mismatches: 2, seedMismatches: 2 });
  });

  it("reports an exact same-molecule duplicate guide as an off-target when it is not the designed locus", () => {
    const sequence = "ACGTACGTACGTACGTACGTAGGAAAAACGTACGTACGTACGTACGTAGG";
    const [candidate] = scanSpCas9Guides(sequence, { start: 1, end: 20 }, { strand: "+" });

    const hits = findWorkspaceOffTargets(candidate, [{ moleculeId: "mol_source", sequence }], {
      sourceMoleculeId: "mol_source",
      maxMismatches: 0,
    });

    expect(hits).toEqual([
      {
        moleculeId: "mol_source",
        start: 28,
        end: 47,
        strand: "+",
        pam: "AGG",
        mismatches: 0,
        seedMismatches: 0,
      },
    ]);
  });

  it("ignores near-matches that do not have a compatible SpCas9 PAM", () => {
    const candidate = testGuideCandidate({
      sequence: "ACGTACGTACGTACGTACGT",
      pam: "AGG",
      strand: "+" as const,
      start: 1,
      end: 20,
      pamStart: 21,
      pamEnd: 23,
      gcPercent: 50,
      seedRegionMaxHomopolymer: 1,
      offTargets: [],
      passingFilters: true,
      filterFailures: [] as string[],
    });
    const refs = [{ moleculeId: "mol_no_pam", sequence: "ACGTACGTACGTACGTACGTAAA" }];

    expect(findWorkspaceOffTargets(candidate, refs, {
      sourceMoleculeId: "mol_source",
      maxMismatches: 0,
    })).toEqual([]);
  });

  it("validates CR1 option boundaries explicitly", () => {
    expect(() => normalizeGrnaOptions({ pamType: "Cas12a" as "SpCas9" })).toThrow(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
    expect(() => normalizeGrnaOptions({ guideLength: 21 })).toThrow(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
    expect(() => normalizeGrnaOptions({ gcRange: [80, 20] })).toThrow(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
    expect(() => normalizeGrnaOptions({ maxSeedHomopolymerRun: 0 })).toThrow(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
    expect(() => normalizeGrnaOptions({ maxOffTargetMismatches: -1 })).toThrow(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
    expect(() => normalizeGrnaOptions({ offTargetMoleculeIds: [""] })).toThrow(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
  });

  it("rejects a targetRegion whose end exceeds molecule length", () => {
    // Molecule is 23 bp; end=24 is one base past the end.
    expect(() => scanSpCas9Guides("ACGTACGTACGTACGTACGTAGG", { start: 1, end: 24 })).toThrow(
      expect.objectContaining({ code: "COORDINATE_OUT_OF_RANGE" }),
    );
  });

  it("passes a guide whose GC is exactly at the lower boundary of the default range", () => {
    // Guide GGGGATATATATATATATAT: 4 G's out of 20 bases = 20.0% GC — exactly the default lower bound.
    // gcPercent < gcRange[0] uses strict less-than, so 20 < 20 is false → passingFilters.
    // Seed (positions 8-19): ATATATATATA T — max homopolymer run = 1, well under threshold.
    const guides = scanSpCas9Guides("GGGGATATATATATATATATAGG", { start: 1, end: 20 }, { strand: "+" });
    expect(guides).toHaveLength(1);
    expect(guides[0]).toMatchObject({
      gcPercent: 20,
      passingFilters: true,
      filterFailures: [],
    });
  });

  it("ranks passing candidates before failing candidates in designGrnas output", async () => {
    // Two plus-strand guides in one molecule:
    //   guide 1 (pos 1-20): ACGTACGTACGTACGTACGT — 50% GC, seed max run 1 → passes
    //   guide 2 (pos 24-43): AAAAAAAAAAAAAAAAAAAA — 0% GC, seed run 12 → fails both filters
    // rankGuideCandidates must place the passing guide first.
    const workspaceDir = await tempWorkspaceDir();
    const seq = "ACGTACGTACGTACGTACGTAGG" + "AAAAAAAAAAAAAAAAAAAA" + "TGG";
    const inputPath = await writeFasta(workspaceDir, "two_guides.fa", "two_guides", seq);
    const imported = await importSequenceFile({ inputPath, workspaceDir, format: "fasta", moleculeId: "mol_two_guides" });

    const result = await designGrnas({
      workspacePath: imported.workspacePath,
      moleculeId: "mol_two_guides",
      targetRegion: { start: 1, end: seq.length },
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      sequence: "ACGTACGTACGTACGTACGT",
      passingFilters: true,
      rankingEvidence: {
        passingFilters: true,
        filterFailures: [],
        offTargetHitCount: 0,
        gcDistanceFrom50: 0,
        guideStart: 1,
        strand: "+",
        efficacyScoreIncluded: false,
      },
    });
    expect(result.candidates[1]).toMatchObject({
      sequence: "AAAAAAAAAAAAAAAAAAAA",
      passingFilters: false,
      rankingEvidence: {
        passingFilters: false,
        filterFailures: ["GC_OUT_OF_RANGE", "SEED_HOMOPOLYMER_TOO_LONG"],
        offTargetHitCount: 0,
        gcDistanceFrom50: 50,
        guideStart: 24,
        strand: "+",
        efficacyScoreIncluded: false,
      },
    });
  });
});
