import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  deleteFeature,
  deletePrimer,
  importSequenceFile,
  readWorkspace,
  upsertFeature,
  upsertPrimer,
  type Feature,
  type Primer,
} from "../src/index.js";

const fixturesRoot = path.resolve("fixtures");

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-writes-"));
}

async function importSingleFasta(): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string; revision: number }> {
  const workspaceDir = await tempWorkspaceDir();
  const result = await importSequenceFile({
    inputPath: path.join(fixturesRoot, "fasta/single.fa"),
    workspaceDir,
    format: "fasta",
  });
  const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });
  return {
    workspaceDir,
    workspacePath: result.workspacePath,
    moleculeId: workspace.molecules[0].id,
    revision: workspace.revision,
  };
}

describe("structured workspace writes", () => {
  it("upserts, updates, and deletes a feature through revision-safe transactions", async () => {
    const { workspacePath, moleculeId } = await importSingleFasta();
    const feature: Feature = {
      id: "feat_agent_gene",
      moleculeId,
      name: "agent gene",
      type: "gene",
      segments: [{ start: 1, end: 4, strand: "+" }],
      qualifiers: { note: "initial" },
    };

    const created = await upsertFeature(workspacePath, 0, feature);
    const updated = await upsertFeature(workspacePath, 1, {
      ...feature,
      name: "agent gene updated",
      qualifiers: { note: "updated" },
    });
    const deleted = await deleteFeature(workspacePath, 2, feature.id);
    const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });

    expect(created.payload).toEqual({ featureId: feature.id, action: "created" });
    expect(created.revision).toBe(1);
    expect(updated.payload).toEqual({ featureId: feature.id, action: "updated" });
    expect(updated.revision).toBe(2);
    expect(deleted.payload).toEqual({ featureId: feature.id });
    expect(deleted.revision).toBe(3);
    expect(workspace.features.map((candidate) => candidate.id)).not.toContain(feature.id);
  });

  it("rejects stale revisions before mutating feature and primer writes", async () => {
    const { workspacePath, moleculeId } = await importSingleFasta();
    const feature: Feature = {
      id: "feat_stale",
      moleculeId,
      name: "stale",
      type: "misc_feature",
      segments: [{ start: 1, end: 2, strand: "+" }],
    };
    const primer: Primer = {
      id: "primer_stale",
      name: "stale primer",
      sequence: "ACGT",
      moleculeId,
    };

    await expect(upsertFeature(workspacePath, 1, feature)).rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(deleteFeature(workspacePath, 1, feature.id)).rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(upsertPrimer(workspacePath, 1, primer)).rejects.toMatchObject({ code: "STALE_REVISION" });
    await expect(deletePrimer(workspacePath, 1, primer.id)).rejects.toMatchObject({ code: "STALE_REVISION" });
  });

  it("leaves the workspace unchanged when feature coordinates are invalid", async () => {
    const { workspacePath, moleculeId } = await importSingleFasta();
    const before = await fs.readFile(workspacePath, "utf8");

    await expect(
      upsertFeature(workspacePath, 0, {
        id: "feat_invalid",
        moleculeId,
        name: "invalid",
        type: "misc_feature",
        segments: [{ start: 1, end: 100, strand: "+" }],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      issues: expect.arrayContaining([expect.objectContaining({ code: "COORDINATE_OUT_OF_RANGE" })]),
    });

    await expect(fs.readFile(workspacePath, "utf8")).resolves.toBe(before);
  });

  it("validates primer sequence alphabet through workspace validation", async () => {
    const { workspacePath, moleculeId } = await importSingleFasta();

    await expect(
      upsertPrimer(workspacePath, 0, {
        id: "primer_invalid",
        name: "invalid primer",
        sequence: "ACGTZ",
        moleculeId,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      issues: expect.arrayContaining([expect.objectContaining({ path: "primers[0].sequence", code: "ALPHABET_MISMATCH" })]),
    });
  });

  it("binds primers by exact matches on forward and reverse-complement molecule sequence", async () => {
    const { workspacePath, moleculeId } = await importSingleFasta();
    const result = await upsertPrimer(
      workspacePath,
      0,
      {
        id: "primer_exact",
        name: "exact primer",
        sequence: "ACGT",
        moleculeId,
      },
      { bindToMolecule: true },
    );
    const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
    const primer = workspace.primers.find((candidate) => candidate.id === "primer_exact");

    expect(result.payload.binding).toEqual({
      segments: [
        { start: 1, end: 4, strand: "+" },
        { start: 1, end: 4, strand: "-" },
      ],
      mismatches: [],
    });
    expect(primer?.binding).toEqual(result.payload.binding);
  });

  it("records empty primer binding when exact matching finds no sites", async () => {
    const { workspacePath, moleculeId } = await importSingleFasta();
    const result = await upsertPrimer(
      workspacePath,
      0,
      {
        id: "primer_no_site",
        name: "no site primer",
        sequence: "AAAA",
        moleculeId,
      },
      { bindToMolecule: true },
    );

    expect(result.payload.binding).toEqual({ segments: [], mismatches: [] });
  });

  it("requires moleculeId when primer binding is requested", async () => {
    const { workspacePath } = await importSingleFasta();

    await expect(
      upsertPrimer(
        workspacePath,
        0,
        {
          id: "primer_unbound",
          name: "unbound primer",
          sequence: "ACGT",
        },
        { bindToMolecule: true },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects no-op upserts through transaction no-change detection", async () => {
    const { workspacePath, moleculeId } = await importSingleFasta();
    const primer: Primer = {
      id: "primer_noop",
      name: "no-op primer",
      sequence: "ACGT",
      moleculeId,
    };

    await upsertPrimer(workspacePath, 0, primer);

    await expect(upsertPrimer(workspacePath, 1, primer)).rejects.toMatchObject({ code: "NO_CHANGE" });
  });

  it("returns structured errors when deleting missing features or primers", async () => {
    const { workspacePath } = await importSingleFasta();

    await expect(deleteFeature(workspacePath, 0, "feat_missing")).rejects.toMatchObject({ code: "FEATURE_NOT_FOUND" });
    await expect(deletePrimer(workspacePath, 0, "primer_missing")).rejects.toMatchObject({ code: "PRIMER_NOT_FOUND" });
  });
});
