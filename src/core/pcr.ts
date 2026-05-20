import { extractCircularRegion } from "./coordinates.js";
import { readMoleculeSequence } from "./context.js";
import { MoleculeError } from "./errors.js";
import type { CoordinateSegment } from "./schema.js";
import { normalizeSequence, reverseComplement, sequenceDigest } from "./sequence.js";

export type PcrProduct = {
  moleculeId: string;
  ampliconLength: number;
  coordinates: CoordinateSegment[];
  sequenceDigest: string;
  forwardPrimerStart: number;
  reversePrimerStart: number;
};

export type SimulatePcrResult = {
  moleculeId: string;
  forwardPrimer: string;
  reversePrimer: string;
  products: PcrProduct[];
};

export async function simulatePcr(
  workspacePath: string,
  moleculeId: string,
  forwardPrimer: string,
  reversePrimer: string,
): Promise<SimulatePcrResult> {
  const forward = normalizeSequence(forwardPrimer, "iupac_dna");
  const reverse = normalizeSequence(reversePrimer, "iupac_dna");
  const reverseBindingSequence = reverseComplement(reverse);
  const { molecule, sequence } = await readMoleculeSequence(workspacePath, moleculeId);
  if (molecule.moleculeType !== "dna" || molecule.alphabet !== "iupac_dna") {
    throw new MoleculeError("ALPHABET_MISMATCH", "PCR simulation requires a DNA molecule.", {
      moleculeId,
      moleculeType: molecule.moleculeType,
      alphabet: molecule.alphabet,
    });
  }

  const forwardStarts = allIndexesOf(sequence, forward);
  const reverseBindingStarts = allIndexesOf(sequence, reverseBindingSequence);
  const products =
    molecule.topology === "circular"
      ? circularProducts(moleculeId, sequence, forward.length, reverse.length, forwardStarts, reverseBindingStarts)
      : linearProducts(moleculeId, sequence, reverse.length, forwardStarts, reverseBindingStarts);

  return {
    moleculeId,
    forwardPrimer: forward,
    reversePrimer: reverse,
    products,
  };
}

function linearProducts(moleculeId: string, sequence: string, reversePrimerLength: number, forwardStarts: number[], reverseBindingStarts: number[]): PcrProduct[] {
  const products: PcrProduct[] = [];
  for (const forwardStart of forwardStarts) {
    for (const reverseStart of reverseBindingStarts) {
      const endExclusive = reverseStart + reversePrimerLength;
      if (forwardStart >= reverseStart) continue;
      const amplicon = sequence.slice(forwardStart, endExclusive);
      products.push({
        moleculeId,
        ampliconLength: amplicon.length,
        coordinates: [{ start: forwardStart + 1, end: endExclusive, strand: "+" }],
        sequenceDigest: sequenceDigest(amplicon),
        forwardPrimerStart: forwardStart + 1,
        reversePrimerStart: reverseStart + 1,
      });
    }
  }
  return products.sort((left, right) => left.coordinates[0].start - right.coordinates[0].start || left.ampliconLength - right.ampliconLength);
}

function circularProducts(
  moleculeId: string,
  sequence: string,
  forwardPrimerLength: number,
  reversePrimerLength: number,
  forwardStarts: number[],
  reverseBindingStarts: number[],
): PcrProduct[] {
  const products: PcrProduct[] = [];
  const length = sequence.length;
  for (const forwardStart of forwardStarts) {
    for (const reverseStart of reverseBindingStarts) {
      const rawEnd = reverseStart + reversePrimerLength;
      const ampliconLength = rawEnd > forwardStart ? rawEnd - forwardStart : rawEnd + length - forwardStart;
      if (ampliconLength < forwardPrimerLength + reversePrimerLength || ampliconLength > length) continue;
      const start = forwardStart + 1;
      const end = ((forwardStart + ampliconLength - 1) % length) + 1;
      const coordinates =
        start <= end
          ? [{ start, end, strand: "+" as const }]
          : [
              { start, end: length, strand: "+" as const },
              { start: 1, end, strand: "+" as const },
            ];
      const amplicon = extractCircularRegion(sequence, start, end, "+");
      products.push({
        moleculeId,
        ampliconLength,
        coordinates,
        sequenceDigest: sequenceDigest(amplicon),
        forwardPrimerStart: start,
        reversePrimerStart: reverseStart + 1,
      });
    }
  }
  return products.sort((left, right) => left.forwardPrimerStart - right.forwardPrimerStart || left.ampliconLength - right.ampliconLength);
}

function allIndexesOf(sequence: string, query: string): number[] {
  const indexes: number[] = [];
  let index = sequence.indexOf(query);
  while (index !== -1) {
    indexes.push(index);
    index = sequence.indexOf(query, index + 1);
  }
  return indexes;
}
