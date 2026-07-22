import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_NCBI_BLAST_TOOL,
  NCBI_BLAST_ENDPOINT,
  NCBI_BLAST_RESULT_FORMAT,
  type NcbiBlastProgram,
  type NcbiBlastTransport,
  runNcbiBlast,
} from "./blast-client.js";
import type { BlastHit, BlastSearchStatistics } from "./blast-parse.js";
import { readMoleculeSequence } from "./context.js";
import { MoleculeError } from "./errors.js";
import { workspaceRootFromPath } from "./paths.js";
import type { Molecule } from "./schema.js";
import { normalizeSequence, sequenceDigest } from "./sequence.js";

export type BlastDatabase = "nt" | "nr" | "refseq_rna" | "refseq_select";
export type BlastSequenceProgram = "blastn" | "blastp" | "blastx" | "tblastn";

export type BlastSequenceInput = {
  workspacePath?: string;
  moleculeId?: string;
  sequence?: string;
  database: BlastDatabase;
  program: BlastSequenceProgram;
  hitlistSize?: number;
  eValueThreshold?: number;
  entrezQuery?: string;
  outputPath?: string;
};

export type BlastSequenceDeps = {
  transport?: NcbiBlastTransport;
  sleepSeconds?: (seconds: number) => Promise<void>;
  email?: string;
  tool?: string;
  submittedAt?: string;
  maxWaitSeconds?: number;
};

export type BlastSequenceArtifact = {
  kind: "blast_result";
  path: string;
  relativePath: string;
  mimeType: "application/json";
  description: string;
};

export type BlastSequenceResult = {
  queryId: string;
  queryLength: number;
  queryDigest: string;
  querySource: "workspace_molecule" | "raw_sequence";
  requestedDatabase: BlastDatabase;
  effectiveDatabase?: string;
  program: BlastSequenceProgram;
  parameters: {
    hitlistSize: number;
    eValueThreshold: number;
    entrezQuery?: string;
  };
  rid: string;
  rtoe: number;
  submittedAt: string;
  completedAt: string;
  hits: BlastHit[];
  hitsTruncated: boolean;
  hitlistLimitReached: boolean;
  truncationRule: "hit_count_equals_requested_hitlist_size";
  ncbiUrl: string;
  provenance: {
    endpoint: string;
    resultFormat: typeof NCBI_BLAST_RESULT_FORMAT;
    requestedDatabase: BlastDatabase;
    effectiveDatabase?: string;
    databaseStatistics?: BlastSearchStatistics;
    rid: string;
    rtoe: number;
    tool: string;
    queryDigest: string;
  };
  artifact?: BlastSequenceArtifact;
  revision?: number;
};

const DEFAULT_HITLIST_SIZE = 10;
const MAX_HITLIST_SIZE = 100;
const DEFAULT_E_VALUE_THRESHOLD = 0.001;
const DEFAULT_MAX_WAIT_SECONDS = 120;

const DATABASES: readonly BlastDatabase[] = ["nt", "nr", "refseq_rna", "refseq_select"];
const PROGRAMS: readonly BlastSequenceProgram[] = ["blastn", "blastp", "blastx", "tblastn"];

const PROGRAM_DATABASES: Record<BlastSequenceProgram, readonly BlastDatabase[]> = {
  blastn: ["nt", "refseq_select"],
  blastp: ["nr"],
  blastx: ["nr"],
  tblastn: ["nt", "refseq_rna"],
};

