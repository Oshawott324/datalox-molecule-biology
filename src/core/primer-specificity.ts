import {
  DEFAULT_NCBI_BLAST_TOOL,
  runNcbiBlast,
  type NcbiBlastTransport,
} from "./blast-client.js";
import { parseBlastJson2, type BlastAlignment, type BlastParsedResult } from "./blast-parse.js";
import { readWorkspace } from "./workspace.js";
import { MoleculeError } from "./errors.js";
import { assertUnambiguousDnaSequence, normalizeSequence } from "./sequence.js";

// B2 validate_primer_specificity. See docs/primer-specificity-spec.md.
//
// The verdict is driven by two biological rules, not by identity percent or
// E-value (which cannot discriminate perfect short hits):
//   Rule 1 -- amplification competence is a 3'-end property.
//   Rule 2 -- an amplicon is a geometry (opposing strands, 3' ends facing
//             inward, within an amplicon distance).

export type PrimerStrand = "plus" | "minus";
export type PrimerRole = "forward" | "reverse";

export type PrimerBindingEvidence = {
  primerRole: PrimerRole;
  start: number;              // normalized subject start (min of hit_from/hit_to)
  end: number;                // normalized subject end (max)
  strand: PrimerStrand;
  threePrimeMatchLength: number;
  mismatches: number;
  amplificationCompetent: boolean;
};

export type PredictedAmplicon = {
  subjectAccession: string;
  subjectTitle?: string;
  productSize: number;
  forwardBinding: PrimerBindingEvidence;
  reverseBinding: PrimerBindingEvidence;
  isIntendedTarget: boolean;
  risk: "strong" | "weak";
};

export type PrimerSpecificityVerdict = "specific" | "low_risk" | "high_off_target_risk" | "inconclusive";

export type PrimerSpecificityResult = {
  primerPairId?: string;
  forwardPrimerId?: string;
  reversePrimerId?: string;
  intendedTarget?: { moleculeId?: string; accession?: string };
  verdict: PrimerSpecificityVerdict;
  inconclusiveReason?: "blast_timeout" | "excessive_low_specificity_hits" | "query_rejected";
  predictedAmplicons: PredictedAmplicon[];
  evidence: {
    forwardHitCount: number;
    reverseHitCount: number;
    blastRidByPrimer: Record<string, string>;
    parameters: Record<string, unknown>;
  };
  nextAction: {
    tool: "upsert_primer" | "manual_review";
    arguments: Record<string, unknown>;
  };
};

export type ValidatePrimerSpecificityInput = {
  workspacePath?: string;
  forwardPrimerId?: string;
  reversePrimerId?: string;
  forwardSequence?: string;
  reverseSequence?: string;
  intendedTarget?: {
    moleculeId?: string;
    accession?: string;
    expectedProductSize?: number;
  };
  database?: "nt" | "refseq_select";
  maxAmpliconSize?: number;
  threePrimeWindow?: number;
  hitlistSize?: number;
  eValueThreshold?: number;
  maxEvaluatedBindings?: number;
  efficientSizeCutoff?: number;
};

export type ValidatePrimerSpecificityDeps = {
  transport?: NcbiBlastTransport;
  sleepSeconds?: (seconds: number) => Promise<void>;
  email?: string;
  tool?: string;
  maxWaitSeconds?: number;
};

const DEFAULTS = {
  database: "nt" as const,
  maxAmpliconSize: 4000,
  threePrimeWindow: 5,
  hitlistSize: 50,
  eValueThreshold: 1000,
  maxEvaluatedBindings: 100,
  efficientSizeCutoff: 3000,
  intendedProductTolerance: 10,
};

// --- Rule 1: 3'-end competence (pure) ---------------------------------------

export function computeBindingEvidence(
  alignment: BlastAlignment,
  primerLength: number,
  threePrimeWindow: number,
  primerRole: PrimerRole = "forward",
): PrimerBindingEvidence {
  const { qseq, hseq } = alignment;
  if (qseq === undefined || hseq === undefined) {
    throw new MoleculeError("INTERNAL_ERROR", "3' competence requires retained alignment strings.", {});
  }
  const strand: PrimerStrand = alignment.strand === "minus" ? "minus" : "plus";
  const start = Math.min(alignment.subjectStart, alignment.subjectEnd);
  const end = Math.max(alignment.subjectStart, alignment.subjectEnd);

  let mismatches = 0;
  for (let i = 0; i < qseq.length; i += 1) {
    if (qseq[i] !== hseq[i]) mismatches += 1;
  }

  // The primer is the query; its 3' terminus is the right end of qseq (query is
  // written 5'->3', so query_to is on the right for both subject strands).
  let threePrimeMatchLength = 0;
  for (let i = qseq.length - 1; i >= 0; i -= 1) {
    if (qseq[i] !== "-" && hseq[i] !== "-" && qseq[i] === hseq[i]) threePrimeMatchLength += 1;
    else break;
  }

  // The 3' terminal base is only actually in the alignment when it reaches the
  // primer's last position. A binding that stops short of the 3' end cannot prime.
  const reachesThreePrimeEnd = alignment.queryEnd === primerLength;
  const amplificationCompetent = reachesThreePrimeEnd && threePrimeMatchLength >= threePrimeWindow;

  return { primerRole, start, end, strand, threePrimeMatchLength, mismatches, amplificationCompetent };
}

