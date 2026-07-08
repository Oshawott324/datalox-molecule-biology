import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { closeManagedSequenceEditors, importSequenceFile, openSequenceEditor, startSequenceEditorServer } from "../src/index.js";
import { stageFixture } from "./support/fixtures.js";

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
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_single",
    });
    const server = await startSequenceEditorServer({ workspacePath: imported.workspacePath, moleculeId: "mol_single" });

    try {
      const html = await fetch(server.url).then((response) => response.text());
      expect(html).toContain("Molecule Biology");
      expect(html).toContain("/api/workspace");
      expect(html).toContain("dual-view");
      expect(html).toContain("Restriction Sites");
      expect(html).toContain("renderAnnotatedSequence");

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
      inputPath: await stageFixture(workspaceDir, "genbank/puc19.gb"),
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

  it("serves restriction sites with sequence context for the static dual view", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const imported = await importSequenceFile({
      inputPath: await stageFixture(workspaceDir, "genbank/puc19.gb"),
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_puc19",
    });
    const server = await startSequenceEditorServer({ workspacePath: imported.workspacePath, moleculeId: "mol_puc19" });

    try {
      const context = await jsonFetch(new URL("/api/context?moleculeId=mol_puc19&start=390&end=455&includeSequence=true&enzymes=EcoRI,HindIII", server.url).toString());
      expect(context).toMatchObject({
        ok: true,
        molecule: expect.objectContaining({ id: "mol_puc19" }),
        region: expect.objectContaining({ start: 390, end: 455 }),
        restrictionSites: expect.arrayContaining([
          expect.objectContaining({ enzyme: "EcoRI", cutPosition: 396 }),
          expect.objectContaining({ enzyme: "HindIII", cutPosition: 447 }),
        ]),
      });
    } finally {
      await server.close();
    }
  });

  it("rejects a stale expectedRevision on the /api/features endpoint", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const imported = await importSequenceFile({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_single",
    });
    const server = await startSequenceEditorServer({ workspacePath: imported.workspacePath, moleculeId: "mol_single" });

    const featureBase = {
      moleculeId: "mol_single",
      name: "feat",
      type: "misc_feature",
      segments: [{ start: 1, end: 4, strand: "+" }],
    };

    try {
      // First write at revision 0 succeeds → workspace advances to revision 1.
      const first = await fetch(new URL("/api/features", server.url).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, feature: { id: "feat_a", ...featureBase } }),
      });
      expect((await first.json() as { ok: boolean }).ok).toBe(true);

      // Second write still at revision 0 is now stale → server returns ok:false with STALE_REVISION.
      const stale = await fetch(new URL("/api/features", server.url).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, feature: { id: "feat_b", ...featureBase } }),
      });
      const body = await stale.json() as { ok: boolean; error?: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("STALE_REVISION");
    } finally {
      await server.close();
    }
  });

  it("reuses one managed editor per workspace instead of leaking servers", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const imported = await importSequenceFile({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_single",
    });

    try {
      const first = await openSequenceEditor({ workspacePath: imported.workspacePath, moleculeId: "mol_single" });
      const second = await openSequenceEditor({ workspacePath: imported.workspacePath, moleculeId: "mol_single" });
      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.url).toBe(first.url);
    } finally {
      await closeManagedSequenceEditors();
    }
  });

  it("refuses to bind the editor to a non-loopback host by default", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const imported = await importSequenceFile({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_single",
    });

    await expect(startSequenceEditorServer({ workspacePath: imported.workspacePath, host: "0.0.0.0" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
