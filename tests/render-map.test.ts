import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  featureColor,
  findRestrictionSites,
  handleRenderPlasmidMap,
  importSequenceFile,
  readMoleculeSequence,
  renderPlasmidMap,
  reverseComplement,
  upsertPrimer,
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
    expect(svg).toContain('stroke="#90A4AE"');
    expect(svg).toContain('stroke="#78909C"');
    expect(svg).toContain('stroke="#E9A227"');

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

  it("renders caller-supplied cut sites and bound primer arrows", async () => {
    const { workspacePath, moleculeId } = await importPuc19();
    const { sequence } = await readMoleculeSequence(workspacePath, moleculeId);
    await upsertPrimer(workspacePath, 0, {
      id: "primer_puc19_mcs_fwd",
      name: "pUC19 MCS fwd",
      sequence: sequence.slice(395, 415),
      moleculeId,
    }, { bindToMolecule: true });
    await upsertPrimer(workspacePath, 1, {
      id: "primer_puc19_mcs_rev",
      name: "pUC19 MCS rev",
      sequence: reverseComplement(sequence.slice(430, 450)),
      moleculeId,
    }, { bindToMolecule: true });
    const sites = await findRestrictionSites(workspacePath, moleculeId, ["EcoRI", "HindIII"]);

    const result = await renderPlasmidMap(workspacePath, moleculeId, {
      outputPath: "reports/maps/puc19-overlay.svg",
      cutSites: sites.map((site) => ({ enzyme: site.enzyme, position: site.cutPosition })),
      showPrimers: true,
      width: 640,
      height: 520,
    });
    const svg = await fs.readFile(result.outputPath, "utf8");

    expect(result.relativePath).toBe(path.join("reports", "maps", "puc19-overlay.svg"));
    expect(result.renderedPrimerIds).toEqual(["primer_puc19_mcs_fwd", "primer_puc19_mcs_rev"]);
    expect(result.renderedCutSites).toEqual([
      { enzyme: "EcoRI", position: 396 },
      { enzyme: "HindIII", position: 447 },
    ]);
    expect(result.rules).toMatchObject({
      primerRendering: "bound_primers_only_one_arrow_per_binding_segment",
      cutSiteRendering: "caller_supplied_ticks_at_cut_position",
    });
    expect(svg).toContain("pUC19 MCS fwd");
    expect(svg).toContain("pUC19 MCS rev");
    expect(svg).toContain('stroke="#1976D2"');
    expect(svg).toContain('stroke="#D32F2F"');
    expect(svg).toContain(">EcoRI</text>");
    expect(svg).toContain(">HindIII</text>");
    expect(svg).toContain("EcoRI cut at 396");
    expect(svg).toContain("HindIII cut at 447");
  });

  it("uses stable biological feature colors", () => {
    expect(featureColor("CDS")).toBe("#E9A227");
    expect(featureColor("gene")).toBe("#E9A227");
    expect(featureColor("promoter")).toBe("#4CAF50");
    expect(featureColor("terminator")).toBe("#E53935");
    expect(featureColor("rep_origin")).toBe("#78909C");
    expect(featureColor("primer_bind")).toBe("#AB47BC");
    expect(featureColor("unknown_feature")).toBe("#546E7A");
  });
});

function featureArcPaths(svg: string): Array<{ start: { x: string; y: string }; end: { x: string; y: string } }> {
  const pattern = /<path d="M ([^ ]+) ([^ ]+) A [^ ]+ [^ ]+ 0 [01] 1 ([^ ]+) ([^"]+)"/g;
  return [...svg.matchAll(pattern)].map((match) => ({
    start: { x: match[1], y: match[2] },
    end: { x: match[3], y: match[4] },
  }));
}
