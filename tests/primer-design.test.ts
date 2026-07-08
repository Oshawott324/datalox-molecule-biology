import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  designPrimers,
  formatPrimer3BoulderInput,
  handleDesignPrimers,
  handleOpenSequence,
  normalizePrimerDesignOptions,
  parsePrimer3Output,
} from "../src/index.js";

const fixturesRoot = path.resolve("fixtures");
const hasPrimer3Core = spawnSync("primer3_core", ["--version"], { stdio: "ignore" }).error === undefined;

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-primer-design-"));
}

const capturedPrimer3Output = [
  "PRIMER_PAIR_NUM_RETURNED=1",
  "PRIMER_LEFT_0=10,20",
  "PRIMER_RIGHT_0=309,20",
  "PRIMER_LEFT_0_SEQUENCE=ACGTACGTACGTACGTACGT",
  "PRIMER_RIGHT_0_SEQUENCE=TGCATGCATGCATGCATGCA",
  "PRIMER_LEFT_0_TM=60.123",
  "PRIMER_RIGHT_0_TM=61.234",
  "PRIMER_LEFT_0_GC_PERCENT=50.000",
  "PRIMER_RIGHT_0_GC_PERCENT=55.000",
  "PRIMER_PAIR_0_PENALTY=2.500",
  "PRIMER_PAIR_0_PRODUCT_SIZE=300",
  "=",
  "",
].join("\n");

