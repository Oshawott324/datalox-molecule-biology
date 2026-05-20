import { extractSegments, validateSegments } from "./coordinates.js";
import { MoleculeError } from "./errors.js";
import { readMoleculeSequence } from "./context.js";
import type { CoordinateSegment } from "./schema.js";

export const STANDARD_GENETIC_CODE_VERSION = "NCBI_standard_code_1";

export const STANDARD_GENETIC_CODE: Record<string, string> = {
  TTT: "F",
  TTC: "F",
  TTA: "L",
  TTG: "L",
  TCT: "S",
  TCC: "S",
  TCA: "S",
  TCG: "S",
  TAT: "Y",
  TAC: "Y",
  TAA: "*",
  TAG: "*",
  TGT: "C",
  TGC: "C",
  TGA: "*",
  TGG: "W",
  CTT: "L",
  CTC: "L",
  CTA: "L",
  CTG: "L",
  CCT: "P",
  CCC: "P",
  CCA: "P",
  CCG: "P",
  CAT: "H",
  CAC: "H",
  CAA: "Q",
  CAG: "Q",
  CGT: "R",
  CGC: "R",
  CGA: "R",
  CGG: "R",
  ATT: "I",
  ATC: "I",
  ATA: "I",
  ATG: "M",
  ACT: "T",
  ACC: "T",
  ACA: "T",
  ACG: "T",
  AAT: "N",
  AAC: "N",
  AAA: "K",
  AAG: "K",
  AGT: "S",
  AGC: "S",
  AGA: "R",
  AGG: "R",
  GTT: "V",
  GTC: "V",
  GTA: "V",
  GTG: "V",
  GCT: "A",
  GCC: "A",
  GCA: "A",
  GCG: "A",
  GAT: "D",
  GAC: "D",
  GAA: "E",
  GAG: "E",
  GGT: "G",
  GGC: "G",
  GGA: "G",
  GGG: "G",
};

export type TranslateRegionOptions = {
  geneticCode?: "standard";
};

export type TranslateRegionResult = {
  moleculeId: string;
  region: CoordinateSegment;
  geneticCode: "standard";
  geneticCodeVersion: typeof STANDARD_GENETIC_CODE_VERSION;
  nucleotideLength: number;
  aminoAcidLength: number;
  aminoAcids: string;
  partialTerminalCodon?: string;
};

export async function translateRegion(
  workspacePath: string,
  moleculeId: string,
  region: CoordinateSegment,
  options: TranslateRegionOptions = {},
): Promise<TranslateRegionResult> {
  if (options.geneticCode !== undefined && options.geneticCode !== "standard") {
    throw new MoleculeError("INVALID_ARGUMENT", "Only the standard genetic code is supported.", { geneticCode: options.geneticCode });
  }
  const { molecule, sequence } = await readMoleculeSequence(workspacePath, moleculeId);
  if (molecule.moleculeType !== "dna" || molecule.alphabet !== "iupac_dna") {
    throw new MoleculeError("ALPHABET_MISMATCH", "Translation requires a DNA molecule.", {
      moleculeId,
      moleculeType: molecule.moleculeType,
      alphabet: molecule.alphabet,
    });
  }
  const issues = validateSegments([region], molecule.length, "region");
  if (issues.length > 0) {
    throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Translation region is invalid.", { issues });
  }

  const nucleotideSequence = extractSegments(sequence, [region]);
  const translated = translateDnaSequence(nucleotideSequence);
  return {
    moleculeId,
    region,
    geneticCode: "standard",
    geneticCodeVersion: STANDARD_GENETIC_CODE_VERSION,
    nucleotideLength: nucleotideSequence.length,
    aminoAcidLength: translated.aminoAcids.length,
    aminoAcids: translated.aminoAcids,
    ...(translated.partialTerminalCodon ? { partialTerminalCodon: translated.partialTerminalCodon } : {}),
  };
}

export function translateDnaSequence(sequence: string): { aminoAcids: string; partialTerminalCodon?: string } {
  const normalized = sequence.toUpperCase().replace(/U/g, "T");
  const codonCount = Math.floor(normalized.length / 3);
  let aminoAcids = "";
  for (let index = 0; index < codonCount * 3; index += 3) {
    const codon = normalized.slice(index, index + 3);
    aminoAcids += STANDARD_GENETIC_CODE[codon] ?? "X";
  }
  const remainder = normalized.length % 3;
  return {
    aminoAcids,
    ...(remainder === 0 ? {} : { partialTerminalCodon: normalized.slice(normalized.length - remainder) }),
  };
}
