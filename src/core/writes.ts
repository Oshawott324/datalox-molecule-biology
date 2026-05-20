import { promises as fs } from "node:fs";
import path from "node:path";

import { MoleculeError } from "./errors.js";
import { workspaceRootFromPath } from "./paths.js";
import type { CoordinateSegment, Feature, Molecule, Primer, PrimerBinding } from "./schema.js";
import { parseStoredSequenceContent, reverseComplement } from "./sequence.js";
import { writeWorkspaceTransaction, type WorkspaceTransactionResult } from "./workspace.js";

export type UpsertFeaturePayload = {
  featureId: string;
  action: "created" | "updated";
};

export type DeleteFeaturePayload = {
  featureId: string;
};

export type UpsertPrimerOptions = {
  bindToMolecule?: boolean;
};

export type UpsertPrimerPayload = {
  primerId: string;
  action: "created" | "updated";
  binding?: PrimerBinding;
};

export type DeletePrimerPayload = {
  primerId: string;
};

export async function upsertFeature(
  workspacePath: string,
  expectedRevision: number,
  feature: Feature,
): Promise<WorkspaceTransactionResult<UpsertFeaturePayload>> {
  return writeWorkspaceTransaction(workspacePath, expectedRevision, (workspace) => {
    const index = workspace.features.findIndex((candidate) => candidate.id === feature.id);
    const action = index === -1 ? "created" : "updated";
    if (index === -1) {
      workspace.features.push(feature);
    } else {
      workspace.features[index] = feature;
    }
    return { featureId: feature.id, action };
  });
}

export async function deleteFeature(
  workspacePath: string,
  expectedRevision: number,
  featureId: string,
): Promise<WorkspaceTransactionResult<DeleteFeaturePayload>> {
  return writeWorkspaceTransaction(workspacePath, expectedRevision, (workspace) => {
    const index = workspace.features.findIndex((feature) => feature.id === featureId);
    if (index === -1) {
      throw new MoleculeError("FEATURE_NOT_FOUND", "Feature was not found.", { featureId });
    }
    workspace.features.splice(index, 1);
    return { featureId };
  });
}

export async function upsertPrimer(
  workspacePath: string,
  expectedRevision: number,
  primer: Primer,
  options: UpsertPrimerOptions = {},
): Promise<WorkspaceTransactionResult<UpsertPrimerPayload>> {
  return writeWorkspaceTransaction(workspacePath, expectedRevision, async (workspace) => {
    const nextPrimer: Primer = options.bindToMolecule
      ? { ...primer, binding: await bindPrimerExact(workspacePath, workspace.molecules, primer) }
      : primer;
    const index = workspace.primers.findIndex((candidate) => candidate.id === nextPrimer.id);
    const action = index === -1 ? "created" : "updated";
    if (index === -1) {
      workspace.primers.push(nextPrimer);
    } else {
      workspace.primers[index] = nextPrimer;
    }
    return {
      primerId: nextPrimer.id,
      action,
      ...(nextPrimer.binding ? { binding: nextPrimer.binding } : {}),
    };
  });
}

export async function deletePrimer(
  workspacePath: string,
  expectedRevision: number,
  primerId: string,
): Promise<WorkspaceTransactionResult<DeletePrimerPayload>> {
  return writeWorkspaceTransaction(workspacePath, expectedRevision, (workspace) => {
    const index = workspace.primers.findIndex((primer) => primer.id === primerId);
    if (index === -1) {
      throw new MoleculeError("PRIMER_NOT_FOUND", "Primer was not found.", { primerId });
    }
    workspace.primers.splice(index, 1);
    return { primerId };
  });
}

async function bindPrimerExact(workspacePath: string, molecules: Molecule[], primer: Primer): Promise<PrimerBinding> {
  if (!primer.moleculeId) {
    throw new MoleculeError("INVALID_ARGUMENT", "bindToMolecule requires primer.moleculeId.", { primerId: primer.id });
  }
  const molecule = molecules.find((candidate) => candidate.id === primer.moleculeId);
  if (!molecule) {
    throw new MoleculeError("MOLECULE_NOT_FOUND", "Primer references a missing molecule.", { moleculeId: primer.moleculeId });
  }

  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const content = await fs.readFile(path.resolve(workspaceRoot, molecule.path), "utf8");
  const sequence = parseStoredSequenceContent(content, molecule.sourceFormat, molecule.alphabet);
  const segments = exactBindingSegments(sequence, primer.sequence);
  return { segments, mismatches: [] };
}

function exactBindingSegments(sequence: string, primerSequence: string): CoordinateSegment[] {
  const query = primerSequence.toUpperCase();
  return [
    ...findExactMatches(sequence, query, "+"),
    ...findExactMatches(reverseComplement(sequence), query, "-").map((segment) => ({
      start: sequence.length - segment.end + 1,
      end: sequence.length - segment.start + 1,
      strand: "-" as const,
    })),
  ];
}

function findExactMatches(sequence: string, query: string, strand: CoordinateSegment["strand"]): CoordinateSegment[] {
  const segments: CoordinateSegment[] = [];
  for (let index = sequence.indexOf(query); index !== -1; index = sequence.indexOf(query, index + 1)) {
    segments.push({ start: index + 1, end: index + query.length, strand });
  }
  return segments;
}
