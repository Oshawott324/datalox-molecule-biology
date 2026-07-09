import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MoleculeError,
  WorkspaceRevisionError,
  readWorkspace,
  sequenceDigest,
  validateWorkspace,
  validateWorkspaceOrThrow,
  writeWorkspaceFile,
  writeWorkspaceTransaction,
  type MoleculeWorkspace,
} from "../src/index.js";

async function tempWorkspaceRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "molws-"));
}

function validWorkspace(sequence: string): MoleculeWorkspace {
  const now = "2026-05-18T00:00:00.000Z";
  return {
    schema: "datalox.molecule.workspace",
    version: 1,
    revision: 0,
    workspaceId: "molws_test",
    createdAt: now,
    updatedAt: now,
    molecules: [
      {
        id: "mol_example",
        name: "example",
        path: "data/sequences/example.fa",
        sourceFormat: "fasta",
        sequenceDigest: sequenceDigest(sequence),
        length: sequence.length,
        topology: "linear",
        moleculeType: "dna",
        alphabet: "iupac_dna",
        description: "Example molecule",
      },
    ],
    features: [
      {
        id: "feat_promoter",
        moleculeId: "mol_example",
        name: "promoter",
        type: "promoter",
        segments: [{ start: 1, end: 4, strand: "+" }],
        qualifiers: { note: "test" },
      },
    ],
    primers: [
      {
        id: "primer_a",
        name: "primer a",
        sequence: "ACGT",
        moleculeId: "mol_example",
        binding: {
          segments: [{ start: 1, end: 4, strand: "+" }],
          mismatches: [],
        },
        metadata: {},
      },
    ],
    guides: [],
    constructs: [],
    experiments: [],
    auditEvents: [],
  };
}

async function createValidWorkspace(): Promise<{ workspacePath: string; workspace: MoleculeWorkspace }> {
  const root = await tempWorkspaceRoot();
  const sequence = "ACGTRYSWKMBDHVN";
  await fs.mkdir(path.join(root, "data/sequences"), { recursive: true });
  await fs.writeFile(path.join(root, "data/sequences/example.fa"), `>example\n${sequence.slice(0, 7)}\n${sequence.slice(7)}\n`, "utf8");
  return {
    workspacePath: path.join(root, "molecule.workspace.json"),
    workspace: validWorkspace(sequence),
  };
}

