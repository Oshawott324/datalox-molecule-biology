import { spawn } from "node:child_process";

import { readMoleculeSequence } from "./context.js";
import { MoleculeError } from "./errors.js";
import { assertUnambiguousDnaSequence, normalizeSequence } from "./sequence.js";

export type PrimerDesignRange = [number, number];

export type DesignPrimersOptions = {
  productSizeRange?: PrimerDesignRange;
  tmRange?: PrimerDesignRange;
  primerSizeRange?: PrimerDesignRange;
  numReturn?: number;
  leftOverhang?: string;
  rightOverhang?: string;
};

export type DesignPrimersInput = {
  workspacePath: string;
  moleculeId: string;
  target: {
    start: number;
    end: number;
  };
  options?: DesignPrimersOptions;
};

export type DesignedPrimer = {
  sequence: string;
  sequenceWithOverhang?: string;
  tm: number;
  gcPercent: number;
  start: number;
  end: number;
  strand: "+" | "-";
};

export type PrimerPairCandidate = {
  rank: number;
  penalty: number;
  left: DesignedPrimer;
  right: DesignedPrimer;
  productSize: number;
};

export type DesignPrimersResult = {
  moleculeId: string;
  target: { start: number; end: number };
  dependency: {
    name: "primer3_core";
    version?: string;
  };
  optionsUsed: Required<Pick<DesignPrimersOptions, "productSizeRange" | "tmRange" | "primerSizeRange" | "numReturn">>;
  candidates: PrimerPairCandidate[];
  nextAction: {
    type: "select_primer_pair";
    instruction: string;
  };
};

export const DEFAULT_PRIMER_DESIGN_OPTIONS = {
  productSizeRange: [200, 1000] as PrimerDesignRange,
  tmRange: [57, 63] as PrimerDesignRange,
  primerSizeRange: [18, 27] as PrimerDesignRange,
  numReturn: 5,
};

export async function designPrimers(input: DesignPrimersInput): Promise<DesignPrimersResult> {
  const { molecule, sequence } = await readMoleculeSequence(input.workspacePath, input.moleculeId);
  if (molecule.alphabet !== "iupac_dna" || molecule.moleculeType !== "dna") {
    throw new MoleculeError("ALPHABET_MISMATCH", "Primer design requires a DNA molecule.", {
      moleculeId: input.moleculeId,
      alphabet: molecule.alphabet,
      moleculeType: molecule.moleculeType,
    });
  }
  assertUnambiguousDnaSequence(sequence, input.moleculeId);

  const options = normalizePrimerDesignOptions(input.options);
  validateTarget(input.target, sequence.length);
  const boulderInput = formatPrimer3BoulderInput({
    moleculeId: input.moleculeId,
    sequence,
    target: input.target,
    options,
  });
  const primer3Output = await runPrimer3Core(boulderInput);
  const candidates = parsePrimer3Output(primer3Output, {
    leftOverhang: input.options?.leftOverhang,
    rightOverhang: input.options?.rightOverhang,
  });

  return {
    moleculeId: input.moleculeId,
    target: input.target,
    dependency: { name: "primer3_core" },
    optionsUsed: options,
    candidates,
    nextAction: {
      type: "select_primer_pair",
      instruction: "Choose a candidate, then call upsert_primer twice with expectedRevision if it should be persisted.",
    },
  };
}

export function normalizePrimerDesignOptions(options: DesignPrimersOptions = {}): DesignPrimersResult["optionsUsed"] {
  const productSizeRange = validateRange(options.productSizeRange ?? DEFAULT_PRIMER_DESIGN_OPTIONS.productSizeRange, "productSizeRange");
  const tmRange = validateRange(options.tmRange ?? DEFAULT_PRIMER_DESIGN_OPTIONS.tmRange, "tmRange");
  const primerSizeRange = validateRange(options.primerSizeRange ?? DEFAULT_PRIMER_DESIGN_OPTIONS.primerSizeRange, "primerSizeRange");
  const numReturn = options.numReturn ?? DEFAULT_PRIMER_DESIGN_OPTIONS.numReturn;
  if (!Number.isInteger(numReturn) || numReturn < 1) {
    throw new MoleculeError("INVALID_ARGUMENT", "numReturn must be a positive integer.", { numReturn });
  }
  if (options.leftOverhang !== undefined) assertUnambiguousDnaSequence(normalizeSequence(options.leftOverhang, "iupac_dna"), "leftOverhang");
  if (options.rightOverhang !== undefined) assertUnambiguousDnaSequence(normalizeSequence(options.rightOverhang, "iupac_dna"), "rightOverhang");
  return { productSizeRange, tmRange, primerSizeRange, numReturn };
}

