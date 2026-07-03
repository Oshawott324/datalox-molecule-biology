import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assemblyFragmentsFromCutIndexes,
  compatibleRestrictionEnds,
  regeneratedRecognitionSequence,
  importSequenceFile,
  resolveAssemblyFragmentsForMolecule,
  resolveLigationProfile,
  selectAssemblyFragment,
  restrictionEndFromProfile,
  RESTRICTION_LIGATION_PROFILES,
  RESTRICTION_LIGATION_PROFILE_VERSION,
} from "../src/index.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function importFasta(sequence: string, moleculeId: string): Promise<{ workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-assembly-");
  const inputPath = path.join(workspaceDir, `${moleculeId}.fa`);
  await fs.writeFile(inputPath, `>${moleculeId}\n${sequence}\n`, "utf8");
  const result = await importSequenceFile({ inputPath, workspaceDir, format: "fasta", moleculeId });
  return { workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

async function importCircularGenBank(sequence: string, moleculeId: string): Promise<{ workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-assembly-gb-");
  const inputPath = path.join(workspaceDir, `${moleculeId}.gb`);
  await fs.writeFile(inputPath, circularGenBank(sequence, moleculeId), "utf8");
  const result = await importSequenceFile({ inputPath, workspaceDir, format: "genbank", moleculeId });
  return { workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

function circularGenBank(sequence: string, name: string): string {
  return [
    `LOCUS       ${name.padEnd(12)} ${sequence.length} bp    DNA     circular SYN 03-JUL-2026`,
    `DEFINITION  ${name}.`,
    "FEATURES             Location/Qualifiers",
    "ORIGIN",
    `        1 ${sequence.toLowerCase()}`,
    "//",
    "",
  ].join("\n");
}

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

  it("enumerates linear assembly fragments from deterministic cut indexes", () => {
    const fragments = assemblyFragmentsFromCutIndexes(100, "linear", [20, 70]);
    expect(fragments).toEqual([
      {
        id: "fragment_1",
        size: 20,
        start: 1,
        end: 20,
        circular: false,
        sourceSegments: [{ start: 1, end: 20, strand: "+" }],
      },
      {
        id: "fragment_2",
        size: 50,
        start: 21,
        end: 70,
        circular: false,
        sourceSegments: [{ start: 21, end: 70, strand: "+" }],
      },
      {
        id: "fragment_3",
        size: 30,
        start: 71,
        end: 100,
        circular: false,
        sourceSegments: [{ start: 71, end: 100, strand: "+" }],
      },
    ]);
    expect(selectAssemblyFragment(fragments)).toMatchObject({ id: "fragment_2", size: 50 });
  });

  it("enumerates circular assembly fragments with explicit wraparound source segments", () => {
    const fragments = assemblyFragmentsFromCutIndexes(100, "circular", [20, 70]);
    expect(fragments).toEqual([
      {
        id: "fragment_1",
        size: 50,
        start: 21,
        end: 70,
        circular: false,
        sourceSegments: [{ start: 21, end: 70, strand: "+" }],
      },
      {
        id: "fragment_2",
        size: 50,
        start: 71,
        end: 20,
        circular: true,
        sourceSegments: [
          { start: 71, end: 100, strand: "+" },
          { start: 1, end: 20, strand: "+" },
        ],
      },
    ]);
    expect(() => selectAssemblyFragment(fragments)).toThrow(expect.objectContaining({
      code: "AMBIGUOUS_FRAGMENT_SELECTION",
    }));
  });

  it("returns the full linearized circular molecule for zero or one circular cut", () => {
    expect(assemblyFragmentsFromCutIndexes(12, "circular", [])).toEqual([
      {
        id: "fragment_1",
        size: 12,
        start: 1,
        end: 12,
        circular: true,
        sourceSegments: [{ start: 1, end: 12, strand: "+" }],
      },
    ]);
    expect(assemblyFragmentsFromCutIndexes(12, "circular", [5])).toEqual([
      {
        id: "fragment_1",
        size: 12,
        start: 6,
        end: 5,
        circular: true,
        sourceSegments: [
          { start: 6, end: 12, strand: "+" },
          { start: 1, end: 5, strand: "+" },
        ],
      },
    ]);
  });

  it("enumerates two fragments from a single linear cut and selects the larger", () => {
    const fragments = assemblyFragmentsFromCutIndexes(100, "linear", [30]);
    expect(fragments).toEqual([
      {
        id: "fragment_1",
        size: 30,
        start: 1,
        end: 30,
        circular: false,
        sourceSegments: [{ start: 1, end: 30, strand: "+" }],
      },
      {
        id: "fragment_2",
        size: 70,
        start: 31,
        end: 100,
        circular: false,
        sourceSegments: [{ start: 31, end: 100, strand: "+" }],
      },
    ]);
    expect(selectAssemblyFragment(fragments)).toMatchObject({ id: "fragment_2", size: 70 });
  });

  it("selects the largest fragment from unequal circular cuts: larger non-wrapping fragment wins", () => {
    // cut at 10 and 70: fragment_1 = 11..70 (60bp), fragment_2 = 71..10 wrapping (40bp)
    const fragments = assemblyFragmentsFromCutIndexes(100, "circular", [10, 70]);
    expect(fragments).toEqual([
      {
        id: "fragment_1",
        size: 60,
        start: 11,
        end: 70,
        circular: false,
        sourceSegments: [{ start: 11, end: 70, strand: "+" }],
      },
      {
        id: "fragment_2",
        size: 40,
        start: 71,
        end: 10,
        circular: true,
        sourceSegments: [
          { start: 71, end: 100, strand: "+" },
          { start: 1, end: 10, strand: "+" },
        ],
      },
    ]);
    expect(selectAssemblyFragment(fragments)).toMatchObject({ id: "fragment_1", size: 60 });
  });

  it("rejects invalid cut indexes before fragment selection", () => {
    expect(() => assemblyFragmentsFromCutIndexes(10, "linear", [0]))
      .toThrow(expect.objectContaining({ code: "COORDINATE_OUT_OF_RANGE" }));
    expect(() => assemblyFragmentsFromCutIndexes(10, "linear", [10]))
      .toThrow(expect.objectContaining({ code: "COORDINATE_OUT_OF_RANGE" }));
    expect(() => assemblyFragmentsFromCutIndexes(10, "circular", [10]))
      .toThrow(expect.objectContaining({ code: "COORDINATE_OUT_OF_RANGE" }));
    expect(() => assemblyFragmentsFromCutIndexes(10, "circular", [-1]))
      .toThrow(expect.objectContaining({ code: "COORDINATE_OUT_OF_RANGE" }));
  });

  it("resolves workspace cut sites into fragments and selects the unique largest fragment", async () => {
    const source = await importFasta("AAAAGAATTCGGGGGGGGGGGGGGGGGGGGGGATCCAAAA", "mol_linear");
    const result = await resolveAssemblyFragmentsForMolecule({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      enzymes: ["EcoRI", "BamHI"],
    });

    expect(result).toMatchObject({
      moleculeId: "mol_linear",
      topology: "linear",
      enzymes: ["EcoRI", "BamHI"],
      cutIndexes: [5, 31],
      selectedFragment: {
        id: "fragment_2",
        size: 26,
        start: 6,
        end: 31,
      },
    });
    expect(result.sites.map((site) => ({ enzyme: site.enzyme, cutPosition: site.cutPosition }))).toEqual([
      { enzyme: "EcoRI", cutPosition: 5 },
      { enzyme: "BamHI", cutPosition: 31 },
    ]);
  });

  it("throws NO_CUT_SITE when a required enzyme is absent from the molecule", async () => {
    const source = await importFasta("AAAAGAATTCAAAA", "mol_no_bam");
    await expect(resolveAssemblyFragmentsForMolecule({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      enzymes: ["BamHI"],
    })).rejects.toMatchObject({
      code: "NO_CUT_SITE",
      details: { moleculeId: "mol_no_bam", enzyme: "BamHI" },
    });
  });

  it("throws AMBIGUOUS_CUT_SITES when a required enzyme cuts more than once", async () => {
    const source = await importCircularGenBank("GAATTCAAAAGAATTC", "mol_two_ecori");
    await expect(resolveAssemblyFragmentsForMolecule({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      enzymes: ["EcoRI"],
    })).rejects.toMatchObject({
      code: "AMBIGUOUS_CUT_SITES",
      details: { moleculeId: "mol_two_ecori", enzyme: "EcoRI" },
    });
  });

  it("requires verified ligation profiles before resolving assembly fragments", async () => {
    const source = await importFasta("AAAAGAAGCTTAAAA", "mol_hindiii");
    await expect(resolveAssemblyFragmentsForMolecule({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      enzymes: ["HindIII"],
    })).rejects.toMatchObject({
      code: "UNSUPPORTED_ENZYME_PROFILE",
    });
  });

  it("resolves a single EcoRI cut in a circular molecule and returns the full linearized fragment", async () => {
    // 30bp circular: 10 A's then EcoRI then 14 A's
    // EcoRI GAATTC starts at position 11 (1-based); G^AATTC cuts after 1 base → cutIndex = 11
    // Single cut → full linearized fragment of size 30, wrapping from 12 back to 11
    const seq = "AAAAAAAAAA" + "GAATTC" + "AAAAAAAAAAAAAA"; // 10 + 6 + 14 = 30 bp
    const source = await importCircularGenBank(seq, "mol_circular_eco");
    const result = await resolveAssemblyFragmentsForMolecule({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      enzymes: ["EcoRI"],
    });
    expect(result).toMatchObject({
      topology: "circular",
      length: 30,
      enzymes: ["EcoRI"],
      cutIndexes: [11],
      fragments: [{ size: 30, start: 12, end: 11, circular: true }],
      selectedFragment: { size: 30, start: 12, end: 11, circular: true },
    });
    expect(result.fragments).toHaveLength(1);
    expect(result.selectedFragment.sourceSegments).toEqual([
      { start: 12, end: 30, strand: "+" },
      { start: 1, end: 11, strand: "+" },
    ]);
  });
});