// --- Rule 2: amplicon geometry (pure) ---------------------------------------

type SubjectBinding = {
  accession: string;
  subjectTitle?: string;
  evidence: PrimerBindingEvidence;
};

function fivePrimePosition(evidence: PrimerBindingEvidence): number {
  return evidence.strand === "plus" ? evidence.start : evidence.end;
}

function threePrimePosition(evidence: PrimerBindingEvidence): number {
  return evidence.strand === "plus" ? evidence.end : evidence.start;
}

export function predictAmplicons(
  bindings: SubjectBinding[],
  options: { maxAmpliconSize: number; efficientSizeCutoff: number },
): PredictedAmplicon[] {
  const amplicons: PredictedAmplicon[] = [];
  const bySubject = new Map<string, SubjectBinding[]>();
  for (const binding of bindings) {
    if (!binding.evidence.amplificationCompetent) continue; // only competent bindings form amplicons
    const list = bySubject.get(binding.accession) ?? [];
    list.push(binding);
    bySubject.set(binding.accession, list);
  }

  for (const [, subjectBindings] of bySubject) {
    const plus = subjectBindings.filter((b) => b.evidence.strand === "plus");
    const minus = subjectBindings.filter((b) => b.evidence.strand === "minus");
    for (const forward of plus) {
      for (const reverse of minus) {
        // 3' ends must face inward: the plus-strand 3' must be upstream of the minus-strand 3'.
        if (threePrimePosition(forward.evidence) >= threePrimePosition(reverse.evidence)) continue;
        // True amplicon size = outer 5'-to-5' span (forward 5' up to reverse 5').
        const productSize = fivePrimePosition(reverse.evidence) - fivePrimePosition(forward.evidence) + 1;
        if (productSize <= 0 || productSize > options.maxAmpliconSize) continue;
        amplicons.push({
          subjectAccession: forward.accession,
          ...(forward.subjectTitle !== undefined ? { subjectTitle: forward.subjectTitle } : {}),
          productSize,
          forwardBinding: forward.evidence,
          reverseBinding: reverse.evidence,
          isIntendedTarget: false,
          risk: productSize <= options.efficientSizeCutoff ? "strong" : "weak",
        });
      }
    }
  }
  return amplicons;
}

// --- intended-target exclusion (pure) ---------------------------------------

export function markIntendedTarget(
  amplicons: PredictedAmplicon[],
  intendedTarget: ValidatePrimerSpecificityInput["intendedTarget"],
  tolerance: number,
): PredictedAmplicon[] {
  if (intendedTarget?.accession === undefined) return amplicons;
  return amplicons.map((amplicon) => {
    const accessionMatches = amplicon.subjectAccession === intendedTarget.accession;
    const sizeMatches = intendedTarget.expectedProductSize === undefined
      ? true
      : Math.abs(amplicon.productSize - intendedTarget.expectedProductSize) <= tolerance;
    return { ...amplicon, isIntendedTarget: accessionMatches && sizeMatches };
  });
}

// --- verdict (pure) ---------------------------------------------------------

export function classifyVerdict(offTargetAmplicons: PredictedAmplicon[]): "specific" | "low_risk" | "high_off_target_risk" {
  if (offTargetAmplicons.length === 0) return "specific";
  if (offTargetAmplicons.some((amplicon) => amplicon.risk === "strong")) return "high_off_target_risk";
  return "low_risk";
}

// --- orchestration ----------------------------------------------------------

