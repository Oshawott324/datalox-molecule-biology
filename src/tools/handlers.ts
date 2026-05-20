import { promises as fs } from "node:fs";
import path from "node:path";

import { getSequenceContext, listMoleculeSummaries } from "../core/context.js";
import {
  exportGenBank,
  findOrfs,
  findRestrictionSites,
  simulateDigest,
  simulatePcr,
  translateRegion,
} from "../core/deterministic.js";
import { MoleculeError } from "../core/errors.js";
import { importSequenceFile, type ImportFormat } from "../core/import.js";
import { reverseComplement } from "../core/sequence.js";
import type { Feature, Primer, Strand } from "../core/schema.js";
import { readWorkspace, validateWorkspace } from "../core/workspace.js";
import { deleteFeature, deletePrimer, upsertFeature, upsertPrimer } from "../core/writes.js";
import { openSequenceEditor } from "../ui/index.js";
import { toolFailure, toolFailureFromError, toolSuccess, type ToolResultEnvelope } from "./envelope.js";

const packageName = "@datalox/molecule-biology";

export type ToolName =
  | "doctor"
  | "open_sequence"
  | "open_workspace"
  | "open_sequence_editor"
  | "read_workspace"
  | "validate_workspace"
  | "list_molecules"
  | "get_sequence_context"
  | "upsert_feature"
  | "delete_feature"
  | "upsert_primer"
  | "delete_primer"
  | "reverse_complement"
  | "translate_region"
  | "find_orfs"
  | "find_restriction_sites"
  | "simulate_digest"
  | "simulate_pcr"
  | "export_genbank";

export type OpenSequenceInput = {
  inputPath: string;
  workspaceDir: string;
  format?: ImportFormat;
  moleculeId?: string;
  expectedRevision?: number;
};

export type WorkspaceInput = {
  workspacePath?: string;
  workspaceDir?: string;
  checkSequenceDigests?: boolean;
};

export type OpenSequenceEditorInput = WorkspaceInput & {
  moleculeId?: string;
  host?: string;
  port?: number;
};

export type SequenceContextInput = WorkspaceInput & {
  moleculeId?: string;
  molecule?: string;
  start?: number;
  end?: number;
  strand?: Strand;
  includeSequence?: boolean;
};

export type ExpectedRevisionInput = WorkspaceInput & {
  expectedRevision: number;
};

export type UpsertFeatureInput = ExpectedRevisionInput & {
  feature: Feature;
};

export type DeleteFeatureInput = ExpectedRevisionInput & {
  featureId: string;
};

export type UpsertPrimerInput = ExpectedRevisionInput & {
  primer: Primer;
  bindToMolecule?: boolean;
};

export type DeletePrimerInput = ExpectedRevisionInput & {
  primerId: string;
};

export type ReverseComplementInput = {
  sequence: string;
};

export type MoleculeToolInput = WorkspaceInput & {
  moleculeId?: string;
  molecule?: string;
};

export type TranslateRegionInput = MoleculeToolInput & {
  start: number;
  end: number;
  strand?: Strand;
  geneticCode?: "standard";
};

export type FindOrfsInput = MoleculeToolInput & {
  minAa?: number;
  startCodons?: string[];
  stopCodons?: string[];
  strands?: Array<"+" | "-">;
};

export type EnzymeInput = MoleculeToolInput & {
  enzymes: string[];
};

export type SimulatePcrInput = MoleculeToolInput & {
  forwardPrimer: string;
  reversePrimer: string;
};

export type ExportGenBankInput = MoleculeToolInput & {
  outputPath: string;
};

export type ToolInputByName = {
  doctor: Record<string, never>;
  open_sequence: OpenSequenceInput;
  open_workspace: WorkspaceInput;
  open_sequence_editor: OpenSequenceEditorInput;
  read_workspace: WorkspaceInput;
  validate_workspace: WorkspaceInput;
  list_molecules: WorkspaceInput;
  get_sequence_context: SequenceContextInput;
  upsert_feature: UpsertFeatureInput;
  delete_feature: DeleteFeatureInput;
  upsert_primer: UpsertPrimerInput;
  delete_primer: DeletePrimerInput;
  reverse_complement: ReverseComplementInput;
  translate_region: TranslateRegionInput;
  find_orfs: FindOrfsInput;
  find_restriction_sites: EnzymeInput;
  simulate_digest: EnzymeInput;
  simulate_pcr: SimulatePcrInput;
  export_genbank: ExportGenBankInput;
};

