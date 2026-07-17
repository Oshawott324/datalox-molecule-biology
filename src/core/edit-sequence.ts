import { promises as fs } from "node:fs";
import path from "node:path";

import { MoleculeError } from "./errors.js";
import { formatSingleRecordFasta } from "./fasta.js";
import { formatGenBank } from "./export-genbank.js";
import { workspaceRootFromPath } from "./paths.js";
import type { CoordinateSegment, Feature, Molecule, SourceFormat } from "./schema.js";
import { normalizeSequence, parseStoredSequenceContent, sequenceDigest } from "./sequence.js";
import { writeStoredSequenceFile } from "./sequence-storage.js";
import { writeWorkspaceTransaction } from "./workspace.js";

export type EditSequenceOperation = "insert" | "delete" | "replace" | "mutate";
export type FeatureImpactKind = "unaffected" | "shifted" | "resized" | "truncated" | "split" | "deleted";

export type EditSequenceInput = {
  workspacePath: string;
  moleculeId: string;
  expectedRevision: number;
  operation: EditSequenceOperation;
  start: number;
  end?: number;
  sequence?: string;
};

export type FeatureImpact = {
  featureId: string;
  name: string;
  impact: FeatureImpactKind;
  frameShifted?: boolean;
  beforeSegments: CoordinateSegment[];
  afterSegments: CoordinateSegment[] | null;
  boundingSpan: { start: number; end: number } | null;
  notes: string[];
};

export type EditSequenceResult = {
  moleculeId: string;
  operation: EditSequenceOperation;
  lengthBefore: number;
  lengthAfter: number;
  delta: number;
  diffSummary: string;
  sequenceDigest: string;
  storedSequencePath: string;
  featureImpact: FeatureImpact[];
  previousRevision: number;
  revision: number;
  nextAction: {
    tool: "validate_workspace";
    instruction: string;
  };
};

type NormalizedEdit = {
  operation: EditSequenceOperation;
  start: number;
  end: number;
  insertedSequence: string;
  deletedLength: number;
  insertLength: number;
  delta: number;
};

type RemappedSegment = {
  segment: CoordinateSegment | null;
  impact: FeatureImpactKind;
};

export async function editSequence(input: EditSequenceInput): Promise<EditSequenceResult> {
  const transaction = await writeWorkspaceTransaction(input.workspacePath, input.expectedRevision, async (workspace) => {
    const molecule = workspace.molecules.find((candidate) => candidate.id === input.moleculeId);
    if (!molecule) {
      throw new MoleculeError("MOLECULE_NOT_FOUND", "Molecule was not found.", { moleculeId: input.moleculeId });
    }
    if (molecule.moleculeType === "protein" || molecule.alphabet === "protein") {
      throw new MoleculeError("INVALID_ARGUMENT", "edit_sequence only supports nucleotide molecules.", {
        moleculeId: molecule.id,
        moleculeType: molecule.moleculeType,
        alphabet: molecule.alphabet,
      });
    }

    const workspaceRoot = workspaceRootFromPath(input.workspacePath);
    const storedContent = await fs.readFile(path.resolve(workspaceRoot, molecule.path), "utf8");
    const currentSequence = parseStoredSequenceContent(storedContent, molecule.sourceFormat, molecule.alphabet);
    const edit = normalizeEdit(input, molecule, currentSequence.length);
    const editedSequence = applyEdit(currentSequence, edit);
    if (editedSequence === currentSequence) {
      throw new MoleculeError("NO_CHANGE", "edit_sequence produced no sequence change.", {
        moleculeId: molecule.id,
        operation: input.operation,
        start: input.start,
        end: input.end,
      });
    }

    const originalFeatures = workspace.features.filter((feature) => feature.moleculeId === molecule.id);
    const impacts = originalFeatures.map((feature) => remapFeature(feature, edit));
    const keptFeatureIds = new Set(impacts.filter((impact) => impact.afterSegments !== null).map((impact) => impact.featureId));
    workspace.features = workspace.features
      .filter((feature) => feature.moleculeId !== molecule.id || keptFeatureIds.has(feature.id))
      .map((feature) => {
        if (feature.moleculeId !== molecule.id) return feature;
        const impact = impacts.find((candidate) => candidate.featureId === feature.id);
        if (!impact?.afterSegments) return feature;
        return { ...feature, segments: impact.afterSegments, source: { kind: "tool", tool: "edit_sequence" } };
      });

    const digest = sequenceDigest(editedSequence);
    const content = formatStoredSequence(molecule, workspace.features.filter((feature) => feature.moleculeId === molecule.id), editedSequence, workspace.createdAt);
    const extension = molecule.sourceFormat === "genbank" ? ".gb" : ".fa";
    const stored = await writeStoredSequenceFile({
      workspacePath: input.workspacePath,
      preferredFileName: `${molecule.id}.${digest.slice("sha256:".length)}${extension}`,
      content,
    });

    molecule.path = stored.relativePath;
    molecule.length = editedSequence.length;
    molecule.sequenceDigest = digest;

    return {
      moleculeId: molecule.id,
      operation: edit.operation,
      lengthBefore: currentSequence.length,
      lengthAfter: editedSequence.length,
      delta: edit.delta,
      diffSummary: diffSummary(edit),
      sequenceDigest: digest,
      storedSequencePath: stored.relativePath,
      featureImpact: impacts,
    };
  });

  return {
    ...transaction.payload,
    previousRevision: transaction.previousRevision,
    revision: transaction.revision,
    nextAction: {
      tool: "validate_workspace",
      instruction: "Call validate_workspace with checkSequenceDigests=true before using the edited molecule.",
    },
  };
}

