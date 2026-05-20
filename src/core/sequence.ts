import { createHash } from "node:crypto";

import { MoleculeError, type ValidationIssue, validationIssue } from "./errors.js";
import type { Alphabet, MoleculeType } from "./schema.js";

const DNA_ALPHABET = new Set("ACGTRYSWKMBDHVN");
const RNA_ALPHABET = new Set("ACGURYSWKMBDHVN");
const PROTEIN_ALPHABET = new Set("ABCDEFGHIKLMNPQRSTVWXYZ*");

export function defaultAlphabetForMoleculeType(moleculeType: MoleculeType): Alphabet {
  if (moleculeType === "rna") return "iupac_rna";
  if (moleculeType === "protein") return "protein";
  return "iupac_dna";
}

export function normalizeSequence(sequence: string, alphabet: Alphabet): string {
  const normalized = sequence.replace(/\s+/g, "").toUpperCase();
  const invalid = firstInvalidSequenceSymbol(normalized, alphabet);
  if (invalid) {
    throw new MoleculeError("ALPHABET_MISMATCH", "Sequence contains a symbol outside the declared alphabet.", {
      symbol: invalid.symbol,
      index: invalid.index,
      alphabet,
    });
  }
  return normalized;
}

export function firstInvalidSequenceSymbol(sequence: string, alphabet: Alphabet): { symbol: string; index: number } | null {
  const allowed = alphabet === "iupac_dna" ? DNA_ALPHABET : alphabet === "iupac_rna" ? RNA_ALPHABET : PROTEIN_ALPHABET;
  for (let index = 0; index < sequence.length; index += 1) {
    const symbol = sequence[index].toUpperCase();
    if (!allowed.has(symbol)) return { symbol: sequence[index], index };
  }
  return null;
}

export function validateSequenceAlphabet(sequence: unknown, alphabet: Alphabet, issuePath: string): ValidationIssue[] {
  if (typeof sequence !== "string" || sequence.length === 0) {
    return [validationIssue(issuePath, "VALIDATION_ERROR", "Sequence must be a non-empty string.")];
  }
  const invalid = firstInvalidSequenceSymbol(sequence.toUpperCase(), alphabet);
  if (!invalid) return [];
  return [
    validationIssue(issuePath, "ALPHABET_MISMATCH", "Sequence contains a symbol outside the declared alphabet.", {
      symbol: invalid.symbol,
      index: invalid.index,
      alphabet,
    }),
  ];
}

export function sequenceDigest(sequence: string): string {
  return `sha256:${createHash("sha256").update(sequence).digest("hex")}`;
}

export function reverseComplement(sequence: string): string {
  const complements: Record<string, string> = {
    A: "T",
    C: "G",
    G: "C",
    T: "A",
    U: "A",
    R: "Y",
    Y: "R",
    S: "S",
    W: "W",
    K: "M",
    M: "K",
    B: "V",
    D: "H",
    H: "D",
    V: "B",
    N: "N",
  };
  return sequence
    .toUpperCase()
    .split("")
    .reverse()
    .map((base) => complements[base] ?? base)
    .join("");
}

export function parseStoredSequenceContent(content: string, sourceFormat: "fasta" | "genbank", alphabet: Alphabet): string {
  if (sourceFormat === "fasta") {
    return parseFastaSequenceOnly(content, alphabet);
  }
  return parseGenBankOriginSequenceOnly(content, alphabet);
}

function parseFastaSequenceOnly(content: string, alphabet: Alphabet): string {
  const lines = content.split(/\r?\n/);
  const sequenceParts: string[] = [];
  let sawHeader = false;
  for (const line of lines) {
    if (line.startsWith(">")) {
      sawHeader = true;
      continue;
    }
    if (line.trim().length > 0) sequenceParts.push(line.trim());
  }
  if (!sawHeader) {
    throw new MoleculeError("PARSE_ERROR", "FASTA file has no record header.");
  }
  const sequence = normalizeSequence(sequenceParts.join(""), alphabet);
  if (sequence.length === 0) {
    throw new MoleculeError("PARSE_ERROR", "FASTA file has no sequence content.");
  }
  return sequence;
}

function parseGenBankOriginSequenceOnly(content: string, alphabet: Alphabet): string {
  const originMatch = /\nORIGIN\b([\s\S]*?)\n\/\//i.exec(`\n${content}`);
  if (!originMatch) {
    throw new MoleculeError("PARSE_ERROR", "GenBank file has no ORIGIN sequence content.");
  }
  const raw = originMatch[1].replace(/[0-9\s]/g, "");
  const sequence = normalizeSequence(raw, alphabet);
  if (sequence.length === 0) {
    throw new MoleculeError("PARSE_ERROR", "GenBank file has no sequence content.");
  }
  return sequence;
}
