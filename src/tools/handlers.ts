import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { getSequenceContext, listMoleculeSummaries, readMoleculeSequence } from "../core/context.js";
import {
  alignSequences,
  exportGenBank,
  exportGrnaReport,
  designPrimers,
  designGrnas,
  findOrfs,
  findRestrictionSites,
  renderDigestGel,
  simulateAssembly,
  simulateDigest,
  simulatePcr,
  translateRegion,
} from "../core/deterministic.js";
import { MoleculeError } from "../core/errors.js";
import { importSequenceFile, type ImportFormat } from "../core/import.js";
import { reverseComplement } from "../core/sequence.js";
import { renderPlasmidMap, type PlasmidMapCutSite } from "../core/render-map.js";
import type { Feature, GuideRecord, Primer, Strand } from "../core/schema.js";
import { readWorkspace, validateWorkspace } from "../core/workspace.js";
import { deleteFeature, deletePrimer, upsertFeature, upsertGuide, upsertPrimer } from "../core/writes.js";
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
  | "upsert_grna"
  | "reverse_complement"
  | "translate_region"
  | "find_orfs"
  | "find_restriction_sites"
  | "simulate_digest"
  | "simulate_pcr"
  | "simulate_assembly"
  | "export_genbank"
  | "export_grna_report"
  | "render_plasmid_map"
  | "render_digest_gel"
  | "align_sequences"
  | "design_primers"
  | "design_grnas";

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

export type UpsertGrnaInput = ExpectedRevisionInput & {
  guide: GuideRecord;
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

export type SimulateAssemblyToolInput = WorkspaceInput & {
  method: "restriction_ligation";
  vector: {
    moleculeId: string;
    leftEnzyme: string;
    rightEnzyme?: string;
    fragment?: "largest_fragment";
  };
  insert: {
    moleculeId: string;
    leftEnzyme: string;
    rightEnzyme?: string;
    fragment?: "largest_fragment";
    orientation?: "forward" | "reverse" | "both";
  };
  product?: {
    moleculeId?: string;
    name?: string;
    topology?: "circular" | "linear";
  };
};

export type ExportGenBankInput = MoleculeToolInput & {
  outputPath: string;
};

export type ExportGrnaReportInput = WorkspaceInput & {
  guideIds: string[];
  outputPath?: string;
};

export type RenderPlasmidMapInput = MoleculeToolInput & {
  outputPath?: string;
  width?: number;
  height?: number;
  cutSites?: PlasmidMapCutSite[];
  showPrimers?: boolean;
  showGuides?: boolean;
};

export type RenderDigestGelInput = WorkspaceInput & {
  gelId: string;
  lanes: Array<{
    label: string;
    fragments: Array<{
      size: number;
      label?: string;
    }>;
  }>;
  customLadder?: number[];
  outputPath?: string;
  width?: number;
  height?: number;
};

export type AlignSequencesInput = WorkspaceInput & {
  sequence?: string;
  targetSequence?: string;
  moleculeId?: string;
  targetMoleculeId?: string;
  mode?: "global" | "local";
  match?: number;
  mismatch?: number;
  gap?: number;
};

export type DesignPrimersToolInput = MoleculeToolInput & {
  target: {
    start: number;
    end: number;
  };
  options?: {
    productSizeRange?: [number, number];
    tmRange?: [number, number];
    primerSizeRange?: [number, number];
    numReturn?: number;
    leftOverhang?: string;
    rightOverhang?: string;
  };
};

export type DesignGrnasToolInput = MoleculeToolInput & {
  targetRegion: {
    start: number;
    end: number;
  };
  options?: {
    pamType?: "SpCas9";
    guideLength?: number;
    strand?: "both" | "+" | "-";
    gcRange?: [number, number];
    maxSeedHomopolymerRun?: number;
    offTargetMoleculeIds?: string[];
    maxOffTargetMismatches?: number;
  };
};

export type DoctorDependencyStatus = {
  name: string;
  command: string;
  requiredFor: string[];
  available: boolean;
  version?: string;
  exitCode?: number | null;
  error?: string;
  install: {
    macos: string;
    linux: string;
    windows: string;
  };
};

export type DoctorResult = {
  package: string;
  runtime: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    cwd: string;
  };
  tools: string[];
  optionalDependencies: {
    primer3_core: DoctorDependencyStatus;
  };
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
  upsert_grna: UpsertGrnaInput;
  reverse_complement: ReverseComplementInput;
  translate_region: TranslateRegionInput;
  find_orfs: FindOrfsInput;
  find_restriction_sites: EnzymeInput;
  simulate_digest: EnzymeInput;
  simulate_pcr: SimulatePcrInput;
  simulate_assembly: SimulateAssemblyToolInput;
  export_genbank: ExportGenBankInput;
  export_grna_report: ExportGrnaReportInput;
  render_plasmid_map: RenderPlasmidMapInput;
  render_digest_gel: RenderDigestGelInput;
  align_sequences: AlignSequencesInput;
  design_primers: DesignPrimersToolInput;
  design_grnas: DesignGrnasToolInput;
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
  upsert_grna: handleUpsertGrna,
  reverse_complement: handleReverseComplement,
  translate_region: handleTranslateRegion,
  find_orfs: handleFindOrfs,
  find_restriction_sites: handleFindRestrictionSites,
  simulate_digest: handleSimulateDigest,
  simulate_pcr: handleSimulatePcr,
  simulate_assembly: handleSimulateAssembly,
  export_genbank: handleExportGenBank,
  export_grna_report: handleExportGrnaReport,
  render_plasmid_map: handleRenderPlasmidMap,
  render_digest_gel: handleRenderDigestGel,
  align_sequences: handleAlignSequences,
  design_primers: handleDesignPrimers,
  design_grnas: handleDesignGrnas,
} satisfies { [K in ToolName]: ToolHandler<ToolInputByName[K]> };

