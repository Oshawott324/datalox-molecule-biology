import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  exportProteinFasta,
  handleExportProteinFasta,
  handleValidateMrnaConstruct,
  importSequenceFile,
  upsertFeature,
  validateMrnaConstruct,
  type MrnaCheck,
} from "../src/index.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function importMolecule(sequence: string, moleculeId = "mol_test"): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-mrna-");
  const inputPath = path.join(workspaceDir, "input.fa");
  await fs.writeFile(inputPath, `>${moleculeId}\n${sequence}\n`, "utf8");
  const result = await importSequenceFile({ inputPath, workspaceDir, format: "fasta", moleculeId });
  return { workspaceDir, workspacePath: result.workspacePath, moleculeId };
}

function check(checks: MrnaCheck[], checkId: string): MrnaCheck | undefined {
  return checks.find((entry) => entry.checkId === checkId);
}

// A minimal but complete mRNA construct: 5'UTR(1..10), CDS(11..25, ATG..TAA in frame),
// 3'UTR(26..40, contains AATAAA). Kozak is strong (A at -3, G at +4).
const VALID_MRNA = "TTTTTTTACCATGGCCGCCGCCTAAGGAATAAAGGGGGGG";
const VALID_ELEMENTS = [
  { type: "five_utr" as const, coordinates: { start: 1, end: 10 } },
  { type: "cds" as const, coordinates: { start: 11, end: 25 } },
  { type: "three_utr" as const, coordinates: { start: 26, end: 40 } },
];

describe("X1 export_protein_fasta", () => {
  it("translates a CDS region and writes a stop-trimmed protein FASTA", async () => {
    const { workspacePath, moleculeId } = await importMolecule("ATGGCCTGCTAA", "mol_x1");
    const result = await exportProteinFasta(workspacePath, moleculeId, { cdsStart: 1, cdsEnd: 12 });

    expect(result).toMatchObject({
      moleculeId: "mol_x1",
      proteinId: "mol_x1",
      region: { start: 1, end: 12 },
      aminoAcids: "MAC*",
      proteinLength: 3,
      stopTrimmed: true,
      mimeType: "text/x-fasta",
    });
    expect(result.relativePath).toBe(path.join("reports", "proteins", "mol_x1.fa"));

    const written = await fs.readFile(result.outputPath, "utf8");
    expect(written).toBe(">mol_x1\nMAC\n");
  });

  it("honors a custom proteinId and surfaces the artifact through the tool handler", async () => {
    const { workspacePath, moleculeId } = await importMolecule("ATGGCCTGCTAA", "mol_x1b");
    const envelope = await handleExportProteinFasta({
      workspacePath,
      moleculeId,
      cdsStart: 1,
      cdsEnd: 12,
      proteinId: "il27_fusion",
    });

    expect(envelope).toMatchObject({
      ok: true,
      tool: "export_protein_fasta",
      data: { proteinId: "il27_fusion", stopTrimmed: true },
      artifacts: [{ kind: "protein_fasta", mimeType: "text/x-fasta" }],
    });
  });

  it("keeps an internal stop untouched and reports it as not trimmed", async () => {
    // ATG TAA GCC -> M * A ; no trailing stop, so nothing is trimmed.
    const { workspacePath, moleculeId } = await importMolecule("ATGTAAGCC", "mol_x1c");
    const result = await exportProteinFasta(workspacePath, moleculeId, { cdsStart: 1, cdsEnd: 9 });
    expect(result.aminoAcids).toBe("M*A");
    expect(result.stopTrimmed).toBe(false);
    expect(result.proteinLength).toBe(3);
  });
});

