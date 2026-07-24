import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { exportReviewBundle, importSequenceFile, MAX_REVIEW_BUNDLE_ARTIFACT_BYTES } from "../src/index.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Minimal stored-ZIP reader (dependency-free) to round-trip entry names and bytes.
function readStoredZip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error("no end-of-central-directory record found");
  const count = buffer.readUInt16LE(eocd + 10);
  let cd = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cd) !== 0x02014b50) throw new Error("bad central directory signature");
    const nameLen = buffer.readUInt16LE(cd + 28);
    const extraLen = buffer.readUInt16LE(cd + 30);
    const commentLen = buffer.readUInt16LE(cd + 32);
    const localOffset = buffer.readUInt32LE(cd + 42);
    const name = buffer.toString("utf8", cd + 46, cd + 46 + nameLen);
    const lhNameLen = buffer.readUInt16LE(localOffset + 26);
    const lhExtraLen = buffer.readUInt16LE(localOffset + 28);
    const size = buffer.readUInt32LE(localOffset + 22);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    entries.set(name, buffer.subarray(dataStart, dataStart + size));
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function importFasta(): Promise<{ dir: string; workspacePath: string; moleculeId: string }> {
  const dir = await tempDir("mol-export-");
  const fa = path.join(dir, "in.fa");
  await fs.writeFile(fa, ">export demo\nACGTACGTACGTACGTACGT\n", "utf8");
  const imp = await importSequenceFile({ inputPath: fa, workspaceDir: dir, format: "fasta", moleculeId: "mol_export" });
  return { dir, workspacePath: imp.workspacePath, moleculeId: imp.moleculeIds[0] };
}

describe("export_review_bundle", () => {
  it("packages review.html, artifacts, workspace snapshot, and a manifest into a valid ZIP", async () => {
    const { dir, workspacePath } = await importFasta();
    await fs.mkdir(path.join(dir, "reports", "maps"), { recursive: true });
    const svgRel = path.join("reports", "maps", "map.svg");
    await fs.writeFile(path.join(dir, svgRel),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="10" height="10" fill="#000000"></rect></svg>', "utf8");

    const result = await exportReviewBundle(workspacePath, {
      artifacts: [{ kind: "plasmid_map", path: svgRel, mimeType: "image/svg+xml" }],
    });

    expect(result.relativePath).toBe(path.join("reports", "export", "review-bundle.zip").split(path.sep).join("/"));
    const zip = readStoredZip(await fs.readFile(result.outputPath));
    const names = [...zip.keys()];

    // required members present
    expect(names).toContain("review.html");
    expect(names).toContain("manifest.json");
    expect(names).toContain("workspace/molecule.workspace.json");
    expect(names).toContain("artifacts/reports/maps/map.svg");
    expect(names.some((n) => n.startsWith("workspace/data/sequences/"))).toBe(true);

    // round-tripped content is correct, not just present
    expect(zip.get("review.html")!.toString("utf8")).toContain("<!doctype html>");
    expect(zip.get("artifacts/reports/maps/map.svg")!.toString("utf8")).toContain("<rect");
    // workspace snapshot in the zip equals the real workspace file
    expect(zip.get("workspace/molecule.workspace.json")!.toString("utf8")).toBe(await fs.readFile(workspacePath, "utf8"));
    // manifest parses and indexes the entries
    const manifest = JSON.parse(zip.get("manifest.json")!.toString("utf8"));
    expect(manifest).toMatchObject({ schema: "datalox.molecule.export_bundle", version: 1, provenanceIncluded: false });
    expect(manifest.entries).toEqual(expect.arrayContaining(["review.html", "workspace/molecule.workspace.json"]));
    expect(result.provenanceIncluded).toBe(false);
  });

  it("rejects a bundle output path outside the workspace", async () => {
    const { workspacePath } = await importFasta();
    await expect(exportReviewBundle(workspacePath, { bundleOutputPath: "../escape.zip" }))
      .rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("does not package raw artifact files rejected by review-bundle safety checks", async () => {
    const { dir, workspacePath } = await importFasta();
    const maliciousRel = path.join("reports", "maps", "crafted.svg");
    await fs.mkdir(path.join(dir, "reports", "maps"), { recursive: true });
    await fs.writeFile(
      path.join(dir, maliciousRel),
      '<svg xmlns="http://www.w3.org/2000/svg"><text onload="alert(1)">unsafe</text></svg>',
      "utf8",
    );

    const result = await exportReviewBundle(workspacePath, {
      artifacts: [{ kind: "plasmid_map", path: maliciousRel, mimeType: "image/svg+xml" }],
    });
    const zip = readStoredZip(await fs.readFile(result.outputPath));
    const reviewHtml = zip.get("review.html")!.toString("utf8");

    expect(result.includedArtifacts).toEqual([expect.objectContaining({ rejected: true })]);
    expect([...zip.keys()]).not.toContain("artifacts/reports/maps/crafted.svg");
    expect(reviewHtml).toContain("SVG rejected:");
  });

  it("does not package raw artifact files omitted by the review-bundle byte ceiling", async () => {
    const { dir, workspacePath } = await importFasta();
    const largeRel = path.join("reports", "large.txt");
    await fs.mkdir(path.join(dir, "reports"), { recursive: true });
    await fs.writeFile(path.join(dir, largeRel), "A".repeat(MAX_REVIEW_BUNDLE_ARTIFACT_BYTES + 1), "utf8");

    const result = await exportReviewBundle(workspacePath, {
      artifacts: [{ kind: "blast_json", path: largeRel, mimeType: "application/json" }],
    });
    const zip = readStoredZip(await fs.readFile(result.outputPath));
    const reviewHtml = zip.get("review.html")!.toString("utf8");

    expect(result.includedArtifacts).toEqual([expect.objectContaining({ truncated: true })]);
    expect([...zip.keys()]).not.toContain("artifacts/reports/large.txt");
    expect(reviewHtml).toContain("byte ceiling");
  });
});
