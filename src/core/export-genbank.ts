import { promises as fs } from "node:fs";
import path from "node:path";

import { readMoleculeSequence } from "./context.js";
import { readWorkspace } from "./workspace.js";
import type { CoordinateSegment, Feature } from "./schema.js";

export type ExportGenBankResult = {
  moleculeId: string;
  outputPath: string;
  featureCount: number;
  sequenceLength: number;
};

export async function exportGenBank(workspacePath: string, moleculeId: string, outputPath: string): Promise<ExportGenBankResult> {
  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
  const { molecule, sequence } = await readMoleculeSequence(workspacePath, moleculeId);
  const features = workspace.features.filter((feature) => feature.moleculeId === moleculeId);
  const content = formatGenBank({
    name: molecule.name,
    length: molecule.length,
    topology: molecule.topology,
    moleculeType: molecule.moleculeType,
    description: molecule.description,
    sequence,
    features,
    date: formatGenBankDate(workspace.createdAt),
  });
  const resolvedOutputPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fs.writeFile(resolvedOutputPath, content, "utf8");
  return {
    moleculeId,
    outputPath: resolvedOutputPath,
    featureCount: features.length,
    sequenceLength: sequence.length,
  };
}

function formatGenBank(record: {
  name: string;
  length: number;
  topology: string;
  moleculeType: string;
  description?: string;
  sequence: string;
  features: Feature[];
  date: string;
}): string {
  const lines: string[] = [];
  lines.push(`LOCUS       ${record.name.padEnd(14).slice(0, 14)} ${String(record.length).padStart(7)} bp    ${record.moleculeType.toUpperCase().padEnd(6)} ${record.topology.padEnd(8)} ${record.date}`);
  lines.push(`DEFINITION  ${record.description ?? record.name}.`);
  lines.push("FEATURES             Location/Qualifiers");
  for (const feature of record.features) {
    lines.push(formatFeatureHeader(feature.type, formatLocation(feature.segments)));
    const qualifiers = { ...(feature.qualifiers ?? {}) };
    if (qualifiers.gene === undefined && qualifiers.label === undefined && qualifiers.product === undefined) {
      qualifiers.label = feature.name;
    }
    for (const [key, value] of Object.entries(qualifiers)) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        lines.push(formatQualifier(key, entry));
      }
    }
  }
  lines.push("ORIGIN");
  lines.push(...formatOrigin(record.sequence));
  lines.push("//");
  return `${lines.join("\n")}\n`;
}

function formatFeatureHeader(type: string, location: string): string {
  return `     ${type.padEnd(15)} ${location}`;
}

function formatLocation(segments: CoordinateSegment[]): string {
  const strand = segments.some((segment) => segment.strand === "-") ? "-" : "+";
  const ranges = segments.map((segment) => (segment.start === segment.end ? String(segment.start) : `${segment.start}..${segment.end}`));
  const joined = ranges.length === 1 ? ranges[0] : `join(${ranges.join(",")})`;
  return strand === "-" ? `complement(${joined})` : joined;
}

function formatQualifier(key: string, value: string): string {
  return `                     /${key}="${escapeQualifier(value)}"`;
}

function escapeQualifier(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatOrigin(sequence: string): string[] {
  const lower = sequence.toLowerCase();
  const lines: string[] = [];
  for (let index = 0; index < lower.length; index += 60) {
    const chunk = lower.slice(index, index + 60);
    const grouped = chunk.match(/.{1,10}/g)?.join(" ") ?? "";
    lines.push(`${String(index + 1).padStart(9)} ${grouped}`);
  }
  return lines;
}

function formatGenBankDate(isoDate: string): string {
  const date = new Date(isoDate);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${String(date.getUTCDate()).padStart(2, "0")}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}
