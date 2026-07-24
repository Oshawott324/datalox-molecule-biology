import { describe, expect, it } from "vitest";

import {
  computeBindingEvidence,
  predictAmplicons,
  markIntendedTarget,
  classifyVerdict,
  validatePrimerSpecificity,
  type PredictedAmplicon,
  type PrimerBindingEvidence,
} from "../src/index.js";
import type { BlastAlignment } from "../src/core/blast-parse.js";

const PRIMER = "ACGTACGTACGTACGTACGT"; // 20 nt

function alignment(over: Partial<BlastAlignment> & { qseq: string; hseq: string }): BlastAlignment {
  return {
    identityPercent: 0, coveragePercent: 0, eValue: 0, bitScore: 0,
    alignedLength: over.qseq.length, identity: 0, gaps: 0,
    queryStart: 1, queryEnd: over.qseq.replace(/-/g, "").length,
    subjectStart: 1, subjectEnd: over.qseq.length, strand: "plus",
    midline: "", ...over,
  };
}

function evidence(strand: "plus" | "minus", start: number, end: number, competent = true, primerRole: "forward" | "reverse" = "forward"): PrimerBindingEvidence {
  return { primerRole, start, end, strand, threePrimeMatchLength: competent ? 5 : 0, mismatches: 0, amplificationCompetent: competent };
}

describe("B2 3'-end competence (Rule 1)", () => {
  it("marks a perfect full-length match amplification-competent", () => {
    const e = computeBindingEvidence(alignment({ qseq: PRIMER, hseq: PRIMER, queryEnd: 20 }), 20, 5);
    expect(e).toMatchObject({ primerRole: "forward", amplificationCompetent: true, threePrimeMatchLength: 20, mismatches: 0 });
  });

  it("rejects a 3'-terminal mismatch even with a matching 5' region", () => {
    const hseq = `${PRIMER.slice(0, 19)}A`; // last base G->A mismatch (PRIMER ends in T actually)
    const mutated = `${PRIMER.slice(0, 19)}${PRIMER[19] === "A" ? "C" : "A"}`;
    const e = computeBindingEvidence(alignment({ qseq: PRIMER, hseq: mutated, queryEnd: 20 }), 20, 5);
    expect(e.threePrimeMatchLength).toBe(0);
    expect(e.amplificationCompetent).toBe(false);
    void hseq;
  });

  it("keeps a 5'-only mismatch amplification-competent (3' end intact)", () => {
    const hseq = `${PRIMER[0] === "A" ? "C" : "A"}${PRIMER.slice(1)}`;
    const e = computeBindingEvidence(alignment({ qseq: PRIMER, hseq, queryEnd: 20 }), 20, 5);
    expect(e.threePrimeMatchLength).toBe(19);
    expect(e.mismatches).toBe(1);
    expect(e.amplificationCompetent).toBe(true);
  });

  it("is not competent when the alignment stops short of the primer 3' end", () => {
    const e = computeBindingEvidence(alignment({ qseq: PRIMER.slice(0, 18), hseq: PRIMER.slice(0, 18), queryEnd: 18 }), 20, 5);
    expect(e.amplificationCompetent).toBe(false); // queryEnd 18 != primerLength 20
  });

  it("records which input primer produced the binding evidence", () => {
    const e = computeBindingEvidence(alignment({ qseq: PRIMER, hseq: PRIMER, queryEnd: 20 }), 20, 5, "reverse");
    expect(e.primerRole).toBe("reverse");
  });
});

