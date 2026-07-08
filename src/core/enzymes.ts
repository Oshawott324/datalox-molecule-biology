import { MoleculeError } from "./errors.js";
import { readMoleculeSequence } from "./context.js";
import type { CoordinateSegment } from "./schema.js";
import { assertUnambiguousDnaSequence, reverseComplement } from "./sequence.js";

export const RESTRICTION_ENZYME_TABLE_VERSION = "datalox_rebase_common_v2";

export type RestrictionEnzyme = {
  name: string;
  recognitionSequence: string;
  cutOffset: number;
};

export type RestrictionSite = {
  moleculeId: string;
  enzyme: string;
  recognitionSequence: string;
  cutOffset: number;
  start: number;
  end: number;
  strand: "+" | "-";
  cutPosition: number;
  cutIndex: number;
  segments: CoordinateSegment[];
  enzymeTableVersion: typeof RESTRICTION_ENZYME_TABLE_VERSION;
};

export type FindRestrictionSitesOptions = {
  includeReverseStrand?: boolean;
};

export const RESTRICTION_ENZYMES: Record<string, RestrictionEnzyme> = {
  ApaI: { name: "ApaI", recognitionSequence: "GGGCCC", cutOffset: 5 },
  EcoRI: { name: "EcoRI", recognitionSequence: "GAATTC", cutOffset: 1 },
  BamHI: { name: "BamHI", recognitionSequence: "GGATCC", cutOffset: 1 },
  BglII: { name: "BglII", recognitionSequence: "AGATCT", cutOffset: 1 },
  ClaI: { name: "ClaI", recognitionSequence: "ATCGAT", cutOffset: 2 },
  HindIII: { name: "HindIII", recognitionSequence: "AAGCTT", cutOffset: 1 },
  KpnI: { name: "KpnI", recognitionSequence: "GGTACC", cutOffset: 5 },
  NcoI: { name: "NcoI", recognitionSequence: "CCATGG", cutOffset: 1 },
  NdeI: { name: "NdeI", recognitionSequence: "CATATG", cutOffset: 2 },
  NheI: { name: "NheI", recognitionSequence: "GCTAGC", cutOffset: 1 },
  NotI: { name: "NotI", recognitionSequence: "GCGGCCGC", cutOffset: 2 },
  PstI: { name: "PstI", recognitionSequence: "CTGCAG", cutOffset: 5 },
  SacI: { name: "SacI", recognitionSequence: "GAGCTC", cutOffset: 5 },
  SalI: { name: "SalI", recognitionSequence: "GTCGAC", cutOffset: 1 },
  SmaI: { name: "SmaI", recognitionSequence: "CCCGGG", cutOffset: 3 },
  SpeI: { name: "SpeI", recognitionSequence: "ACTAGT", cutOffset: 1 },
  SphI: { name: "SphI", recognitionSequence: "GCATGC", cutOffset: 5 },
  XbaI: { name: "XbaI", recognitionSequence: "TCTAGA", cutOffset: 1 },
  XhoI: { name: "XhoI", recognitionSequence: "CTCGAG", cutOffset: 1 },
  XmaI: { name: "XmaI", recognitionSequence: "CCCGGG", cutOffset: 1 },
};

export async function findRestrictionSites(
  workspacePath: string,
  moleculeId: string,
  enzymes: string[],
  options: FindRestrictionSitesOptions = {},
): Promise<RestrictionSite[]> {
  const selected = resolveEnzymes(enzymes);
  const { molecule, sequence } = await readMoleculeSequence(workspacePath, moleculeId);
  if (molecule.moleculeType !== "dna" || molecule.alphabet !== "iupac_dna") {
    throw new MoleculeError("ALPHABET_MISMATCH", "Restriction-site search requires a DNA molecule.", {
      moleculeId,
      moleculeType: molecule.moleculeType,
      alphabet: molecule.alphabet,
    });
  }

  const sites: RestrictionSite[] = [];
  assertUnambiguousDnaSequence(sequence, moleculeId);
  for (const enzyme of selected) {
    assertUnambiguousDnaSequence(enzyme.recognitionSequence, `${enzyme.name}.recognitionSequence`);
    sites.push(...findSitesForEnzyme(moleculeId, sequence, molecule.topology, enzyme, "+"));
    const reverseRecognition = reverseComplement(enzyme.recognitionSequence);
    if (options.includeReverseStrand && reverseRecognition !== enzyme.recognitionSequence) {
      sites.push(...findSitesForEnzyme(moleculeId, sequence, molecule.topology, { ...enzyme, recognitionSequence: reverseRecognition }, "-"));
    }
  }
  return sites.sort((left, right) => left.start - right.start || left.enzyme.localeCompare(right.enzyme) || left.strand.localeCompare(right.strand));
}

export function resolveEnzymes(names: string[]): RestrictionEnzyme[] {
  if (!Array.isArray(names) || names.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "At least one restriction enzyme is required.", { enzymes: names });
  }
  return names.map((name) => {
    const enzyme = RESTRICTION_ENZYMES[name];
    if (!enzyme) {
      throw new MoleculeError("INVALID_ARGUMENT", "Restriction enzyme is not in the deterministic local table.", {
        enzyme: name,
        enzymeTableVersion: RESTRICTION_ENZYME_TABLE_VERSION,
        availableEnzymes: Object.keys(RESTRICTION_ENZYMES),
      });
    }
    return enzyme;
  });
}

function findSitesForEnzyme(
  moleculeId: string,
  sequence: string,
  topology: "linear" | "circular",
  enzyme: RestrictionEnzyme,
  strand: "+" | "-",
): RestrictionSite[] {
  const sites: RestrictionSite[] = [];
  const searchSequence = topology === "circular" ? `${sequence}${sequence.slice(0, enzyme.recognitionSequence.length - 1)}` : sequence;
  const maxStartIndex = topology === "circular" ? sequence.length - 1 : sequence.length - enzyme.recognitionSequence.length;
  let index = searchSequence.indexOf(enzyme.recognitionSequence);
  while (index !== -1) {
    if (index > maxStartIndex) break;
    const rawEnd = index + enzyme.recognitionSequence.length;
    const start = (index % sequence.length) + 1;
    const end = ((rawEnd - 1) % sequence.length) + 1;
    const rawCutIndex = index + enzyme.cutOffset;
    const cutIndex = topology === "circular" ? rawCutIndex % sequence.length : rawCutIndex;
    sites.push({
      moleculeId,
      enzyme: enzyme.name,
      recognitionSequence: enzyme.recognitionSequence,
      cutOffset: enzyme.cutOffset,
      start,
      end,
      strand,
      cutPosition: cutIndex === 0 ? sequence.length : cutIndex,
      cutIndex,
      segments: siteSegments(start, end, sequence.length, strand),
      enzymeTableVersion: RESTRICTION_ENZYME_TABLE_VERSION,
    });
    index = searchSequence.indexOf(enzyme.recognitionSequence, index + 1);
  }
  return sites;
}

function siteSegments(start: number, end: number, moleculeLength: number, strand: "+" | "-"): CoordinateSegment[] {
  if (start <= end) return [{ start, end, strand }];
  return [
    { start, end: moleculeLength, strand },
    { start: 1, end, strand },
  ];
}