export function formatPrimer3BoulderInput(input: {
  moleculeId: string;
  sequence: string;
  target: { start: number; end: number };
  options: DesignPrimersResult["optionsUsed"];
}): string {
  validateTarget(input.target, input.sequence.length);
  const targetStartZeroBased = input.target.start - 1;
  const targetLength = input.target.end - input.target.start + 1;
  const optTm = midpoint(input.options.tmRange);
  const optSize = Math.round(midpoint(input.options.primerSizeRange));
  return [
    `SEQUENCE_ID=${input.moleculeId}`,
    `SEQUENCE_TEMPLATE=${input.sequence}`,
    `SEQUENCE_TARGET=${targetStartZeroBased},${targetLength}`,
    `PRIMER_PRODUCT_SIZE_RANGE=${input.options.productSizeRange[0]}-${input.options.productSizeRange[1]}`,
    `PRIMER_MIN_TM=${input.options.tmRange[0]}`,
    `PRIMER_OPT_TM=${optTm}`,
    `PRIMER_MAX_TM=${input.options.tmRange[1]}`,
    `PRIMER_MIN_SIZE=${input.options.primerSizeRange[0]}`,
    `PRIMER_OPT_SIZE=${optSize}`,
    `PRIMER_MAX_SIZE=${input.options.primerSizeRange[1]}`,
    `PRIMER_NUM_RETURN=${input.options.numReturn}`,
    "=",
    "",
  ].join("\n");
}

export function parsePrimer3Output(output: string, overhangs: { leftOverhang?: string; rightOverhang?: string } = {}): PrimerPairCandidate[] {
  const records = parseBoulderRecord(output);
  const returned = numberField(records, "PRIMER_PAIR_NUM_RETURNED");
  const candidates: PrimerPairCandidate[] = [];
  for (let index = 0; index < returned; index += 1) {
    const left = coordinatePair(records, `PRIMER_LEFT_${index}`);
    const right = coordinatePair(records, `PRIMER_RIGHT_${index}`);
    const leftSequence = stringField(records, `PRIMER_LEFT_${index}_SEQUENCE`);
    const rightSequence = stringField(records, `PRIMER_RIGHT_${index}_SEQUENCE`);
    const leftPrimer: DesignedPrimer = {
      sequence: leftSequence,
      ...(overhangs.leftOverhang !== undefined ? { sequenceWithOverhang: `${normalizeSequence(overhangs.leftOverhang, "iupac_dna")}${leftSequence}` } : {}),
      tm: numberField(records, `PRIMER_LEFT_${index}_TM`),
      gcPercent: numberField(records, `PRIMER_LEFT_${index}_GC_PERCENT`),
      start: left.startZeroBased + 1,
      end: left.startZeroBased + left.length,
      strand: "+",
    };
    const rightPrimer: DesignedPrimer = {
      sequence: rightSequence,
      ...(overhangs.rightOverhang !== undefined ? { sequenceWithOverhang: `${normalizeSequence(overhangs.rightOverhang, "iupac_dna")}${rightSequence}` } : {}),
      tm: numberField(records, `PRIMER_RIGHT_${index}_TM`),
      gcPercent: numberField(records, `PRIMER_RIGHT_${index}_GC_PERCENT`),
      start: right.startZeroBased - right.length + 2,
      end: right.startZeroBased + 1,
      strand: "-",
    };
    candidates.push({
      rank: index + 1,
      penalty: numberField(records, `PRIMER_PAIR_${index}_PENALTY`),
      left: leftPrimer,
      right: rightPrimer,
      productSize: numberField(records, `PRIMER_PAIR_${index}_PRODUCT_SIZE`),
    });
  }
  return candidates;
}

function runPrimer3Core(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("primer3_core", [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new MoleculeError("DEPENDENCY_MISSING", "primer3_core was not found on PATH.", {
          dependency: "primer3_core",
          install: [
            "macOS: brew install primer3",
            "Linux/WSL: sudo apt-get install primer3",
            "Windows: no official native primer3_core.exe is published; run the MCP server inside WSL or Docker with primer3 installed there",
          ],
        }));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new MoleculeError("DETERMINISTIC_TOOL_UNAVAILABLE", "primer3_core exited with a non-zero status.", {
        dependency: "primer3_core",
        exitCode: code,
        stderr,
      }));
    });
    child.stdin.end(input);
  });
}

function validateRange(value: PrimerDesignRange, name: string): PrimerDesignRange {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0) || value[0] > value[1]) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be a positive ordered two-number range.`, { [name]: value });
  }
  return value;
}

function validateTarget(target: { start: number; end: number }, moleculeLength: number): void {
  if (!Number.isInteger(target.start) || !Number.isInteger(target.end) || target.start < 1 || target.end < 1 || target.start > target.end || target.end > moleculeLength) {
    throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Primer design target coordinates are invalid.", { target, moleculeLength });
  }
}

function midpoint(range: PrimerDesignRange): number {
  return (range[0] + range[1]) / 2;
}

function parseBoulderRecord(output: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    if (line === "=" || line.trim().length === 0) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return fields;
}

function stringField(fields: Map<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined || value.length === 0) {
    throw new MoleculeError("PARSE_ERROR", "Primer3 output is missing a required field.", { field: key });
  }
  return value;
}

function numberField(fields: Map<string, string>, key: string): number {
  const value = Number(stringField(fields, key));
  if (!Number.isFinite(value)) {
    throw new MoleculeError("PARSE_ERROR", "Primer3 output field is not numeric.", { field: key });
  }
  return value;
}

function coordinatePair(fields: Map<string, string>, key: string): { startZeroBased: number; length: number } {
  const [rawStart, rawLength] = stringField(fields, key).split(",");
  const startZeroBased = Number(rawStart);
  const length = Number(rawLength);
  if (!Number.isInteger(startZeroBased) || !Number.isInteger(length) || startZeroBased < 0 || length < 1) {
    throw new MoleculeError("PARSE_ERROR", "Primer3 coordinate field is invalid.", { field: key, value: fields.get(key) });
  }
  return { startZeroBased, length };
}
