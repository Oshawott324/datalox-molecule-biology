import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { importSequenceFile, startSequenceEditorServer } from "../src/index.js";

const fixturesRoot = path.resolve("fixtures");

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-ui-"));
}

async function jsonFetch(url: string, options?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, options);
  expect(response.ok).toBe(true);
  return await response.json() as Record<string, unknown>;
}

describe("compact sequence editor server", () => {
  it("serves the editor, reads workspace context, and writes features revision-safely", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const imported = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_single",
    });
    const server = await startSequenceEditorServer({ workspacePath: imported.workspacePath, moleculeId: "mol_single" });

    try {
      const html = await fetch(server.url).then((response) => response.text());
      expect(html).toContain("Molecule Biology");
      expect(html).toContain("/api/workspace");

      const workspace = await jsonFetch(new URL("/api/workspace", server.url).toString());
      expect(workspace).toMatchObject({
        ok: true,
        revision: 0,
        molecules: [expect.objectContaining({ id: "mol_single", length: 15 })],
      });

      const context = await jsonFetch(new URL("/api/context?moleculeId=mol_single&start=1&end=4&includeSequence=true", server.url).toString());
      expect(context).toMatchObject({
        ok: true,
        molecule: expect.objectContaining({ id: "mol_single" }),
        sequence: "ACGT",
      });

      const write = await jsonFetch(new URL("/api/features", server.url).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          feature: {
            id: "feat_ui",
            moleculeId: "mol_single",
            name: "ui feature",
            type: "misc_feature",
            segments: [{ start: 1, end: 4, strand: "+" }],
          },
        }),
      });
      expect(write).toMatchObject({
        ok: true,
        revision: 1,
        data: { featureId: "feat_ui", action: "created" },
      });

      const refreshed = await jsonFetch(new URL("/api/workspace", server.url).toString());
      expect(refreshed).toMatchObject({
        ok: true,
        revision: 1,
        features: [expect.objectContaining({ id: "feat_ui" })],
      });
    } finally {
      await server.close();
    }
  });

  it("serves a plasmid map SVG for circular GenBank workspaces", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const imported = await importSequenceFile({
      inputPath: path.join(fixturesRoot, "genbank/puc19.gb"),
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_puc19",
    });
    const server = await startSequenceEditorServer({ workspacePath: imported.workspacePath, moleculeId: "mol_puc19" });

    try {
      const map = await jsonFetch(new URL("/api/map?moleculeId=mol_puc19", server.url).toString());
      expect(map).toMatchObject({
        ok: true,
        moleculeId: "mol_puc19",
        mimeType: "image/svg+xml",
        renderedFeatureIds: expect.arrayContaining([
          "feat_mol_puc19_laczalpha",
          "feat_mol_puc19_mcs",
          "feat_mol_puc19_pmb1_ori",
          "feat_mol_puc19_bla",
        ]),
      });
      expect(map.svg).toEqual(expect.stringContaining("<svg"));
      expect(map.svg).toEqual(expect.stringContaining("pUC19"));
    } finally {
      await server.close();
    }
  });
});