export type ToolHandler<TInput> = (input: TInput) => Promise<ToolResultEnvelope>;

export const toolHandlers = {
  doctor: handleDoctor,
  open_sequence: handleOpenSequence,
  open_workspace: handleOpenWorkspace,
  open_sequence_editor: handleOpenSequenceEditor,
  read_workspace: handleReadWorkspace,
  validate_workspace: handleValidateWorkspace,
  list_molecules: handleListMolecules,
  get_sequence_context: handleGetSequenceContext,
  upsert_feature: handleUpsertFeature,
  delete_feature: handleDeleteFeature,
  upsert_primer: handleUpsertPrimer,
  delete_primer: handleDeletePrimer,
  reverse_complement: handleReverseComplement,
  translate_region: handleTranslateRegion,
  find_orfs: handleFindOrfs,
  find_restriction_sites: handleFindRestrictionSites,
  simulate_digest: handleSimulateDigest,
  simulate_pcr: handleSimulatePcr,
  export_genbank: handleExportGenBank,
} satisfies { [K in ToolName]: ToolHandler<ToolInputByName[K]> };

export async function runToolHandler<TName extends ToolName>(
  tool: TName,
  input: ToolInputByName[TName],
): Promise<ToolResultEnvelope> {
  return toolHandlers[tool](input as never);
}

export async function handleDoctor(): Promise<ToolResultEnvelope> {
  return toolSuccess("doctor", {
    package: packageName,
    tools: Object.keys(toolHandlers).filter((name) => name !== "doctor"),
  });
}

