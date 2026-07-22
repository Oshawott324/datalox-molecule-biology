import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";

import { MoleculeError } from "./errors.js";
import { workspaceRootFromPath } from "./paths.js";
import type { MoleculeWorkspace } from "./schema.js";
import { PACKAGE_VERSION } from "./version.js";
import { readWorkspace } from "./workspace.js";
import { verifyReplayBundle, type ReplayBundleManifest, type ReplayToolRecord } from "../replay/bundle.js";

export type ReviewBundleArtifactInput = {
  kind: string;
  path: string;
  mimeType?: string;
  description?: string;
};

export type ReviewBundleIncludedArtifact = {
  kind: string;
  path: string;
  mimeType?: string;
  description?: string;
  missing?: boolean;
  rejected?: boolean;
  truncated?: boolean;
  reason?: string;
  bytes?: number;
};

export type RenderReviewBundleOptions = {
  outputPath?: string;
  artifacts?: ReviewBundleArtifactInput[];
  replayBundlePath?: string;
  includeReplaySummary?: boolean;
  moleculeIds?: string[];
  includeLocalPaths?: boolean;
};

export type RenderReviewBundleResult = {
  outputPath: string;
  relativePath: string;
  mimeType: "text/html";
  moleculeIds: string[];
  includedArtifacts: ReviewBundleIncludedArtifact[];
  provenanceBundleId?: string;
  provenanceVerified?: boolean;
  revision: number;
};

type ResolvedArtifact = ReviewBundleArtifactInput & {
  resolvedPath: string;
  relativePath: string;
};

type ReplaySummary = {
  bundleId: string;
  verified: boolean;
  recordCount: number;
  tools: string[];
  records: Array<{
    index: number;
    toolName: string;
    ok?: boolean;
    artifactKinds: string[];
  }>;
};

const DEFAULT_OUTPUT_PATH = path.join("reports", "review", "review.html");
export const MAX_REVIEW_BUNDLE_ARTIFACT_BYTES = 512_000;

const SVG_ARTIFACT_KINDS = new Set(["plasmid_map", "gel"]);
const ALLOWED_SVG_TAGS = new Set([
  "svg",
  "style",
  "defs",
  "marker",
  "path",
  "g",
  "circle",
  "line",
  "rect",
  "text",
  "title",
  "tspan",
]);
const ALLOWED_SVG_ATTRIBUTES = new Set([
  "xmlns",
  "width",
  "height",
  "viewBox",
  "role",
  "aria-label",
  "class",
  "id",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "d",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-dasharray",
  "text-anchor",
  "dominant-baseline",
  "font-weight",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
  "markerUnits",
  "marker-end",
  "transform",
  "opacity",
]);

