import { promises as fs } from "node:fs";
import path from "node:path";

import { validateSegments } from "./coordinates.js";
import {
  MoleculeError,
  type ValidationIssue,
  type ValidationResult,
  WorkspaceRevisionError,
  WorkspaceValidationError,
  validationIssue,
} from "./errors.js";
import { validateWorkspaceRelativePath, workspaceRootFromPath } from "./paths.js";
import {
  WORKSPACE_SCHEMA,
  WORKSPACE_VERSION,
  type Alphabet,
  type Feature,
  type Molecule,
  type MoleculeWorkspace,
  type Primer,
  type SourceFormat,
} from "./schema.js";
import { defaultAlphabetForMoleculeType, parseStoredSequenceContent, sequenceDigest, validateSequenceAlphabet } from "./sequence.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validateRequiredString(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  if (!isNonEmptyString(value)) {
    issues.push(validationIssue(issuePath, "VALIDATION_ERROR", "Value must be a non-empty string."));
  }
}

function validateDuplicateIds(items: unknown, collectionPath: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(items)) return;
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string") return;
    const previousIndex = seen.get(item.id);
    if (previousIndex !== undefined) {
      issues.push(validationIssue(`${collectionPath}[${index}].id`, "VALIDATION_ERROR", "Duplicate id in collection.", {
        id: item.id,
        firstPath: `${collectionPath}[${previousIndex}].id`,
      }));
    } else {
      seen.set(item.id, index);
    }
  });
}

function validateArray(value: unknown, issuePath: string, issues: ValidationIssue[]): value is unknown[] {
  if (!Array.isArray(value)) {
    issues.push(validationIssue(issuePath, "VALIDATION_ERROR", "Value must be an array."));
    return false;
  }
  return true;
}

function validateMolecule(value: unknown, index: number, workspaceRoot: string, issues: ValidationIssue[]): Molecule | null {
  const issuePath = `molecules[${index}]`;
  if (!isRecord(value)) {
    issues.push(validationIssue(issuePath, "VALIDATION_ERROR", "Molecule must be an object."));
    return null;
  }
  validateRequiredString(value.id, `${issuePath}.id`, issues);
  validateRequiredString(value.name, `${issuePath}.name`, issues);
  validateRequiredString(value.path, `${issuePath}.path`, issues);
  issues.push(...validateWorkspaceRelativePath(value.path, `${issuePath}.path`, workspaceRoot));
  if (value.sourceFormat !== "fasta" && value.sourceFormat !== "genbank") {
    issues.push(validationIssue(`${issuePath}.sourceFormat`, "VALIDATION_ERROR", "Source format must be 'fasta' or 'genbank'."));
  }
  if (typeof value.sequenceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.sequenceDigest)) {
    issues.push(validationIssue(`${issuePath}.sequenceDigest`, "VALIDATION_ERROR", "Sequence digest must be sha256:<64 lowercase hex characters>."));
  }
  if (typeof value.length !== "number" || !Number.isInteger(value.length) || value.length < 1) {
    issues.push(validationIssue(`${issuePath}.length`, "VALIDATION_ERROR", "Molecule length must be a positive integer."));
  }
  if (value.topology !== "linear" && value.topology !== "circular") {
    issues.push(validationIssue(`${issuePath}.topology`, "VALIDATION_ERROR", "Topology must be 'linear' or 'circular'."));
  }
  if (value.moleculeType !== "dna" && value.moleculeType !== "rna" && value.moleculeType !== "protein") {
    issues.push(validationIssue(`${issuePath}.moleculeType`, "VALIDATION_ERROR", "Molecule type must be 'dna', 'rna', or 'protein'."));
  }
  if (value.alphabet !== "iupac_dna" && value.alphabet !== "iupac_rna" && value.alphabet !== "protein") {
    issues.push(validationIssue(`${issuePath}.alphabet`, "VALIDATION_ERROR", "Alphabet must be a supported workspace alphabet."));
  }
  if (typeof value.description !== "undefined" && typeof value.description !== "string") {
    issues.push(validationIssue(`${issuePath}.description`, "VALIDATION_ERROR", "Description must be a string when present."));
  }
  if (issues.some((issue) => issue.path.startsWith(issuePath))) return null;
  return value as Molecule;
}