export async function validatePrimerSpecificity(
  input: ValidatePrimerSpecificityInput,
  deps: ValidatePrimerSpecificityDeps = {},
): Promise<PrimerSpecificityResult> {
  const pair = await resolvePrimerPair(input);
  const database = input.database ?? DEFAULTS.database;
  const maxAmpliconSize = positiveInt(input.maxAmpliconSize ?? DEFAULTS.maxAmpliconSize, "maxAmpliconSize");
  const threePrimeWindow = positiveInt(input.threePrimeWindow ?? DEFAULTS.threePrimeWindow, "threePrimeWindow");
  const hitlistSize = positiveInt(input.hitlistSize ?? DEFAULTS.hitlistSize, "hitlistSize");
  const eValueThreshold = input.eValueThreshold ?? DEFAULTS.eValueThreshold;
  const maxEvaluatedBindings = positiveInt(input.maxEvaluatedBindings ?? DEFAULTS.maxEvaluatedBindings, "maxEvaluatedBindings");
  const efficientSizeCutoff = positiveInt(input.efficientSizeCutoff ?? DEFAULTS.efficientSizeCutoff, "efficientSizeCutoff");
  validateIntendedTarget(input.intendedTarget);

  const parameters = {
    database, maxAmpliconSize, threePrimeWindow, hitlistSize, eValueThreshold, maxEvaluatedBindings, efficientSizeCutoff,
  };

  const email = deps.email ?? process.env.NCBI_BLAST_EMAIL;
  if (email === undefined || email.length === 0) {
    throw new MoleculeError("DEPENDENCY_MISSING", "NCBI_BLAST_EMAIL must be set before calling validate_primer_specificity.", {
      env: "NCBI_BLAST_EMAIL",
    });
  }
  const tool = deps.tool ?? process.env.NCBI_BLAST_TOOL ?? DEFAULT_NCBI_BLAST_TOOL;

  const runs: Record<string, { rid: string; parsed: BlastParsedResult; length: number; role: "forward" | "reverse" }> = {};
  const blastRidByPrimer: Record<string, string> = {};
  for (const role of ["forward", "reverse"] as const) {
    const sequence = role === "forward" ? pair.forwardSequence : pair.reverseSequence;
    try {
      const run = await runNcbiBlast({
        sequence,
        database,
        program: "blastn",
        hitlistSize,
        expect: String(eValueThreshold),
        email,
        tool,
        maxWaitSeconds: deps.maxWaitSeconds ?? 120,
        ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
        ...(deps.sleepSeconds !== undefined ? { sleepSeconds: deps.sleepSeconds } : {}),
      });
      blastRidByPrimer[role] = run.rid;
      runs[role] = { rid: run.rid, parsed: parseBlastJson2(run.raw.resultJson, { retainAlignmentStrings: true }), length: sequence.length, role };
    } catch (error) {
      if (error instanceof MoleculeError && error.code === "BLAST_TIMEOUT") {
        const rid = (error.details as { rid?: string } | undefined)?.rid;
        if (rid) blastRidByPrimer[role] = rid;
        return inconclusive(input, pair, "blast_timeout", blastRidByPrimer, parameters);
      }
      throw error;
    }
  }

  // Collect competent bindings from both primers.
  const bindings: SubjectBinding[] = [];
  let forwardHitCount = 0;
  let reverseHitCount = 0;
  for (const role of ["forward", "reverse"] as const) {
    const run = runs[role];
    if (role === "forward") forwardHitCount = run.parsed.hits.length;
    else reverseHitCount = run.parsed.hits.length;
    let competentCount = 0;
    for (const hit of run.parsed.hits) {
      for (const alignment of hit.alignments) {
        const evidence = computeBindingEvidence(alignment, run.length, threePrimeWindow, role);
        if (!evidence.amplificationCompetent) continue;
        competentCount += 1;
        bindings.push({ accession: hit.accession, ...(hit.title !== undefined ? { subjectTitle: hit.title } : {}), evidence });
      }
    }
    if (competentCount > maxEvaluatedBindings) {
      return inconclusive(input, pair, "excessive_low_specificity_hits", blastRidByPrimer, parameters);
    }
  }

  const allAmplicons = markIntendedTarget(
    predictAmplicons(bindings, { maxAmpliconSize, efficientSizeCutoff }),
    input.intendedTarget,
    DEFAULTS.intendedProductTolerance,
  );
  const offTarget = allAmplicons.filter((amplicon) => !amplicon.isIntendedTarget);
  const verdict = classifyVerdict(offTarget);

  return {
    ...pairIds(pair),
    ...(input.intendedTarget ? { intendedTarget: intendedTargetSummary(input.intendedTarget) } : {}),
    verdict,
    predictedAmplicons: offTarget,
    evidence: { forwardHitCount, reverseHitCount, blastRidByPrimer, parameters },
    nextAction: nextActionFor(verdict, pair),
  };
}

function inconclusive(
  input: ValidatePrimerSpecificityInput,
  pair: ResolvedPair,
  reason: NonNullable<PrimerSpecificityResult["inconclusiveReason"]>,
  blastRidByPrimer: Record<string, string>,
  parameters: Record<string, unknown>,
): PrimerSpecificityResult {
  return {
    ...pairIds(pair),
    ...(input.intendedTarget ? { intendedTarget: intendedTargetSummary(input.intendedTarget) } : {}),
    verdict: "inconclusive",
    inconclusiveReason: reason,
    predictedAmplicons: [],
    evidence: { forwardHitCount: 0, reverseHitCount: 0, blastRidByPrimer, parameters },
    nextAction: { tool: "manual_review", arguments: { reason } },
  };
}