describe("Primer3-backed primer design", () => {
  it("formats BoulderIO with target interval and explicit defaults", () => {
    const input = formatPrimer3BoulderInput({
      moleculeId: "mol_test",
      sequence: "A".repeat(500),
      target: { start: 101, end: 200 },
      options: normalizePrimerDesignOptions(),
    });

    expect(input).toContain("SEQUENCE_ID=mol_test\n");
    expect(input).toContain(`SEQUENCE_TEMPLATE=${"A".repeat(500)}\n`);
    expect(input).toContain("SEQUENCE_TARGET=100,100\n");
    expect(input).toContain("PRIMER_PRODUCT_SIZE_RANGE=200-1000\n");
    expect(input).toContain("PRIMER_MIN_TM=57\n");
    expect(input).toContain("PRIMER_OPT_TM=60\n");
    expect(input).toContain("PRIMER_MAX_TM=63\n");
    expect(input).toContain("PRIMER_MIN_SIZE=18\n");
    expect(input).toContain("PRIMER_OPT_SIZE=23\n");
    expect(input).toContain("PRIMER_MAX_SIZE=27\n");
    expect(input).toContain("PRIMER_NUM_RETURN=5\n=\n");
  });

  it("parses Primer3 output and converts right-primer coordinates", () => {
    const candidates = parsePrimer3Output(capturedPrimer3Output, {
      leftOverhang: "GAATTC",
      rightOverhang: "AAGCTT",
    });

    expect(candidates).toEqual([
      {
        rank: 1,
        penalty: 2.5,
        productSize: 300,
        left: {
          sequence: "ACGTACGTACGTACGTACGT",
          sequenceWithOverhang: "GAATTCACGTACGTACGTACGTACGT",
          tm: 60.123,
          gcPercent: 50,
          start: 11,
          end: 30,
          strand: "+",
        },
        right: {
          sequence: "TGCATGCATGCATGCATGCA",
          sequenceWithOverhang: "AAGCTTTGCATGCATGCATGCATGCA",
          tm: 61.234,
          gcPercent: 55,
          start: 291,
          end: 310,
          strand: "-",
        },
      },
    ]);
  });

  it("returns empty candidates when Primer3 finds no valid pair", () => {
    expect(parsePrimer3Output("PRIMER_PAIR_NUM_RETURNED=0\n=\n")).toEqual([]);
  });

  it("parses multiple Primer3 candidates by rank and index", () => {
    const output = [
      "PRIMER_PAIR_NUM_RETURNED=2",
      "PRIMER_LEFT_0=10,20",
      "PRIMER_RIGHT_0=309,20",
      "PRIMER_LEFT_0_SEQUENCE=ACGTACGTACGTACGTACGT",
      "PRIMER_RIGHT_0_SEQUENCE=TGCATGCATGCATGCATGCA",
      "PRIMER_LEFT_0_TM=60",
      "PRIMER_RIGHT_0_TM=61",
      "PRIMER_LEFT_0_GC_PERCENT=50",
      "PRIMER_RIGHT_0_GC_PERCENT=55",
      "PRIMER_PAIR_0_PENALTY=2.5",
      "PRIMER_PAIR_0_PRODUCT_SIZE=300",
      "PRIMER_LEFT_1=20,21",
      "PRIMER_RIGHT_1=419,22",
      "PRIMER_LEFT_1_SEQUENCE=AAAACCCCGGGGTTTTAAAAA",
      "PRIMER_RIGHT_1_SEQUENCE=TTTTGGGGCCCCAAAATTTTGG",
      "PRIMER_LEFT_1_TM=59",
      "PRIMER_RIGHT_1_TM=60",
      "PRIMER_LEFT_1_GC_PERCENT=45",
      "PRIMER_RIGHT_1_GC_PERCENT=50",
      "PRIMER_PAIR_1_PENALTY=4",
      "PRIMER_PAIR_1_PRODUCT_SIZE=400",
      "=",
      "",
    ].join("\n");

    const candidates = parsePrimer3Output(output);

    expect(candidates).toHaveLength(2);
    expect(candidates[1]).toMatchObject({
      rank: 2,
      penalty: 4,
      productSize: 400,
      left: {
        sequence: "AAAACCCCGGGGTTTTAAAAA",
        start: 21,
        end: 41,
        strand: "+",
      },
      right: {
        sequence: "TTTTGGGGCCCCAAAATTTTGG",
        start: 399,
        end: 420,
        strand: "-",
      },
    });
  });

  it("rejects wraparound or out-of-range targets before calling Primer3", () => {
    expect(() => formatPrimer3BoulderInput({
      moleculeId: "mol_test",
      sequence: "A".repeat(100),
      target: { start: 80, end: 20 },
      options: normalizePrimerDesignOptions(),
    })).toThrow("Primer design target coordinates are invalid.");
  });

  it("rejects ambiguous DNA before calling Primer3", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const sourcePath = path.join(workspaceDir, "ambiguous.fa");
    await fs.writeFile(sourcePath, ">ambiguous\nACGTACGTNNNNACGTACGTACGTACGT\n", "utf8");
    const open = await handleOpenSequence({
      inputPath: sourcePath,
      workspaceDir,
      format: "fasta",
      moleculeId: "mol_ambiguous",
    });
    expect(open.ok).toBe(true);

    const result = await handleDesignPrimers({
      workspaceDir,
      moleculeId: "mol_ambiguous",
      target: { start: 1, end: 20 },
    });

    expect(result).toMatchObject({
      ok: false,
      tool: "design_primers",
      error: {
        code: "AMBIGUOUS_SEQUENCE",
        details: {
          label: "mol_ambiguous",
          positions: [
            { position: 9, base: "N" },
            { position: 10, base: "N" },
            { position: 11, base: "N" },
            { position: 12, base: "N" },
          ],
          totalAmbiguousCount: 4,
        },
      },
    });
  });

  it("rejects ambiguous primer overhangs before calling Primer3", () => {
    expect(() => normalizePrimerDesignOptions({ leftOverhang: "GAANNC" })).toThrow("Sequence contains ambiguous bases.");
    expect(() => normalizePrimerDesignOptions({ rightOverhang: "AAGNTT" })).toThrow("Sequence contains ambiguous bases.");
  });

  it.skipIf(hasPrimer3Core)("returns DEPENDENCY_MISSING when primer3_core is absent", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const open = await handleOpenSequence({
      inputPath: path.join(fixturesRoot, "genbank/puc19.gb"),
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_puc19",
    });
    expect(open.ok).toBe(true);

    const result = await handleDesignPrimers({
      workspaceDir,
      moleculeId: "mol_puc19",
      target: { start: 1629, end: 2028 },
    });

    expect(result).toMatchObject({
      ok: false,
      tool: "design_primers",
      error: {
        code: "DEPENDENCY_MISSING",
        details: {
          dependency: "primer3_core",
        },
      },
    });
  });

  it.skipIf(!hasPrimer3Core)("designs primers for a pUC19 target with primer3_core", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const open = await handleOpenSequence({
      inputPath: path.join(fixturesRoot, "genbank/puc19.gb"),
      workspaceDir,
      format: "genbank",
      moleculeId: "mol_puc19",
    });
    expect(open.ok).toBe(true);

    const result = await designPrimers({
      workspacePath: path.join(workspaceDir, "molecule.workspace.json"),
      moleculeId: "mol_puc19",
      target: { start: 1629, end: 2028 },
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].productSize).toBeGreaterThanOrEqual(200);
    expect(result.candidates[0].productSize).toBeLessThanOrEqual(1000);
  });
});
