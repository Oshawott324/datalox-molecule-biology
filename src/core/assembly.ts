import { MoleculeError } from "./errors.js";
import { findRestrictionSites, RESTRICTION_ENZYMES, type RestrictionSite } from "./enzymes.js";
import { readMoleculeSequence } from "./context.js";
import { reverseComplement } from "./sequence.js";

export const RESTRICTION_LIGATION_PROFILE_VERSION = "datalox_neb_ligation_profiles_v1";

export type RestrictionEndType = "five_prime_overhang" | "three_prime_overhang" | "blunt";

export type RestrictionLigationProfile = {
  enzyme: string;
  recognitionSequence: string;
  topCutOffset: number;
  bottomCutOffset: number;
  endType: RestrictionEndType;
  overhangSequence: string;
  source: "NEB";
  sourceUrl: string;
};

export type RestrictionFragmentEnd = {
  enzyme: string;
  endType: RestrictionEndType;
  overhangSequence: string;
  ligationProfileVersion: typeof RESTRICTION_LIGATION_PROFILE_VERSION;
};

export type RestrictionEndCompatibility = {
  compatible: boolean;
  left: RestrictionFragmentEnd;
  right: RestrictionFragmentEnd;
  reason?: "END_TYPE_MISMATCH" | "OVERHANG_MISMATCH";
};

export type AssemblyFragmentSelector = "largest_fragment";

export type AssemblySourceSegment = {
  start: number;
  end: number;
  strand: "+" | "-";
};

export type AssemblyFragment = {
  id: string;
  size: number;
  start: number;
  end: number;
  circular: boolean;
  sourceSegments: AssemblySourceSegment[];
};

export type ResolveAssemblyFragmentsInput = {
  workspacePath: string;
  moleculeId: string;
  enzymes: string[];
  selector?: AssemblyFragmentSelector;
};

export type ResolvedAssemblyFragments = {
  moleculeId: string;
  topology: "linear" | "circular";
  length: number;
  enzymes: string[];
  sites: RestrictionSite[];
  cutIndexes: number[];
  fragments: AssemblyFragment[];
  selectedFragment: AssemblyFragment;
};

export const RESTRICTION_LIGATION_PROFILES: Record<string, RestrictionLigationProfile> = {
  EcoRI: {
    enzyme: "EcoRI",
    recognitionSequence: "GAATTC",
    topCutOffset: 1,
    bottomCutOffset: 5,
    endType: "five_prime_overhang",
    overhangSequence: "AATT",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0101-ecori",
  },
  BamHI: {
    enzyme: "BamHI",
    recognitionSequence: "GGATCC",
    topCutOffset: 1,
    bottomCutOffset: 5,
    endType: "five_prime_overhang",
    overhangSequence: "GATC",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0136-bamhi",
  },
  BglII: {
    enzyme: "BglII",
    recognitionSequence: "AGATCT",
    topCutOffset: 1,
    bottomCutOffset: 5,
    endType: "five_prime_overhang",
    overhangSequence: "GATC",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0144-bglii",
  },
  SmaI: {
    enzyme: "SmaI",
    recognitionSequence: "CCCGGG",
    topCutOffset: 3,
    bottomCutOffset: 3,
    endType: "blunt",
    overhangSequence: "",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0141-smai",
  },
  KpnI: {
    enzyme: "KpnI",
    recognitionSequence: "GGTACC",
    topCutOffset: 5,
    bottomCutOffset: 1,
    endType: "three_prime_overhang",
    overhangSequence: "GTAC",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0142-kpni",
  },
  PstI: {
    enzyme: "PstI",
    recognitionSequence: "CTGCAG",
    topCutOffset: 5,
    bottomCutOffset: 1,
    endType: "three_prime_overhang",
    overhangSequence: "TGCA",
    source: "NEB",
    sourceUrl: "https://www.neb.com/en/products/r0140-psti",
  },
};

export function resolveLigationProfile(enzyme: string): RestrictionLigationProfile {
  if (RESTRICTION_ENZYMES[enzyme] === undefined) {
    throw new MoleculeError("INVALID_ARGUMENT", "Restriction enzyme is not in the deterministic local table.", {
      enzyme,
      availableEnzymes: Object.keys(RESTRICTION_ENZYMES),
    });
  }
  const profile = RESTRICTION_LIGATION_PROFILES[enzyme];
  if (profile === undefined) {
    throw new MoleculeError("UNSUPPORTED_ENZYME_PROFILE", "Restriction enzyme does not have a verified ligation-end profile.", {
      enzyme,
      ligationProfileVersion: RESTRICTION_LIGATION_PROFILE_VERSION,
      supportedEnzymes: Object.keys(RESTRICTION_LIGATION_PROFILES),
    });
  }
  return profile;
}