export async function renderReviewBundle(
  workspacePath: string,
  options: RenderReviewBundleOptions = {},
): Promise<RenderReviewBundleResult> {
  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const relativePath = workspaceRelativeOutputPath(workspaceRoot, options.outputPath ?? DEFAULT_OUTPUT_PATH, "outputPath");
  const outputPath = path.join(workspaceRoot, relativePath);
  const moleculeIds = selectedMoleculeIds(workspace, options.moleculeIds);
  const replay = options.replayBundlePath
    ? await readReplaySummary(workspaceRoot, options.replayBundlePath)
    : undefined;
  const includeReplaySummary = options.includeReplaySummary ?? replay !== undefined;
  const artifactInputs = [
    ...normalizeArtifactInputs(options.artifacts ?? [], "artifacts"),
    ...(replay ? replay.artifacts : []),
  ];
  const uniqueArtifacts = uniqueArtifactInputs(artifactInputs);
  const renderedArtifacts = await renderArtifactSections(workspaceRoot, uniqueArtifacts);
  const manifest = {
    schema: "datalox.molecule.review_bundle",
    version: 1,
    generatedAt: new Date().toISOString(),
    packageVersion: PACKAGE_VERSION,
    workspace: {
      workspaceId: workspace.workspaceId,
      revision: workspace.revision,
      moleculeIds,
      ...(options.includeLocalPaths ? { workspacePath } : {}),
    },
    artifacts: renderedArtifacts.included,
    ...(replay ? { provenance: replay.summary } : {}),
  };
  const html = renderHtml({
    workspace,
    moleculeIds,
    includeLocalPaths: options.includeLocalPaths ?? false,
    artifactHtml: renderedArtifacts.html,
    manifest,
    replaySummary: includeReplaySummary ? replay?.summary : undefined,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, "utf8");

  return {
    outputPath,
    relativePath,
    mimeType: "text/html",
    moleculeIds,
    includedArtifacts: renderedArtifacts.included,
    ...(replay ? { provenanceBundleId: replay.summary.bundleId } : {}),
    ...(replay ? { provenanceVerified: replay.summary.verified } : {}),
    revision: workspace.revision,
  };
}

function selectedMoleculeIds(workspace: MoleculeWorkspace, requested: string[] | undefined): string[] {
  if (requested === undefined) return workspace.molecules.map((molecule) => molecule.id);
  const known = new Set(workspace.molecules.map((molecule) => molecule.id));
  return requested.map((moleculeId, index) => {
    if (typeof moleculeId !== "string" || moleculeId.length === 0) {
      throw new MoleculeError("INVALID_ARGUMENT", "moleculeIds entries must be non-empty strings.", { index, moleculeId });
    }
    if (!known.has(moleculeId)) {
      throw new MoleculeError("MOLECULE_NOT_FOUND", "Requested moleculeId was not found in the workspace.", { moleculeId });
    }
    return moleculeId;
  });
}

function normalizeArtifactInputs(artifacts: ReviewBundleArtifactInput[], field: string): ReviewBundleArtifactInput[] {
  if (!Array.isArray(artifacts)) {
    throw new MoleculeError("INVALID_ARGUMENT", `${field} must be an array.`, { [field]: artifacts });
  }
  return artifacts.map((artifact, index) => {
    if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
      throw new MoleculeError("INVALID_ARGUMENT", `${field} entries must be objects.`, { index, artifact });
    }
    if (typeof artifact.kind !== "string" || artifact.kind.length === 0) {
      throw new MoleculeError("INVALID_ARGUMENT", `${field}[].kind must be a non-empty string.`, { index, artifact });
    }
    if (typeof artifact.path !== "string" || artifact.path.length === 0) {
      throw new MoleculeError("INVALID_ARGUMENT", `${field}[].path must be a non-empty string.`, { index, artifact });
    }
    return {
      kind: artifact.kind,
      path: artifact.path,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
    };
  });
}

function uniqueArtifactInputs(artifacts: ReviewBundleArtifactInput[]): ReviewBundleArtifactInput[] {
  const seen = new Set<string>();
  const result: ReviewBundleArtifactInput[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.kind}\n${artifact.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(artifact);
  }
  return result;
}

