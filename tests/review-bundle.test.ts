import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createReplayRecorder,
  importSequenceFile,
  MAX_REVIEW_BUNDLE_ARTIFACT_BYTES,
  packReplayBundle,
  recordToolCall,
  renderDigestGel,
  renderPlasmidMap,
  renderReviewBundle,
  runToolHandler,
  type ToolResultEnvelope,
} from "../src/index.js";
import { stageFixture } from "./support/fixtures.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function importPuc19(): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-review-");
  const result = await importSequenceFile({
    inputPath: await stageFixture(workspaceDir, "genbank/puc19.gb"),
    workspaceDir,
    format: "genbank",
    moleculeId: "mol_puc19",
  });
  return { workspaceDir, workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

describe("artifact review bundle rendering", () => {
  it("inlines explicit map and gel artifacts and writes a parseable escaped manifest", async () => {
    const { workspacePath, moleculeId } = await importPuc19();
    const map = await renderPlasmidMap(workspacePath, moleculeId, { outputPath: "reports/maps/review-map.svg" });
    const gel = await renderDigestGel(workspacePath, "review_gel", [{
      label: "HindIII",
      fragments: [{ size: 2686 }],
    }], { outputPath: "reports/gels/review-gel.svg" });

    const result = await renderReviewBundle(workspacePath, {
      artifacts: [
        { kind: "plasmid_map", path: map.outputPath, mimeType: "image/svg+xml", description: "map </script> & check" },
        { kind: "gel", path: gel.relativePath, mimeType: "image/svg+xml", description: "digest gel" },
      ],
    });
    const html = await fs.readFile(result.outputPath, "utf8");

    expect(result.relativePath).toBe(path.join("reports", "review", "review.html"));
    expect(result.includedArtifacts.map((artifact) => artifact.kind)).toEqual(["plasmid_map", "gel"]);
    expect(html).toContain("<svg");
    expect(html).toContain("review_gel");
    expect(html).not.toContain("<script src=");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c/script\\u003e");

    const manifest = manifestFromHtml(html);
    expect(manifest).toMatchObject({
      schema: "datalox.molecule.review_bundle",
      version: 1,
      workspace: {
        moleculeIds: [moleculeId],
      },
      artifacts: [
        { kind: "plasmid_map", path: path.join("reports", "maps", "review-map.svg") },
        { kind: "gel", path: path.join("reports", "gels", "review-gel.svg") },
      ],
    });
  });

  it("does not scan reports for artifacts that were not explicitly supplied", async () => {
    const { workspacePath, workspaceDir } = await importPuc19();
    await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "reports", "unlisted.txt"), "do not include", "utf8");

    const result = await renderReviewBundle(workspacePath);
    const html = await fs.readFile(result.outputPath, "utf8");

    expect(result.includedArtifacts).toEqual([]);
    expect(html).not.toContain("do not include");
    expect(html).toContain("No artifacts were provided.");
  });

  it("marks missing artifacts with a visible placeholder instead of failing", async () => {
    const { workspacePath } = await importPuc19();
    const result = await renderReviewBundle(workspacePath, {
      artifacts: [{ kind: "genbank", path: "reports/missing.gb", mimeType: "chemical/x-genbank" }],
    });
    const html = await fs.readFile(result.outputPath, "utf8");

    expect(result.includedArtifacts).toEqual([expect.objectContaining({
      kind: "genbank",
      missing: true,
    })]);
    expect(html).toContain("Missing artifact file.");
  });

  it("rejects malicious caller-supplied SVG instead of trusting the declared artifact kind", async () => {
    const { workspacePath, workspaceDir } = await importPuc19();
    const maliciousPath = path.join(workspaceDir, "reports", "maps", "crafted.svg");
    await fs.mkdir(path.dirname(maliciousPath), { recursive: true });
    await fs.writeFile(maliciousPath, `<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="javascript:alert(1)"><text onmouseover="alert(2)">x</text></a></svg>`, "utf8");

    const result = await renderReviewBundle(workspacePath, {
      artifacts: [{ kind: "plasmid_map", path: maliciousPath, mimeType: "image/svg+xml" }],
    });
    const html = await fs.readFile(result.outputPath, "utf8");

    expect(result.includedArtifacts).toEqual([expect.objectContaining({
      kind: "plasmid_map",
      rejected: true,
    })]);
    expect(html).toContain("SVG rejected:");
    expect(html).not.toContain("onmouseover=");
    expect(html).not.toContain("javascript:");
  });

  it("truncates oversized artifact input rather than emitting an unbounded HTML file", async () => {
    const { workspacePath, workspaceDir } = await importPuc19();
    const largePath = path.join(workspaceDir, "reports", "large.txt");
    await fs.mkdir(path.dirname(largePath), { recursive: true });
    await fs.writeFile(largePath, "A".repeat(MAX_REVIEW_BUNDLE_ARTIFACT_BYTES + 1), "utf8");

    const result = await renderReviewBundle(workspacePath, {
      artifacts: [{ kind: "blast_json", path: largePath, mimeType: "application/json" }],
    });
    const html = await fs.readFile(result.outputPath, "utf8");

    expect(result.includedArtifacts).toEqual([expect.objectContaining({
      kind: "blast_json",
      truncated: true,
    })]);
    expect(html).toContain("byte ceiling");
    expect(html).not.toContain("A".repeat(1000));
  });

  it("rejects artifact paths outside the workspace", async () => {
    const { workspacePath } = await importPuc19();

    await expect(renderReviewBundle(workspacePath, {
      artifacts: [{ kind: "genbank", path: path.resolve("package.json") }],
    })).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("can derive artifact and tool-call summary from an explicit replay bundle", async () => {
    const { workspaceDir, workspacePath, moleculeId } = await importPuc19();
    const recorder = createReplayRecorder();
    const rendered = await recordToolCall(recorder, "render_plasmid_map", {
      workspacePath,
      moleculeId,
      outputPath: "reports/maps/replay-map.svg",
    }, () => runToolHandler("render_plasmid_map", {
      workspacePath,
      moleculeId,
      outputPath: "reports/maps/replay-map.svg",
    }));
    expect(rendered.ok).toBe(true);
    const bundle = await packReplayBundle(recorder, { workspaceDir, workspacePath, bundleId: "review_test_bundle" });

    const result = await renderReviewBundle(workspacePath, {
      replayBundlePath: bundle.bundlePath,
    });
    const html = await fs.readFile(result.outputPath, "utf8");
    const manifest = manifestFromHtml(html);

    expect(result.provenanceBundleId).toBe("review_test_bundle");
    expect(result.provenanceVerified).toBe(true);
    expect(result.includedArtifacts).toEqual([expect.objectContaining({ kind: "plasmid_map" })]);
    expect(html).toContain("Replay Summary");
    expect(html).toContain("render_plasmid_map");
    expect(manifest.provenance).toMatchObject({
      bundleId: "review_test_bundle",
      verified: true,
      recordCount: 1,
      tools: ["render_plasmid_map"],
    });
  });

  it("returns a review_bundle artifact from the handler", async () => {
    const { workspacePath } = await importPuc19();
    const envelope = await runToolHandler("render_review_bundle", { workspacePath }) as ToolResultEnvelope;

    expect(envelope).toMatchObject({
      ok: true,
      tool: "render_review_bundle",
      artifacts: [
        {
          kind: "review_bundle",
          mimeType: "text/html",
        },
      ],
      nextAction: {
        tool: "validate_workspace",
      },
    });
  });
});

function manifestFromHtml(html: string): Record<string, any> {
  const match = html.match(/<script type="application\/json" id="datalox-review-manifest">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("review manifest script block was not found");
  return JSON.parse(match[1]);
}