export async function blastSequence(input: BlastSequenceInput, deps: BlastSequenceDeps = {}): Promise<BlastSequenceResult> {
  const program = normalizeProgram(input.program);
  const database = normalizeDatabase(input.database);
  assertProgramDatabaseCompatibility(program, database);

  const hitlistSize = normalizeHitlistSize(input.hitlistSize ?? DEFAULT_HITLIST_SIZE);
  const eValueThreshold = normalizeEValueThreshold(input.eValueThreshold ?? DEFAULT_E_VALUE_THRESHOLD);
  if (input.entrezQuery !== undefined && input.entrezQuery.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "entrezQuery must be non-empty when provided.", { entrezQuery: input.entrezQuery });
  }
  if (input.outputPath !== undefined && input.outputPath.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "outputPath must be non-empty when provided.", { outputPath: input.outputPath });
  }
  if (input.workspacePath !== undefined && input.workspacePath.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "workspacePath must be non-empty when provided.", { workspacePath: input.workspacePath });
  }

  const query = await resolveBlastQuery(input, program);
  const artifactPlan = input.workspacePath === undefined
    ? outputPathRequiresWorkspace(input.outputPath)
    : resolveBlastArtifactPath(input.workspacePath, query.queryId, program, database, "pending", input.outputPath);
  const email = deps.email ?? process.env.NCBI_BLAST_EMAIL;
  if (email === undefined || email.length === 0) {
    throw new MoleculeError("DEPENDENCY_MISSING", "NCBI_BLAST_EMAIL must be set before calling blast_sequence.", {
      env: "NCBI_BLAST_EMAIL",
    });
  }
  const tool = deps.tool ?? process.env.NCBI_BLAST_TOOL ?? DEFAULT_NCBI_BLAST_TOOL;

  const runOptions = {
    sequence: query.sequence,
    database,
    program: program as NcbiBlastProgram,
    hitlistSize,
    expect: String(eValueThreshold),
    email,
    tool,
    maxWaitSeconds: deps.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS,
    ...(input.entrezQuery !== undefined ? { entrezQuery: input.entrezQuery } : {}),
    ...(deps.submittedAt !== undefined ? { submittedAt: deps.submittedAt } : {}),
    ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
    ...(deps.sleepSeconds !== undefined ? { sleepSeconds: deps.sleepSeconds } : {}),
  };
  const run = await runNcbiBlast(runOptions);

  const queryDigest = sequenceDigest(query.sequence);
  const artifact = artifactPlan === undefined
    ? undefined
    : await writeBlastArtifact(input.workspacePath as string, query.queryId, program, database, run.rid, run.raw.resultJson, input.outputPath);
  const hitlistLimitReached = run.result.hits.length >= hitlistSize;
  return {
    queryId: query.queryId,
    queryLength: query.sequence.length,
    queryDigest,
    querySource: query.source,
    requestedDatabase: database,
    ...(run.effectiveDatabase !== undefined ? { effectiveDatabase: run.effectiveDatabase } : {}),
    program,
    parameters: {
      hitlistSize,
      eValueThreshold,
      ...(input.entrezQuery !== undefined ? { entrezQuery: input.entrezQuery } : {}),
    },
    rid: run.rid,
    rtoe: run.rtoe,
    submittedAt: run.submittedAt,
    completedAt: run.completedAt,
    hits: run.result.hits,
    hitsTruncated: hitlistLimitReached,
    hitlistLimitReached,
    truncationRule: "hit_count_equals_requested_hitlist_size",
    ncbiUrl: `${NCBI_BLAST_ENDPOINT}?${new URLSearchParams({ RID: run.rid, CMD: "Get" }).toString()}`,
    provenance: {
      endpoint: run.endpoint,
      resultFormat: NCBI_BLAST_RESULT_FORMAT,
      requestedDatabase: database,
      ...(run.effectiveDatabase !== undefined ? { effectiveDatabase: run.effectiveDatabase } : {}),
      ...(run.result.statistics !== undefined ? { databaseStatistics: run.result.statistics } : {}),
      rid: run.rid,
      rtoe: run.rtoe,
      tool,
      queryDigest,
    },
    ...(artifact !== undefined ? { artifact } : {}),
    ...(query.revision !== undefined ? { revision: query.revision } : {}),
  };
}

function outputPathRequiresWorkspace(outputPath: string | undefined): undefined {
  if (outputPath !== undefined) {
    throw new MoleculeError("INVALID_ARGUMENT", "workspacePath is required when outputPath is provided.", { outputPath });
  }
  return undefined;
}

async function resolveBlastQuery(
  input: BlastSequenceInput,
  program: BlastSequenceProgram,
): Promise<{ queryId: string; sequence: string; source: "workspace_molecule" | "raw_sequence"; revision?: number }> {
  const hasMolecule = input.moleculeId !== undefined;
  const hasSequence = input.sequence !== undefined;
  if (hasMolecule === hasSequence) {
    throw new MoleculeError("INVALID_ARGUMENT", "Provide exactly one of moleculeId or sequence.", {
      moleculeId: input.moleculeId,
      sequence: input.sequence,
    });
  }

  if (hasMolecule) {
    const moleculeId = input.moleculeId as string;
    if (input.workspacePath === undefined || input.workspacePath.length === 0) {
      throw new MoleculeError("INVALID_ARGUMENT", "workspacePath is required when moleculeId is provided.", {
        workspacePath: input.workspacePath,
        moleculeId,
      });
    }
    const resolved = await readMoleculeSequence(input.workspacePath, moleculeId);
    assertProgramMoleculeCompatibility(program, resolved.molecule);
    return {
      queryId: resolved.molecule.id,
      sequence: resolved.sequence,
      source: "workspace_molecule",
      revision: resolved.revision,
    };
  }

  if (input.sequence === undefined || input.sequence.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "sequence must be non-empty when provided.", { sequence: input.sequence });
  }
  const alphabet = program === "blastp" || program === "tblastn" ? "protein" : "iupac_dna";
  return {
    queryId: "raw_sequence",
    sequence: normalizeSequence(input.sequence, alphabet),
    source: "raw_sequence",
  };
}