describe("B2 amplicon geometry (Rule 2)", () => {
  const opts = { maxAmpliconSize: 4000, efficientSizeCutoff: 3000 };

  it("predicts an amplicon for opposing strands facing inward within size, with outer 5'-to-5' product size", () => {
    const amps = predictAmplicons([
      { accession: "ACC1", evidence: evidence("plus", 100, 120, true, "forward") },
      { accession: "ACC1", evidence: evidence("minus", 500, 520, true, "reverse") },
    ], opts);
    expect(amps).toHaveLength(1);
    // forward 5'=100, reverse 5'=520 -> 520-100+1 = 421
    expect(amps[0]).toMatchObject({ productSize: 421, risk: "strong", subjectAccession: "ACC1" });
  });

  it("does not predict an amplicon for same-strand co-occurrence", () => {
    expect(predictAmplicons([
      { accession: "ACC1", evidence: evidence("plus", 100, 120, true, "forward") },
      { accession: "ACC1", evidence: evidence("plus", 500, 520, true, "reverse") },
    ], opts)).toHaveLength(0);
  });

  it("does not predict an amplicon when 3' ends face outward", () => {
    // plus 3'=120, minus 3'=50 -> forward 3' downstream of reverse 3' -> outward
    expect(predictAmplicons([
      { accession: "ACC1", evidence: evidence("plus", 100, 120, true, "forward") },
      { accession: "ACC1", evidence: evidence("minus", 50, 70, true, "reverse") },
    ], opts)).toHaveLength(0);
  });

  it("does not predict an amplicon beyond maxAmpliconSize", () => {
    expect(predictAmplicons([
      { accession: "ACC1", evidence: evidence("plus", 100, 120, true, "forward") },
      { accession: "ACC1", evidence: evidence("minus", 5000, 5020, true, "reverse") },
    ], opts)).toHaveLength(0);
  });

  it("classifies a large but amplifiable product as weak risk", () => {
    const amps = predictAmplicons([
      { accession: "ACC1", evidence: evidence("plus", 100, 120, true, "forward") },
      { accession: "ACC1", evidence: evidence("minus", 3600, 3620, true, "reverse") },
    ], opts);
    expect(amps).toHaveLength(1);
    expect(amps[0]).toMatchObject({ productSize: 3521, risk: "weak" });
  });

  it("ignores non-amplification-competent bindings", () => {
    expect(predictAmplicons([
      { accession: "ACC1", evidence: evidence("plus", 100, 120, true, "forward") },
      { accession: "ACC1", evidence: evidence("minus", 500, 520, false, "reverse") },
    ], opts)).toHaveLength(0);
  });

  it("keeps input primer role visible for same-primer self-priming evidence", () => {
    const amps = predictAmplicons([
      { accession: "ACC1", evidence: evidence("plus", 100, 120, true, "forward") },
      { accession: "ACC1", evidence: evidence("minus", 500, 520, true, "forward") },
    ], opts);
    expect(amps).toHaveLength(1);
    expect(amps[0].forwardBinding.primerRole).toBe("forward");
    expect(amps[0].reverseBinding.primerRole).toBe("forward");
  });
});

describe("B2 intended-target exclusion (Rule 3)", () => {
  const base: PredictedAmplicon = {
    subjectAccession: "ACC_INTENDED", productSize: 500,
    forwardBinding: evidence("plus", 1, 20), reverseBinding: evidence("minus", 480, 500),
    isIntendedTarget: false, risk: "strong",
  };

  it("marks the intended product but keeps a second off-target amplicon on the same accession", () => {
    const marked = markIntendedTarget(
      [base, { ...base, productSize: 1200 }],
      { accession: "ACC_INTENDED", expectedProductSize: 500 },
      10,
    );
    expect(marked[0].isIntendedTarget).toBe(true);   // size 500 within tolerance
    expect(marked[1].isIntendedTarget).toBe(false);  // size 1200 -> still counts
  });
});

describe("B2 verdict", () => {
  const amp = (risk: "strong" | "weak"): PredictedAmplicon => ({
    subjectAccession: "A", productSize: 500,
    forwardBinding: evidence("plus", 1, 20), reverseBinding: evidence("minus", 480, 500),
    isIntendedTarget: false, risk,
  });
  it("specific when no off-target amplicons", () => expect(classifyVerdict([])).toBe("specific"));
  it("high_off_target_risk when a strong amplicon exists", () => expect(classifyVerdict([amp("strong")])).toBe("high_off_target_risk"));
  it("low_risk when only weak amplicons exist", () => expect(classifyVerdict([amp("weak")])).toBe("low_risk"));
});