async function renderArtifactSections(
  workspaceRoot: string,
  artifacts: ReviewBundleArtifactInput[],
): Promise<{ html: string[]; included: ReviewBundleIncludedArtifact[] }> {
  const html: string[] = [];
  const included: ReviewBundleIncludedArtifact[] = [];
  let totalBytes = 0;
  for (const artifact of artifacts) {
    const resolved = resolveArtifactPath(workspaceRoot, artifact);
    const base: ReviewBundleIncludedArtifact = {
      kind: artifact.kind,
      path: resolved.relativePath,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
    };
    let content: string | undefined;
    try {
      content = await fs.readFile(resolved.resolvedPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        included.push({ ...base, missing: true, reason: "artifact file was not found" });
        html.push(artifactPlaceholder(base, "Missing artifact file."));
        continue;
      }
      throw error;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (totalBytes + bytes > MAX_REVIEW_BUNDLE_ARTIFACT_BYTES) {
      included.push({ ...base, truncated: true, bytes, reason: "review bundle artifact byte ceiling exceeded" });
      html.push(artifactPlaceholder(base, "Artifact omitted because the review bundle byte ceiling was reached."));
      continue;
    }
    totalBytes += bytes;

    if (SVG_ARTIFACT_KINDS.has(artifact.kind) && (artifact.mimeType === "image/svg+xml" || resolved.relativePath.toLowerCase().endsWith(".svg"))) {
      const validation = validateInlineSvg(content);
      if (!validation.ok) {
        included.push({ ...base, rejected: true, bytes, reason: validation.reason });
        html.push(artifactPlaceholder(base, `SVG rejected: ${validation.reason}`));
        continue;
      }
      included.push({ ...base, bytes });
      html.push(`<section class="artifact artifact-svg"><h2>${escapeHtml(artifactTitle(base))}</h2>${content}</section>`);
      continue;
    }

    included.push({ ...base, bytes });
    html.push(`<section class="artifact artifact-text"><h2>${escapeHtml(artifactTitle(base))}</h2><pre>${escapeHtml(content)}</pre></section>`);
  }
  return { html, included };
}

function resolveArtifactPath(workspaceRoot: string, artifact: ReviewBundleArtifactInput): ResolvedArtifact {
  const resolvedPath = path.isAbsolute(artifact.path) ? path.resolve(artifact.path) : path.resolve(workspaceRoot, artifact.path);
  const relativePath = path.relative(workspaceRoot, resolvedPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new MoleculeError("PATH_OUTSIDE_WORKSPACE", "Review bundle artifact paths must stay inside the workspace.", {
      artifactPath: artifact.path,
      workspaceRoot,
    });
  }
  return { ...artifact, resolvedPath, relativePath };
}

function workspaceRelativeOutputPath(workspaceRoot: string, outputPath: string, field: string): string {
  const resolved = path.isAbsolute(outputPath) ? path.resolve(outputPath) : path.resolve(workspaceRoot, outputPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MoleculeError("PATH_OUTSIDE_WORKSPACE", `${field} must stay inside the workspace.`, {
      [field]: outputPath,
      workspaceRoot,
    });
  }
  return relative;
}

async function readReplaySummary(
  workspaceRoot: string,
  replayBundlePath: string,
): Promise<{ summary: ReplaySummary; artifacts: ReviewBundleArtifactInput[] }> {
  const resolvedBundlePath = path.isAbsolute(replayBundlePath)
    ? path.resolve(replayBundlePath)
    : path.resolve(workspaceRoot, replayBundlePath);
  const relativeToWorkspace = path.relative(workspaceRoot, resolvedBundlePath);
  const expectedPrefix = path.join(".datalox", "replay-bundles");
  if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace) || !relativeToWorkspace.startsWith(expectedPrefix)) {
    throw new MoleculeError("PATH_OUTSIDE_WORKSPACE", "replayBundlePath must point inside workspace .datalox/replay-bundles/.", {
      replayBundlePath,
      workspaceRoot,
    });
  }
  const manifest = JSON.parse(await fs.readFile(path.join(resolvedBundlePath, "manifest.json"), "utf8")) as ReplayBundleManifest;
  const verification = await verifyReplayBundle(resolvedBundlePath);
  if (!verification.ok) {
    throw new MoleculeError("INVALID_ARGUMENT", "Replay bundle failed verification and cannot be summarized in a review bundle.", {
      replayBundlePath,
      issues: verification.issues,
    });
  }
  const records: ReplaySummary["records"] = [];
  const artifacts: ReviewBundleArtifactInput[] = [];
  for (const manifestRecord of manifest.records ?? []) {
    if (typeof manifestRecord.path !== "string" || path.isAbsolute(manifestRecord.path)) continue;
    const recordPath = path.resolve(resolvedBundlePath, manifestRecord.path);
    const relativeToRecords = path.relative(path.join(resolvedBundlePath, "records"), recordPath);
    if (relativeToRecords.startsWith("..") || path.isAbsolute(relativeToRecords)) continue;
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as ReplayToolRecord;
    const observation = record.observation;
    const observationArtifacts = extractObservationArtifacts(observation);
    artifacts.push(...observationArtifacts);
    records.push({
      index: record.index,
      toolName: record.toolName,
      ok: observationOk(observation),
      artifactKinds: observationArtifacts.map((artifact) => artifact.kind),
    });
  }
  return {
    summary: {
      bundleId: manifest.bundleId,
      verified: true,
      recordCount: records.length,
      tools: records.map((record) => record.toolName),
      records,
    },
    artifacts,
  };
}

