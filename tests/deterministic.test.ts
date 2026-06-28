import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  exportGenBank,
  findOrfs,
  findRestrictionSites,
  importSequenceFile,
  readMoleculeSequence,
  readWorkspace,
  RESTRICTION_ENZYMES,
  RESTRICTION_ENZYME_TABLE_VERSION,
  reverseComplement,
  sequenceDigest,
  simulateDigest,
  simulatePcr,
  translateRegion,
} from "../src/index.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function importFasta(sequence: string, name = "deterministic"): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-det-");
  const inputPath = path.join(workspaceDir, "input.fa");
  await fs.writeFile(inputPath, `>${name}\n${sequence}\n`, "utf8");
  const result = await importSequenceFile({ inputPath, workspaceDir, format: "fasta" });
  return { workspaceDir, workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

async function importGenBank(content: string): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-det-gb-");
  const inputPath = path.join(workspaceDir, "input.gb");
  await fs.writeFile(inputPath, content, "utf8");
  const result = await importSequenceFile({ inputPath, workspaceDir, format: "genbank" });
  return { workspaceDir, workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

async function importGenBankFixture(relativePath: string, moleculeId: string): Promise<{ workspaceDir: string; workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-det-gb-fixture-");
  const result = await importSequenceFile({
    inputPath: path.resolve(relativePath),
    workspaceDir,
    format: "genbank",
    moleculeId,
  });
  return { workspaceDir, workspacePath: result.workspacePath, moleculeId: result.moleculeIds[0] };
}

describe("deterministic biology core", () => {
  it("keeps reverse complement deterministic for ambiguous DNA bases", () => {
    expect(reverseComplement("ACGTRYSWKMBDHVN")).toBe("NBDHVKMWSRYACGT");
  });

  it("pins the common REBASE-derived restriction enzyme table", () => {
    expect(RESTRICTION_ENZYME_TABLE_VERSION).toBe("datalox_rebase_common_v2");
    expect(RESTRICTION_ENZYMES).toMatchObject({
      ApaI: { recognitionSequence: "GGGCCC", cutOffset: 5 },
      BamHI: { recognitionSequence: "GGATCC", cutOffset: 1 },
      BglII: { recognitionSequence: "AGATCT", cutOffset: 1 },
      ClaI: { recognitionSequence: "ATCGAT", cutOffset: 2 },
      EcoRI: { recognitionSequence: "GAATTC", cutOffset: 1 },
      HindIII: { recognitionSequence: "AAGCTT", cutOffset: 1 },
      KpnI: { recognitionSequence: "GGTACC", cutOffset: 5 },
      NcoI: { recognitionSequence: "CCATGG", cutOffset: 1 },
      NdeI: { recognitionSequence: "CATATG", cutOffset: 2 },
      NheI: { recognitionSequence: "GCTAGC", cutOffset: 1 },
      NotI: { recognitionSequence: "GCGGCCGC", cutOffset: 2 },
      PstI: { recognitionSequence: "CTGCAG", cutOffset: 5 },
      SacI: { recognitionSequence: "GAGCTC", cutOffset: 5 },
      SalI: { recognitionSequence: "GTCGAC", cutOffset: 1 },
      SmaI: { recognitionSequence: "CCCGGG", cutOffset: 3 },
      SpeI: { recognitionSequence: "ACTAGT", cutOffset: 1 },
      SphI: { recognitionSequence: "GCATGC", cutOffset: 5 },
      XbaI: { recognitionSequence: "TCTAGA", cutOffset: 1 },
      XhoI: { recognitionSequence: "CTCGAG", cutOffset: 1 },
      XmaI: { recognitionSequence: "CCCGGG", cutOffset: 1 },
    });
  });

  it("translates known forward, reverse, ambiguous, and partial regions", async () => {
    const { workspacePath, moleculeId } = await importFasta("ATGGCCNNNTAAACAT");

    await expect(translateRegion(workspacePath, moleculeId, { start: 1, end: 12, strand: "+" })).resolves.toMatchObject({
      aminoAcids: "MAX*",
      nucleotideLength: 12,
    });
    await expect(translateRegion(workspacePath, moleculeId, { start: 13, end: 16, strand: "-" })).resolves.toMatchObject({
      aminoAcids: "M",
      partialTerminalCodon: "T",
    });
  });

  it("finds ORFs with explicit start and stop codons on both strands", async () => {
    const { workspacePath, moleculeId } = await importFasta("CCCATGAAATAAGGG");
    const orfs = await findOrfs(workspacePath, moleculeId, { minAa: 2, strands: ["+", "-"] });

    expect(orfs).toEqual([
      {
        moleculeId,
        start: 4,
        end: 12,
        strand: "+",
        frame: 1,
        nucleotideLength: 9,
        aminoAcidLength: 2,
        startCodon: "ATG",
        stopCodon: "TAA",
      },
    ]);
  });

  it("finds restriction sites from the versioned local enzyme table and returns zero-site results", async () => {
    const { workspacePath, moleculeId } = await importFasta("AAAAGAATTCAAGCTTGGATCCAAAA");
    const sites = await findRestrictionSites(workspacePath, moleculeId, ["EcoRI", "HindIII", "BamHI"]);

    expect(sites.map((site) => ({ enzyme: site.enzyme, start: site.start, end: site.end, cutPosition: site.cutPosition }))).toEqual([
      { enzyme: "EcoRI", start: 5, end: 10, cutPosition: 5 },
      { enzyme: "HindIII", start: 11, end: 16, cutPosition: 11 },
      { enzyme: "BamHI", start: 17, end: 22, cutPosition: 17 },
    ]);
    expect(sites.every((site) => site.enzymeTableVersion === "datalox_rebase_common_v2")).toBe(true);

    const none = await findRestrictionSites(workspacePath, moleculeId, ["EcoRI"], {});
    expect(none.filter((site) => site.start > 100)).toEqual([]);

    const noSiteFixture = await importFasta("ACGTACGT");
    await expect(findRestrictionSites(noSiteFixture.workspacePath, noSiteFixture.moleculeId, ["EcoRI"])).resolves.toEqual([]);
  });

  it("finds circular restriction sites that cross the origin", async () => {
    const circular = await importGenBank(`LOCUS       pOrigin       10 bp    DNA     circular 18-MAY-2026
DEFINITION  Origin-spanning cutter.
FEATURES             Location/Qualifiers
ORIGIN
        1 tcaaaagaat
//
`);
    const sites = await findRestrictionSites(circular.workspacePath, circular.moleculeId, ["EcoRI"]);

    expect(sites).toEqual([
      expect.objectContaining({
        enzyme: "EcoRI",
        start: 7,
        end: 2,
        segments: [
          { start: 7, end: 10, strand: "+" },
          { start: 1, end: 2, strand: "+" },
        ],
      }),
    ]);
  });

  it("simulates complete linear and circular restriction digests with fragment sizes summing to molecule length", async () => {
    const linear = await importFasta("AAAAGAATTCAAGCTTGGATCCAAAA");
    const linearDigest = await simulateDigest(linear.workspacePath, linear.moleculeId, ["EcoRI", "HindIII", "BamHI"]);
    expect(linearDigest.fragments.map((fragment) => fragment.size)).toEqual([5, 6, 6, 9]);
    expect(linearDigest.fragments.reduce((sum, fragment) => sum + fragment.size, 0)).toBe(linearDigest.length);

    const singleCutterCircular = await importGenBank(`LOCUS       pOne          14 bp    DNA     circular 18-MAY-2026
DEFINITION  One cutter.
FEATURES             Location/Qualifiers
ORIGIN
        1 aaaagaattc aaaa
//
`);
    const singleDigest = await simulateDigest(singleCutterCircular.workspacePath, singleCutterCircular.moleculeId, ["EcoRI"]);
    expect(singleDigest.fragments).toEqual([{ size: 14, start: 6, end: 5, circular: true }]);

    const twoCutterCircular = await importGenBank(`LOCUS       pTwo          24 bp    DNA     circular 18-MAY-2026
DEFINITION  Two cutters.
FEATURES             Location/Qualifiers
ORIGIN
        1 aaaagaattc aaaaggatc caaaa
//
`);
    const twoDigest = await simulateDigest(twoCutterCircular.workspacePath, twoCutterCircular.moleculeId, ["EcoRI", "BamHI"]);
    expect(twoDigest.fragments.map((fragment) => fragment.size)).toEqual([10, 14]);
    expect(twoDigest.fragments.reduce((sum, fragment) => sum + fragment.size, 0)).toBe(twoDigest.length);
  });

  it("pins pUC19 MCS restriction sites and digest fragments against the authentic fixture", async () => {
    const puc19 = await importGenBankFixture("fixtures/genbank/puc19.gb", "mol_puc19");
    const sites = await findRestrictionSites(puc19.workspacePath, puc19.moleculeId, ["EcoRI", "BamHI", "HindIII"]);

    expect(sites.map((site) => ({
      enzyme: site.enzyme,
      recognitionSequence: site.recognitionSequence,
      start: site.start,
      end: site.end,
      cutPosition: site.cutPosition,
    }))).toEqual([
      { enzyme: "EcoRI", recognitionSequence: "GAATTC", start: 396, end: 401, cutPosition: 396 },
      { enzyme: "BamHI", recognitionSequence: "GGATCC", start: 417, end: 422, cutPosition: 417 },
      { enzyme: "HindIII", recognitionSequence: "AAGCTT", start: 447, end: 452, cutPosition: 447 },
    ]);

    const digest = await simulateDigest(puc19.workspacePath, puc19.moleculeId, ["EcoRI", "BamHI", "HindIII"]);
    expect(digest.length).toBe(2686);
    expect(digest.fragments.map((fragment) => ({
      size: fragment.size,
      start: fragment.start,
      end: fragment.end,
      circular: fragment.circular,
    }))).toEqual([
      { size: 21, start: 397, end: 417, circular: false },
      { size: 30, start: 418, end: 447, circular: false },
      { size: 2635, start: 448, end: 396, circular: true },
    ]);
    expect(digest.fragments.reduce((sum, fragment) => sum + fragment.size, 0)).toBe(2686);
  });

  it("simulates exact PCR products and returns no-product cases without guessing", async () => {
    const { workspacePath, moleculeId } = await importFasta("AAACCCATGGGGTTAACCGGGTTT");
    const result = await simulatePcr(workspacePath, moleculeId, "ATGGGG", "CCCGG");

    expect(result.products).toEqual([
      {
        moleculeId,
        ampliconLength: 15,
        coordinates: [{ start: 7, end: 21, strand: "+" }],
        sequenceDigest: sequenceDigest("ATGGGGTTAACCGGG"),
        forwardPrimerStart: 7,
        reversePrimerStart: 17,
      },
    ]);
    await expect(simulatePcr(workspacePath, moleculeId, "AAAAAA", "CCCGG")).resolves.toMatchObject({ products: [] });
  });

  it("exports GenBank that re-imports with the same sequence digest and core features", async () => {
    const source = await importGenBank(`LOCUS       pExport       18 bp    DNA     linear   18-MAY-2026
DEFINITION  Export fixture.
FEATURES             Location/Qualifiers
     gene            1..6
                     /gene="alpha"
     CDS             complement(10..15)
                     /product="rev"
ORIGIN
        1 atgcccttta aagggccc
//
`);
    const outputPath = path.join(source.workspaceDir, "reports/exports/pExport.gb");
    await exportGenBank(source.workspacePath, source.moleculeId, outputPath);
    const reimported = await importGenBank(await fs.readFile(outputPath, "utf8"));

    const originalSequence = await readMoleculeSequence(source.workspacePath, source.moleculeId);
    const exportedSequence = await readMoleculeSequence(reimported.workspacePath, reimported.moleculeId);
    const exportedWorkspace = await readWorkspace(reimported.workspacePath, { checkSequenceDigests: true });

    expect(exportedSequence.molecule.sequenceDigest).toBe(originalSequence.molecule.sequenceDigest);
    expect(exportedWorkspace.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "alpha", type: "gene", segments: [{ start: 1, end: 6, strand: "+" }] }),
        expect.objectContaining({ name: "rev", type: "CDS", segments: [{ start: 10, end: 15, strand: "-" }] }),
      ]),
    );
  });

  it("confines export_genbank to the workspace and blocks path escapes by default", async () => {
    const source = await importFasta("ACGTACGTACGT", "pConfine");

    // Absolute path inside the workspace is allowed (matches render_plasmid_map).
    const insidePath = path.join(source.workspaceDir, "reports/exports/inside.gb");
    const inside = await exportGenBank(source.workspacePath, source.moleculeId, insidePath);
    expect(inside.relativePath).toBe(path.join("reports", "exports", "inside.gb"));
    await expect(fs.readFile(insidePath, "utf8")).resolves.toContain("LOCUS");

    // Workspace-relative paths are resolved from the workspace root, not the process cwd.
    const relativeInside = await exportGenBank(source.workspacePath, source.moleculeId, "reports/exports/relative.gb");
    expect(relativeInside.outputPath).toBe(path.join(source.workspaceDir, "reports", "exports", "relative.gb"));
    expect(relativeInside.relativePath).toBe(path.join("reports", "exports", "relative.gb"));
    await expect(fs.readFile(relativeInside.outputPath, "utf8")).resolves.toContain("LOCUS");

    // Relative traversal escaping the workspace root is rejected.
    await expect(exportGenBank(source.workspacePath, source.moleculeId, "../escape.gb"))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    // Absolute path outside the workspace is rejected.
    const outsideDir = await tempDir("mol-export-outside-");
    await expect(exportGenBank(source.workspacePath, source.moleculeId, path.join(outsideDir, "escape.gb")))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(fs.readFile(path.join(outsideDir, "escape.gb"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows export outside the workspace only with the explicit opt-out flag", async () => {
    const source = await importFasta("ACGTACGTACGT", "pOptOut");
    const outsideDir = await tempDir("mol-export-optout-");
    const outsidePath = path.join(outsideDir, "exported.gb");

    process.env.MOLECULE_MCP_UNSAFE_EXPORT_OUTSIDE_WORKSPACE = "1";
    try {
      const result = await exportGenBank(source.workspacePath, source.moleculeId, outsidePath);
      expect(result.outputPath).toBe(path.resolve(outsidePath));
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toContain("LOCUS");
    } finally {
      delete process.env.MOLECULE_MCP_UNSAFE_EXPORT_OUTSIDE_WORKSPACE;
    }
  });

  it("pins datalox_insert_v1 fixture: 700 bp, XhoI-only among all 20 panel enzymes", async () => {
    const workspaceDir = await tempDir("mol-insert-");
    const result = await importSequenceFile({
      inputPath: path.resolve("fixtures/fasta/datalox_insert_v1.fa"),
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_insert",
    });
    const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });

    expect(workspace.molecules[0]).toMatchObject({
      id: "mol_insert",
      length: 700,
      sequenceDigest: "sha256:c954387359735d60c46d3a98c55ec42c2427dd2245be6882f4629e5c357c85e0",
    });

    const ALL_PANEL = [
      "ApaI", "BglII", "ClaI", "EcoRI", "BamHI", "HindIII", "KpnI", "NcoI", "NdeI", "NheI",
      "NotI", "PstI", "SacI", "SalI", "SmaI", "SpeI", "SphI", "XbaI", "XhoI", "XmaI",
    ];
    const sites = await findRestrictionSites(result.workspacePath, "mol_insert", ALL_PANEL);

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ enzyme: "XhoI", cutPosition: 250 });
  });
});