describe("B2 orchestration (injected transport)", () => {
  const forwardSeq = "ACGTACGTACGTACGTACGT";
  const reverseSeq = "TTTTCCCCGGGGAAAATTTT";

  function resultJson(seq: string, accession: string, hitFrom: number, hitTo: number, strand: "Plus" | "Minus"): string {
    return JSON.stringify({
      BlastOutput2: [{ report: {
        program: "blastn", version: "BLASTN 2.17.0+", search_target: { db: "core_nt" },
        params: { expect: 1000, sc_match: 1, sc_mismatch: -3, gap_open: 5, gap_extend: 2 },
        results: { search: { query_id: "Q", query_title: "p", query_len: seq.length,
          hits: [{ num: 1, description: [{ id: "x", accession, title: `Vector ${accession}`, taxid: 1, sciname: "synthetic construct" }],
            len: 9000, hsps: [{ num: 1, bit_score: 40, score: 20, evalue: 0.02, identity: seq.length, query_from: 1, query_to: seq.length,
              query_strand: "Plus", hit_from: hitFrom, hit_to: hitTo, hit_strand: strand, align_len: seq.length, gaps: 0,
              qseq: seq, hseq: seq, midline: "|".repeat(seq.length) }] }] } } } }],
    });
  }

  it("returns high_off_target_risk with one strong amplicon from opposing bindings", async () => {
    const result = await validatePrimerSpecificity(
      { forwardSequence: forwardSeq, reverseSequence: reverseSeq },
      {
        email: "test@example.com",
        sleepSeconds: async () => undefined,
        transport: async (req) => {
          const query = (req.params.QUERY as string) ?? "";
          if (req.params.CMD === "Put") return query.includes(forwardSeq) ? "RID = FWDRID\nRTOE = 1\n" : "RID = REVRID\nRTOE = 1\n";
          if (req.params.FORMAT_OBJECT === "SearchInfo") return "Status=READY\n";
          return req.params.RID === "FWDRID"
            ? resultJson(forwardSeq, "ACC1", 100, 120, "Plus")   // forward primer, plus strand
            : resultJson(reverseSeq, "ACC1", 520, 500, "Minus"); // reverse primer, minus strand
        },
      },
    );
    expect(result.verdict).toBe("high_off_target_risk");
    expect(result.predictedAmplicons).toHaveLength(1);
    expect(result.predictedAmplicons[0]).toMatchObject({ subjectAccession: "ACC1", productSize: 421, risk: "strong" });
    expect(result.predictedAmplicons[0].forwardBinding.primerRole).toBe("forward");
    expect(result.predictedAmplicons[0].reverseBinding.primerRole).toBe("reverse");
    expect(result.nextAction.tool).toBe("manual_review");
    expect(result.evidence.blastRidByPrimer).toMatchObject({ forward: "FWDRID", reverse: "REVRID" });
  });

  it("returns inconclusive/blast_timeout when a primer search never resolves", async () => {
    const result = await validatePrimerSpecificity(
      { forwardSequence: forwardSeq, reverseSequence: reverseSeq },
      {
        email: "test@example.com",
        sleepSeconds: async () => undefined,
        maxWaitSeconds: 120,
        transport: async (req) => {
          if (req.params.CMD === "Put") return "RID = SLOWRID\nRTOE = 1\n";
          if (req.params.FORMAT_OBJECT === "SearchInfo") return "Status=WAITING\n";
          return "{}";
        },
      },
    );
    expect(result.verdict).toBe("inconclusive");
    expect(result.inconclusiveReason).toBe("blast_timeout");
    expect(result.evidence.blastRidByPrimer.forward).toBe("SLOWRID");
    expect(result.nextAction.tool).toBe("manual_review");
  });

  it("rejects ambiguous primer bases before BLAST submission", async () => {
    await expect(validatePrimerSpecificity(
      { forwardSequence: "ACGTACGTACGTACGTACGN", reverseSequence: reverseSeq },
      { email: "test@example.com", transport: async () => { throw new Error("should not call BLAST"); } },
    )).rejects.toMatchObject({
      code: "AMBIGUOUS_SEQUENCE",
      details: { label: "forwardSequence" },
    });
  });

  it("rejects intendedTarget moleculeId without accession because BLAST subjects use accessions", async () => {
    await expect(validatePrimerSpecificity(
      {
        forwardSequence: forwardSeq,
        reverseSequence: reverseSeq,
        intendedTarget: { moleculeId: "mol_target", expectedProductSize: 421 },
      },
      { email: "test@example.com", transport: async () => { throw new Error("should not call BLAST"); } },
    )).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { moleculeId: "mol_target" },
    });
  });
});
