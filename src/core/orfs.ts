import { MoleculeError } from "./errors.js";
import { readMoleculeSequence } from "./context.js";
import { reverseComplement } from "./sequence.js";

export type OrfStrand = "+" | "-";

export type FindOrfsOptions = {
  minAa?: number;
  startCodons?: string[];
  stopCodons?: string[];
  strands?: OrfStrand[];
  includeCircularOrigin?: false;
};

export type OrfResult = {
  moleculeId: string;
  start: number;
  end: number;
  strand: OrfStrand;
  frame: 1 | 2 | 3;
  nucleotideLength: number;
  aminoAcidLength: number;
  startCodon: string;
  stopCodon: string;
};

const DEFAULT_START_CODONS = ["ATG"];
const DEFAULT_STOP_CODONS = ["TAA", "TAG", "TGA"];

export async function findOrfs(workspacePath: string, moleculeId: string, options: FindOrfsOptions = {}): Promise<OrfResult[]> {
  if (options.includeCircularOrigin !== undefined && options.includeCircularOrigin !== false) {
    throw new MoleculeError("INVALID_ARGUMENT", "Circular-origin ORF search is not supported by this deterministic MVP.", {
      includeCircularOrigin: options.includeCircularOrigin,
    });
  }
  const minAa = options.minAa ?? 30;
  if (!Number.isInteger(minAa) || minAa < 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "minAa must be a non-negative integer.", { minAa });
  }
  const startCodons = normalizeCodonSet(options.startCodons ?? DEFAULT_START_CODONS, "startCodons");
  const stopCodons = normalizeCodonSet(options.stopCodons ?? DEFAULT_STOP_CODONS, "stopCodons");
  const strands = options.strands ?? ["+"];
  if (strands.length === 0 || strands.some((strand) => strand !== "+" && strand !== "-")) {
    throw new MoleculeError("INVALID_ARGUMENT", "strands must contain '+' and/or '-'.", { strands });
  }

  const { molecule, sequence } = await readMoleculeSequence(workspacePath, moleculeId);
  if (molecule.moleculeType !== "dna" || molecule.alphabet !== "iupac_dna") {
    throw new MoleculeError("ALPHABET_MISMATCH", "ORF search requires a DNA molecule.", {
      moleculeId,
      moleculeType: molecule.moleculeType,
      alphabet: molecule.alphabet,
    });
  }

  const results: OrfResult[] = [];
  for (const strand of strands) {
    const scanSequence = strand === "+" ? sequence : reverseComplement(sequence);
    results.push(...scanStrand(moleculeId, scanSequence, strand, startCodons, stopCodons, minAa));
  }
  return results.sort((left, right) => left.start - right.start || left.end - right.end || left.strand.localeCompare(right.strand));
}

function normalizeCodonSet(codons: string[], name: string): Set<string> {
  if (!Array.isArray(codons) || codons.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be a non-empty codon array.`, { [name]: codons });
  }
  const normalized = codons.map((codon) => codon.toUpperCase().replace(/U/g, "T"));
  const invalid = normalized.find((codon) => !/^[ACGT]{3}$/.test(codon));
  if (invalid) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must contain explicit DNA codons.`, { codon: invalid });
  }
  return new Set(normalized);
}

function scanStrand(
  moleculeId: string,
  sequence: string,
  strand: OrfStrand,
  startCodons: Set<string>,
  stopCodons: Set<string>,
  minAa: number,
): OrfResult[] {
  const results: OrfResult[] = [];
  for (let frame = 0; frame < 3; frame += 1) {
    for (let index = frame; index <= sequence.length - 3; index += 3) {
      const startCodon = sequence.slice(index, index + 3);
      if (!startCodons.has(startCodon)) continue;
      for (let stopIndex = index + 3; stopIndex <= sequence.length - 3; stopIndex += 3) {
        const stopCodon = sequence.slice(stopIndex, stopIndex + 3);
        if (!stopCodons.has(stopCodon)) continue;
        const nucleotideLength = stopIndex + 3 - index;
        const aminoAcidLength = nucleotideLength / 3 - 1;
        if (aminoAcidLength >= minAa) {
          results.push(toOrfResult(moleculeId, sequence.length, strand, frame, index, stopIndex, nucleotideLength, aminoAcidLength, startCodon, stopCodon));
        }
        break;
      }
    }
  }
  return results;
}

function toOrfResult(
  moleculeId: string,
  moleculeLength: number,
  strand: OrfStrand,
  frame: number,
  startIndex: number,
  stopIndex: number,
  nucleotideLength: number,
  aminoAcidLength: number,
  startCodon: string,
  stopCodon: string,
): OrfResult {
  if (strand === "+") {
    return {
      moleculeId,
      start: startIndex + 1,
      end: stopIndex + 3,
      strand,
      frame: (frame + 1) as 1 | 2 | 3,
      nucleotideLength,
      aminoAcidLength,
      startCodon,
      stopCodon,
    };
  }
  return {
    moleculeId,
    start: moleculeLength - (stopIndex + 3) + 1,
    end: moleculeLength - startIndex,
    strand,
    frame: (frame + 1) as 1 | 2 | 3,
    nucleotideLength,
    aminoAcidLength,
    startCodon,
    stopCodon,
  };
}