export function restrictionEndFromProfile(profile: RestrictionLigationProfile): RestrictionFragmentEnd {
  return {
    enzyme: profile.enzyme,
    endType: profile.endType,
    overhangSequence: profile.overhangSequence,
    ligationProfileVersion: RESTRICTION_LIGATION_PROFILE_VERSION,
  };
}

export function compatibleRestrictionEnds(
  left: RestrictionFragmentEnd,
  right: RestrictionFragmentEnd,
): RestrictionEndCompatibility {
  if (left.endType !== right.endType) {
    return { compatible: false, left, right, reason: "END_TYPE_MISMATCH" };
  }
  if (left.endType === "blunt" && left.overhangSequence === "" && right.overhangSequence === "") {
    return { compatible: true, left, right };
  }
  if (reverseComplement(left.overhangSequence) !== right.overhangSequence) {
    return { compatible: false, left, right, reason: "OVERHANG_MISMATCH" };
  }
  return { compatible: true, left, right };
}

export function regeneratedRecognitionSequence(
  leftSequence: string,
  rightSequence: string,
  profile: RestrictionLigationProfile,
): string | undefined {
  const span = profile.recognitionSequence.length - 1;
  const junction = `${leftSequence.slice(-span)}${rightSequence.slice(0, span)}`;
  return junction.includes(profile.recognitionSequence) ? profile.recognitionSequence : undefined;
}

export function assemblyFragmentsFromCutIndexes(
  length: number,
  topology: "linear" | "circular",
  cutIndexes: number[],
): AssemblyFragment[] {
  if (!Number.isInteger(length) || length < 1) {
    throw new MoleculeError("INVALID_ARGUMENT", "length must be a positive integer.", { length });
  }
  const normalized = uniqueSortedCutIndexes(length, topology, cutIndexes);
  return topology === "circular"
    ? circularAssemblyFragments(length, normalized)
    : linearAssemblyFragments(length, normalized);
}

export async function resolveAssemblyFragmentsForMolecule(
  input: ResolveAssemblyFragmentsInput,
): Promise<ResolvedAssemblyFragments> {
  if (!Array.isArray(input.enzymes) || input.enzymes.length === 0 || input.enzymes.length > 2) {
    throw new MoleculeError("INVALID_ARGUMENT", "W3 assembly fragment resolution requires one or two enzymes.", {
      enzymes: input.enzymes,
    });
  }
  for (const enzyme of input.enzymes) {
    resolveLigationProfile(enzyme);
  }

  const { molecule, sequence } = await readMoleculeSequence(input.workspacePath, input.moleculeId);
  if (molecule.moleculeType !== "dna" || molecule.alphabet !== "iupac_dna") {
    throw new MoleculeError("ALPHABET_MISMATCH", "Assembly fragment resolution requires a DNA molecule.", {
      moleculeId: input.moleculeId,
      moleculeType: molecule.moleculeType,
      alphabet: molecule.alphabet,
    });
  }

  const sites = await findRestrictionSites(input.workspacePath, input.moleculeId, input.enzymes);
  const sitesByEnzyme = new Map<string, RestrictionSite[]>();
  for (const enzyme of input.enzymes) sitesByEnzyme.set(enzyme, []);
  for (const site of sites) {
    sitesByEnzyme.get(site.enzyme)?.push(site);
  }

  for (const enzyme of input.enzymes) {
    const enzymeSites = sitesByEnzyme.get(enzyme) ?? [];
    if (enzymeSites.length === 0) {
      throw new MoleculeError("NO_CUT_SITE", "Required restriction enzyme does not cut the molecule.", {
        moleculeId: input.moleculeId,
        enzyme,
      });
    }
    if (enzymeSites.length > 1) {
      throw new MoleculeError("AMBIGUOUS_CUT_SITES", "Required restriction enzyme cuts the molecule more than once in W3 fragment resolution.", {
        moleculeId: input.moleculeId,
        enzyme,
        cutPositions: enzymeSites.map((site) => site.cutPosition),
      });
    }
  }

  const cutIndexes = sites.map((site) => site.cutIndex);
  const fragments = assemblyFragmentsFromCutIndexes(sequence.length, molecule.topology, cutIndexes);
  const selectedFragment = selectAssemblyFragment(fragments, input.selector ?? "largest_fragment");
  return {
    moleculeId: input.moleculeId,
    topology: molecule.topology,
    length: sequence.length,
    enzymes: input.enzymes,
    sites,
    cutIndexes,
    fragments,
    selectedFragment,
  };
}

