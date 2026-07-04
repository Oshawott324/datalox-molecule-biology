import { promises as fs } from "node:fs";
import path from "node:path";

import { extractSegments, validateSegments } from "./coordinates.js";
import { MoleculeError } from "./errors.js";
import { workspaceRootFromPath } from "./paths.js";
import type { CoordinateSegment, Feature, GuideRecord, Molecule, Primer } from "./schema.js";
import { parseStoredSequenceContent } from "./sequence.js";
import { readWorkspace } from "./workspace.js";

export type SequenceContextOptions = {
  region?: CoordinateSegment;
  includeSequence?: boolean;
  includeFeatures?: boolean;
  includePrimers?: boolean;
  includeGuides?: boolean;
};

export type MoleculeSummary = Pick<Molecule, "id" | "name" | "length" | "topology" | "moleculeType" | "alphabet" | "sourceFormat" | "sequenceDigest">;

export type SequenceContext = {
  molecule: MoleculeSummary;
  revision: number;
  region?: {
    start: number;
    end: number;
    strand: CoordinateSegment["strand"];
    length: number;
  };
  sequence?: string;
  features?: Feature[];
  primers?: Primer[];
  guides?: GuideRecord[];
};

export async function listMoleculeSummaries(workspacePath: string): Promise<{ revision: number; molecules: MoleculeSummary[] }> {
  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
  return {
    revision: workspace.revision,
    molecules: workspace.molecules.map(toMoleculeSummary),
  };
}

export async function readMoleculeSequence(workspacePath: string, moleculeId: string): Promise<{ molecule: Molecule; sequence: string; revision: number }> {
  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
  const molecule = workspace.molecules.find((candidate) => candidate.id === moleculeId);
  if (!molecule) {
    throw new MoleculeError("MOLECULE_NOT_FOUND", "Molecule was not found.", { moleculeId });
  }
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const content = await fs.readFile(path.resolve(workspaceRoot, molecule.path), "utf8");
  return {
    molecule,
    sequence: parseStoredSequenceContent(content, molecule.sourceFormat, molecule.alphabet),
    revision: workspace.revision,
  };
}

export async function getSequenceContext(
  workspacePath: string,
  moleculeId: string,
  options: SequenceContextOptions = {},
): Promise<SequenceContext> {
  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
  const molecule = workspace.molecules.find((candidate) => candidate.id === moleculeId);
  if (!molecule) {
    throw new MoleculeError("MOLECULE_NOT_FOUND", "Molecule was not found.", { moleculeId });
  }

  const region = options.region ? normalizeRegion(options.region, molecule.length) : undefined;
  const context: SequenceContext = {
    molecule: toMoleculeSummary(molecule),
    revision: workspace.revision,
    ...(region ? { region: { start: region.start, end: region.end, strand: region.strand, length: region.end - region.start + 1 } } : {}),
  };

  if (options.includeSequence) {
    const workspaceRoot = workspaceRootFromPath(workspacePath);
    const content = await fs.readFile(path.resolve(workspaceRoot, molecule.path), "utf8");
    const sequence = parseStoredSequenceContent(content, molecule.sourceFormat, molecule.alphabet);
    context.sequence = region ? extractSegments(sequence, [region]) : sequence;
  }

  if (options.includeFeatures ?? true) {
    context.features = region ? workspace.features.filter((feature) => feature.moleculeId === moleculeId && overlapsRegion(feature.segments, region)) : workspace.features.filter((feature) => feature.moleculeId === moleculeId);
  }

  if (options.includePrimers ?? true) {
    context.primers = region
      ? workspace.primers.filter((primer) => primer.moleculeId === moleculeId && primer.binding && overlapsRegion(primer.binding.segments, region))
      : workspace.primers.filter((primer) => primer.moleculeId === moleculeId);
  }

  if (options.includeGuides ?? true) {
    context.guides = region
      ? workspace.guides.filter((guide) => guide.moleculeId === moleculeId && overlapsRegion([{ start: guide.start, end: guide.end, strand: guide.strand }], region))
      : workspace.guides.filter((guide) => guide.moleculeId === moleculeId);
  }

  return context;
}

function toMoleculeSummary(molecule: Molecule): MoleculeSummary {
  return {
    id: molecule.id,
    name: molecule.name,
    length: molecule.length,
    topology: molecule.topology,
    moleculeType: molecule.moleculeType,
    alphabet: molecule.alphabet,
    sourceFormat: molecule.sourceFormat,
    sequenceDigest: molecule.sequenceDigest,
  };
}

function normalizeRegion(region: CoordinateSegment, moleculeLength: number): CoordinateSegment {
  const issues = validateSegments([region], moleculeLength, "region");
  if (issues.length > 0) {
    throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Region coordinates are invalid.", { issues });
  }
  return region;
}

function overlapsRegion(segments: CoordinateSegment[], region: CoordinateSegment): boolean {
  return segments.some((segment) => segment.start <= region.end && segment.end >= region.start);
}
