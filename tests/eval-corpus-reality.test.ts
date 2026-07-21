import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  editSequence,
  findRestrictionSites,
  importSequenceFile,
  readWorkspace,
  runToolHandler,
  simulateDigest,
  validateWorkspace,
} from "../src/index.js";

// Independent biological anchor for the eval corpus.
//
// The corpus checker (scripts/eval-corpus-v0.mjs) compares fresh tool output to
// the corpus's own checked-in expected files. If a tool regresses AND the corpus
// is regenerated, both move together and the checker still passes. This suite
// instead hardcodes the ground-truth biology, so a tool regression fails here
// even if the corpus expected files were regenerated to match it. It reproduces
// through the same tool surface, not private helpers.

const CORPUS = "eval-corpus/v0/tasks";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function openFromFixture(fixture: string, moleculeId: string): Promise<{ workspacePath: string; moleculeId: string; workspaceDir: string }> {
  const workspaceDir = await tempDir("corpus-anchor-");
  const local = path.join(workspaceDir, path.basename(fixture));
  await fs.copyFile(path.resolve(fixture), local);
  const imp = await importSequenceFile({ inputPath: local, workspaceDir, format: fixture.endsWith(".fa") ? "fasta" : "genbank", moleculeId });
  return { workspacePath: imp.workspacePath, moleculeId: imp.moleculeIds[0], workspaceDir };
}

describe("eval corpus biological ground truth", () => {
  it("mb-edit-puc19-mcs-insert: NotI insert after EcoRI leaves bla in-frame (canonical fixture)", async () => {
    // Uses the canonical repo fixture, fully independent of the corpus copy.
    const src = await openFromFixture("fixtures/genbank/puc19.gb", "mol_puc19");
    const edit = await editSequence({
      workspacePath: src.workspacePath,
      moleculeId: src.moleculeId,
      expectedRevision: 0,
      operation: "insert",
      start: 402,
      sequence: "GCGGCCGC",
    });
    expect(edit.lengthAfter).toBe(2694);
    expect(edit.delta).toBe(8);
    expect(edit.featureImpact.some((f) => f.frameShifted === true)).toBe(false);
    const bla = edit.featureImpact.find((f) => f.name === "bla");
    expect(bla?.afterSegments).toEqual([{ start: 1637, end: 2425, strand: "-" }]);

    const sites = await findRestrictionSites(src.workspacePath, src.moleculeId, ["NotI"]);
    expect(sites.map((s) => ({ enzyme: s.enzyme, start: s.start, end: s.end, cutPosition: s.cutPosition }))).toEqual([
      { enzyme: "NotI", start: 402, end: 409, cutPosition: 403 },
    ]);

    const ws = await readWorkspace(src.workspacePath, { checkSequenceDigests: true });
    await expect(validateWorkspace(ws, { workspacePath: src.workspacePath, checkSequenceDigests: true })).resolves.toMatchObject({ ok: true });
  });

  it("mb-digest-puc19-hindiii-xhoi: HindIII+XhoI distinguishes empty/forward/reverse", async () => {
    const cases: Array<[string, string, number[]]> = [
      [`${CORPUS}/mb-digest-puc19-hindiii-xhoi/inputs/puc19-empty.gb`, "mol_empty", [2686]],
      [`${CORPUS}/mb-digest-puc19-hindiii-xhoi/inputs/puc19-forward.gb`, "mol_forward", [480, 2885]],
      [`${CORPUS}/mb-digest-puc19-hindiii-xhoi/inputs/puc19-reverse.gb`, "mol_reverse", [284, 3081]],
    ];
    for (const [fixture, molId, expectedFragments] of cases) {
      const src = await openFromFixture(fixture, molId);
      const digest = await simulateDigest(src.workspacePath, src.moleculeId, ["HindIII", "XhoI"]);
      const sizes = digest.fragments.map((f) => f.size).sort((a, b) => a - b);
      expect(sizes).toEqual(expectedFragments);
    }
  });

  it("mb-mrna-il27-validation: valid element layout translates to MAAA*", async () => {
    const src = await openFromFixture(`${CORPUS}/mb-mrna-il27-validation/inputs/il27-proxy-mrna.fa`, "mol_mrna_eval");

    const construct = await runToolHandler("validate_mrna_construct", {
      workspacePath: src.workspacePath,
      moleculeId: src.moleculeId,
      templateType: "mrna",
      elements: [
        { type: "five_utr", coordinates: { start: 1, end: 10 } },
        { type: "cds", coordinates: { start: 11, end: 25 } },
        { type: "three_utr", coordinates: { start: 26, end: 40 } },
      ],
    } as never);
    expect(construct.ok).toBe(true);
    if (!construct.ok) throw new Error("expected valid mRNA construct");
    expect(construct.data).toMatchObject({ summary: "valid", failCount: 0, warningCount: 0 });

    const protein = await runToolHandler("export_protein_fasta", {
      workspacePath: src.workspacePath,
      moleculeId: src.moleculeId,
      cdsStart: 11,
      cdsEnd: 25,
      proteinId: "il27_proxy",
      outputPath: "reports/proteins/anchor.fa",
    } as never);
    expect(protein.ok).toBe(true);
    if (!protein.ok) throw new Error("expected protein export success");
    // CDS ATG GCC GCC GCC TAA -> M A A A * ; FASTA carries the stop-trimmed peptide.
    const fasta = await fs.readFile(protein.artifacts?.[0]?.path ?? "", "utf8");
    expect(fasta).toMatch(/\nMAAA\s*$/);
  });
});
