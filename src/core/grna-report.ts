import { promises as fs } from "node:fs";
import path from "node:path";

import { MoleculeError } from "./errors.js";
import { workspaceRootFromPath } from "./paths.js";
import type { GuideRecord } from "./schema.js";
import { readWorkspace } from "./workspace.js";

export type ExportGrnaReportOptions = {
  outputPath?: string;
};

export type ExportGrnaReportResult = {
  guideIds: string[];
  outputPath: string;
  relativePath: string;
  mimeType: "text/markdown";
  guideCount: number;
  reportsDetailedOffTargetHits: false;
  offTargetDetailInstruction: string;
};

export async function exportGrnaReport(
  workspacePath: string,
  guideIds: string[],
  options: ExportGrnaReportOptions = {},
): Promise<ExportGrnaReportResult> {
  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
  const ids = normalizeGuideIds(guideIds);
  const guides = ids.map((guideId) => {
    const guide = workspace.guides.find((candidate) => candidate.id === guideId);
    if (!guide) {
      throw new MoleculeError("GUIDE_NOT_FOUND", "Guide was not found.", { guideId });
    }
    return guide;
  });
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const relativePath = options.outputPath
    ? path.relative(workspaceRoot, path.isAbsolute(options.outputPath) ? options.outputPath : path.join(workspaceRoot, options.outputPath))
    : path.join("reports", "guides", `${safeReportId(ids)}.grna-report.md`);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new MoleculeError("INVALID_ARGUMENT", "gRNA report outputPath must stay inside the workspace.", {
      outputPath: options.outputPath,
      workspaceRoot,
    });
  }
  const outputPath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, formatGrnaReport(guides), "utf8");
  return {
    guideIds: ids,
    outputPath,
    relativePath,
    mimeType: "text/markdown",
    guideCount: guides.length,
    reportsDetailedOffTargetHits: false,
    offTargetDetailInstruction: "Persisted guide records store offTargetHitCount and offTargetScope only. Rerun design_grnas with the same target/options to inspect full off-target hit rows.",
  };
}

function normalizeGuideIds(guideIds: string[]): string[] {
  if (!Array.isArray(guideIds) || guideIds.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "guideIds must contain at least one guide id.", { guideIds });
  }
  const ids = guideIds.map((guideId) => {
    if (typeof guideId !== "string" || guideId.length === 0) {
      throw new MoleculeError("INVALID_ARGUMENT", "guideIds must be non-empty strings.", { guideIds });
    }
    return guideId;
  });
  if (new Set(ids).size !== ids.length) {
    throw new MoleculeError("INVALID_ARGUMENT", "guideIds must not contain duplicates.", { guideIds });
  }
  return ids;
}

function safeReportId(guideIds: string[]): string {
  const joined = guideIds.join("_").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
  return joined.length > 0 ? joined : "selected_guides";
}

function formatGrnaReport(guides: GuideRecord[]): string {
  const lines: string[] = [];
  lines.push("# gRNA Report");
  lines.push("");
  lines.push("CR1 SpCas9 guide report. No validated on-target efficacy score is included.");
  lines.push("");
  lines.push("| Guide | Molecule | Strand | Coordinates | PAM | GC % | Filters | Workspace off-target count |");
  lines.push("|---|---|---:|---|---|---:|---|---:|");
  for (const guide of guides) {
    lines.push([
      escapeMarkdown(guide.name),
      escapeMarkdown(guide.moleculeId),
      guide.strand,
      `${guide.start}..${guide.end}`,
      escapeMarkdown(guide.pam),
      formatNumber(guide.gcPercent),
      guide.rankingEvidence.filterFailures.length === 0 ? "pass" : escapeMarkdown(guide.rankingEvidence.filterFailures.join(", ")),
      String(guide.offTargetHitCount),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  for (const guide of guides) {
    lines.push(`## ${guide.id}`);
    lines.push("");
    lines.push(`- Name: ${guide.name}`);
    lines.push(`- Molecule: ${guide.moleculeId}`);
    lines.push(`- Sequence: ${guide.sequence}`);
    lines.push(`- PAM: ${guide.pam} (${guide.pamType})`);
    lines.push(`- Strand: ${guide.strand}`);
    lines.push(`- Protospacer coordinates: ${guide.start}..${guide.end}`);
    lines.push(`- PAM coordinates: ${guide.pamStart}..${guide.pamEnd}`);
    lines.push(`- GC percent: ${formatNumber(guide.gcPercent)}`);
    lines.push(`- Seed max homopolymer run: ${guide.seedRegionMaxHomopolymer}`);
    lines.push(`- Off-target scope: ${guide.offTargetScope}`);
    lines.push(`- Workspace off-target count: ${guide.offTargetHitCount}`);
    lines.push(`- Passing filters: ${guide.rankingEvidence.passingFilters}`);
    lines.push(`- Filter failures: ${guide.rankingEvidence.filterFailures.length === 0 ? "none" : guide.rankingEvidence.filterFailures.join(", ")}`);
    lines.push(`- GC distance from 50: ${formatNumber(guide.rankingEvidence.gcDistanceFrom50)}`);
    lines.push(`- Efficacy score included: ${guide.rankingEvidence.efficacyScoreIncluded}`);
    lines.push("");
  }
  lines.push("## Evidence Boundary");
  lines.push("");
  lines.push("- This report uses persisted guide records from the workspace.");
  lines.push("- CR1 does not include genome-scale off-target search.");
  lines.push("- CR1 does not include validated Azimuth/Doench on-target efficacy scoring.");
  lines.push("- Detailed off-target hit rows are not persisted in guide records. Rerun `design_grnas` with the same target/options to inspect full workspace off-target hits.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
