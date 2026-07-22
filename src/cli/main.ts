#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MoleculeError } from "../core/errors.js";
import { runMoleculeMcpServer } from "../mcp/index.js";
import { runReplayDemo } from "../replay/index.js";
import {
  runToolHandler,
  toolFailureFromError,
  type AlignSequencesInput,
  type BlastSequenceToolInput,
  type DeleteFeatureInput,
  type DeletePrimerInput,
  type DesignGrnasToolInput,
  type DesignPrimersToolInput,
  type EnzymeInput,
  type ExportGenBankInput,
  type ExportGrnaReportInput,
  type ExportProteinFastaInput,
  type FindOrfsInput,
  type OpenSequenceInput,
  type OpenSequenceEditorInput,
  type RenderPlasmidMapInput,
  type RenderDigestGelInput,
  type RenderReviewBundleInput,
  type ReverseComplementInput,
  type SequenceContextInput,
  type SimulateAssemblyToolInput,
  type SimulatePcrInput,
  type TranslateRegionInput,
  type ToolInputByName,
  type ToolName,
  type ToolResultEnvelope,
  type UpsertFeatureInput,
  type UpsertGrnaInput,
  type UpsertPrimerInput,
  type ValidateMrnaConstructToolInput,
  type WorkspaceInput,
} from "../tools/index.js";

export type CliRunResult = {
  exitCode: number;
  stdout: string;
};

type ParsedArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
  positional: string[];
};

const commandToTool: Record<string, ToolName> = {
  doctor: "doctor",
  "open-sequence": "open_sequence",
  "open-sequence-editor": "open_sequence_editor",
  "open-workspace": "open_workspace",
  "read-workspace": "read_workspace",
  validate: "validate_workspace",
  "list-molecules": "list_molecules",
  context: "get_sequence_context",
  "upsert-feature": "upsert_feature",
  "edit-sequence": "edit_sequence",
  "delete-feature": "delete_feature",
  "upsert-primer": "upsert_primer",
  "delete-primer": "delete_primer",
  "upsert-grna": "upsert_grna",
  "reverse-complement": "reverse_complement",
  "translate-region": "translate_region",
  "find-orfs": "find_orfs",
  "find-restriction-sites": "find_restriction_sites",
  "simulate-digest": "simulate_digest",
  "simulate-pcr": "simulate_pcr",
  "simulate-assembly": "simulate_assembly",
  "export-genbank": "export_genbank",
  "export-grna-report": "export_grna_report",
  "render-plasmid-map": "render_plasmid_map",
  "render-digest-gel": "render_digest_gel",
  "render-review-bundle": "render_review_bundle",
  "align-sequences": "align_sequences",
  "blast-sequence": "blast_sequence",
  "design-primers": "design_primers",
  "design-grnas": "design_grnas",
  "export-protein-fasta": "export_protein_fasta",
  "validate-mrna-construct": "validate_mrna_construct",
};

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<CliRunResult> {
  const parsed = parseArgs(argv);
  const command = parsed.command;
  if (command === "mcp-server") {
    await runMoleculeMcpServer();
    return {
      exitCode: 0,
      stdout: "",
    };
  }
  if (command === "replay-demo") {
    try {
      const result = await runReplayDemo(await replayDemoInput(parsed));
      return {
        exitCode: result.verification.ok ? 0 : 1,
        stdout: `${JSON.stringify(result, null, 2)}\n`,
      };
    } catch (error) {
      const result = toolFailureFromError("replay-demo", error);
      return {
        exitCode: 1,
        stdout: `${JSON.stringify(result, null, 2)}\n`,
      };
    }
  }
  const tool = command ? commandToTool[command] : undefined;

  const result = tool === undefined
    ? toolFailureFromError("cli", new MoleculeError("INVALID_ARGUMENT", "Unknown or missing command.", {
        command,
        commands: [...Object.keys(commandToTool), "mcp-server", "replay-demo"],
      }))
    : await runCliTool(tool, parsed);

  return {
    exitCode: result.ok ? 0 : 1,
    stdout: `${JSON.stringify(result, null, 2)}\n`,
  };
}