export function normalizeEdit(input: EditSequenceInput, molecule: Molecule, sequenceLength: number): NormalizedEdit {
  if (!Number.isInteger(input.start)) {
    throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "start must be an integer coordinate.", { start: input.start });
  }
  const operation = input.operation;
  if (!["insert", "delete", "replace", "mutate"].includes(operation)) {
    throw new MoleculeError("INVALID_ARGUMENT", "Unsupported edit_sequence operation.", { operation });
  }

  if (operation === "insert") {
    if (molecule.topology === "circular" && input.start === sequenceLength + 1) {
      throw new MoleculeError("INVALID_ARGUMENT", "Append-style insert at length + 1 is only supported for linear molecules.", {
        start: input.start,
        moleculeLength: sequenceLength,
        topology: molecule.topology,
      });
    }
    if (input.start < 1 || input.start > sequenceLength + 1) {
      throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Insert start is outside molecule bounds.", {
        start: input.start,
        moleculeLength: sequenceLength,
        allowedAppendStart: sequenceLength + 1,
      });
    }
    const insertedSequence = requiredNormalizedSequence(input.sequence, molecule, operation);
    return {
      operation,
      start: input.start,
      end: input.start - 1,
      insertedSequence,
      deletedLength: 0,
      insertLength: insertedSequence.length,
      delta: insertedSequence.length,
    };
  }

  if (!Number.isInteger(input.end)) {
    throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "end must be an integer coordinate for this operation.", { end: input.end });
  }
  const end = input.end as number;
  if (molecule.topology === "circular" && input.start > end) {
    throw new MoleculeError("INVALID_ARGUMENT", "Origin-spanning edits on circular molecules are not supported.", {
      start: input.start,
      end,
      topology: molecule.topology,
    });
  }
  if (input.start < 1 || end > sequenceLength || input.start > end) {
    throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Edit coordinates are outside molecule bounds.", {
      start: input.start,
      end,
      moleculeLength: sequenceLength,
    });
  }

  const deletedLength = end - input.start + 1;
  const insertedSequence = operation === "delete" ? "" : requiredNormalizedSequence(input.sequence, molecule, operation);
  if (operation === "mutate" && insertedSequence.length !== deletedLength) {
    throw new MoleculeError("INVALID_ARGUMENT", "mutate requires sequence length to match the edited span.", {
      spanLength: deletedLength,
      sequenceLength: insertedSequence.length,
    });
  }
  return {
    operation,
    start: input.start,
    end,
    insertedSequence,
    deletedLength,
    insertLength: insertedSequence.length,
    delta: insertedSequence.length - deletedLength,
  };
}

export function applyEdit(sequence: string, edit: NormalizedEdit): string {
  if (edit.operation === "insert") {
    return `${sequence.slice(0, edit.start - 1)}${edit.insertedSequence}${sequence.slice(edit.start - 1)}`;
  }
  return `${sequence.slice(0, edit.start - 1)}${edit.insertedSequence}${sequence.slice(edit.end)}`;
}

