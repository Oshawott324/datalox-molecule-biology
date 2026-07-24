import { promises as fs } from "node:fs";
import path from "node:path";

import { MoleculeError } from "./errors.js";
import { workspaceRootFromPath } from "./paths.js";
import {
  renderReviewBundle,
  type RenderReviewBundleOptions,
  type ReviewBundleIncludedArtifact,
} from "./review-bundle.js";
import type { MoleculeWorkspace } from "./schema.js";
import { PACKAGE_VERSION } from "./version.js";
import { readWorkspace } from "./workspace.js";
import { createStoredZip, type ZipEntry } from "./zip.js";

const DEFAULT_EXPORT_PATH = "reports/export/review-bundle.zip";

export type ExportReviewBundleOptions = RenderReviewBundleOptions & {
  bundleOutputPath?: string; // workspace-relative path for the .zip
};

export type ExportReviewBundleResult = {
  outputPath: string;
  relativePath: string;
  entryCount: number;
  entries: string[];
  includedArtifacts: ReviewBundleIncludedArtifact[];
  provenanceIncluded: boolean;
  provenanceBundleId?: string;
  revision: number;
};

// UI-4: a single portable ZIP that packages the human-readable review.html, the
// raw artifact files, a workspace snapshot, and (optionally) the provenance
// bundle. It is a thin packaging layer over render_review_bundle -- it does not
// define a new format, it collects existing outputs.
//
// The archive is NOT byte-deterministic: review.html embeds timestamps and may
// embed non-reproducible BLAST results, so the ZIP is a record, not a
// hash-pinned artifact. Keep it out of determinism gates and the eval corpus.
export async function exportReviewBundle(
  workspacePath: string,
  options: ExportReviewBundleOptions = {},
): Promise<ExportReviewBundleResult> {
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const exportRelative = confinedRelativePath(workspaceRoot, options.bundleOutputPath ?? DEFAULT_EXPORT_PATH, "bundleOutputPath");
  const exportAbsolute = path.join(workspaceRoot, exportRelative);

  const review = await renderReviewBundle(workspacePath, options);
  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: false });

  const entries: ZipEntry[] = [];

  // 1. Human-readable entry point at the archive root.
  entries.push({ name: "review.html", data: await fs.readFile(review.outputPath) });

  // 2. Raw artifact files, mirrored under artifacts/ at their workspace-relative
  //    path (collision-free). Skip artifacts that the review bundle could not
  //    safely inline; the HTML manifest still records their missing/rejected/
  //    truncated status.
  for (const artifact of review.includedArtifacts) {
    if (artifact.missing || artifact.rejected || artifact.truncated) continue;
    const relative = confinedRelativePath(workspaceRoot, artifact.path, "artifacts[].path");
    const data = await readFileIfPresent(path.join(workspaceRoot, relative));
    if (data) entries.push({ name: `artifacts/${relative}`, data });
  }

  // 3. Workspace snapshot: the canonical workspace file plus each molecule's
  //    stored sequence file, mirrored under workspace/.
  entries.push({ name: "workspace/molecule.workspace.json", data: await fs.readFile(workspacePath) });
  for (const relative of moleculeSequenceRelativePaths(workspace, workspaceRoot)) {
    const data = await readFileIfPresent(path.join(workspaceRoot, relative));
    if (data) entries.push({ name: `workspace/${relative}`, data });
  }

  // 4. Provenance bundle (manifest + records), if a replay bundle was provided.
  let provenanceIncluded = false;
  if (options.replayBundlePath !== undefined) {
    provenanceIncluded = await addProvenanceEntries(entries, workspaceRoot, options.replayBundlePath);
  }

  // 5. Export manifest at the root: the machine-readable index of the archive.
  const manifest = {
    schema: "datalox.molecule.export_bundle",
    version: 1,
    generatedAt: new Date().toISOString(),
    packageVersion: PACKAGE_VERSION,
    workspaceRevision: workspace.revision,
    moleculeIds: review.moleculeIds,
    provenanceBundleId: review.provenanceBundleId ?? null,
    provenanceIncluded,
    entries: entries.map((entry) => entry.name),
  };
  entries.push({ name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") });

  const archive = createStoredZip(entries);
  await fs.mkdir(path.dirname(exportAbsolute), { recursive: true });
  await fs.writeFile(exportAbsolute, archive);

  return {
    outputPath: exportAbsolute,
    relativePath: exportRelative,
    entryCount: entries.length,
    entries: entries.map((entry) => entry.name),
    includedArtifacts: review.includedArtifacts,
    provenanceIncluded,
    ...(review.provenanceBundleId ? { provenanceBundleId: review.provenanceBundleId } : {}),
    revision: review.revision,
  };
}

function moleculeSequenceRelativePaths(workspace: MoleculeWorkspace, workspaceRoot: string): string[] {
  const seen = new Set<string>();
  const relatives: string[] = [];
  for (const molecule of workspace.molecules) {
    const relative = confinedRelativePath(workspaceRoot, molecule.path, "molecule.path");
    if (seen.has(relative)) continue;
    seen.add(relative);
    relatives.push(relative);
  }
  return relatives;
}

async function addProvenanceEntries(entries: ZipEntry[], workspaceRoot: string, replayBundlePath: string): Promise<boolean> {
  const relative = confinedRelativePath(workspaceRoot, replayBundlePath, "replayBundlePath");
  const prefix = path.join(".datalox", "replay-bundles").split(path.sep).join("/");
  if (relative !== prefix && !relative.startsWith(`${prefix}/`)) {
    throw new MoleculeError("PATH_OUTSIDE_WORKSPACE", "replayBundlePath must point inside .datalox/replay-bundles/.", {
      path: replayBundlePath,
    });
  }
  const bundleRoot = path.join(workspaceRoot, relative);
  let added = false;
  for (const fileRelative of await listFilesRecursive(bundleRoot)) {
    const data = await fs.readFile(path.join(bundleRoot, fileRelative));
    entries.push({ name: `provenance/${fileRelative}`, data });
    added = true;
  }
  return added;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let dirEntries;
    try {
      dirEntries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    for (const dirEntry of dirEntries) {
      const childPrefix = prefix ? `${prefix}/${dirEntry.name}` : dirEntry.name;
      if (dirEntry.isDirectory()) {
        await walk(path.join(dir, dirEntry.name), childPrefix);
      } else if (dirEntry.isFile()) {
        out.push(childPrefix);
      }
    }
  }
  await walk(root, "");
  return out.sort();
}

async function readFileIfPresent(absolutePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function confinedRelativePath(workspaceRoot: string, candidate: string, field: string): string {
  const resolved = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MoleculeError("PATH_OUTSIDE_WORKSPACE", `${field} must stay inside the workspace.`, {
      path: candidate,
      workspaceRoot,
    });
  }
  return relative.split(path.sep).join("/");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