describe("workspace validation", () => {
  it("accepts a valid workspace and checks sequence digest when the source file exists", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();

    await expect(validateWorkspaceOrThrow(workspace, { workspacePath, checkSequenceDigests: true })).resolves.toEqual(workspace);
  });

  it("rejects missing molecule source files when digest checks are enabled", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    const result = await validateWorkspace(workspace, { workspacePath, checkSequenceDigests: true });

    await fs.unlink(path.join(path.dirname(workspacePath), workspace.molecules[0].path));
    const missingResult = await validateWorkspace(workspace, { workspacePath, checkSequenceDigests: true });

    expect(result.ok).toBe(true);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "molecules[0].path", code: "FILE_NOT_FOUND" })]));
  });

  it("rejects an invalid schema", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    const result = await validateWorkspace({ ...workspace, schema: "wrong" }, { workspacePath });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "schema", code: "VALIDATION_ERROR" })]));
  });

  it("rejects duplicate ids in object collections", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    const result = await validateWorkspace(
      {
        ...workspace,
        molecules: [...workspace.molecules, { ...workspace.molecules[0] }],
      },
      { workspacePath },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "molecules[1].id" })]));
  });

  it("rejects missing molecule references", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    const result = await validateWorkspace(
      {
        ...workspace,
        features: [{ ...workspace.features[0], moleculeId: "mol_missing" }],
      },
      { workspacePath },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "features[0].moleculeId", code: "MOLECULE_NOT_FOUND" })]));
  });

  it("rejects absolute and escaping molecule paths", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    const absoluteResult = await validateWorkspace(
      { ...workspace, molecules: [{ ...workspace.molecules[0], path: "/tmp/example.fa" }] },
      { workspacePath },
    );
    const escapeResult = await validateWorkspace(
      { ...workspace, molecules: [{ ...workspace.molecules[0], path: "../example.fa" }] },
      { workspacePath },
    );

    expect(absoluteResult.ok).toBe(false);
    expect(escapeResult.ok).toBe(false);
    expect(absoluteResult.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "molecules[0].path" })]));
    expect(escapeResult.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "molecules[0].path" })]));
  });

  it("rejects invalid feature coordinates", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    const reversedResult = await validateWorkspace(
      {
        ...workspace,
        features: [{ ...workspace.features[0], segments: [{ start: 5, end: 4, strand: "+" }] }],
      },
      { workspacePath },
    );
    const outOfRangeResult = await validateWorkspace(
      {
        ...workspace,
        features: [{ ...workspace.features[0], segments: [{ start: 1, end: 100, strand: "+" }] }],
      },
      { workspacePath },
    );

    expect(reversedResult.ok).toBe(false);
    expect(outOfRangeResult.ok).toBe(false);
    expect(reversedResult.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "COORDINATE_OUT_OF_RANGE" })]));
    expect(outOfRangeResult.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "COORDINATE_OUT_OF_RANGE" })]));
  });

  it("rejects a primer outside the molecule alphabet", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    const result = await validateWorkspace(
      {
        ...workspace,
        primers: [{ ...workspace.primers[0], sequence: "ACGTZ" }],
      },
      { workspacePath },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "primers[0].sequence", code: "ALPHABET_MISMATCH" })]));
  });

  it("commits revision-safe workspace transactions", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    await writeWorkspaceFile(workspacePath, workspace);

    const result = await writeWorkspaceTransaction(workspacePath, 0, (draft) => {
      draft.features.push({
        id: "feat_gene",
        moleculeId: "mol_example",
        name: "gene",
        type: "gene",
        segments: [{ start: 5, end: 8, strand: "+" }],
      });
      return { featureId: "feat_gene" };
    });
    const persisted = await readWorkspace(workspacePath, { checkSequenceDigests: true });

    expect(result.previousRevision).toBe(0);
    expect(result.revision).toBe(1);
    expect(result.payload).toEqual({ featureId: "feat_gene" });
    expect(persisted.revision).toBe(1);
    expect(persisted.features.map((feature) => feature.id)).toContain("feat_gene");
  });

  it("rejects stale workspace transactions", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    await writeWorkspaceFile(workspacePath, { ...workspace, revision: 2 });

    await expect(writeWorkspaceTransaction(workspacePath, 1, (draft) => {
      draft.auditEvents.push({ kind: "test" });
    })).rejects.toBeInstanceOf(WorkspaceRevisionError);
  });

  it("serializes concurrent same-revision workspace transactions so only one commits", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    await writeWorkspaceFile(workspacePath, workspace);

    const first = writeWorkspaceTransaction(workspacePath, 0, async (draft) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      draft.features.push({
        id: "feat_first",
        moleculeId: "mol_example",
        name: "first",
        type: "misc_feature",
        segments: [{ start: 1, end: 4, strand: "+" }],
      });
      return { featureId: "feat_first" };
    });
    const second = writeWorkspaceTransaction(workspacePath, 0, (draft) => {
      draft.features.push({
        id: "feat_second",
        moleculeId: "mol_example",
        name: "second",
        type: "misc_feature",
        segments: [{ start: 5, end: 8, strand: "+" }],
      });
      return { featureId: "feat_second" };
    });

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(WorkspaceRevisionError);

    const persisted = await readWorkspace(workspacePath, { checkSequenceDigests: true });
    expect(persisted.revision).toBe(1);
    const racedFeatureIds = persisted.features.map((feature) => feature.id).filter((id) => id === "feat_first" || id === "feat_second");
    expect(racedFeatureIds).toHaveLength(1);
  });

  it("rejects no-op workspace transactions", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    await writeWorkspaceFile(workspacePath, workspace);

    await expect(writeWorkspaceTransaction(workspacePath, 0, () => ({ changed: false }))).rejects.toMatchObject({
      code: "NO_CHANGE",
    });
  });

  it("does not persist invalid workspace transactions", async () => {
    const { workspacePath, workspace } = await createValidWorkspace();
    await writeWorkspaceFile(workspacePath, workspace);
    const before = await fs.readFile(workspacePath, "utf8");

    await expect(writeWorkspaceTransaction(workspacePath, 0, (draft) => {
      draft.features.push({
        id: "feat_bad",
        moleculeId: "mol_example",
        name: "bad",
        type: "misc_feature",
        segments: [{ start: 100, end: 120, strand: "+" }],
      });
    })).rejects.toBeInstanceOf(MoleculeError);

    await expect(fs.readFile(workspacePath, "utf8")).resolves.toBe(before);
  });
});