async function replayDemoInput(parsed: ParsedArgs): Promise<{ inputPath: string; workspaceDir: string; moleculeId?: string; bundleId?: string }> {
  const inputPath = stringFlag(parsed, "input-path") ?? parsed.positional[0] ?? "";
  const workspaceDir = stringFlag(parsed, "workspace-dir") ?? await fs.mkdtemp(path.join(os.tmpdir(), "mol-replay-demo-"));
  return {
    inputPath,
    workspaceDir,
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "bundle-id") ? { bundleId: stringFlag(parsed, "bundle-id") } : {}),
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: ParsedArgs["flags"] = {};
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    if (rawName.length === 0) {
      positional.push(token);
      continue;
    }

    if (
      rawName === "include-sequence"
      || rawName === "no-check-sequence-digests"
      || rawName === "bind-to-molecule"
      || rawName === "show-primers"
      || rawName === "show-guides"
      || rawName === "include-replay-summary"
      || rawName === "include-local-paths"
    ) {
      flags[rawName] = true;
      continue;
    }

    if (inlineValue !== undefined) {
      flags[rawName] = inlineValue;
      continue;
    }

    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[rawName] = true;
    } else {
      flags[rawName] = next;
      index += 1;
    }
  }

  return { command, flags, positional };
}

async function inputForTool(tool: ToolName, parsed: ParsedArgs): Promise<ToolInputByName[ToolName]> {
  if (tool === "doctor") return {};
  if (tool === "open_sequence") return openSequenceInput(parsed);
  if (tool === "open_sequence_editor") return openSequenceEditorInput(parsed);
  if (tool === "get_sequence_context") return sequenceContextInput(parsed);
  if (tool === "upsert_feature") return upsertFeatureInput(parsed);
  if (tool === "edit_sequence") return editSequenceInput(parsed);
  if (tool === "delete_feature") return deleteFeatureInput(parsed);
  if (tool === "upsert_primer") return upsertPrimerInput(parsed);
  if (tool === "delete_primer") return deletePrimerInput(parsed);
  if (tool === "upsert_grna") return upsertGrnaInput(parsed);
  if (tool === "reverse_complement") return reverseComplementInput(parsed);
  if (tool === "translate_region") return translateRegionInput(parsed);
  if (tool === "find_orfs") return findOrfsInput(parsed);
  if (tool === "find_restriction_sites" || tool === "simulate_digest") return enzymeInput(parsed);
  if (tool === "simulate_pcr") return simulatePcrInput(parsed);
  if (tool === "simulate_assembly") return simulateAssemblyInput(parsed);
  if (tool === "export_genbank") return exportGenBankInput(parsed);
  if (tool === "export_grna_report") return exportGrnaReportInput(parsed);
  if (tool === "render_plasmid_map") return renderPlasmidMapInput(parsed);
  if (tool === "render_digest_gel") return renderDigestGelInput(parsed);
  if (tool === "render_review_bundle") return renderReviewBundleInput(parsed);
  if (tool === "align_sequences") return alignSequencesInput(parsed);
  if (tool === "blast_sequence") return blastSequenceInput(parsed);
  if (tool === "design_primers") return designPrimersInput(parsed);
  if (tool === "design_grnas") return designGrnasInput(parsed);
  if (tool === "export_protein_fasta") return exportProteinFastaInput(parsed);
  if (tool === "validate_mrna_construct") return validateMrnaConstructInput(parsed);
  return workspaceInput(parsed);
}

async function runCliTool(tool: ToolName, parsed: ParsedArgs): Promise<ToolResultEnvelope> {
  try {
    return await runToolHandler(tool, await inputForTool(tool, parsed) as never);
  } catch (error) {
    return toolFailureFromError(tool, error);
  }
}

function openSequenceInput(parsed: ParsedArgs): OpenSequenceInput {
  const inputPath = stringFlag(parsed, "input-path") ?? parsed.positional[0] ?? "";
  return {
    inputPath,
    workspaceDir: stringFlag(parsed, "workspace-dir") ?? "",
    ...(stringFlag(parsed, "format") ? { format: stringFlag(parsed, "format") as OpenSequenceInput["format"] } : {}),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "expected-revision") !== undefined ? { expectedRevision: numberFlag(parsed, "expected-revision") } : {}),
  };
}