function extractObservationArtifacts(value: unknown): ReviewBundleArtifactInput[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const artifacts = (value as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts.flatMap((artifact) => {
    if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) return [];
    const candidate = artifact as { kind?: unknown; path?: unknown; mimeType?: unknown; description?: unknown };
    if (typeof candidate.kind !== "string" || typeof candidate.path !== "string") return [];
    return [{
      kind: candidate.kind,
      path: candidate.path,
      ...(typeof candidate.mimeType === "string" ? { mimeType: candidate.mimeType } : {}),
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
    }];
  });
}

function observationOk(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const ok = (value as { ok?: unknown }).ok;
  return typeof ok === "boolean" ? ok : undefined;
}

function validateInlineSvg(svg: string): { ok: true } | { ok: false; reason: string } {
  if (!/^\s*(<\?xml\b[^?]*\?>\s*)?<svg\b/i.test(svg)) return { ok: false, reason: "artifact is not SVG text" };
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(svg)) return { ok: false, reason: "SVG doctype/entity declarations are not allowed" };
  if (/<\s*(foreignObject|image|use)\b/i.test(svg)) return { ok: false, reason: "SVG contains a disallowed element" };
  for (const styleMatch of svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (/url\s*\(|@import/i.test(styleMatch[1])) return { ok: false, reason: "SVG style contains external reference syntax" };
  }

  const tagPattern = /<\s*(\/?)([A-Za-z][A-Za-z0-9:-]*)([^<>]*)>/g;
  for (const match of svg.matchAll(tagPattern)) {
    const closing = match[1] === "/";
    const tag = match[2];
    const attrs = match[3] ?? "";
    if (!ALLOWED_SVG_TAGS.has(tag)) return { ok: false, reason: `SVG element is not allowed: ${tag}` };
    if (!closing) {
      const attrCheck = validateSvgAttributes(attrs);
      if (!attrCheck.ok) return attrCheck;
    }
  }
  return { ok: true };
}

function validateSvgAttributes(source: string): { ok: true } | { ok: false; reason: string } {
  let rest = source.replace(/\/\s*$/, "");
  const attrPattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(attrPattern)) {
    const name = match[1];
    const value = match[3] ?? match[4] ?? "";
    rest = rest.replace(match[0], "");
    if (/^on/i.test(name)) return { ok: false, reason: `SVG event attribute is not allowed: ${name}` };
    if (name === "href" || name === "xlink:href") return { ok: false, reason: `SVG href attribute is not allowed: ${name}` };
    if (!ALLOWED_SVG_ATTRIBUTES.has(name)) return { ok: false, reason: `SVG attribute is not allowed: ${name}` };
    if (name === "xmlns" && value !== "http://www.w3.org/2000/svg") {
      return { ok: false, reason: "SVG namespace is not allowed" };
    }
    if (name !== "xmlns" && /(javascript|data|https?|file)\s*:/i.test(value)) {
      return { ok: false, reason: "SVG attribute contains a disallowed URI scheme" };
    }
    if (name === "marker-end" && !/^url\(#[A-Za-z0-9_.:-]+\)$/.test(value)) {
      return { ok: false, reason: "SVG marker-end must reference a local marker id" };
    }
  }
  if (rest.trim().length > 0) return { ok: false, reason: "SVG contains malformed or unquoted attributes" };
  return { ok: true };
}

