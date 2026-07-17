import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  editSequence,
  getSequenceContext,
  importSequenceFile,
  readMoleculeSequence,
  readWorkspace,
  validateWorkspace,
  writeWorkspaceTransaction,
} from "../src/index.js";
import type { Feature } from "../src/index.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function importFasta(sequence: string, name = "edit"): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-edit-");
  const inputPath = path.join(workspaceDir, "input.fa");
  await fs.writeFile(inputPath, `>${name}\n${sequence}\n`, "utf8");
  const result = await importSequenceFile({ inputPath, workspaceDir, format: "fasta" });
  return { workspaceDir, workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

async function importGenBank(content: string): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-edit-gb-");
  const inputPath = path.join(workspaceDir, "input.gb");
  await fs.writeFile(inputPath, content, "utf8");
  const result = await importSequenceFile({ inputPath, workspaceDir, format: "genbank" });
  return { workspaceDir, workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

async function addFeatures(workspacePath: string, moleculeId: string, features: Omit<Feature, "moleculeId">[]): Promise<number> {
  const transaction = await writeWorkspaceTransaction(workspacePath, 0, (workspace) => {
    workspace.features.push(...features.map((feature) => ({ ...feature, moleculeId })));
    return { added: features.length };
  });
  return transaction.revision;
}

describe("edit_sequence", () => {
  it("appends bases at length + 1 and writes a new stored FASTA file", async () => {
    const source = await importFasta("ACGT");
    const before = await readWorkspace(source.workspacePath, { checkSequenceDigests: true });
    const oldPath = before.molecules[0].path;

    const result = await editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: 0,
      operation: "insert",
      start: 5,
      sequence: "TT",
    });

    const edited = await readMoleculeSequence(source.workspacePath, source.moleculeId);
    expect(edited.sequence).toBe("ACGTTT");
    expect(result).toMatchObject({
      lengthBefore: 4,
      lengthAfter: 6,
      delta: 2,
      diffSummary: "insert 2 bases before 5",
      previousRevision: 0,
      revision: 1,
      nextAction: { tool: "validate_workspace" },
    });
    expect(edited.molecule.path).not.toBe(oldPath);
    expect(await fs.readFile(path.join(source.workspaceDir, oldPath), "utf8")).toContain("ACGT");
  });

  it("remaps multi-segment features, removes fully deleted features, and validates cleanly", async () => {
    const source = await importFasta("AAAAACCCGGTTTAAACCCGGTTTAAACCC");
    const revision = await addFeatures(source.workspacePath, source.moleculeId, [
      {
        id: "feat_join",
        name: "joined",
        type: "misc_feature",
        segments: [
          { start: 2, end: 4, strand: "+" },
          { start: 20, end: 22, strand: "+" },
        ],
      },
      {
        id: "feat_deleted",
        name: "deleted",
        type: "misc_feature",
        segments: [{ start: 6, end: 8, strand: "+" }],
      },
      {
        id: "feat_cds",
        name: "cds",
        type: "CDS",
        segments: [{ start: 12, end: 17, strand: "+" }],
      },
    ]);

    const result = await editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: revision,
      operation: "delete",
      start: 6,
      end: 8,
    });

    expect(result.featureImpact).toHaveLength(3);
    expect(result.featureImpact.find((impact) => impact.featureId === "feat_join")).toMatchObject({
      impact: "shifted",
      beforeSegments: [
        { start: 2, end: 4, strand: "+" },
        { start: 20, end: 22, strand: "+" },
      ],
      afterSegments: [
        { start: 2, end: 4, strand: "+" },
        { start: 17, end: 19, strand: "+" },
      ],
    });
    expect(result.featureImpact.find((impact) => impact.featureId === "feat_deleted")).toMatchObject({
      impact: "deleted",
      afterSegments: null,
      boundingSpan: null,
    });

    const workspace = await readWorkspace(source.workspacePath, { checkSequenceDigests: true });
    expect(workspace.features.some((feature) => feature.id === "feat_deleted")).toBe(false);
    expect(workspace.features.find((feature) => feature.id === "feat_cds")?.segments).toEqual([{ start: 9, end: 14, strand: "+" }]);
    await expect(validateWorkspace(workspace, { workspacePath: source.workspacePath, checkSequenceDigests: true })).resolves.toMatchObject({ ok: true });
  });

  it("reports a multi-segment feature as truncated when one segment is deleted", async () => {
    const source = await importFasta("AAAAACCCGGTTTAAACCCGGTTTAAACCC");
    const revision = await addFeatures(source.workspacePath, source.moleculeId, [
      {
        id: "feat_join",
        name: "joined",
        type: "misc_feature",
        segments: [
          { start: 2, end: 4, strand: "+" },
          { start: 20, end: 22, strand: "+" },
        ],
      },
    ]);

    const result = await editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: revision,
      operation: "delete",
      start: 20,
      end: 22,
    });

    expect(result.featureImpact).toEqual([
      expect.objectContaining({
        featureId: "feat_join",
        impact: "truncated",
        afterSegments: [{ start: 2, end: 4, strand: "+" }],
        boundingSpan: { start: 2, end: 4 },
      }),
    ]);
  });

  it("reports split and frameShifted independently for an insertion inside a CDS", async () => {
    const source = await importFasta("ATGAAACCCGGGTTT");
    const revision = await addFeatures(source.workspacePath, source.moleculeId, [
      {
        id: "feat_cds",
        name: "coding",
        type: "CDS",
        segments: [{ start: 1, end: 15, strand: "+" }],
      },
    ]);

    const result = await editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: revision,
      operation: "insert",
      start: 7,
      sequence: "A",
    });

    expect(result.featureImpact).toEqual([
      {
        featureId: "feat_cds",
        name: "coding",
        impact: "split",
        frameShifted: true,
        beforeSegments: [{ start: 1, end: 15, strand: "+" }],
        afterSegments: [{ start: 1, end: 16, strand: "+" }],
        boundingSpan: { start: 1, end: 16 },
        notes: [
          "CDS length may no longer preserve the original reading frame.",
          "Edit splits a feature segment; v1 reports the merged span and does not fabricate split annotations.",
        ],
      },
    ]);
  });

  it("rejects stale expectedRevision before writing a new sequence file", async () => {
    const source = await importFasta("ACGTACGT");
    const before = await readWorkspace(source.workspacePath, { checkSequenceDigests: true });
    const oldPath = before.molecules[0].path;

    await editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: 0,
      operation: "insert",
      start: 2,
      sequence: "A",
    });

    await expect(editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: 0,
      operation: "insert",
      start: 2,
      sequence: "T",
    })).rejects.toMatchObject({ code: "STALE_REVISION" });

    const workspace = await readWorkspace(source.workspacePath, { checkSequenceDigests: true });
    expect(workspace.molecules[0].path).not.toBe(oldPath);
    const storedFiles = await fs.readdir(path.join(source.workspaceDir, "data", "sequences"));
    expect(storedFiles).toHaveLength(2);
  });

  it("round-trips an edited GenBank-backed molecule through get_sequence_context", async () => {
    const source = await importGenBank(`LOCUS       EDITGB          12 bp    DNA     linear   01-JAN-2026
DEFINITION  edit gb.
FEATURES             Location/Qualifiers
     misc_feature    3..9
                     /label="window"
ORIGIN
        1 acgtacgtac gt
//
`);

    const result = await editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: 0,
      operation: "replace",
      start: 5,
      end: 6,
      sequence: "TT",
    });

    expect(result.featureImpact).toHaveLength(1);
    const context = await getSequenceContext(source.workspacePath, source.moleculeId, { includeSequence: true });
    expect(context.sequence).toBe("ACGTTTGTACGT");
    expect(context.features?.[0]?.segments).toEqual([{ start: 3, end: 9, strand: "+" }]);
    await expect(validateWorkspace(await readWorkspace(source.workspacePath, { checkSequenceDigests: true }), {
      workspacePath: source.workspacePath,
      checkSequenceDigests: true,
    })).resolves.toMatchObject({ ok: true });
  });

  it("rejects origin-spanning coordinate order on a circular molecule", async () => {
    const source = await importGenBank(`LOCUS       CIRC            12 bp    DNA     circular 01-JAN-2026
DEFINITION  circular.
FEATURES             Location/Qualifiers
ORIGIN
        1 acgtacgtac gt
//
`);

    await expect(editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: 0,
      operation: "delete",
      start: 10,
      end: 3,
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects append-style insert on a circular molecule", async () => {
    const source = await importGenBank(`LOCUS       CIRC            12 bp    DNA     circular 01-JAN-2026
DEFINITION  circular.
FEATURES             Location/Qualifiers
ORIGIN
        1 acgtacgtac gt
//
`);

    await expect(editSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      expectedRevision: 0,
      operation: "insert",
      start: 13,
      sequence: "A",
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
