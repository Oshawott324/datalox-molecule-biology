import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseBlastJson2, parseBlastPutResponse, parseBlastStatus } from "../src/index.js";

const liveFixture = "fixtures/blast/puc19-bla-blastn-nt/result.json";
const livePutResponse = "fixtures/blast/puc19-bla-blastn-nt/put-response.txt";
const liveStatusResponse = "fixtures/blast/puc19-bla-blastn-nt/status-0060.txt";
const emptyFixture = "fixtures/blast/empty-hits-json2s/result.json";

function readJsonFixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("BLAST JSON2_S parser", () => {
  it("parses the frozen pUC19 bla fixture into summarized hits and provenance", () => {
    const parsed = parseBlastJson2(readFileSync(liveFixture, "utf8"));

    expect(parsed).toMatchObject({
      program: "blastn",
      version: "BLASTN 2.17.0+",
      queryLength: 300,
      effectiveDatabase: "core_nt",
      parameters: {
        expect: 0.001,
        sc_match: 2,
        sc_mismatch: -3,
        gap_open: 5,
        gap_extend: 2,
      },
      statistics: {
        dbNum: 128547243,
        dbLen: 948086538397,
      },
    });
    expect(parsed.hits).toHaveLength(5);
    expect(parsed.hits[0]).toMatchObject({
      accession: "PX095324",
      title: "Synthetic construct pTS002X-XIST, complete sequence",
      taxId: 32630,
      organism: "synthetic construct",
      subjectLength: 8269,
    });
    expect(parsed.hits[0].alignments[0]).toEqual({
      identityPercent: 100,
      coveragePercent: 100,
      eValue: 1.39168e-149,
      bitScore: 542.297,
      alignedLength: 300,
      identity: 300,
      gaps: 0,
      queryStart: 1,
      queryEnd: 300,
      subjectStart: 7277,
      subjectEnd: 7576,
      strand: "plus",
    });
    expect(parsed.hits[0].alignments[0]).not.toHaveProperty("qseq");
    expect(parsed.hits[0].alignments[0]).not.toHaveProperty("hseq");
    expect(parsed.hits[0].alignments[0]).not.toHaveProperty("midline");
  });

  it("extracts RID, RTOE, and READY status from frozen HTML responses", () => {
    expect(parseBlastPutResponse(readFileSync(livePutResponse, "utf8"))).toEqual({
      rid: "606SVMTS014",
      rtoe: 30,
    });
    expect(parseBlastStatus(readFileSync(liveStatusResponse, "utf8"))).toBe("READY");
  });

  it("parses an explicit empty hits array as a valid zero-hit result", () => {
    const parsed = parseBlastJson2(readFileSync(emptyFixture, "utf8"));

    expect(parsed).toMatchObject({
      program: "blastn",
      queryLength: 120,
      effectiveDatabase: "core_nt",
      statistics: {
        dbNum: 128547243,
        dbLen: 948086538397,
      },
      hits: [],
    });
  });

  it("normalizes a missing hits key to an empty hit list", () => {
    const fixture = readJsonFixture(emptyFixture) as {
      BlastOutput2: [{ report: { results: { search: { hits?: unknown[] } } } }];
    };
    delete fixture.BlastOutput2[0].report.results.search.hits;

    expect(parseBlastJson2(fixture).hits).toEqual([]);
  });

  it("treats search statistics as optional provenance", () => {
    const fixture = readJsonFixture(emptyFixture) as {
      BlastOutput2: [{ report: { results: { search: { stat?: unknown } } } }];
    };
    delete fixture.BlastOutput2[0].report.results.search.stat;

    const parsed = parseBlastJson2(fixture);
    expect(parsed.hits).toEqual([]);
    expect(parsed.statistics).toBeUndefined();
  });

  it("rejects multi-report JSON2_S responses for single-query B1 parsing", () => {
    const fixture = readJsonFixture(emptyFixture) as { BlastOutput2: unknown[] };
    fixture.BlastOutput2.push(fixture.BlastOutput2[0]);

    expect(() => parseBlastJson2(fixture)).toThrow("Expected exactly one BLAST report.");
  });
});