function workspaceInput(parsed: ParsedArgs): WorkspaceInput {
  return {
    workspacePath: stringFlag(parsed, "workspace-path") ?? parsed.positional[0],
    workspaceDir: stringFlag(parsed, "workspace-dir"),
    checkSequenceDigests: parsed.flags["no-check-sequence-digests"] === true ? false : true,
  };
}

function openSequenceEditorInput(parsed: ParsedArgs): OpenSequenceEditorInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { moleculeId: stringFlag(parsed, "molecule") } : {}),
    ...(stringFlag(parsed, "host") ? { host: stringFlag(parsed, "host") } : {}),
    ...(stringFlag(parsed, "port") !== undefined ? { port: numberFlag(parsed, "port") } : {}),
  };
}

function sequenceContextInput(parsed: ParsedArgs): SequenceContextInput {
  return {
    workspacePath: stringFlag(parsed, "workspace-path") ?? parsed.positional[0],
    workspaceDir: stringFlag(parsed, "workspace-dir"),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    ...(stringFlag(parsed, "start") !== undefined ? { start: numberFlag(parsed, "start") } : {}),
    ...(stringFlag(parsed, "end") !== undefined ? { end: numberFlag(parsed, "end") } : {}),
    ...(stringFlag(parsed, "strand") ? { strand: stringFlag(parsed, "strand") as SequenceContextInput["strand"] } : {}),
    includeSequence: parsed.flags["include-sequence"] === true,
  };
}

async function upsertFeatureInput(parsed: ParsedArgs): Promise<UpsertFeatureInput> {
  return {
    ...workspaceInput(parsed),
    expectedRevision: numberFlag(parsed, "expected-revision"),
    feature: await jsonFileFlag(parsed, "feature"),
  } as UpsertFeatureInput;
}

function editSequenceInput(parsed: ParsedArgs): ToolInputByName["edit_sequence"] {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    expectedRevision: numberFlag(parsed, "expected-revision"),
    operation: stringFlag(parsed, "operation") as ToolInputByName["edit_sequence"]["operation"],
    start: numberFlag(parsed, "start"),
    ...(stringFlag(parsed, "end") !== undefined ? { end: numberFlag(parsed, "end") } : {}),
    ...(stringFlag(parsed, "sequence") !== undefined ? { sequence: stringFlag(parsed, "sequence") } : {}),
  };
}

function deleteFeatureInput(parsed: ParsedArgs): DeleteFeatureInput {
  return {
    ...workspaceInput(parsed),
    expectedRevision: numberFlag(parsed, "expected-revision"),
    featureId: stringFlag(parsed, "feature-id") ?? "",
  };
}

async function upsertPrimerInput(parsed: ParsedArgs): Promise<UpsertPrimerInput> {
  return {
    ...workspaceInput(parsed),
    expectedRevision: numberFlag(parsed, "expected-revision"),
    primer: await jsonFileFlag(parsed, "primer"),
    bindToMolecule: parsed.flags["bind-to-molecule"] === true,
  } as UpsertPrimerInput;
}

function deletePrimerInput(parsed: ParsedArgs): DeletePrimerInput {
  return {
    ...workspaceInput(parsed),
    expectedRevision: numberFlag(parsed, "expected-revision"),
    primerId: stringFlag(parsed, "primer-id") ?? "",
  };
}

async function upsertGrnaInput(parsed: ParsedArgs): Promise<UpsertGrnaInput> {
  return {
    ...workspaceInput(parsed),
    expectedRevision: numberFlag(parsed, "expected-revision"),
    guide: await jsonFileFlag(parsed, "guide"),
  } as UpsertGrnaInput;
}

function reverseComplementInput(parsed: ParsedArgs): ReverseComplementInput {
  return { sequence: stringFlag(parsed, "sequence") ?? parsed.positional[0] ?? "" };
}

function translateRegionInput(parsed: ParsedArgs): TranslateRegionInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    start: numberFlag(parsed, "start"),
    end: numberFlag(parsed, "end"),
    ...(stringFlag(parsed, "strand") ? { strand: stringFlag(parsed, "strand") as TranslateRegionInput["strand"] } : {}),
    ...(stringFlag(parsed, "genetic-code") ? { geneticCode: stringFlag(parsed, "genetic-code") as TranslateRegionInput["geneticCode"] } : {}),
  };
}

