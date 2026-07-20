import { promises as fs } from "node:fs";
import path from "node:path";

import { parseFasta, type ParsedFastaRecord, formatSingleRecordFasta } from "./fasta.js";
import { parseGenBank, type ParsedGenBankRecord } from "./genbank.js";
import { validateWorkspaceOrThrow, writeWorkspaceFile } from "./workspace.js";
import type { Feature, Molecule, MoleculeWorkspace, SourceFormat } from "./schema.js";
import { sequenceDigest } from "./sequence.js";
import { ensureSequenceDataDir, uniqueSequenceFileName } from "./sequence-storage.js";
import { MoleculeError, WorkspaceRevisionError } from "./errors.js";

export type ImportFormat = "auto" | SourceFormat;

export type ImportSequenceFileOptions = {
  inputPath: string;
  workspaceDir: string;
  format?: ImportFormat;
  moleculeId?: string;
  expectedRevision?: number;
};

export type ImportSequenceFileResult = {
  ok: true;
  workspacePath: string;
  moleculeIds: string[];
  previousRevision: number;
  revision: number;
  copiedPaths: string[];
};

type ImportRecord = {
  name: string;
  sequence: string;
  topology: "linear" | "circular";
  moleculeType: "dna" | "rna" | "protein";
  alphabet: "iupac_dna" | "iupac_rna" | "protein";
  sourceFormat: SourceFormat;
  description?: string;
  features: Omit<Feature, "id" | "moleculeId" | "source">[];
  fileContent: string;
  fileExtension: string;
};

export async function importSequenceFile(options: ImportSequenceFileOptions): Promise<ImportSequenceFileResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  await fs.mkdir(workspaceDir, { recursive: true });
  const workspaceRoot = await fs.realpath(workspaceDir);
  const inputPath = await confinedInputPath(options.inputPath, workspaceRoot);
  const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
  const format = await detectFormat(inputPath, options.format ?? "auto");
  const content = await fs.readFile(inputPath, "utf8");
  const records = format === "fasta" ? fastaImportRecords(content) : genBankImportRecords(content);
  const dataDir = await ensureSequenceDataDir(workspaceDir);

  let { workspace, existed } = await readOrCreateWorkspace(workspacePath);
  const previousRevision = workspace.revision;
  if (existed) {
    if (options.expectedRevision === undefined) {
      throw new MoleculeError("INVALID_ARGUMENT", "expectedRevision is required when importing into an existing workspace.", {
        actualRevision: previousRevision,
      });
    }
    if (workspace.revision !== options.expectedRevision) {
      throw new WorkspaceRevisionError(options.expectedRevision, workspace.revision);
    }
  }
  const moleculeIds: string[] = [];
  const copiedPaths: string[] = [];
  const usedMoleculeIds = new Set(workspace.molecules.map((molecule) => molecule.id));
  const usedFeatureIds = new Set(workspace.features.map((feature) => feature.id));

  for (const [index, record] of records.entries()) {
    const moleculeId = uniqueId(
      usedMoleculeIds,
      options.moleculeId && records.length === 1 ? options.moleculeId : `mol_${slug(record.name)}${records.length > 1 ? `_${index + 1}` : ""}`,
    );
    const fileName = uniqueSequenceFileName(dataDir, `${slug(record.name)}${record.fileExtension}`);
    const absoluteCopiedPath = path.join(dataDir, fileName);
    await fs.writeFile(absoluteCopiedPath, record.fileContent, "utf8");
    const relativePath = path.relative(workspaceDir, absoluteCopiedPath);
    copiedPaths.push(relativePath);
    moleculeIds.push(moleculeId);

    const molecule: Molecule = {
      id: moleculeId,
      name: record.name,
      path: relativePath,
      sourceFormat: record.sourceFormat,
      sequenceDigest: sequenceDigest(record.sequence),
      length: record.sequence.length,
      topology: record.topology,
      moleculeType: record.moleculeType,
      alphabet: record.alphabet,
      ...(record.description ? { description: record.description } : {}),
    };
    workspace.molecules.push(molecule);
    for (const [featureIndex, feature] of record.features.entries()) {
      const baseFeatureId = `feat_${moleculeId}_${slug(feature.name || feature.type || `feature_${featureIndex + 1}`)}`;
      workspace.features.push({
        id: uniqueId(usedFeatureIds, baseFeatureId),
        moleculeId,
        ...feature,
        source: { kind: "import", tool: "open_sequence" },
      });
    }
  }

  if (previousRevision > 0 || workspace.molecules.length > moleculeIds.length) {
    workspace.revision = previousRevision + 1;
  }
  workspace.updatedAt = new Date().toISOString();
  workspace = await validateWorkspaceOrThrow(workspace, { workspacePath, checkSequenceDigests: true });
  await writeWorkspaceFile(workspacePath, workspace);
  return { ok: true, workspacePath, moleculeIds, previousRevision, revision: workspace.revision, copiedPaths };
}

