import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assemblyFragmentsFromCutIndexes,
  compatibleRestrictionEnds,
  constructRestrictionLigationCandidates,
  regeneratedRecognitionSequence,
  importSequenceFile,
  readWorkspace,
  readMoleculeSequence,
  resolveAssemblyFragmentsForMolecule,
  resolveLigationProfile,
  selectAssemblyFragment,
  simulateAssembly,
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

async function importVectorAndInsert(
  vectorSequence: string,
  insertSequence: string,
  options: { vectorId?: string; insertId?: string; insertCircular?: boolean } = {},
): Promise<{ workspaceDir: string; workspacePath: string; vectorId: string; insertId: string }> {
  const workspaceDir = await tempDir("mol-assembly-pair-");
  const vectorId = options.vectorId ?? "mol_vector_pair";
  const insertId = options.insertId ?? "mol_insert_pair";
  const vectorPath = path.join(workspaceDir, `${vectorId}.gb`);
  await fs.writeFile(vectorPath, circularGenBank(vectorSequence, vectorId), "utf8");
  const vectorImport = await importSequenceFile({ inputPath: vectorPath, workspaceDir, format: "genbank", moleculeId: vectorId });

  const insertPath = path.join(workspaceDir, options.insertCircular ? `${insertId}.gb` : `${insertId}.fa`);
  await fs.writeFile(
    insertPath,
    options.insertCircular ? circularGenBank(insertSequence, insertId) : `>${insertId}\n${insertSequence}\n`,
    "utf8",
  );
  const insertImport = await importSequenceFile({
    inputPath: insertPath,
    workspaceDir,
    format: options.insertCircular ? "genbank" : "fasta",
    moleculeId: insertId,
    expectedRevision: vectorImport.revision,
  });
  return { workspaceDir, workspacePath: insertImport.workspacePath, vectorId, insertId };
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
      XmaI: {
        recognitionSequence: "CCCGGG",
        topCutOffset: 1,
        bottomCutOffset: 5,
        endType: "five_prime_overhang",
        overhangSequence: "CCGG",
        sourceUrl: "https://www.neb.com/en-us/products/r0180-xmai",
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

  it("pins XmaI as a 5-prime overhang neoschizomer of blunt SmaI", () => {
    const xma = restrictionEndFromProfile(resolveLigationProfile("XmaI"));
    const sma = restrictionEndFromProfile(resolveLigationProfile("SmaI"));
    expect(xma).toMatchObject({
      enzyme: "XmaI",
      endType: "five_prime_overhang",
      overhangSequence: "CCGG",
    });
    expect(compatibleRestrictionEnds(xma, xma)).toMatchObject({ compatible: true });
    expect(compatibleRestrictionEnds(xma, sma)).toMatchObject({
      compatible: false,
      reason: "END_TYPE_MISMATCH",
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

  it("propagates AMBIGUOUS_FRAGMENT_SELECTION when two enzymes produce equal-length circular fragments", async () => {
    // EcoRI (G^AATTC) at pos 1 gives cutIndex 1; BamHI (G^GATCC) at pos 11 gives cutIndex 11.
    // Both cuts divide the 20 bp circular molecule into two 10 bp fragments, producing a size tie.
    const source = await importCircularGenBank("GAATTCAAAAGGATCCAAAA", "mol_ambig_frag");
    await expect(resolveAssemblyFragmentsForMolecule({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      enzymes: ["EcoRI", "BamHI"],
    })).rejects.toMatchObject({ code: "AMBIGUOUS_FRAGMENT_SELECTION" });
  });

  it("constructs a forward EcoRI/BamHI directional ligation candidate with junction metadata", async () => {
    const vector = await importCircularGenBank(
      "AAAA" + "GAATTC" + "CCCCCCCCCCCCCC" + "GGATCC" + "TTTTTTTTTTTTTTTTTTTT",
      "mol_vector",
    );
    const insert = await importFasta(
      "AAAA" + "GAATTC" + "GGGGGGGGGGGGGG" + "GGATCC" + "AAAA",
      "mol_insert",
    );
    const vectorResolved = await resolveAssemblyFragmentsForMolecule({
      workspacePath: vector.workspacePath,
      moleculeId: vector.moleculeId,
      enzymes: ["EcoRI", "BamHI"],
    });
    const insertResolved = await resolveAssemblyFragmentsForMolecule({
      workspacePath: insert.workspacePath,
      moleculeId: insert.moleculeId,
      enzymes: ["EcoRI", "BamHI"],
    });
    const vectorSequence = (await readMoleculeSequence(vector.workspacePath, vector.moleculeId)).sequence;
    const insertSequence = (await readMoleculeSequence(insert.workspacePath, insert.moleculeId)).sequence;

    const [candidate] = constructRestrictionLigationCandidates({
      vector: { resolved: vectorResolved, sequence: vectorSequence },
      insert: { resolved: insertResolved, sequence: insertSequence },
      orientation: "forward",
    });

    expect(vectorResolved.selectedFragment).toMatchObject({ start: 26, end: 5, size: 30 });
    expect(insertResolved.selectedFragment).toMatchObject({ start: 6, end: 25, size: 20 });
    expect(candidate).toMatchObject({
      candidateId: "candidate_forward",
      name: "candidate_forward",
      topology: "circular",
      length: 50,
      orientation: "forward",
      sourceSegments: [
        {
          role: "vector_backbone",
          moleculeId: "mol_vector",
          segments: [
            { start: 26, end: 50, strand: "+" },
            { start: 1, end: 5, strand: "+" },
          ],
        },
        {
          role: "insert",
          moleculeId: "mol_insert",
          segments: [{ start: 6, end: 25, strand: "+" }],
        },
      ],
      ends: [
        {
          role: "vector",
          moleculeId: "mol_vector",
          enzyme: "BamHI",
          side: "left",
          endType: "five_prime_overhang",
          overhangSequence: "GATC",
        },
        {
          role: "vector",
          moleculeId: "mol_vector",
          enzyme: "EcoRI",
          side: "right",
          endType: "five_prime_overhang",
          overhangSequence: "AATT",
        },
        {
          role: "insert",
          moleculeId: "mol_insert",
          enzyme: "EcoRI",
          side: "left",
          endType: "five_prime_overhang",
          overhangSequence: "AATT",
        },
        {
          role: "insert",
          moleculeId: "mol_insert",
          enzyme: "BamHI",
          side: "right",
          endType: "five_prime_overhang",
          overhangSequence: "GATC",
        },
      ],
      junctions: [
        {
          leftSource: { role: "vector", moleculeId: "mol_vector", enzyme: "EcoRI", side: "right" },
          rightSource: { role: "insert", moleculeId: "mol_insert", enzyme: "EcoRI", side: "left" },
          compatible: true,
          endType: "five_prime_overhang",
          overhangSequence: "AATT",
          regeneratedRecognitionSequence: "GAATTC",
        },
        {
          leftSource: { role: "insert", moleculeId: "mol_insert", enzyme: "BamHI", side: "right" },
          rightSource: { role: "vector", moleculeId: "mol_vector", enzyme: "BamHI", side: "left" },
          compatible: true,
          endType: "five_prime_overhang",
          overhangSequence: "GATC",
          regeneratedRecognitionSequence: "GGATCC",
        },
      ],
    });
    expect(candidate.sequence).toBe("GATCC" + "T".repeat(20) + "AAAAG" + "AATTC" + "G".repeat(14) + "G");
    expect(candidate.sequenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects reverse orientation for directional EcoRI/BamHI ligation", async () => {
    const vector = await importCircularGenBank(
      "AAAA" + "GAATTC" + "CCCCCCCCCCCCCC" + "GGATCC" + "TTTTTTTTTTTTTTTTTTTT",
      "mol_vector_rev",
    );
    const insert = await importFasta(
      "AAAA" + "GAATTC" + "GGGGGGGGGGGGGG" + "GGATCC" + "AAAA",
      "mol_insert_rev",
    );
    const vectorResolved = await resolveAssemblyFragmentsForMolecule({
      workspacePath: vector.workspacePath,
      moleculeId: vector.moleculeId,
      enzymes: ["EcoRI", "BamHI"],
    });
    const insertResolved = await resolveAssemblyFragmentsForMolecule({
      workspacePath: insert.workspacePath,
      moleculeId: insert.moleculeId,
      enzymes: ["EcoRI", "BamHI"],
    });

    await expect(Promise.resolve().then(async () => constructRestrictionLigationCandidates({
      vector: { resolved: vectorResolved, sequence: (await readMoleculeSequence(vector.workspacePath, vector.moleculeId)).sequence },
      insert: { resolved: insertResolved, sequence: (await readMoleculeSequence(insert.workspacePath, insert.moleculeId)).sequence },
      orientation: "reverse",
    }))).rejects.toMatchObject({
      code: "INCOMPATIBLE_RESTRICTION_ENDS",
    });
  });

  it("constructs a BamHI/BglII compatible scar with no regenerated recognition sequences at either junction", async () => {
    // Vector: circular 30bp; BamHI at cutIndex=1, BglII at cutIndex=11.
    // Backbone (largest, 20bp): wrapping from pos 12..30 + pos 1..1 (from BglII cut back to BamHI cut).
    // orderedFragmentEnds: { left: BglII, right: BamHI }
    const vector = await importCircularGenBank(
      "GGATCC" + "AAAA" + "AGATCT" + "T".repeat(14),
      "mol_bgl_bam_vector",
    );
    // Insert: linear 26bp; BglII at cutIndex=5, BamHI at cutIndex=17.
    // Insert fragment (largest, 12bp): middle section pos 6..17.
    // orderedFragmentEnds: { left: BglII, right: BamHI }
    const insert = await importFasta(
      "AAAA" + "AGATCT" + "GGGGGG" + "GGATCC" + "AAAA",
      "mol_bgl_bam_insert",
    );
    const vectorResolved = await resolveAssemblyFragmentsForMolecule({
      workspacePath: vector.workspacePath,
      moleculeId: vector.moleculeId,
      enzymes: ["BamHI", "BglII"],
    });
    const insertResolved = await resolveAssemblyFragmentsForMolecule({
      workspacePath: insert.workspacePath,
      moleculeId: insert.moleculeId,
      enzymes: ["BamHI", "BglII"],
    });
    const [candidate] = constructRestrictionLigationCandidates({
      vector: { resolved: vectorResolved, sequence: (await readMoleculeSequence(vector.workspacePath, vector.moleculeId)).sequence },
      insert: { resolved: insertResolved, sequence: (await readMoleculeSequence(insert.workspacePath, insert.moleculeId)).sequence },
      orientation: "forward",
    });
    // Product = 20bp backbone + 12bp insert = 32bp
    expect(candidate).toMatchObject({
      topology: "circular",
      length: 32,
      junctions: [
        {
          leftSource: { enzyme: "BamHI" },
          rightSource: { enzyme: "BglII" },
          endType: "five_prime_overhang",
          overhangSequence: "GATC",
        },
        {
          leftSource: { enzyme: "BamHI" },
          rightSource: { enzyme: "BglII" },
          endType: "five_prime_overhang",
          overhangSequence: "GATC",
        },
      ],
    });
    // Direct junction: vector slice(-5)="TTTTG" + insert slice(0,5)="GATCT" gives "TTTTGGATCT".
    // Closing junction: insert slice(-5)="GGGGG" + vector slice(0,5)="GATCT" gives "GGGGGGATCT".
    // Neither junction sequence contains GGATCC (BamHI) or AGATCT (BglII).
    expect(candidate.junctions[0]).not.toHaveProperty("regeneratedRecognitionSequence");
    expect(candidate.junctions[1]).not.toHaveProperty("regeneratedRecognitionSequence");
  });

  it("constructs both orientations for EcoRI single-cut ligation", async () => {
    const vector = await importCircularGenBank("AAAA" + "GAATTC" + "CCCCCCCCCC", "mol_vector_single");
    const insert = await importCircularGenBank("TTTT" + "GAATTC" + "GGGGGG", "mol_insert_single");
    const vectorResolved = await resolveAssemblyFragmentsForMolecule({
      workspacePath: vector.workspacePath,
      moleculeId: vector.moleculeId,
      enzymes: ["EcoRI"],
    });
    const insertResolved = await resolveAssemblyFragmentsForMolecule({
      workspacePath: insert.workspacePath,
      moleculeId: insert.moleculeId,
      enzymes: ["EcoRI"],
    });
    const candidates = constructRestrictionLigationCandidates({
      vector: { resolved: vectorResolved, sequence: (await readMoleculeSequence(vector.workspacePath, vector.moleculeId)).sequence },
      insert: { resolved: insertResolved, sequence: (await readMoleculeSequence(insert.workspacePath, insert.moleculeId)).sequence },
      orientation: "both",
    });

    expect(candidates.map((candidate) => candidate.orientation)).toEqual(["forward", "reverse"]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].length).toBe(vectorResolved.length + insertResolved.length);
    expect(candidates[1].length).toBe(vectorResolved.length + insertResolved.length);
    expect(candidates[0].sequence).not.toBe(candidates[1].sequence);
    expect(candidates[1].sourceSegments[1]).toMatchObject({
      role: "insert",
      moleculeId: "mol_insert_single",
      segments: [
        { start: 1, end: 5, strand: "-" },
        { start: 6, end: 16, strand: "-" },
      ],
    });
  });

  it("simulates directional restriction ligation and writes a re-importable GenBank artifact without mutating the workspace", async () => {
    const pair = await importVectorAndInsert(
      "AAAA" + "GAATTC" + "CCCCCCCCCCCCCC" + "GGATCC" + "TTTTTTTTTTTTTTTTTTTT",
      "AAAA" + "GAATTC" + "GGGGGGGGGGGGGG" + "GGATCC" + "AAAA",
      { vectorId: "mol_vector_sim", insertId: "mol_insert_sim" },
    );
    const before = await readWorkspace(pair.workspacePath);
    const result = await simulateAssembly({
      workspacePath: pair.workspacePath,
      method: "restriction_ligation",
      vector: { moleculeId: pair.vectorId, leftEnzyme: "EcoRI", rightEnzyme: "BamHI" },
      insert: {
        moleculeId: pair.insertId,
        leftEnzyme: "EcoRI",
        rightEnzyme: "BamHI",
        orientation: "forward",
      },
      product: { moleculeId: "mol_product_sim", name: "product_sim" },
    });
    const after = await readWorkspace(pair.workspacePath);

    expect(after.revision).toBe(before.revision);
    expect(after.molecules.map((molecule) => molecule.id).sort()).toEqual(["mol_insert_sim", "mol_vector_sim"]);
    expect(result).toMatchObject({
      method: "restriction_ligation",
      vector: { moleculeId: "mol_vector_sim", selectedFragment: { size: 30 } },
      insert: { moleculeId: "mol_insert_sim", selectedFragment: { size: 20 } },
      nextAction: { tool: "open_sequence" },
      candidates: [
        {
          candidateId: "candidate_forward",
          name: "product_sim",
          topology: "circular",
          length: 50,
          orientation: "forward",
          artifacts: [
            {
              kind: "genbank",
              relativePath: path.join("reports", "assembly", "mol_product_sim.gb"),
              mimeType: "chemical/x-genbank",
            },
          ],
        },
      ],
    });
    const [candidate] = result.candidates;
    expect("sequence" in candidate).toBe(false);

    const artifactPath = candidate.artifacts[0].path;
    const artifact = await fs.readFile(artifactPath, "utf8");
    expect(artifact).toContain("LOCUS");
    expect(artifact).toContain("/label=\"junction_1\"");
    expect(artifact).toContain("/label=\"junction_2\"");
    expect(artifact).toContain("/regenerated_site=\"GAATTC\"");
    expect(artifact).toContain("/regenerated_site=\"GGATCC\"");

    const reimportDir = await tempDir("mol-assembly-reimport-");
    const reimported = await importSequenceFile({
      inputPath: artifactPath,
      workspaceDir: reimportDir,
      format: "genbank",
      moleculeId: "mol_reimported_product",
    });
    const product = await readMoleculeSequence(reimported.workspacePath, "mol_reimported_product");
    expect(product.molecule.topology).toBe("circular");
    expect(product.sequence).toHaveLength(50);
  });

  it("uses deterministic candidate-specific artifact paths when simulating both single-cut orientations", async () => {
    const pair = await importVectorAndInsert(
      "AAAA" + "GAATTC" + "CCCCCCCCCC",
      "TTTT" + "GAATTC" + "GGGGGG",
      { vectorId: "mol_vector_both", insertId: "mol_insert_both", insertCircular: true },
    );
    const result = await simulateAssembly({
      workspacePath: pair.workspacePath,
      method: "restriction_ligation",
      vector: { moleculeId: pair.vectorId, leftEnzyme: "EcoRI" },
      insert: {
        moleculeId: pair.insertId,
        leftEnzyme: "EcoRI",
        orientation: "both",
      },
      product: { moleculeId: "mol_product_both", name: "product_both" },
    });

    expect(result.candidates.map((candidate) => candidate.orientation)).toEqual(["forward", "reverse"]);
    expect(result.candidates.map((candidate) => candidate.artifacts[0].relativePath)).toEqual([
      path.join("reports", "assembly", "mol_product_both_forward.gb"),
      path.join("reports", "assembly", "mol_product_both_reverse.gb"),
    ]);
    expect((await fs.stat(result.candidates[0].artifacts[0].path)).isFile()).toBe(true);
    expect((await fs.stat(result.candidates[1].artifacts[0].path)).isFile()).toBe(true);
  });

  it("does not write artifacts when directional restriction ligation is incompatible", async () => {
    const pair = await importVectorAndInsert(
      "AAAA" + "GAATTC" + "CCCCCCCCCCCCCC" + "GGATCC" + "TTTTTTTTTTTTTTTTTTTT",
      "AAAA" + "GAATTC" + "GGGGGGGGGGGGGG" + "GGATCC" + "AAAA",
      { vectorId: "mol_vector_bad", insertId: "mol_insert_bad" },
    );

    await expect(simulateAssembly({
      workspacePath: pair.workspacePath,
      method: "restriction_ligation",
      vector: { moleculeId: pair.vectorId, leftEnzyme: "EcoRI", rightEnzyme: "BamHI" },
      insert: {
        moleculeId: pair.insertId,
        leftEnzyme: "EcoRI",
        rightEnzyme: "BamHI",
        orientation: "reverse",
      },
      product: { moleculeId: "mol_should_not_exist" },
    })).rejects.toMatchObject({ code: "INCOMPATIBLE_RESTRICTION_ENDS" });
    await expect(fs.stat(path.join(pair.workspaceDir, "reports", "assembly", "mol_should_not_exist.gb")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the artifact using candidateId when product is not specified", async () => {
    const pair = await importVectorAndInsert(
      "AAAA" + "GAATTC" + "CCCCCCCCCCCCCC" + "GGATCC" + "TTTTTTTTTTTTTTTTTTTT",
      "AAAA" + "GAATTC" + "GGGGGGGGGGGGGG" + "GGATCC" + "AAAA",
      { vectorId: "mol_vector_defprod", insertId: "mol_insert_defprod" },
    );
    const result = await simulateAssembly({
      workspacePath: pair.workspacePath,
      method: "restriction_ligation",
      vector: { moleculeId: pair.vectorId, leftEnzyme: "EcoRI", rightEnzyme: "BamHI" },
      insert: { moleculeId: pair.insertId, leftEnzyme: "EcoRI", rightEnzyme: "BamHI" },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].artifacts[0].relativePath).toBe(
      path.join("reports", "assembly", "candidate_forward.gb"),
    );
    expect((await fs.stat(result.candidates[0].artifacts[0].path)).isFile()).toBe(true);
  });

  it("simulates SmaI blunt-end ligation with regenerated recognition sequences at both junctions", async () => {
    // Both molecules are circular with a single SmaI (CCC^GGG) site; each linearizes as a full fragment.
    // SmaI at pos 5 in both molecules gives cutIndex 7. Product = 20 + 15 = 35 bp circular.
    // These SmaI-generated blunt ends regenerate CCCGGG at the junction because the left end
    // ends with CCC and the right end starts with GGG.
    const pair = await importVectorAndInsert(
      "AAAACCCGGGAAAAAAAAAA", // 20 bp circular; SmaI CCCGGG at pos 5, cutIndex 7
      "TTTTCCCGGGTTTTT",      // 15 bp circular; SmaI CCCGGG at pos 5, cutIndex 7
      { vectorId: "mol_smai_vector", insertId: "mol_smai_insert", insertCircular: true },
    );
    const result = await simulateAssembly({
      workspacePath: pair.workspacePath,
      method: "restriction_ligation",
      vector: { moleculeId: pair.vectorId, leftEnzyme: "SmaI" },
      insert: { moleculeId: pair.insertId, leftEnzyme: "SmaI" },
      product: { moleculeId: "mol_smai_product", topology: "circular" },
    });
    expect(result.candidates).toHaveLength(1);
    const [candidate] = result.candidates;
    expect(candidate).toMatchObject({
      name: "mol_smai_product",
      topology: "circular",
      length: 35,
      orientation: "forward",
      ends: [
        { role: "vector", enzyme: "SmaI", side: "left", endType: "blunt", overhangSequence: "" },
        { role: "vector", enzyme: "SmaI", side: "right", endType: "blunt", overhangSequence: "" },
        { role: "insert", enzyme: "SmaI", side: "left", endType: "blunt", overhangSequence: "" },
        { role: "insert", enzyme: "SmaI", side: "right", endType: "blunt", overhangSequence: "" },
      ],
      junctions: [
        {
          leftSource: { enzyme: "SmaI", side: "right" },
          rightSource: { enzyme: "SmaI", side: "left" },
          endType: "blunt",
          overhangSequence: "",
          regeneratedRecognitionSequence: "CCCGGG",
        },
        {
          leftSource: { enzyme: "SmaI", side: "right" },
          rightSource: { enzyme: "SmaI", side: "left" },
          endType: "blunt",
          overhangSequence: "",
          regeneratedRecognitionSequence: "CCCGGG",
        },
      ],
    });
  });
});