function findOrfsInput(parsed: ParsedArgs): FindOrfsInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    ...(stringFlag(parsed, "min-aa") !== undefined ? { minAa: numberFlag(parsed, "min-aa") } : {}),
    ...(stringFlag(parsed, "start-codons") ? { startCodons: commaListFlag(parsed, "start-codons") } : {}),
    ...(stringFlag(parsed, "stop-codons") ? { stopCodons: commaListFlag(parsed, "stop-codons") } : {}),
    ...(stringFlag(parsed, "strands") ? { strands: commaListFlag(parsed, "strands") as Array<"+" | "-"> } : {}),
  };
}

function enzymeInput(parsed: ParsedArgs): EnzymeInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    enzymes: commaListFlag(parsed, "enzymes"),
  };
}

function simulatePcrInput(parsed: ParsedArgs): SimulatePcrInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    forwardPrimer: stringFlag(parsed, "forward") ?? stringFlag(parsed, "forward-primer") ?? "",
    reversePrimer: stringFlag(parsed, "reverse") ?? stringFlag(parsed, "reverse-primer") ?? "",
  };
}

async function simulateAssemblyInput(parsed: ParsedArgs): Promise<SimulateAssemblyToolInput> {
  const input = await jsonFileFlag(parsed, "input");
  if (input === undefined) {
    throw new MoleculeError("INVALID_ARGUMENT", "simulate-assembly requires --input <json-file>.");
  }
  return input as SimulateAssemblyToolInput;
}

function exportGenBankInput(parsed: ParsedArgs): ExportGenBankInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    outputPath: stringFlag(parsed, "output") ?? stringFlag(parsed, "output-path") ?? "",
  };
}

function exportProteinFastaInput(parsed: ParsedArgs): ExportProteinFastaInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    cdsStart: numberFlag(parsed, "cds-start"),
    cdsEnd: numberFlag(parsed, "cds-end"),
    ...(stringFlag(parsed, "protein-id") ? { proteinId: stringFlag(parsed, "protein-id") } : {}),
    ...(stringFlag(parsed, "output") ? { outputPath: stringFlag(parsed, "output") } : {}),
    ...(stringFlag(parsed, "output-path") ? { outputPath: stringFlag(parsed, "output-path") } : {}),
  };
}

async function validateMrnaConstructInput(parsed: ParsedArgs): Promise<ValidateMrnaConstructToolInput> {
  const elements = await jsonFileFlag(parsed, "elements");
  if (elements === undefined) {
    throw new MoleculeError("INVALID_ARGUMENT", "validate-mrna-construct requires --elements <json-file>.");
  }
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { moleculeId: stringFlag(parsed, "molecule") } : {}),
    templateType: stringFlag(parsed, "template-type") as ValidateMrnaConstructToolInput["templateType"],
    elements: elements as ValidateMrnaConstructToolInput["elements"],
  };
}

function exportGrnaReportInput(parsed: ParsedArgs): ExportGrnaReportInput {
  return {
    ...workspaceInput(parsed),
    guideIds: commaListFlag(parsed, "guide-ids"),
    ...(stringFlag(parsed, "output") ? { outputPath: stringFlag(parsed, "output") } : {}),
    ...(stringFlag(parsed, "output-path") ? { outputPath: stringFlag(parsed, "output-path") } : {}),
  };
}

async function renderPlasmidMapInput(parsed: ParsedArgs): Promise<RenderPlasmidMapInput> {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    ...(stringFlag(parsed, "output") ? { outputPath: stringFlag(parsed, "output") } : {}),
    ...(stringFlag(parsed, "output-path") ? { outputPath: stringFlag(parsed, "output-path") } : {}),
    ...(stringFlag(parsed, "width") !== undefined ? { width: numberFlag(parsed, "width") } : {}),
    ...(stringFlag(parsed, "height") !== undefined ? { height: numberFlag(parsed, "height") } : {}),
    ...(stringFlag(parsed, "cut-sites") ? { cutSites: await jsonFileFlag(parsed, "cut-sites") as RenderPlasmidMapInput["cutSites"] } : {}),
    ...(parsed.flags["show-primers"] === true ? { showPrimers: true } : {}),
    ...(parsed.flags["show-guides"] === true ? { showGuides: true } : {}),
  };
}