export async function handleOpenSequence(input: OpenSequenceInput): Promise<ToolResultEnvelope> {
  const tool = "open_sequence";
  try {
    assertNonEmptyString(input.inputPath, "inputPath");
    assertNonEmptyString(input.workspaceDir, "workspaceDir");
    if (input.format !== undefined) assertImportFormat(input.format);
    if (input.moleculeId !== undefined) assertNonEmptyString(input.moleculeId, "moleculeId");
    if (input.expectedRevision !== undefined) assertNonNegativeInteger(input.expectedRevision, "expectedRevision");

    const result = await importSequenceFile(input);
    return toolSuccess(tool, result, {
      workspacePath: result.workspacePath,
      revision: result.revision,
      nextAction: result.moleculeIds[0]
        ? {
            tool: "get_sequence_context",
            arguments: {
              workspacePath: result.workspacePath,
              moleculeId: result.moleculeIds[0],
            },
          }
        : undefined,
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleOpenWorkspace(input: WorkspaceInput): Promise<ToolResultEnvelope> {
  return readWorkspaceEnvelope("open_workspace", input);
}

export async function handleOpenSequenceEditor(input: OpenSequenceEditorInput): Promise<ToolResultEnvelope> {
  const tool = "open_sequence_editor";
  try {
    const workspacePath = workspacePathFromInput(input);
    const result = await openSequenceEditor({
      workspacePath,
      ...(input.moleculeId ? { moleculeId: input.moleculeId } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(input.port !== undefined ? { port: assertNonNegativeInteger(input.port, "port") } : {}),
    });
    return toolSuccess(tool, result, {
      workspacePath,
      nextAction: {
        tool: "get_sequence_context",
        arguments: {
          workspacePath,
          ...(input.moleculeId ? { moleculeId: input.moleculeId } : {}),
        },
      },
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleReadWorkspace(input: WorkspaceInput): Promise<ToolResultEnvelope> {
  return readWorkspaceEnvelope("read_workspace", input);
}

export async function handleValidateWorkspace(input: WorkspaceInput): Promise<ToolResultEnvelope> {
  const tool = "validate_workspace";
  try {
    const workspacePath = workspacePathFromInput(input);
    const parsed = JSON.parse(await fs.readFile(workspacePath, "utf8")) as unknown;
    const result = await validateWorkspace(parsed, {
      workspacePath,
      checkSequenceDigests: input.checkSequenceDigests ?? true,
    });
    if (!result.ok) {
      return toolFailure(tool, "VALIDATION_ERROR", "Workspace validation failed.", { workspacePath, issues: result.issues });
    }
    const revision = typeof parsed === "object" && parsed !== null && "revision" in parsed && typeof parsed.revision === "number" ? parsed.revision : undefined;
    return toolSuccess(tool, { workspacePath, valid: true, issues: result.issues }, {
      workspacePath,
      revision,
      nextAction: {
        tool: "list_molecules",
        arguments: { workspacePath },
      },
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleListMolecules(input: WorkspaceInput): Promise<ToolResultEnvelope> {
  const tool = "list_molecules";
  try {
    const workspacePath = workspacePathFromInput(input);
    const result = await listMoleculeSummaries(workspacePath);
    return toolSuccess(tool, { workspacePath, ...result }, {
      workspacePath,
      revision: result.revision,
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleGetSequenceContext(input: SequenceContextInput): Promise<ToolResultEnvelope> {
  const tool = "get_sequence_context";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = input.moleculeId ?? input.molecule;
    assertNonEmptyString(moleculeId, "moleculeId");

    const hasStart = input.start !== undefined;
    const hasEnd = input.end !== undefined;
    if (hasStart !== hasEnd) {
      throw new MoleculeError("INVALID_ARGUMENT", "start and end must be provided together.");
    }

    const region = hasStart && hasEnd
      ? {
          start: assertNonNegativeInteger(input.start, "start"),
          end: assertNonNegativeInteger(input.end, "end"),
          strand: input.strand ?? "+",
        }
      : undefined;
    if (region && region.strand !== "+" && region.strand !== "-" && region.strand !== "none") {
      throw new MoleculeError("INVALID_ARGUMENT", "strand must be '+', '-', or 'none'.", { strand: region.strand });
    }

    const result = await getSequenceContext(workspacePath, moleculeId, {
      ...(region ? { region } : {}),
      includeSequence: input.includeSequence ?? false,
    });
    return toolSuccess(tool, { workspacePath, ...result }, {
      workspacePath,
      revision: result.revision,
      nextAction: {
        tool: "validate_workspace",
        arguments: { workspacePath },
      },
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleUpsertFeature(input: UpsertFeatureInput): Promise<ToolResultEnvelope> {
  const tool = "upsert_feature";
  try {
    const workspacePath = workspacePathFromInput(input);
    const expectedRevision = assertNonNegativeInteger(input.expectedRevision, "expectedRevision");
    assertRecord(input.feature, "feature");
    const result = await upsertFeature(workspacePath, expectedRevision, input.feature);
    return toolSuccess(tool, result.payload, writeMetadata(workspacePath, result.revision));
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleDeleteFeature(input: DeleteFeatureInput): Promise<ToolResultEnvelope> {
  const tool = "delete_feature";
  try {
    const workspacePath = workspacePathFromInput(input);
    const expectedRevision = assertNonNegativeInteger(input.expectedRevision, "expectedRevision");
    assertNonEmptyString(input.featureId, "featureId");
    const result = await deleteFeature(workspacePath, expectedRevision, input.featureId);
    return toolSuccess(tool, result.payload, writeMetadata(workspacePath, result.revision));
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleUpsertPrimer(input: UpsertPrimerInput): Promise<ToolResultEnvelope> {
  const tool = "upsert_primer";
  try {
    const workspacePath = workspacePathFromInput(input);
    const expectedRevision = assertNonNegativeInteger(input.expectedRevision, "expectedRevision");
    assertRecord(input.primer, "primer");
    const result = await upsertPrimer(workspacePath, expectedRevision, input.primer, { bindToMolecule: input.bindToMolecule ?? false });
    return toolSuccess(tool, result.payload, writeMetadata(workspacePath, result.revision));
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleDeletePrimer(input: DeletePrimerInput): Promise<ToolResultEnvelope> {
  const tool = "delete_primer";
  try {
    const workspacePath = workspacePathFromInput(input);
    const expectedRevision = assertNonNegativeInteger(input.expectedRevision, "expectedRevision");
    assertNonEmptyString(input.primerId, "primerId");
    const result = await deletePrimer(workspacePath, expectedRevision, input.primerId);
    return toolSuccess(tool, result.payload, writeMetadata(workspacePath, result.revision));
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleReverseComplement(input: ReverseComplementInput): Promise<ToolResultEnvelope> {
  const tool = "reverse_complement";
  try {
    assertNonEmptyString(input.sequence, "sequence");
    return toolSuccess(tool, { sequence: input.sequence, reverseComplement: reverseComplement(input.sequence) });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleTranslateRegion(input: TranslateRegionInput): Promise<ToolResultEnvelope> {
  const tool = "translate_region";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    const result = await translateRegion(workspacePath, moleculeId, {
      start: assertPositiveInteger(input.start, "start"),
      end: assertPositiveInteger(input.end, "end"),
      strand: input.strand ?? "+",
    }, { geneticCode: input.geneticCode });
    return toolSuccess(tool, { workspacePath, ...result }, { workspacePath });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleFindOrfs(input: FindOrfsInput): Promise<ToolResultEnvelope> {
  const tool = "find_orfs";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    const result = await findOrfs(workspacePath, moleculeId, {
      ...(input.minAa !== undefined ? { minAa: assertNonNegativeInteger(input.minAa, "minAa") } : {}),
      ...(input.startCodons ? { startCodons: input.startCodons } : {}),
      ...(input.stopCodons ? { stopCodons: input.stopCodons } : {}),
      ...(input.strands ? { strands: input.strands } : {}),
    });
    return toolSuccess(tool, { workspacePath, moleculeId, orfs: result }, { workspacePath });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleFindRestrictionSites(input: EnzymeInput): Promise<ToolResultEnvelope> {
  const tool = "find_restriction_sites";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    const enzymes = assertStringArray(input.enzymes, "enzymes");
    const sites = await findRestrictionSites(workspacePath, moleculeId, enzymes);
    return toolSuccess(tool, { workspacePath, moleculeId, sites }, { workspacePath });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleSimulateDigest(input: EnzymeInput): Promise<ToolResultEnvelope> {
  const tool = "simulate_digest";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    const enzymes = assertStringArray(input.enzymes, "enzymes");
    const result = await simulateDigest(workspacePath, moleculeId, enzymes);
    return toolSuccess(tool, { workspacePath, ...result }, { workspacePath });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleSimulatePcr(input: SimulatePcrInput): Promise<ToolResultEnvelope> {
  const tool = "simulate_pcr";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    assertNonEmptyString(input.forwardPrimer, "forwardPrimer");
    assertNonEmptyString(input.reversePrimer, "reversePrimer");
    const result = await simulatePcr(workspacePath, moleculeId, input.forwardPrimer, input.reversePrimer);
    return toolSuccess(tool, { workspacePath, ...result }, { workspacePath });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleExportGenBank(input: ExportGenBankInput): Promise<ToolResultEnvelope> {
  const tool = "export_genbank";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    assertNonEmptyString(input.outputPath, "outputPath");
    const result = await exportGenBank(workspacePath, moleculeId, input.outputPath);
    return toolSuccess(tool, { workspacePath, ...result }, { workspacePath });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

async function readWorkspaceEnvelope(tool: "open_workspace" | "read_workspace", input: WorkspaceInput): Promise<ToolResultEnvelope> {
  try {
    const workspacePath = workspacePathFromInput(input);
    const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: input.checkSequenceDigests ?? true });
    return toolSuccess(tool, { workspacePath, workspace }, {
      workspacePath,
      revision: workspace.revision,
      nextAction: {
        tool: "list_molecules",
        arguments: { workspacePath },
      },
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export function workspacePathFromInput(input: WorkspaceInput): string {
  if (input.workspacePath !== undefined) {
    assertNonEmptyString(input.workspacePath, "workspacePath");
    return path.resolve(input.workspacePath);
  }
  assertNonEmptyString(input.workspaceDir, "workspaceDir");
  return path.join(path.resolve(input.workspaceDir), "molecule.workspace.json");
}

function writeMetadata(workspacePath: string, revision: number): { workspacePath: string; revision: number; nextAction: { tool: string; arguments: Record<string, unknown> } } {
  return {
    workspacePath,
    revision,
    nextAction: {
      tool: "validate_workspace",
      arguments: { workspacePath },
    },
  };
}

function moleculeIdFromInput(input: MoleculeToolInput): string {
  const moleculeId = input.moleculeId ?? input.molecule;
  assertNonEmptyString(moleculeId, "moleculeId");
  return moleculeId;
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be a non-empty string.`, { [name]: value });
  }
}

function assertNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be a non-negative integer.`, { [name]: value });
  }
  return value;
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be a positive integer.`, { [name]: value });
  }
  return value;
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be an object.`, { [name]: value });
  }
}

function assertStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be a non-empty string array.`, { [name]: value });
  }
  return value;
}

function assertImportFormat(format: string): asserts format is ImportFormat {
  if (format !== "auto" && format !== "fasta" && format !== "genbank") {
    throw new MoleculeError("INVALID_ARGUMENT", "format must be 'auto', 'fasta', or 'genbank'.", { format });
  }
}