export async function runToolHandler<TName extends ToolName>(
  tool: TName,
  input: ToolInputByName[TName],
): Promise<ToolResultEnvelope> {
  return toolHandlers[tool](input as never);
}

export async function handleDoctor(): Promise<ToolResultEnvelope> {
  const result: DoctorResult = {
    package: packageName,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
    },
    tools: Object.keys(toolHandlers).filter((name) => name !== "doctor"),
    optionalDependencies: {
      primer3_core: primer3CoreStatus(),
    },
  };
  return toolSuccess("doctor", result);
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

export async function handleUpsertGrna(input: UpsertGrnaInput): Promise<ToolResultEnvelope> {
  const tool = "upsert_grna";
  try {
    const workspacePath = workspacePathFromInput(input);
    const expectedRevision = assertNonNegativeInteger(input.expectedRevision, "expectedRevision");
    assertRecord(input.guide, "guide");
    const result = await upsertGuide(workspacePath, expectedRevision, input.guide);
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

export async function handleSimulateAssembly(input: SimulateAssemblyToolInput): Promise<ToolResultEnvelope> {
  const tool = "simulate_assembly";
  try {
    const workspacePath = workspacePathFromInput(input);
    if (input.method !== "restriction_ligation") {
      throw new MoleculeError("INVALID_ARGUMENT", "method must be 'restriction_ligation'.", { method: input.method });
    }
    const vector = assemblySideInput(input.vector, "vector");
    const insert = {
      ...assemblySideInput(input.insert, "insert"),
      ...(input.insert.orientation !== undefined ? { orientation: assemblyOrientation(input.insert.orientation) } : {}),
    };
    const product = input.product === undefined ? undefined : assemblyProductInput(input.product);
    const result = await simulateAssembly({
      workspacePath,
      method: input.method,
      vector,
      insert,
      ...(product ? { product } : {}),
    });
    const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: false });
    const nextAction = result.candidates.length === 1
      ? {
          tool: "open_sequence",
          arguments: {
            inputPath: result.candidates[0].artifacts[0].path,
            workspaceDir: path.dirname(workspacePath),
            format: "genbank",
            expectedRevision: workspace.revision,
          },
        }
      : undefined;
    return toolSuccess(tool, result, {
      workspacePath,
      revision: workspace.revision,
      artifacts: result.candidates.flatMap((candidate) => candidate.artifacts.map((artifact) => ({
        kind: artifact.kind,
        path: artifact.path,
        mimeType: artifact.mimeType,
        description: artifact.description,
      }))),
      ...(nextAction ? { nextAction } : {}),
    });
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
    return toolSuccess(tool, { workspacePath, ...result }, {
      workspacePath,
      artifacts: [
        {
          kind: "genbank",
          path: result.outputPath,
          mimeType: "chemical/x-genbank",
          description: "GenBank flat file export of the molecule and its workspace features.",
        },
      ],
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleExportGrnaReport(input: ExportGrnaReportInput): Promise<ToolResultEnvelope> {
  const tool = "export_grna_report";
  try {
    const workspacePath = workspacePathFromInput(input);
    const guideIds = assertStringArray(input.guideIds, "guideIds");
    const result = await exportGrnaReport(workspacePath, guideIds, {
      ...(input.outputPath ? { outputPath: input.outputPath } : {}),
    });
    return toolSuccess(tool, { workspacePath, ...result }, {
      workspacePath,
      artifacts: [
        {
          kind: "grna_report",
          path: result.outputPath,
          mimeType: result.mimeType,
          description: "Markdown report for selected persisted guide RNA records.",
        },
      ],
      nextAction: {
        tool: "validate_workspace",
        arguments: { workspacePath },
      },
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleRenderPlasmidMap(input: RenderPlasmidMapInput): Promise<ToolResultEnvelope> {
  const tool = "render_plasmid_map";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    const result = await renderPlasmidMap(workspacePath, moleculeId, {
      ...(input.outputPath ? { outputPath: input.outputPath } : {}),
      ...(input.width !== undefined ? { width: assertPositiveInteger(input.width, "width") } : {}),
      ...(input.height !== undefined ? { height: assertPositiveInteger(input.height, "height") } : {}),
      ...(input.cutSites ? { cutSites: assertCutSites(input.cutSites) } : {}),
      ...(input.showPrimers !== undefined ? { showPrimers: input.showPrimers } : {}),
      ...(input.showGuides !== undefined ? { showGuides: input.showGuides } : {}),
    });
    return toolSuccess(tool, { workspacePath, ...result }, {
      workspacePath,
      artifacts: [
        {
          kind: "plasmid_map",
          path: result.outputPath,
          mimeType: result.mimeType,
          description: "Deterministic circular plasmid SVG map.",
        },
      ],
      nextAction: {
        tool: "validate_workspace",
        arguments: { workspacePath },
      },
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleRenderDigestGel(input: RenderDigestGelInput): Promise<ToolResultEnvelope> {
  const tool = "render_digest_gel";
  try {
    const workspacePath = workspacePathFromInput(input);
    assertNonEmptyString(input.gelId, "gelId");
    const result = await renderDigestGel(workspacePath, input.gelId, input.lanes, {
      ...(input.outputPath ? { outputPath: input.outputPath } : {}),
      ...(input.width !== undefined ? { width: assertPositiveInteger(input.width, "width") } : {}),
      ...(input.height !== undefined ? { height: assertPositiveInteger(input.height, "height") } : {}),
      ...(input.customLadder ? { customLadder: input.customLadder } : {}),
    });
    return toolSuccess(tool, { workspacePath, ...result }, {
      workspacePath,
      artifacts: [
        {
          kind: "gel",
          path: result.outputPath,
          mimeType: result.mimeType,
          description: "Deterministic SVG gel rendering of linear digest or PCR fragments.",
        },
      ],
      nextAction: {
        tool: "validate_workspace",
        arguments: { workspacePath },
      },
    });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleAlignSequences(input: AlignSequencesInput): Promise<ToolResultEnvelope> {
  const tool = "align_sequences";
  try {
    if (input.mode !== undefined && input.mode !== "global" && input.mode !== "local") {
      throw new MoleculeError("INVALID_ARGUMENT", "mode must be 'global' or 'local'.", { mode: input.mode });
    }
    if (input.match !== undefined) assertInteger(input.match, "match");
    if (input.mismatch !== undefined) assertInteger(input.mismatch, "mismatch");
    if (input.gap !== undefined) assertInteger(input.gap, "gap");

    const query = await resolveAlignmentSequence(input, input.sequence, input.moleculeId, "sequence", "moleculeId");
    const target = await resolveAlignmentSequence(input, input.targetSequence, input.targetMoleculeId, "targetSequence", "targetMoleculeId");

    const result = alignSequences(query.sequence, target.sequence, {
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.match !== undefined ? { match: input.match } : {}),
      ...(input.mismatch !== undefined ? { mismatch: input.mismatch } : {}),
      ...(input.gap !== undefined ? { gap: input.gap } : {}),
    });

    const usesWorkspace = query.moleculeId !== undefined || target.moleculeId !== undefined;
    return toolSuccess(
      tool,
      { ...(usesWorkspace ? { workspacePath: workspacePathFromInput(input) } : {}), ...result },
      usesWorkspace ? { workspacePath: workspacePathFromInput(input) } : {},
    );
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleDesignPrimers(input: DesignPrimersToolInput): Promise<ToolResultEnvelope> {
  const tool = "design_primers";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    assertRecord(input.target, "target");
    const target = {
      start: assertPositiveInteger(input.target.start, "target.start"),
      end: assertPositiveInteger(input.target.end, "target.end"),
    };
    const result = await designPrimers({
      workspacePath,
      moleculeId,
      target,
      ...(input.options ? { options: input.options } : {}),
    });
    return toolSuccess(tool, { workspacePath, ...result }, { workspacePath });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

export async function handleDesignGrnas(input: DesignGrnasToolInput): Promise<ToolResultEnvelope> {
  const tool = "design_grnas";
  try {
    const workspacePath = workspacePathFromInput(input);
    const moleculeId = moleculeIdFromInput(input);
    assertRecord(input.targetRegion, "targetRegion");
    const targetRegion = {
      start: assertPositiveInteger(input.targetRegion.start, "targetRegion.start"),
      end: assertPositiveInteger(input.targetRegion.end, "targetRegion.end"),
    };
    const result = await designGrnas({
      workspacePath,
      moleculeId,
      targetRegion,
      ...(input.options ? { options: input.options } : {}),
    });
    return toolSuccess(tool, { workspacePath, ...result }, { workspacePath });
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

function primer3CoreStatus(): DoctorDependencyStatus {
  const result = spawnSync("primer3_core", ["--version"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const version = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (result.error) {
    return {
      name: "primer3_core",
      command: "primer3_core",
      requiredFor: ["design_primers"],
      available: false,
      error: result.error.message,
      install: primer3InstallInstructions(),
    };
  }
  return {
    name: "primer3_core",
    command: "primer3_core",
    requiredFor: ["design_primers"],
    available: result.error === undefined,
    ...(version ? { version } : {}),
    exitCode: result.status,
    install: primer3InstallInstructions(),
  };
}

function primer3InstallInstructions(): DoctorDependencyStatus["install"] {
  return {
    macos: "brew install primer3",
    linux: "sudo apt-get install primer3",
    windows: "No official native primer3_core.exe is published; run the MCP server inside WSL or Docker with primer3 installed there.",
  };
}

function assemblySideInput(value: unknown, name: "vector" | "insert"): {
  moleculeId: string;
  leftEnzyme: string;
  rightEnzyme?: string;
  fragment?: "largest_fragment";
} {
  assertRecord(value, name);
  assertNonEmptyString(value.moleculeId, `${name}.moleculeId`);
  assertNonEmptyString(value.leftEnzyme, `${name}.leftEnzyme`);
  if (value.rightEnzyme !== undefined) assertNonEmptyString(value.rightEnzyme, `${name}.rightEnzyme`);
  if (value.fragment !== undefined && value.fragment !== "largest_fragment") {
    throw new MoleculeError("INVALID_ARGUMENT", `${name}.fragment must be 'largest_fragment'.`, { fragment: value.fragment });
  }
  return {
    moleculeId: value.moleculeId,
    leftEnzyme: value.leftEnzyme,
    ...(value.rightEnzyme !== undefined ? { rightEnzyme: value.rightEnzyme } : {}),
    ...(value.fragment !== undefined ? { fragment: value.fragment } : {}),
  };
}

function assemblyOrientation(value: unknown): "forward" | "reverse" | "both" {
  if (value !== "forward" && value !== "reverse" && value !== "both") {
    throw new MoleculeError("INVALID_ARGUMENT", "insert.orientation must be 'forward', 'reverse', or 'both'.", { orientation: value });
  }
  return value;
}

function assemblyProductInput(value: unknown): { moleculeId?: string; name?: string; topology?: "circular" | "linear" } {
  assertRecord(value, "product");
  if (value.moleculeId !== undefined) assertNonEmptyString(value.moleculeId, "product.moleculeId");
  if (value.name !== undefined) assertNonEmptyString(value.name, "product.name");
  if (value.topology !== undefined && value.topology !== "circular" && value.topology !== "linear") {
    throw new MoleculeError("INVALID_ARGUMENT", "product.topology must be 'circular' or 'linear'.", { topology: value.topology });
  }
  return {
    ...(value.moleculeId !== undefined ? { moleculeId: value.moleculeId } : {}),
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.topology !== undefined ? { topology: value.topology } : {}),
  };
}

async function resolveAlignmentSequence(
  input: WorkspaceInput,
  sequence: string | undefined,
  moleculeId: string | undefined,
  sequenceField: string,
  moleculeField: string,
): Promise<{ sequence: string; moleculeId?: string }> {
  const hasSequence = sequence !== undefined;
  const hasMolecule = moleculeId !== undefined;
  if (hasSequence === hasMolecule) {
    throw new MoleculeError(
      "INVALID_ARGUMENT",
      `Provide exactly one of ${sequenceField} or ${moleculeField}.`,
      { [sequenceField]: sequence, [moleculeField]: moleculeId },
    );
  }
  if (hasSequence) {
    assertNonEmptyString(sequence, sequenceField);
    return { sequence };
  }
  assertNonEmptyString(moleculeId, moleculeField);
  const workspacePath = workspacePathFromInput(input);
  const resolved = await readMoleculeSequence(workspacePath, moleculeId);
  return { sequence: resolved.sequence, moleculeId };
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

function assertInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be an integer.`, { [name]: value });
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

function assertCutSites(value: unknown): PlasmidMapCutSite[] {
  if (!Array.isArray(value)) {
    throw new MoleculeError("INVALID_ARGUMENT", "cutSites must be an array.", { cutSites: value });
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new MoleculeError("INVALID_ARGUMENT", "cutSites entries must be objects.", { index, entry });
    }
    const candidate = entry as Record<string, unknown>;
    assertNonEmptyString(candidate.enzyme, `cutSites[${index}].enzyme`);
    return {
      enzyme: candidate.enzyme,
      position: assertPositiveInteger(candidate.position, `cutSites[${index}].position`),
    };
  });
}

function assertImportFormat(format: string): asserts format is ImportFormat {
  if (format !== "auto" && format !== "fasta" && format !== "genbank") {
    throw new MoleculeError("INVALID_ARGUMENT", "format must be 'auto', 'fasta', or 'genbank'.", { format });
  }
}