export function remapFeature(feature: Feature, edit: NormalizedEdit): FeatureImpact {
  const beforeSegments = feature.segments.map((segment) => ({ ...segment }));
  const remapped = beforeSegments.map((segment) => remapSegment(segment, edit));
  const afterSegments = remapped.map((entry) => entry.segment).filter((segment): segment is CoordinateSegment => segment !== null);
  const impact = aggregateImpact(remapped);
  const notes: string[] = [];
  const frameShifted = isCdsFeature(feature) && edit.delta % 3 !== 0 && edit.start <= maxSegmentEnd(beforeSegments);
  if (frameShifted) notes.push("CDS length may no longer preserve the original reading frame.");
  if (impact === "split") notes.push("Edit splits a feature segment; v1 reports the merged span and does not fabricate split annotations.");

  return {
    featureId: feature.id,
    name: feature.name,
    impact,
    ...(frameShifted ? { frameShifted: true } : {}),
    beforeSegments,
    afterSegments: afterSegments.length === 0 ? null : afterSegments,
    boundingSpan: afterSegments.length === 0 ? null : boundingSpan(afterSegments),
    notes,
  };
}

function remapSegment(segment: CoordinateSegment, edit: NormalizedEdit): RemappedSegment {
  if (edit.operation === "insert") {
    if (edit.start <= segment.start) {
      return { segment: shiftSegment(segment, edit.delta), impact: "shifted" };
    }
    if (edit.start > segment.end) {
      return { segment: { ...segment }, impact: "unaffected" };
    }
    return {
      segment: { ...segment, end: segment.end + edit.delta },
      impact: "split",
    };
  }

  if (segment.end < edit.start) {
    return { segment: { ...segment }, impact: "unaffected" };
  }
  if (segment.start > edit.end) {
    return { segment: shiftSegment(segment, edit.delta), impact: "shifted" };
  }
  if (edit.start <= segment.start && edit.end >= segment.end) {
    return { segment: null, impact: "deleted" };
  }
  if (edit.start > segment.start && edit.end < segment.end) {
    return {
      segment: { ...segment, end: segment.end + edit.delta },
      impact: edit.delta === 0 ? "unaffected" : "resized",
    };
  }
  if (edit.start <= segment.start && edit.end < segment.end) {
    const remapped = { ...segment, start: edit.start + edit.insertLength, end: segment.end + edit.delta };
    return remapped.start <= remapped.end ? { segment: remapped, impact: "truncated" } : { segment: null, impact: "deleted" };
  }
  const remapped = { ...segment, end: edit.start - 1 };
  return remapped.start <= remapped.end ? { segment: remapped, impact: "truncated" } : { segment: null, impact: "deleted" };
}

function aggregateImpact(remapped: RemappedSegment[]): FeatureImpactKind {
  if (remapped.every((entry) => entry.segment === null)) return "deleted";
  const impacts = new Set(remapped.map((entry) => entry.impact));
  for (const impact of ["split", "truncated", "resized", "shifted"] as const) {
    if (impacts.has(impact)) return impact;
  }
  if (impacts.has("deleted")) return "truncated";
  return "unaffected";
}

function shiftSegment(segment: CoordinateSegment, delta: number): CoordinateSegment {
  return { ...segment, start: segment.start + delta, end: segment.end + delta };
}

function boundingSpan(segments: CoordinateSegment[]): { start: number; end: number } {
  return {
    start: Math.min(...segments.map((segment) => segment.start)),
    end: Math.max(...segments.map((segment) => segment.end)),
  };
}

function maxSegmentEnd(segments: CoordinateSegment[]): number {
  return Math.max(...segments.map((segment) => segment.end));
}

function isCdsFeature(feature: Feature): boolean {
  return feature.type.toLowerCase() === "cds";
}

function requiredNormalizedSequence(sequence: string | undefined, molecule: Molecule, operation: EditSequenceOperation): string {
  if (typeof sequence !== "string" || sequence.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", `${operation} requires a non-empty sequence.`, { operation });
  }
  return normalizeSequence(sequence, molecule.alphabet);
}

function formatStoredSequence(molecule: Molecule, features: Feature[], sequence: string, createdAt: string): string {
  if (molecule.sourceFormat === "fasta") {
    return formatSingleRecordFasta(molecule.name, sequence);
  }
  return formatGenBank({
    name: molecule.name,
    length: sequence.length,
    topology: molecule.topology,
    moleculeType: molecule.moleculeType,
    description: molecule.description,
    sequence,
    features,
    date: formatGenBankDate(createdAt),
  });
}

function diffSummary(edit: NormalizedEdit): string {
  if (edit.operation === "insert") {
    return `insert ${edit.insertedSequence.length} bases before ${edit.start}`;
  }
  return `${edit.operation} ${edit.start}..${edit.end} (${edit.deletedLength} bases) with ${edit.insertLength} bases`;
}

function formatGenBankDate(isoDate: string): string {
  const date = new Date(isoDate);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${String(date.getUTCDate()).padStart(2, "0")}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}