async function confinedInputPath(inputPath: string, workspaceRoot: string): Promise<string> {
  const resolvedInputPath = path.resolve(inputPath);
  const realInputPath = await fs.realpath(resolvedInputPath);
  const relative = path.relative(workspaceRoot, realInputPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MoleculeError("PATH_OUTSIDE_WORKSPACE", "Input path must resolve inside the workspace root.", {
      inputPath: realInputPath,
      workspaceRoot,
    });
  }
  return realInputPath;
}

async function readOrCreateWorkspace(workspacePath: string): Promise<{ workspace: MoleculeWorkspace; existed: boolean }> {
  try {
    return {
      workspace: await validateWorkspaceOrThrow(JSON.parse(await fs.readFile(workspacePath, "utf8")) as unknown, {
        workspacePath,
        checkSequenceDigests: true,
      }),
      existed: true,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;
  }
  const now = new Date().toISOString();
  return {
    workspace: {
      schema: "datalox.molecule.workspace",
      version: 1,
      revision: 0,
      workspaceId: `molws_${slug(path.basename(path.dirname(workspacePath)))}`,
      createdAt: now,
      updatedAt: now,
      molecules: [],
      features: [],
      primers: [],
      guides: [],
      constructs: [],
      experiments: [],
      auditEvents: [],
    },
    existed: false,
  };
}

async function detectFormat(inputPath: string, requested: ImportFormat): Promise<SourceFormat> {
  if (requested === "fasta" || requested === "genbank") return requested;
  const extension = path.extname(inputPath).toLowerCase();
  if ([".fa", ".fasta", ".fna"].includes(extension)) return "fasta";
  if ([".gb", ".gbk", ".genbank"].includes(extension)) return "genbank";
  const handle = await fs.open(inputPath, "r");
  try {
    const buffer = Buffer.alloc(256);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, read.bytesRead).toString("utf8").trimStart();
    if (prefix.startsWith(">")) return "fasta";
    if (prefix.startsWith("LOCUS")) return "genbank";
  } finally {
    await handle.close();
  }
  throw new MoleculeError("UNSUPPORTED_FORMAT", "Unable to determine sequence file format.", { inputPath });
}

function fastaImportRecords(content: string): ImportRecord[] {
  const records = parseFasta(content, "iupac_dna");
  return records.map((record: ParsedFastaRecord) => ({
    name: record.name,
    sequence: record.sequence,
    topology: "linear",
    moleculeType: "dna",
    alphabet: "iupac_dna",
    sourceFormat: "fasta",
    features: [],
    fileContent: records.length === 1 ? content : formatSingleRecordFasta(record.name, record.sequence),
    fileExtension: ".fa",
  }));
}

function genBankImportRecords(content: string): ImportRecord[] {
  const record = parseGenBank(content);
  return [
    {
      name: record.name,
      sequence: record.sequence,
      topology: record.topology,
      moleculeType: record.moleculeType,
      alphabet: record.alphabet,
      sourceFormat: "genbank",
      ...(record.description ? { description: record.description } : {}),
      features: record.features.map((feature) => ({
        name: feature.qualifiers.gene?.toString() ?? feature.qualifiers.label?.toString() ?? feature.qualifiers.product?.toString() ?? feature.key,
        type: feature.key,
        segments: feature.segments,
        qualifiers: feature.qualifiers,
      })),
      fileContent: content,
      fileExtension: ".gb",
    },
  ];
}

function slug(value: string): string {
  const slugged = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return slugged.length > 0 ? slugged : "record";
}

function uniqueId(used: Set<string>, preferred: string): string {
  let candidate = preferred;
  for (let index = 2; used.has(candidate); index += 1) {
    candidate = `${preferred}_${index}`;
  }
  used.add(candidate);
  return candidate;
}