function nextActionFor(verdict: PrimerSpecificityVerdict, pair: ResolvedPair): PrimerSpecificityResult["nextAction"] {
  if (verdict === "specific" || verdict === "low_risk") {
    return { tool: "upsert_primer", arguments: { ...pairIds(pair) } };
  }
  return { tool: "manual_review", arguments: { verdict } };
}

// --- primer resolution ------------------------------------------------------

type ResolvedPair = {
  forwardSequence: string;
  reverseSequence: string;
  forwardPrimerId?: string;
  reversePrimerId?: string;
};

function pairIds(pair: ResolvedPair): { forwardPrimerId?: string; reversePrimerId?: string } {
  return {
    ...(pair.forwardPrimerId !== undefined ? { forwardPrimerId: pair.forwardPrimerId } : {}),
    ...(pair.reversePrimerId !== undefined ? { reversePrimerId: pair.reversePrimerId } : {}),
  };
}

function intendedTargetSummary(intendedTarget: NonNullable<ValidatePrimerSpecificityInput["intendedTarget"]>): { moleculeId?: string; accession?: string } {
  return {
    ...(intendedTarget.moleculeId !== undefined ? { moleculeId: intendedTarget.moleculeId } : {}),
    ...(intendedTarget.accession !== undefined ? { accession: intendedTarget.accession } : {}),
  };
}

function validateIntendedTarget(intendedTarget: ValidatePrimerSpecificityInput["intendedTarget"]): void {
  if (intendedTarget === undefined) return;
  if (intendedTarget.moleculeId !== undefined && intendedTarget.accession === undefined) {
    throw new MoleculeError("INVALID_ARGUMENT", "intendedTarget.accession is required when using BLAST-backed primer specificity.", {
      moleculeId: intendedTarget.moleculeId,
    });
  }
}

async function resolvePrimerPair(input: ValidatePrimerSpecificityInput): Promise<ResolvedPair> {
  const hasIds = input.forwardPrimerId !== undefined || input.reversePrimerId !== undefined;
  const hasSequences = input.forwardSequence !== undefined || input.reverseSequence !== undefined;
  if (hasIds === hasSequences) {
    throw new MoleculeError("INVALID_ARGUMENT", "Provide exactly one of (forwardPrimerId + reversePrimerId) or (forwardSequence + reverseSequence).", {});
  }

  if (hasSequences) {
    if (input.forwardSequence === undefined || input.reverseSequence === undefined) {
      throw new MoleculeError("INVALID_ARGUMENT", "Both forwardSequence and reverseSequence are required.", {});
    }
    const forwardSequence = normalizePrimerSequence(input.forwardSequence, "forwardSequence");
    const reverseSequence = normalizePrimerSequence(input.reverseSequence, "reverseSequence");
    return {
      forwardSequence,
      reverseSequence,
    };
  }

  if (input.forwardPrimerId === undefined || input.reversePrimerId === undefined) {
    throw new MoleculeError("INVALID_ARGUMENT", "Both forwardPrimerId and reversePrimerId are required.", {});
  }
  if (input.workspacePath === undefined || input.workspacePath.length === 0) {
    throw new MoleculeError("INVALID_ARGUMENT", "workspacePath is required when primer IDs are provided.", {});
  }
  const workspace = await readWorkspace(input.workspacePath, { checkSequenceDigests: false });
  const forward = findPrimer(workspace.primers, input.forwardPrimerId);
  const reverse = findPrimer(workspace.primers, input.reversePrimerId);
  return {
    forwardSequence: normalizePrimerSequence(forward.sequence, "forwardPrimer.sequence"),
    reverseSequence: normalizePrimerSequence(reverse.sequence, "reversePrimer.sequence"),
    forwardPrimerId: input.forwardPrimerId,
    reversePrimerId: input.reversePrimerId,
  };
}

function findPrimer(primers: Array<{ id: string; sequence: string }>, primerId: string): { id: string; sequence: string } {
  const primer = primers.find((candidate) => candidate.id === primerId);
  if (!primer) {
    throw new MoleculeError("PRIMER_NOT_FOUND", "Primer was not found in the workspace.", { primerId });
  }
  return primer;
}

function positiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new MoleculeError("INVALID_ARGUMENT", `${label} must be a positive integer.`, { [label]: value });
  }
  return value;
}

function normalizePrimerSequence(sequence: string, label: string): string {
  const normalized = normalizeSequence(sequence, "iupac_dna");
  assertUnambiguousDnaSequence(normalized, label);
  return normalized;
}