async function validateStoredSequenceDigest(
  workspaceRoot: string,
  molecule: Molecule,
  issuePath: string,
  issues: ValidationIssue[],
): Promise<void> {
  const resolved = path.resolve(workspaceRoot, molecule.path);
  try {
    const content = await fs.readFile(resolved, "utf8");
    const sequence = parseStoredSequenceContent(content, molecule.sourceFormat, molecule.alphabet);
    const digest = sequenceDigest(sequence);
    if (sequence.length !== molecule.length) {
      issues.push(validationIssue(`${issuePath}.length`, "VALIDATION_ERROR", "Molecule length does not match source sequence length.", {
        expected: molecule.length,
        actual: sequence.length,
      }));
    }
    if (digest !== molecule.sequenceDigest) {
      issues.push(validationIssue(`${issuePath}.sequenceDigest`, "VALIDATION_ERROR", "Molecule sequence digest does not match source sequence.", {
        expected: molecule.sequenceDigest,
        actual: digest,
      }));
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      issues.push(validationIssue(`${issuePath}.path`, "FILE_NOT_FOUND", "Molecule source file was not found.", {
        path: molecule.path,
      }));
      return;
    }
    if (error instanceof MoleculeError) {
      issues.push(validationIssue(`${issuePath}.path`, error.code, error.message, error.details));
      return;
    }
    throw error;
  }
}

function validateFeature(value: unknown, index: number, moleculeById: Map<string, Molecule>, issues: ValidationIssue[]): Feature | null {
  const issuePath = `features[${index}]`;
  if (!isRecord(value)) {
    issues.push(validationIssue(issuePath, "VALIDATION_ERROR", "Feature must be an object."));
    return null;
  }
  validateRequiredString(value.id, `${issuePath}.id`, issues);
  validateRequiredString(value.moleculeId, `${issuePath}.moleculeId`, issues);
  validateRequiredString(value.name, `${issuePath}.name`, issues);
  validateRequiredString(value.type, `${issuePath}.type`, issues);
  const molecule = typeof value.moleculeId === "string" ? moleculeById.get(value.moleculeId) : undefined;
  if (typeof value.moleculeId === "string" && !molecule) {
    issues.push(validationIssue(`${issuePath}.moleculeId`, "MOLECULE_NOT_FOUND", "Feature references a missing molecule.", {
      moleculeId: value.moleculeId,
    }));
  }
  if (molecule) {
    issues.push(...validateSegments(value.segments, molecule.length, `${issuePath}.segments`));
  } else if (!Array.isArray(value.segments) || value.segments.length === 0) {
    issues.push(validationIssue(`${issuePath}.segments`, "VALIDATION_ERROR", "Feature segments must be a non-empty array."));
  }
  if (typeof value.qualifiers !== "undefined") {
    if (!isRecord(value.qualifiers)) {
      issues.push(validationIssue(`${issuePath}.qualifiers`, "VALIDATION_ERROR", "Feature qualifiers must be an object."));
    } else {
      for (const [key, qualifierValue] of Object.entries(value.qualifiers)) {
        if (typeof qualifierValue === "string") continue;
        if (Array.isArray(qualifierValue) && qualifierValue.every((entry) => typeof entry === "string")) continue;
        issues.push(validationIssue(`${issuePath}.qualifiers.${key}`, "VALIDATION_ERROR", "Feature qualifier values must be strings or string arrays."));
      }
    }
  }
  return issues.some((issue) => issue.path.startsWith(issuePath)) ? null : value as Feature;
}