export function selectAssemblyFragment(
  fragments: AssemblyFragment[],
  selector: AssemblyFragmentSelector = "largest_fragment",
): AssemblyFragment {
  if (selector !== "largest_fragment") {
    throw new MoleculeError("INVALID_ARGUMENT", "W3 only supports largest_fragment selection.", { selector });
  }
  if (fragments.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "At least one fragment is required for selection.");
  }
  const sorted = [...fragments].sort((left, right) => right.size - left.size || left.id.localeCompare(right.id));
  const largest = sorted[0];
  const tied = sorted.filter((fragment) => fragment.size === largest.size);
  if (tied.length > 1) {
    throw new MoleculeError("AMBIGUOUS_FRAGMENT_SELECTION", "Largest-fragment selection has a size tie.", {
      selector,
      tiedFragments: tied.map((fragment) => ({
        id: fragment.id,
        size: fragment.size,
        start: fragment.start,
        end: fragment.end,
        circular: fragment.circular,
      })),
    });
  }
  return largest;
}

function uniqueSortedCutIndexes(length: number, topology: "linear" | "circular", cutIndexes: number[]): number[] {
  if (!Array.isArray(cutIndexes)) {
    throw new MoleculeError("INVALID_ARGUMENT", "cutIndexes must be an array.", { cutIndexes });
  }
  const valid = cutIndexes.map((cutIndex) => {
    if (!Number.isInteger(cutIndex)) {
      throw new MoleculeError("INVALID_ARGUMENT", "cutIndexes entries must be integers.", { cutIndex });
    }
    if (topology === "circular") {
      if (cutIndex < 0 || cutIndex >= length) {
        throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Circular cut index must be within [0, length).", { cutIndex, length });
      }
      return cutIndex;
    }
    if (cutIndex <= 0 || cutIndex >= length) {
      throw new MoleculeError("COORDINATE_OUT_OF_RANGE", "Linear cut index must be within (0, length).", { cutIndex, length });
    }
    return cutIndex;
  });
  return [...new Set(valid)].sort((left, right) => left - right);
}

function linearAssemblyFragments(length: number, cutIndexes: number[]): AssemblyFragment[] {
  const boundaries = [0, ...cutIndexes, length];
  const fragments: AssemblyFragment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startIndex = boundaries[index];
    const endIndex = boundaries[index + 1];
    fragments.push({
      id: `fragment_${index + 1}`,
      size: endIndex - startIndex,
      start: startIndex + 1,
      end: endIndex,
      circular: false,
      sourceSegments: [{ start: startIndex + 1, end: endIndex, strand: "+" }],
    });
  }
  return fragments;
}

function circularAssemblyFragments(length: number, cutIndexes: number[]): AssemblyFragment[] {
  if (cutIndexes.length <= 1) {
    const cutIndex = cutIndexes[0];
    const start = cutIndex === undefined || cutIndex === 0 ? 1 : cutIndex + 1;
    const end = cutIndex === undefined || cutIndex === 0 ? length : cutIndex;
    return [{
      id: "fragment_1",
      size: length,
      start,
      end,
      circular: true,
      sourceSegments: circularSourceSegments(length, start, end),
    }];
  }

  const fragments: AssemblyFragment[] = [];
  for (let index = 0; index < cutIndexes.length; index += 1) {
    const current = cutIndexes[index];
    const next = cutIndexes[(index + 1) % cutIndexes.length];
    const wraps = next <= current;
    const start = current + 1;
    const end = next === 0 ? length : next;
    fragments.push({
      id: `fragment_${index + 1}`,
      size: wraps ? length - current + next : next - current,
      start,
      end,
      circular: wraps,
      sourceSegments: circularSourceSegments(length, start, end),
    });
  }
  return fragments;
}

function circularSourceSegments(length: number, start: number, end: number): AssemblySourceSegment[] {
  if (start <= end) return [{ start, end, strand: "+" }];
  return [
    { start, end: length, strand: "+" },
    { start: 1, end, strand: "+" },
  ];
}