function assertProgramMoleculeCompatibility(program: BlastSequenceProgram, molecule: Molecule): void {
  const queryClass = queryMoleculeType(program);
  const actualClass = molecule.moleculeType === "protein" ? "protein" : "nucleotide";
  if (queryClass !== actualClass) {
    throw new MoleculeError("INVALID_ARGUMENT", `${program} is incompatible with ${molecule.moleculeType} query molecules.`, {
      program,
      moleculeType: molecule.moleculeType,
      moleculeId: molecule.id,
      requiredQueryType: queryClass,
    });
  }
}

function queryMoleculeType(program: BlastSequenceProgram): "nucleotide" | "protein" {
  return program === "blastp" || program === "tblastn" ? "protein" : "nucleotide";
}

function normalizeDatabase(database: unknown): BlastDatabase {
  if (typeof database !== "string" || !DATABASES.includes(database as BlastDatabase)) {
    throw new MoleculeError("INVALID_ARGUMENT", "database must be one of nt, nr, refseq_rna, or refseq_select.", { database });
  }
  return database as BlastDatabase;
}

function normalizeProgram(program: unknown): BlastSequenceProgram {
  if (typeof program !== "string" || !PROGRAMS.includes(program as BlastSequenceProgram)) {
    throw new MoleculeError("INVALID_ARGUMENT", "program must be one of blastn, blastp, blastx, or tblastn.", { program });
  }
  return program as BlastSequenceProgram;
}

function assertProgramDatabaseCompatibility(program: BlastSequenceProgram, database: BlastDatabase): void {
  if (!PROGRAM_DATABASES[program].includes(database)) {
    throw new MoleculeError("INVALID_ARGUMENT", "program is incompatible with database.", {
      program,
      database,
      allowedDatabases: PROGRAM_DATABASES[program],
    });
  }
}

function normalizeHitlistSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_HITLIST_SIZE) {
    throw new MoleculeError("INVALID_ARGUMENT", `hitlistSize must be an integer from 1 to ${MAX_HITLIST_SIZE}.`, {
      hitlistSize: value,
      maxHitlistSize: MAX_HITLIST_SIZE,
    });
  }
  return value;
}

function normalizeEValueThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "eValueThreshold must be a positive finite number.", { eValueThreshold: value });
  }
  return value;
}

async function writeBlastArtifact(
  workspacePath: string,
  queryId: string,
  program: BlastSequenceProgram,
  database: BlastDatabase,
  rid: string,
  resultJson: string,
  outputPath?: string,
): Promise<BlastSequenceArtifact> {
  const { relativePath, resolvedOutputPath } = resolveBlastArtifactPath(workspacePath, queryId, program, database, rid, outputPath);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fs.writeFile(resolvedOutputPath, resultJson, "utf8");
  return {
    kind: "blast_result",
    path: resolvedOutputPath,
    relativePath,
    mimeType: "application/json",
    description: `Raw NCBI BLAST ${program} JSON2_S result for ${queryId} against ${database}.`,
  };
}

function resolveBlastArtifactPath(
  workspacePath: string,
  queryId: string,
  program: BlastSequenceProgram,
  database: BlastDatabase,
  rid: string,
  outputPath?: string,
): { relativePath: string; resolvedOutputPath: string } {
  const workspaceRoot = workspaceRootFromPath(workspacePath);
  const relativePath = outputPath === undefined
    ? path.join("reports", "blast", `${safePathToken(queryId)}.${program}.${database}.${safePathToken(rid)}.json`)
    : path.relative(workspaceRoot, path.isAbsolute(outputPath) ? outputPath : path.join(workspaceRoot, outputPath));
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new MoleculeError("INVALID_ARGUMENT", "BLAST outputPath must stay inside the workspace.", {
      outputPath,
      workspaceRoot,
    });
  }
  return {
    relativePath,
    resolvedOutputPath: path.join(workspaceRoot, relativePath),
  };
}

function safePathToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return token.length === 0 ? "query" : token.slice(0, 80);
}