function validatePrimer(value: unknown, index: number, moleculeById: Map<string, Molecule>, issues: ValidationIssue[]): Primer | null {
  const issuePath = `primers[${index}]`;
  if (!isRecord(value)) {
    issues.push(validationIssue(issuePath, "VALIDATION_ERROR", "Primer must be an object."));
    return null;
  }
  validateRequiredString(value.id, `${issuePath}.id`, issues);
  validateRequiredString(value.name, `${issuePath}.name`, issues);
  validateRequiredString(value.sequence, `${issuePath}.sequence`, issues);
  let alphabet: Alphabet = "iupac_dna";
  if (typeof value.moleculeId !== "undefined") {
    if (typeof value.moleculeId !== "string" || value.moleculeId.length === 0) {
      issues.push(validationIssue(`${issuePath}.moleculeId`, "VALIDATION_ERROR", "Primer moleculeId must be a non-empty string when present."));
    } else {
      const molecule = moleculeById.get(value.moleculeId);
      if (!molecule) {
        issues.push(validationIssue(`${issuePath}.moleculeId`, "MOLECULE_NOT_FOUND", "Primer references a missing molecule.", {
          moleculeId: value.moleculeId,
        }));
      } else {
        alphabet = defaultAlphabetForMoleculeType(molecule.moleculeType);
      }
    }
  }
  issues.push(...validateSequenceAlphabet(value.sequence, alphabet, `${issuePath}.sequence`));
  if (isRecord(value.binding)) {
    const molecule = typeof value.moleculeId === "string" ? moleculeById.get(value.moleculeId) : undefined;
    if (!molecule) {
      issues.push(validationIssue(`${issuePath}.binding`, "VALIDATION_ERROR", "Primer binding requires a valid moleculeId."));
    } else {
      issues.push(...validateSegments(value.binding.segments, molecule.length, `${issuePath}.binding.segments`, true));
    }
  } else if (typeof value.binding !== "undefined") {
    issues.push(validationIssue(`${issuePath}.binding`, "VALIDATION_ERROR", "Primer binding must be an object when present."));
  }
  return issues.some((issue) => issue.path.startsWith(issuePath)) ? null : value as Primer;
}

export async function validateWorkspace(
  value: unknown,
  options: { workspacePath?: string; checkSequenceDigests?: boolean } = {},
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const workspaceRoot = options.workspacePath ? workspaceRootFromPath(options.workspacePath) : process.cwd();
  if (!isRecord(value)) {
    return { ok: false, issues: [validationIssue("", "VALIDATION_ERROR", "Workspace must be a JSON object.")] };
  }
  if (value.schema !== WORKSPACE_SCHEMA) {
    issues.push(validationIssue("schema", "VALIDATION_ERROR", `Workspace schema must be '${WORKSPACE_SCHEMA}'.`));
  }
  if (value.version !== WORKSPACE_VERSION) {
    issues.push(validationIssue("version", "VALIDATION_ERROR", `Workspace version must be ${WORKSPACE_VERSION}.`));
  }
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) {
    issues.push(validationIssue("revision", "VALIDATION_ERROR", "Workspace revision must be a non-negative integer."));
  }
  validateRequiredString(value.workspaceId, "workspaceId", issues);
  if (!isIsoDateString(value.createdAt)) issues.push(validationIssue("createdAt", "VALIDATION_ERROR", "createdAt must be an ISO date string."));
  if (!isIsoDateString(value.updatedAt)) issues.push(validationIssue("updatedAt", "VALIDATION_ERROR", "updatedAt must be an ISO date string."));
  const molecules = validateArray(value.molecules, "molecules", issues) ? value.molecules : [];
  const features = validateArray(value.features, "features", issues) ? value.features : [];
  const primers = validateArray(value.primers, "primers", issues) ? value.primers : [];
  validateArray(value.constructs, "constructs", issues);
  validateArray(value.experiments, "experiments", issues);
  validateArray(value.auditEvents, "auditEvents", issues);
  validateDuplicateIds(molecules, "molecules", issues);
  validateDuplicateIds(features, "features", issues);
  validateDuplicateIds(primers, "primers", issues);

  const validMolecules = molecules
    .map((molecule, index) => validateMolecule(molecule, index, workspaceRoot, issues))
    .filter((molecule): molecule is Molecule => molecule !== null);
  const moleculeById = new Map(validMolecules.map((molecule) => [molecule.id, molecule]));
  features.forEach((feature, index) => validateFeature(feature, index, moleculeById, issues));
  primers.forEach((primer, index) => validatePrimer(primer, index, moleculeById, issues));

  if (options.checkSequenceDigests) {
    await Promise.all(validMolecules.map((molecule, index) => validateStoredSequenceDigest(workspaceRoot, molecule, `molecules[${index}]`, issues)));
  }
  return { ok: issues.length === 0, issues };
}