describe("M1 validate_mrna_construct", () => {
  it("passes a well-formed mRNA construct with no warnings", async () => {
    const { workspacePath, moleculeId } = await importMolecule(VALID_MRNA, "mol_valid");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: VALID_ELEMENTS,
    });

    expect(result.summary).toBe("valid");
    expect(result.failCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(check(result.checks, "CDS_STARTS_WITH_ATG")?.status).toBe("pass");
    expect(check(result.checks, "CDS_IN_FRAME")?.status).toBe("pass");
    expect(check(result.checks, "CDS_HAS_STOP_CODON")?.status).toBe("pass");
    expect(check(result.checks, "CDS_NO_PREMATURE_STOP")?.status).toBe("pass");
    expect(check(result.checks, "KOZAK_CONTEXT")?.status).toBe("pass");
    expect(check(result.checks, "POLYA_SIGNAL_PRESENT")?.status).toBe("pass");
    expect(check(result.checks, "ELEMENT_ORDER")?.status).toBe("pass");
  });

  it("warns (not fails) on a suboptimal Kozak context", async () => {
    // -3 is T, +4 is C: both weak.
    const seq = "TTTTTTTTCCATGCCCGCCGCCTAAGGAATAAAGGGGGGG";
    const { workspacePath, moleculeId } = await importMolecule(seq, "mol_kozak");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: VALID_ELEMENTS,
    });
    expect(result.summary).toBe("valid_with_warnings");
    expect(result.failCount).toBe(0);
    expect(check(result.checks, "KOZAK_CONTEXT")?.status).toBe("warning");
  });

  it("warns when no polyA signal hexamer is present near the 3'UTR", async () => {
    const seq = "TTTTTTTACCATGGCCGCCGCCTAAGCGCGCGCGCGCGCG";
    const { workspacePath, moleculeId } = await importMolecule(seq, "mol_nopolya");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: VALID_ELEMENTS,
    });
    expect(result.summary).toBe("valid_with_warnings");
    expect(check(result.checks, "POLYA_SIGNAL_PRESENT")?.status).toBe("warning");
  });

  it("fails when the CDS does not start with ATG", async () => {
    const seq = "TTTTTTTACCTTGGCCGCCGCCTAAGGAATAAAGGGGGGG";
    const { workspacePath, moleculeId } = await importMolecule(seq, "mol_noatg");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: VALID_ELEMENTS,
    });
    expect(result.summary).toBe("invalid");
    expect(check(result.checks, "CDS_STARTS_WITH_ATG")?.status).toBe("fail");
  });

  it("fails on an internal in-frame stop codon", async () => {
    const seq = "TTTTTTTACCATGTAAGCCGCCTAAGGAATAAAGGGGGGG";
    const { workspacePath, moleculeId } = await importMolecule(seq, "mol_premature");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: VALID_ELEMENTS,
    });
    expect(result.summary).toBe("invalid");
    const premature = check(result.checks, "CDS_NO_PREMATURE_STOP");
    expect(premature?.status).toBe("fail");
    expect(premature?.detail).toContain("position 14");
  });

  it("fails when the CDS length is not divisible by 3", async () => {
    const { workspacePath, moleculeId } = await importMolecule(VALID_MRNA, "mol_frame");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: [
        { type: "five_utr", coordinates: { start: 1, end: 10 } },
        { type: "cds", coordinates: { start: 11, end: 24 } }, // 14 bases
        { type: "three_utr", coordinates: { start: 26, end: 40 } },
      ],
    });
    expect(result.summary).toBe("invalid");
    expect(check(result.checks, "CDS_IN_FRAME")?.status).toBe("fail");
  });

  it("fails when elements are out of 5'->3' order", async () => {
    const { workspacePath, moleculeId } = await importMolecule(VALID_MRNA, "mol_order");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: [
        { type: "five_utr", coordinates: { start: 26, end: 40 } },
        { type: "cds", coordinates: { start: 11, end: 25 } },
        { type: "three_utr", coordinates: { start: 1, end: 10 } },
      ],
    });
    expect(result.summary).toBe("invalid");
    expect(check(result.checks, "ELEMENT_ORDER")?.status).toBe("fail");
  });

  it("fails when a required element is missing", async () => {
    const { workspacePath, moleculeId } = await importMolecule(VALID_MRNA, "mol_missing");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: [
        { type: "five_utr", coordinates: { start: 1, end: 10 } },
        { type: "cds", coordinates: { start: 11, end: 25 } },
      ],
    });
    expect(result.summary).toBe("invalid");
    const presence = result.checks.find((entry) => entry.checkId === "ELEMENT_PRESENT" && entry.element === "three_utr");
    expect(presence?.status).toBe("fail");
  });

  it("checks promoter and IVT-site placement for a plasmid template", async () => {
    // promoter(1..5) five_utr(6..15) cds(16..30) three_utr(31..45) polya_signal(46..51) ivt(52..56)
    const seq = "TAATA" + "GGGGGGGAGG" + "ATGGCCGCCGCCTAA" + "GGAATAAAGGGGGGG" + "AATAAA" + "GAATT";
    const { workspacePath, moleculeId } = await importMolecule(seq, "mol_plasmid");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "plasmid_template",
      elements: [
        { type: "t7_promoter", coordinates: { start: 1, end: 5 } },
        { type: "five_utr", coordinates: { start: 6, end: 15 } },
        { type: "cds", coordinates: { start: 16, end: 30 } },
        { type: "three_utr", coordinates: { start: 31, end: 45 } },
        { type: "polya_signal", coordinates: { start: 46, end: 51 } },
        { type: "ivt_site", coordinates: { start: 52, end: 56 } },
      ],
    });
    expect(result.summary).toBe("valid");
    expect(check(result.checks, "PROMOTER_UPSTREAM_OF_5UTR")?.status).toBe("pass");
    expect(check(result.checks, "IVT_SITE_DOWNSTREAM_OF_POLYA")?.status).toBe("pass");
  });

  it("requires a promoter and IVT site for plasmid templates", async () => {
    const { workspacePath, moleculeId } = await importMolecule(VALID_MRNA, "mol_plasmid_missing");
    const result = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "plasmid_template",
      elements: VALID_ELEMENTS,
    });
    expect(result.summary).toBe("invalid");
    expect(result.checks.some((c) => c.checkId === "ELEMENT_PRESENT" && c.element === "t7_promoter|sp6_promoter" && c.status === "fail")).toBe(true);
    expect(result.checks.some((c) => c.checkId === "ELEMENT_PRESENT" && c.element === "ivt_site" && c.status === "fail")).toBe(true);
  });

  it("resolves elements from workspace features by featureId and by type inference", async () => {
    const { workspacePath, moleculeId } = await importMolecule(VALID_MRNA, "mol_features");
    let revision = 0;
    const addFeature = async (id: string, type: string, start: number, end: number): Promise<void> => {
      const result = await upsertFeature(workspacePath, revision, {
        id,
        moleculeId,
        name: id,
        type,
        segments: [{ start, end, strand: "+" }],
        source: { kind: "agent", tool: "upsert_feature" },
      });
      revision = result.revision;
    };
    await addFeature("feat_5utr", "5'UTR", 1, 10);
    await addFeature("feat_cds", "CDS", 11, 25);
    await addFeature("feat_3utr", "3'UTR", 26, 40);

    // By explicit featureId.
    const byId = await handleValidateMrnaConstruct({
      workspacePath,
      moleculeId,
      templateType: "mrna",
      elements: [
        { type: "five_utr", featureId: "feat_5utr" },
        { type: "cds", featureId: "feat_cds" },
        { type: "three_utr", featureId: "feat_3utr" },
      ],
    });
    expect(byId).toMatchObject({
      ok: true,
      data: { summary: "valid" },
      nextAction: { tool: "validate_workspace" },
    });

    // By type inference (no featureId, no coordinates).
    const byInference = await validateMrnaConstruct(workspacePath, {
      moleculeId,
      templateType: "mrna",
      elements: [{ type: "five_utr" }, { type: "cds" }, { type: "three_utr" }],
    });
    expect(byInference.summary).toBe("valid");
  });

  it("routes an invalid construct to manual_review through the tool handler", async () => {
    const seq = "TTTTTTTACCTTGGCCGCCGCCTAAGGAATAAAGGGGGGG";
    const { workspacePath, moleculeId } = await importMolecule(seq, "mol_invalid_handler");
    const envelope = await handleValidateMrnaConstruct({
      workspacePath,
      moleculeId,
      templateType: "mrna",
      elements: VALID_ELEMENTS,
    });
    expect(envelope).toMatchObject({
      ok: true,
      data: { summary: "invalid" },
      nextAction: { tool: "manual_review", arguments: { instruction: "Resolve the failed mRNA construct checks before proceeding." } },
    });
  });

  it("rejects an unknown templateType", async () => {
    const { workspacePath, moleculeId } = await importMolecule(VALID_MRNA, "mol_badtype");
    const envelope = await handleValidateMrnaConstruct({
      workspacePath,
      moleculeId,
      templateType: "genomic" as never,
      elements: VALID_ELEMENTS,
    });
    expect(envelope).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  });
});