function renderHtml(input: {
  workspace: MoleculeWorkspace;
  moleculeIds: string[];
  includeLocalPaths: boolean;
  artifactHtml: string[];
  manifest: unknown;
  replaySummary?: ReplaySummary;
}): string {
  const molecules = input.workspace.molecules.filter((molecule) => input.moleculeIds.includes(molecule.id));
  const replayRows = input.replaySummary
    ? input.replaySummary.records.map((record) => `<tr><td>${record.index}</td><td>${escapeHtml(record.toolName)}</td><td>${record.ok === undefined ? "unknown" : String(record.ok)}</td><td>${escapeHtml(record.artifactKinds.join(", "))}</td></tr>`).join("\n")
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Datalox Molecule Review Bundle</title>
  <style>
    body { margin: 24px; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2927; background: #ffffff; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 22px 0 10px; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0 18px; font-size: 13px; }
    th, td { border: 1px solid #d8dfdd; padding: 7px 8px; text-align: left; vertical-align: top; }
    th { background: #eef4f2; }
    pre { overflow: auto; white-space: pre-wrap; background: #f6f8f7; border: 1px solid #d8dfdd; padding: 10px; }
    .meta { color: #5d6a66; font-size: 13px; }
    .artifact { border-top: 1px solid #d8dfdd; padding-top: 8px; margin-top: 12px; }
    .placeholder { border: 1px dashed #a8b5b1; background: #fbfcfc; padding: 10px; color: #5d6a66; }
    svg { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <h1>Datalox Molecule Review Bundle</h1>
  <div class="meta">Workspace ${escapeHtml(input.workspace.workspaceId)} at revision ${input.workspace.revision}; generated by @datalox/molecule-biology ${escapeHtml(PACKAGE_VERSION)}.</div>
  ${input.includeLocalPaths ? `<div class="meta">Local paths included for local review only.</div>` : ""}
  <h2>Molecules</h2>
  <table><thead><tr><th>ID</th><th>Name</th><th>Length</th><th>Topology</th><th>Type</th><th>Digest</th></tr></thead><tbody>
  ${molecules.map((molecule) => `<tr><td>${escapeHtml(molecule.id)}</td><td>${escapeHtml(molecule.name)}</td><td>${molecule.length}</td><td>${escapeHtml(molecule.topology)}</td><td>${escapeHtml(molecule.moleculeType)}</td><td>${escapeHtml(molecule.sequenceDigest)}</td></tr>`).join("\n")}
  </tbody></table>
  ${input.replaySummary ? `<h2>Replay Summary</h2><div class="meta">Bundle ${escapeHtml(input.replaySummary.bundleId)}; verified ${String(input.replaySummary.verified)}; ${input.replaySummary.recordCount} records.</div><table><thead><tr><th>#</th><th>Tool</th><th>OK</th><th>Artifacts</th></tr></thead><tbody>${replayRows}</tbody></table>` : ""}
  <h2>Artifacts</h2>
  ${input.artifactHtml.length > 0 ? input.artifactHtml.join("\n") : `<div class="placeholder">No artifacts were provided.</div>`}
  <script type="application/json" id="datalox-review-manifest">${escapeJsonForScript(input.manifest)}</script>
</body>
</html>
`;
}

function artifactTitle(artifact: ReviewBundleIncludedArtifact): string {
  return artifact.description ? `${artifact.kind}: ${artifact.description}` : artifact.kind;
}

function artifactPlaceholder(artifact: ReviewBundleIncludedArtifact, message: string): string {
  return `<section class="artifact"><h2>${escapeHtml(artifactTitle(artifact))}</h2><div class="placeholder">${escapeHtml(message)} Path: ${escapeHtml(artifact.path)}</div></section>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