export async function validateWorkspaceOrThrow(
  value: unknown,
  options: { workspacePath?: string; checkSequenceDigests?: boolean } = {},
): Promise<MoleculeWorkspace> {
  const result = await validateWorkspace(value, options);
  if (!result.ok) throw new WorkspaceValidationError(result.issues);
  return value as MoleculeWorkspace;
}

export async function readWorkspace(workspacePath: string, options: { checkSequenceDigests?: boolean } = {}): Promise<MoleculeWorkspace> {
  const content = await fs.readFile(workspacePath, "utf8");
  const parsed = JSON.parse(content) as unknown;
  return validateWorkspaceOrThrow(parsed, { workspacePath, checkSequenceDigests: options.checkSequenceDigests });
}

export type WorkspaceTransactionResult<T> = {
  workspace: MoleculeWorkspace;
  payload: T;
  previousRevision: number;
  revision: number;
};

export async function writeWorkspaceTransaction<T>(
  workspacePath: string,
  expectedRevision: number,
  transform: (workspace: MoleculeWorkspace) => T | Promise<T>,
): Promise<WorkspaceTransactionResult<T>> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "expectedRevision must be a non-negative integer.", { expectedRevision });
  }

  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
  if (workspace.revision !== expectedRevision) {
    throw new WorkspaceRevisionError(expectedRevision, workspace.revision);
  }

  const before = JSON.stringify(workspace);
  const payload = await transform(workspace);
  const afterTransform = JSON.stringify(workspace);
  if (afterTransform === before) {
    throw new MoleculeError("NO_CHANGE", "Workspace transaction produced no changes.", { revision: workspace.revision });
  }

  const previousRevision = workspace.revision;
  workspace.revision = previousRevision + 1;
  workspace.updatedAt = new Date().toISOString();
  const validated = await validateWorkspaceOrThrow(workspace, { workspacePath, checkSequenceDigests: true });
  await writeWorkspaceFile(workspacePath, validated, { alreadyValidated: true });

  return {
    workspace: validated,
    payload,
    previousRevision,
    revision: validated.revision,
  };
}

export async function writeWorkspaceFile(workspacePath: string, workspace: MoleculeWorkspace): Promise<void>;
export async function writeWorkspaceFile(
  workspacePath: string,
  workspace: MoleculeWorkspace,
  options: { alreadyValidated?: boolean },
): Promise<void>;
export async function writeWorkspaceFile(workspacePath: string, workspace: MoleculeWorkspace, options?: { alreadyValidated?: boolean }): Promise<void> {
  if (!options?.alreadyValidated) {
    await validateWorkspaceOrThrow(workspace, { workspacePath, checkSequenceDigests: true });
  }
  await atomicWriteJson(workspacePath, workspace);
}

async function atomicWriteJson(workspacePath: string, workspace: MoleculeWorkspace): Promise<void> {
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  const directory = path.dirname(workspacePath);
  const basename = path.basename(workspacePath);
  const tempPath = path.join(directory, `.${basename}.${process.pid}.${Date.now()}.tmp`);
  const content = `${JSON.stringify(workspace, null, 2)}\n`;
  let renamed = false;
  try {
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, workspacePath);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(tempPath, { force: true });
  }
}
