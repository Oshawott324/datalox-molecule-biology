import { MoleculeError } from "./errors.js";
import { RESTRICTION_ENZYMES } from "./enzymes.js";
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
