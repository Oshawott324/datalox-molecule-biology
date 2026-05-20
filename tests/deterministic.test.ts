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

describe("deterministic biology core", () => {
  it("keeps reverse complement deterministic for ambiguous DNA bases", () => {
    expect(reverseComplement("ACGTRYSWKMBDHVN")).toBe("NBDHVKMWSRYACGT");
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
    expect(sites.every((site) => site.enzymeTableVersion === "datalox_rebase_minimal_v1")).toBe(true);

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
});
