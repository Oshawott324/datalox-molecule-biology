import { describe, expect, it } from "vitest";

import {
  compatibleRestrictionEnds,
  regeneratedRecognitionSequence,
  resolveLigationProfile,
  restrictionEndFromProfile,
  RESTRICTION_LIGATION_PROFILES,
  RESTRICTION_LIGATION_PROFILE_VERSION,
} from "../src/index.js";

describe("restriction ligation profiles", () => {
  it("pins NEB-verified ligation profiles used by W3 foundation tests", () => {
    expect(RESTRICTION_LIGATION_PROFILE_VERSION).toBe("datalox_neb_ligation_profiles_v1");
    expect(RESTRICTION_LIGATION_PROFILES).toMatchObject({
      EcoRI: {
        recognitionSequence: "GAATTC",
        topCutOffset: 1,
        bottomCutOffset: 5,
        endType: "five_prime_overhang",
        overhangSequence: "AATT",
        sourceUrl: "https://www.neb.com/en/products/r0101-ecori",
      },
      BamHI: {
        recognitionSequence: "GGATCC",
        topCutOffset: 1,
        bottomCutOffset: 5,
        endType: "five_prime_overhang",
        overhangSequence: "GATC",
        sourceUrl: "https://www.neb.com/en/products/r0136-bamhi",
      },
      BglII: {
        recognitionSequence: "AGATCT",
        topCutOffset: 1,
        bottomCutOffset: 5,
        endType: "five_prime_overhang",
        overhangSequence: "GATC",
        sourceUrl: "https://www.neb.com/en/products/r0144-bglii",
      },
      SmaI: {
        recognitionSequence: "CCCGGG",
        topCutOffset: 3,
        bottomCutOffset: 3,
        endType: "blunt",
        overhangSequence: "",
        sourceUrl: "https://www.neb.com/en/products/r0141-smai",
      },
      KpnI: {
        recognitionSequence: "GGTACC",
        topCutOffset: 5,
        bottomCutOffset: 1,
        endType: "three_prime_overhang",
        overhangSequence: "GTAC",
        sourceUrl: "https://www.neb.com/en/products/r0142-kpni",
      },
      PstI: {
        recognitionSequence: "CTGCAG",
        topCutOffset: 5,
        bottomCutOffset: 1,
        endType: "three_prime_overhang",
        overhangSequence: "TGCA",
        sourceUrl: "https://www.neb.com/en/products/r0140-psti",
      },
    });
  });

  it("reports unsupported ligation profiles instead of inferring from digest cut offsets", () => {
    expect(() => resolveLigationProfile("HindIII")).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_ENZYME_PROFILE",
    }));
  });

  it("checks compatible 5-prime cohesive ends through reverse-complemented overhangs", () => {
    const bam = restrictionEndFromProfile(resolveLigationProfile("BamHI"));
    const bgl = restrictionEndFromProfile(resolveLigationProfile("BglII"));
    expect(compatibleRestrictionEnds(bam, bgl)).toMatchObject({
      compatible: true,
      left: { enzyme: "BamHI", endType: "five_prime_overhang", overhangSequence: "GATC" },
      right: { enzyme: "BglII", endType: "five_prime_overhang", overhangSequence: "GATC" },
    });
  });

  it("rejects incompatible cohesive ends with a structured reason", () => {
    const eco = restrictionEndFromProfile(resolveLigationProfile("EcoRI"));
    const bam = restrictionEndFromProfile(resolveLigationProfile("BamHI"));
    expect(compatibleRestrictionEnds(eco, bam)).toMatchObject({
      compatible: false,
      reason: "OVERHANG_MISMATCH",
    });
  });

  it("pins blunt-end compatibility for SmaI", () => {
    const left = restrictionEndFromProfile(resolveLigationProfile("SmaI"));
    const right = restrictionEndFromProfile(resolveLigationProfile("SmaI"));
    expect(compatibleRestrictionEnds(left, right)).toMatchObject({
      compatible: true,
      left: { enzyme: "SmaI", endType: "blunt", overhangSequence: "" },
      right: { enzyme: "SmaI", endType: "blunt", overhangSequence: "" },
    });
  });

  it("pins 3-prime overhang compatibility for KpnI and PstI profiles", () => {
    const kpnLeft = restrictionEndFromProfile(resolveLigationProfile("KpnI"));
    const kpnRight = restrictionEndFromProfile(resolveLigationProfile("KpnI"));
    const pst = restrictionEndFromProfile(resolveLigationProfile("PstI"));

    expect(kpnLeft).toMatchObject({ endType: "three_prime_overhang", overhangSequence: "GTAC" });
    expect(pst).toMatchObject({ endType: "three_prime_overhang", overhangSequence: "TGCA" });
    expect(compatibleRestrictionEnds(kpnLeft, kpnRight)).toMatchObject({ compatible: true });
    expect(compatibleRestrictionEnds(kpnLeft, pst)).toMatchObject({
      compatible: false,
      reason: "OVERHANG_MISMATCH",
    });
  });

  it("throws INVALID_ARGUMENT for an enzyme absent from the digest table entirely", () => {
    expect(() => resolveLigationProfile("NotAnEnzyme")).toThrow(expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }));
  });

  it("confirms EcoRI self-ligation compatibility: AATT is its own reverse complement", () => {
    const eco = restrictionEndFromProfile(resolveLigationProfile("EcoRI"));
    expect(compatibleRestrictionEnds(eco, eco)).toMatchObject({
      compatible: true,
      left: { enzyme: "EcoRI", endType: "five_prime_overhang", overhangSequence: "AATT" },
      right: { enzyme: "EcoRI", endType: "five_prime_overhang", overhangSequence: "AATT" },
    });
  });

  it("rejects a 5-prime end against a 3-prime end with END_TYPE_MISMATCH", () => {
    const bam = restrictionEndFromProfile(resolveLigationProfile("BamHI"));
    const kpn = restrictionEndFromProfile(resolveLigationProfile("KpnI"));
    expect(compatibleRestrictionEnds(bam, kpn)).toMatchObject({
      compatible: false,
      reason: "END_TYPE_MISMATCH",
    });
    expect(compatibleRestrictionEnds(kpn, bam)).toMatchObject({
      compatible: false,
      reason: "END_TYPE_MISMATCH",
    });
  });

  it("does not claim regenerated recognition sites for BamHI/BglII scars", () => {
    const bam = resolveLigationProfile("BamHI");
    const bgl = resolveLigationProfile("BglII");

    expect(regeneratedRecognitionSequence("AAAGG", "ATCTAAA", bam)).toBeUndefined(); // GGATCT scar
    expect(regeneratedRecognitionSequence("AAAAG", "ATCCAAA", bgl)).toBeUndefined(); // AGATCC scar
    expect(regeneratedRecognitionSequence("AAAG", "GATCCAAA", bam)).toBe("GGATCC");
  });

  it("detects regenerated recognition sequences across the ligation junction for EcoRI, KpnI, and SmaI", () => {
    const eco = resolveLigationProfile("EcoRI"); // GAATTC, 5' overhang AATT
    const kpn = resolveLigationProfile("KpnI");  // GGTACC, 3' overhang GTAC; cut GGTAC^C
    const sma = resolveLigationProfile("SmaI");  // CCCGGG, blunt CCC^GGG

    // EcoRI: left ends in "G" (the one base before cut), right starts with "AATTC" (4-overhang + last base)
    // junction = slice(-5)="AAAAG" + slice(0,5)="AATTC" = "AAAAGAATTC" ⊃ "GAATTC"
    expect(regeneratedRecognitionSequence("AAAAG", "AATTCAAA", eco)).toBe("GAATTC");
    expect(regeneratedRecognitionSequence("AAAAA", "AATTCAAA", eco)).toBeUndefined(); // no G before AATTC

    // KpnI: left ends in "GGTAC" (5 bases before 3' cut), right starts with "C" (1 base after cut)
    // junction = "GGTAC" + "CAAAA" = "GGTACCAAAA" ⊃ "GGTACC"
    expect(regeneratedRecognitionSequence("AAAAGGTAC", "CAAAA", kpn)).toBe("GGTACC");
    expect(regeneratedRecognitionSequence("AAAAGGTAC", "AAAAA", kpn)).toBeUndefined();

    // SmaI: left ends in "CCC" (3 bases before blunt cut), right starts with "GGG" (3 bases after cut)
    // junction = "AACCC" + "GGGAA" = "AACCCGGGAA" ⊃ "CCCGGG"
    expect(regeneratedRecognitionSequence("AAACCC", "GGGAAA", sma)).toBe("CCCGGG");
    expect(regeneratedRecognitionSequence("AAACCC", "AAAAA", sma)).toBeUndefined();
  });
});