async function renderDigestGelInput(parsed: ParsedArgs): Promise<RenderDigestGelInput> {
  return {
    ...workspaceInput(parsed),
    gelId: stringFlag(parsed, "gel-id") ?? stringFlag(parsed, "gelId") ?? "",
    lanes: await jsonFileFlag(parsed, "lanes") as RenderDigestGelInput["lanes"],
    ...(stringFlag(parsed, "custom-ladder") ? { customLadder: commaListFlag(parsed, "custom-ladder").map((entry) => Number(entry)) } : {}),
    ...(stringFlag(parsed, "output") ? { outputPath: stringFlag(parsed, "output") } : {}),
    ...(stringFlag(parsed, "output-path") ? { outputPath: stringFlag(parsed, "output-path") } : {}),
    ...(stringFlag(parsed, "width") !== undefined ? { width: numberFlag(parsed, "width") } : {}),
    ...(stringFlag(parsed, "height") !== undefined ? { height: numberFlag(parsed, "height") } : {}),
  };
}

async function renderReviewBundleInput(parsed: ParsedArgs): Promise<RenderReviewBundleInput> {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "output") ? { outputPath: stringFlag(parsed, "output") } : {}),
    ...(stringFlag(parsed, "output-path") ? { outputPath: stringFlag(parsed, "output-path") } : {}),
    ...(stringFlag(parsed, "artifacts") ? { artifacts: await jsonFileFlag(parsed, "artifacts") as RenderReviewBundleInput["artifacts"] } : {}),
    ...(stringFlag(parsed, "replay-bundle-path") ? { replayBundlePath: stringFlag(parsed, "replay-bundle-path") } : {}),
    ...(stringFlag(parsed, "molecule-ids") ? { moleculeIds: commaListFlag(parsed, "molecule-ids") } : {}),
    ...(parsed.flags["include-replay-summary"] === true ? { includeReplaySummary: true } : {}),
    ...(parsed.flags["include-local-paths"] === true ? { includeLocalPaths: true } : {}),
  };
}

function alignSequencesInput(parsed: ParsedArgs): AlignSequencesInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "sequence") !== undefined ? { sequence: stringFlag(parsed, "sequence") } : {}),
    ...(stringFlag(parsed, "target-sequence") !== undefined ? { targetSequence: stringFlag(parsed, "target-sequence") } : {}),
    ...(stringFlag(parsed, "molecule-id") !== undefined ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "target-molecule-id") !== undefined ? { targetMoleculeId: stringFlag(parsed, "target-molecule-id") } : {}),
    ...(stringFlag(parsed, "mode") !== undefined ? { mode: stringFlag(parsed, "mode") as AlignSequencesInput["mode"] } : {}),
    ...(stringFlag(parsed, "match") !== undefined ? { match: numberFlag(parsed, "match") } : {}),
    ...(stringFlag(parsed, "mismatch") !== undefined ? { mismatch: numberFlag(parsed, "mismatch") } : {}),
    ...(stringFlag(parsed, "gap") !== undefined ? { gap: numberFlag(parsed, "gap") } : {}),
  };
}

function blastSequenceInput(parsed: ParsedArgs): BlastSequenceToolInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") !== undefined ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") !== undefined ? { molecule: stringFlag(parsed, "molecule") } : {}),
    ...(stringFlag(parsed, "sequence") !== undefined ? { sequence: stringFlag(parsed, "sequence") } : {}),
    database: stringFlag(parsed, "database") as BlastSequenceToolInput["database"],
    program: stringFlag(parsed, "program") as BlastSequenceToolInput["program"],
    ...(stringFlag(parsed, "hitlist-size") !== undefined ? { hitlistSize: numberFlag(parsed, "hitlist-size") } : {}),
    ...(stringFlag(parsed, "e-value-threshold") !== undefined ? { eValueThreshold: Number(stringFlag(parsed, "e-value-threshold")) } : {}),
    ...(stringFlag(parsed, "entrez-query") !== undefined ? { entrezQuery: stringFlag(parsed, "entrez-query") } : {}),
    ...(stringFlag(parsed, "output") !== undefined ? { outputPath: stringFlag(parsed, "output") } : {}),
    ...(stringFlag(parsed, "output-path") !== undefined ? { outputPath: stringFlag(parsed, "output-path") } : {}),
  };
}

