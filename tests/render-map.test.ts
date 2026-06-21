import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  handleRenderPlasmidMap,
  importSequenceFile,
  renderPlasmidMap,
} from "../src/index.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function importPuc19(): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-render-");
  const result = await importSequenceFile({
    inputPath: path.resolve("fixtures/genbank/puc19.gb"),
    workspaceDir,
    format: "genbank",
    moleculeId: "mol_puc19",
  });
  return { workspaceDir, workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

describe("plasmid map rendering", () => {
  it("writes a deterministic SVG map for the pUC19 fixture", async () => {
    const { workspaceDir, workspacePath, moleculeId } = await importPuc19();
    const result = await renderPlasmidMap(workspacePath, moleculeId, { width: 640, height: 520 });
    const svg = await fs.readFile(result.outputPath, "utf8");

    expect(result).toMatchObject({
      moleculeId,
      relativePath: path.join("reports", "maps", "mol_puc19.plasmid.svg"),
      mimeType: "image/svg+xml",
      width: 640,
      height: 520,
      length: 2686,
      renderedFeatureIds: [
        "feat_mol_puc19_laczalpha",
        "feat_mol_puc19_mcs",
        "feat_mol_puc19_pmb1_ori",
        "feat_mol_puc19_bla",
        "feat_mol_puc19_bla_2",
      ],
      rules: {
        baseOneAngle: "12_o_clock",
        direction: "clockwise",
        featureSortKey: "minimum_segment_start_then_minimum_segment_end_then_id",
        multiSegmentRendering: "one_arc_per_segment_one_label_per_feature",
      },
    });
    expect(result.outputPath).toBe(path.join(workspaceDir, result.relativePath));
    expect(svg).toContain("pUC19");
    expect(svg).toContain("lacZalpha");
    expect(svg).toContain("MCS");
    expect(svg).toContain("pMB1 ori");
    expect(svg).toContain("bla");
    expect(svg).not.toContain(">source<");

    const arcs = featureArcPaths(svg);
    expect(arcs).toHaveLength(6);
    expect(arcs.every((arc) => arc.start.x !== arc.end.x || arc.start.y !== arc.end.y)).toBe(true);
    expect(new Set(arcs.map((arc) => `${arc.start.x},${arc.start.y}`)).size).toBeGreaterThan(1);
  });

  it("returns artifact metadata from the tool handler", async () => {
    const { workspacePath, moleculeId } = await importPuc19();
    const result = await handleRenderPlasmidMap({
      workspacePath,
      moleculeId,
      width: 600,
      height: 500,
    });

    expect(result).toMatchObject({
      ok: true,
      tool: "render_plasmid_map",
      artifacts: [
        {
          kind: "plasmid_map",
          mimeType: "image/svg+xml",
        },
      ],
      nextAction: {
        tool: "validate_workspace",
      },
    });
    if (!result.ok) throw new Error("expected render_plasmid_map success");
    await expect(fs.stat(result.artifacts?.[0]?.path ?? "")).resolves.toBeTruthy();
  });
});

function featureArcPaths(svg: string): Array<{ start: { x: string; y: string }; end: { x: string; y: string } }> {
  const pattern = /<path d="M ([^ ]+) ([^ ]+) A [^ ]+ [^ ]+ 0 [01] 1 ([^ ]+) ([^"]+)"/g;
  return [...svg.matchAll(pattern)].map((match) => ({
    start: { x: match[1], y: match[2] },
    end: { x: match[3], y: match[4] },
  }));
}