function designPrimersInput(parsed: ParsedArgs): DesignPrimersToolInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    target: {
      start: numberFlag(parsed, "target-start"),
      end: numberFlag(parsed, "target-end"),
    },
    options: {
      ...(stringFlag(parsed, "product-size-range") ? { productSizeRange: numberPairFlag(parsed, "product-size-range") } : {}),
      ...(stringFlag(parsed, "tm-range") ? { tmRange: numberPairFlag(parsed, "tm-range") } : {}),
      ...(stringFlag(parsed, "primer-size-range") ? { primerSizeRange: numberPairFlag(parsed, "primer-size-range") } : {}),
      ...(stringFlag(parsed, "num-return") !== undefined ? { numReturn: numberFlag(parsed, "num-return") } : {}),
      ...(stringFlag(parsed, "left-overhang") ? { leftOverhang: stringFlag(parsed, "left-overhang") } : {}),
      ...(stringFlag(parsed, "right-overhang") ? { rightOverhang: stringFlag(parsed, "right-overhang") } : {}),
    },
  };
}

function designGrnasInput(parsed: ParsedArgs): DesignGrnasToolInput {
  return {
    ...workspaceInput(parsed),
    ...(stringFlag(parsed, "molecule-id") ? { moleculeId: stringFlag(parsed, "molecule-id") } : {}),
    ...(stringFlag(parsed, "molecule") ? { molecule: stringFlag(parsed, "molecule") } : {}),
    targetRegion: {
      start: numberFlag(parsed, "target-start") || numberFlag(parsed, "target-region-start"),
      end: numberFlag(parsed, "target-end") || numberFlag(parsed, "target-region-end"),
    },
    options: {
      ...(stringFlag(parsed, "pam-type") ? { pamType: stringFlag(parsed, "pam-type") as "SpCas9" } : {}),
      ...(stringFlag(parsed, "guide-length") !== undefined ? { guideLength: numberFlag(parsed, "guide-length") } : {}),
      ...(stringFlag(parsed, "strand") ? { strand: stringFlag(parsed, "strand") as "both" | "+" | "-" } : {}),
      ...(stringFlag(parsed, "gc-range") ? { gcRange: numberPairFlag(parsed, "gc-range") } : {}),
      ...(stringFlag(parsed, "max-seed-homopolymer-run") !== undefined ? { maxSeedHomopolymerRun: numberFlag(parsed, "max-seed-homopolymer-run") } : {}),
      ...(stringFlag(parsed, "off-target-molecule-ids") ? { offTargetMoleculeIds: commaListFlag(parsed, "off-target-molecule-ids") } : {}),
      ...(stringFlag(parsed, "max-off-target-mismatches") !== undefined ? { maxOffTargetMismatches: numberFlag(parsed, "max-off-target-mismatches") } : {}),
    },
  };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(parsed: ParsedArgs, name: string): number {
  const value = stringFlag(parsed, name);
  return value === undefined ? Number.NaN : Number(value);
}

function commaListFlag(parsed: ParsedArgs, name: string): string[] {
  const value = stringFlag(parsed, name);
  return value === undefined ? [] : value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function numberPairFlag(parsed: ParsedArgs, name: string): [number, number] {
  const values = commaListFlag(parsed, name).map((entry) => Number(entry));
  return [values[0] ?? Number.NaN, values[1] ?? Number.NaN];
}

async function jsonFileFlag(parsed: ParsedArgs, name: string): Promise<unknown> {
  const filePath = stringFlag(parsed, name);
  if (filePath === undefined) return undefined;
  return JSON.parse(stripUtf8Bom(await fs.readFile(filePath, "utf8"))) as unknown;
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, stdout } = await runCli();
  process.stdout.write(stdout);
  process.exitCode = exitCode;
}
