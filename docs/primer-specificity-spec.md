# Primer Specificity Spec (B2 `validate_primer_specificity`)

Status: draft spec. No implementation until reviewed. Fixture-first: B2 does not
start until a short-query BLAST fixture is captured (see "Fixture Requirement").

This document specs B2 `validate_primer_specificity`. It builds on B1
`blast_sequence` (see `docs/blast-validation-spec.md`) but is a distinct
capability: B1 is a general homology search and parser contract; B2 is an
off-target amplicon prediction algorithm that consumes BLAST.

## Why This Is Not "B1 Twice"

Running B1 on the forward primer and again on the reverse primer produces two
raw hit lists. That is evidence, not an answer. The product value -- the
Primer-BLAST-equivalent capability -- is the verdict: given a primer pair, does
it amplify anything other than the intended target? That requires predicting
off-target amplicons from paired primer bindings, which is biology the raw hit
lists do not provide.

The naive design ("both primers hit the same subject -> risk") is wrong and
would flag almost every pair as high risk, because primers are short and hit
many subjects. Two rules below prevent that.

## Agent Workflow

```text
design_primers
-> validate_primer_specificity   (B2: BLAST each primer, predict off-target amplicons, classify)
-> upsert_primer                 (if verdict is specific / acceptable)
   OR manual_review              (if verdict is high_off_target_risk / inconclusive)
```

This mirrors a biologist's NCBI Primer-BLAST habit while keeping Primer3 as the
local design engine (B1/B2 are the BLAST validation layer) and full provenance
in the workspace.

## Input

```ts
type ValidatePrimerSpecificityInput = {
  workspacePath?: string;         // required if primer IDs or moleculeId are used
  // Provide the pair as persisted primer IDs OR as raw sequences, not both:
  forwardPrimerId?: string;
  reversePrimerId?: string;
  forwardSequence?: string;       // raw 5'->3' forward primer
  reverseSequence?: string;       // raw 5'->3' reverse primer
  intendedTarget?: {
    moleculeId?: string;          // workspace molecule the pair is designed against
    accession?: string;          // known subject accession of the intended template
    expectedProductSize?: number; // intended amplicon size, if known
  };
  database?: "nt" | "refseq_select"; // default nt
  maxAmpliconSize?: number;       // default 4000; products larger than this are not counted
  threePrimeWindow?: number;      // default 5; 3' bases that must match to be amplification-competent
  hitlistSize?: number;           // default 50 (short queries return many hits)
  eValueThreshold?: number;       // default 1000 (short queries have high E-values; see BLAST Parameters)
  maxEvaluatedBindings?: number;  // default 100; per-primer cap on competent bindings before inconclusive
};
```

Validation rules:

- Exactly one of (`forwardPrimerId` + `reversePrimerId`) or
  (`forwardSequence` + `reverseSequence`) must be provided. Mixed or partial
  pairs return `INVALID_ARGUMENT`.
- Primer sequences must be unambiguous nucleotides. Reject ambiguity codes with
  `INVALID_ARGUMENT` (matches the workspace unambiguous-sequence policy).
- If primer IDs are given, `workspacePath` is required and the primers must
  exist. Missing primer -> `PRIMER_NOT_FOUND`.
- `program` is fixed to `blastn` for B2 (primers are nucleotide). It is not a
  caller input.

## The Biology B2 Must Encode

### Rule 1: Amplification competence is a 3'-end property

A primer with mismatches in its 5' region can still prime if its 3' end matches;
a single mismatch at the 3'-terminal base usually blocks extension even with a
perfect 5' match. So B2 classifies each primer binding by its 3' end, not by
E-value or overall identity.

A binding is **amplification-competent** when:

- the 3'-terminal base matches the subject, and
- there is no mismatch within the last `threePrimeWindow` (default 5) bases.

Record, per binding: `threePrimeMatchLength` (contiguous matched bases counted
from the 3' end) and total `mismatches`. Bindings that are not
amplification-competent are retained as evidence but do not form amplicons.

#### Required internal data: raw HSP alignment

3'-end competence cannot be derived from B1's summarized output. Identity percent
and coordinates do not reveal WHERE the mismatches fall relative to the primer's
3' end -- and 3'-terminal mismatches are exactly what determine competence. B2
therefore consumes the raw HSP `qseq`, `hseq`, and `midline` strings (from the
raw BLAST JSON artifact, or via an internal parser mode that retains them), walks
the alignment inward from the primer's 3' terminus, and computes
`threePrimeMatchLength`, `mismatches`, and `amplificationCompetent`.

This does not weaken B1's envelope. B1's agent-facing output still omits
`qseq`/`hseq`/`midline`. The raw strings are an internal input to B2 only; the B2
envelope exposes derived evidence, never raw alignment. Concretely: add an
internal parser mode (e.g. `parseBlastJson2(raw, { retainAlignmentStrings: true })`)
used only by B2; the default agent-facing parse stays summarized.

### Rule 2: An amplicon is a geometry, not a co-occurrence

An off-target amplicon is predicted only when, on the SAME subject:

- one primer binds amplification-competently on the plus strand (forward-competent),
- the other binds amplification-competently on the minus strand (reverse-competent),
- their 3' ends point TOWARD each other, and
- the distance between the outer 5' ends is <= `maxAmpliconSize`.

`productSize` is that distance. Same-strand co-occurrence, outward-facing 3'
ends, or distance beyond `maxAmpliconSize` are NOT amplicons. Either primer may
act as the forward or reverse binder (a single primer binding two opposing
nearby sites can self-prime an amplicon); enumerate all competent pairings.

#### Coordinate normalization and 3' subject position

BLAST reports `hit_from`/`hit_to` in alignment order, so on a minus-strand hit
`hit_from > hit_to`. Normalize before any geometry math:

- `subjectStart = min(hit_from, hit_to)`
- `subjectEnd = max(hit_from, hit_to)`

Locate the primer's 3' terminus on the subject by role and strand:

- forward-competent (plus strand): the primer 3' end is at `subjectEnd`, pointing
  downstream (increasing coordinate).
- reverse-competent (minus strand): the primer 3' end is at `subjectStart`,
  pointing upstream (decreasing coordinate).

"3' ends facing inward" means the forward binding's 3' position is less than the
reverse binding's 3' position, with `productSize = reverse3Prime - forward3Prime + 1`.
Use these normalized positions, never raw `hit_from`/`hit_to`, for distance and
orientation.

### Rule 3: Intended-target exclusion is per-amplicon, not per-accession

If `intendedTarget` is provided, mark the intended product as
`isIntendedTarget: true` and exclude it from the off-target verdict. Match the
intended amplicon by accession/moleculeId AND product size within tolerance
(default +/- 10 bp), not by accession alone -- a primer pair can mis-prime
elsewhere on the intended molecule, and those amplicons must still count.

## Output

```ts
type PredictedAmplicon = {
  subjectAccession: string;
  subjectTitle?: string;
  productSize: number;
  forwardBinding: PrimerBindingEvidence;
  reverseBinding: PrimerBindingEvidence;
  isIntendedTarget: boolean;
  risk: "strong" | "weak";        // strong = both bindings competent at full 3' window
};

type PrimerBindingEvidence = {
  start: number;
  end: number;
  strand: "plus" | "minus";
  threePrimeMatchLength: number;
  mismatches: number;
  amplificationCompetent: boolean;
};

type PrimerSpecificityResult = {
  primerPairId?: string;
  forwardPrimerId?: string;
  reversePrimerId?: string;
  intendedTarget?: { moleculeId?: string; accession?: string };
  verdict: "specific" | "low_risk" | "high_off_target_risk" | "inconclusive";
  inconclusiveReason?: "blast_timeout" | "excessive_low_specificity_hits" | "query_rejected";
  predictedAmplicons: PredictedAmplicon[];   // off-target only; intended excluded from verdict
  evidence: {
    forwardHitCount: number;
    reverseHitCount: number;
    blastRidByPrimer: Record<string, string>; // primer role/id -> RID, for resume on timeout
    parameters: Record<string, unknown>;      // database, maxAmpliconSize, threePrimeWindow, E-value, hitlistSize
  };
  nextAction: {
    tool: "upsert_primer" | "manual_review";
    arguments: Record<string, unknown>;
  };
};
```

The envelope carries only derived evidence. B2 consumes raw HSP alignment
strings internally to compute 3'-end competence (see "Required internal data")
but never surfaces `qseq`/`hseq`/`midline` in this output.

## Verdict Classification

Applied after intended-target exclusion:

| Verdict | Condition |
|---|---|
| `specific` | Zero off-target amplicons. |
| `low_risk` | Off-target amplicons exist, but every one is `risk: "weak"` -- at least one binding is not competent at the full 3' window, or `productSize` is in the low-efficiency range (default > 3000 bp). |
| `high_off_target_risk` | At least one off-target amplicon with `risk: "strong"` (both bindings competent at the full 3' window) and `productSize` in the efficient range (default <= 3000 bp). |
| `inconclusive` | BLAST for one or both primers did not resolve (timeout, RID returned but not READY), the short-query search returned too many low-specificity hits to evaluate (over `hitlistSize` with no competent bindings), or NCBI rejected the query. Set `inconclusiveReason`. |

Numeric defaults (`threePrimeWindow` 5, `maxAmpliconSize` 4000, efficient-size
cutoff 3000) are parameters, not hardcoded magic; stamp the values used into
`evidence.parameters`. Do not silently repair a risky pair or reinterpret a
verdict -- report it and route via `nextAction`.

## Inconclusive And Timeout Handling

B2 issues TWO BLAST submissions (forward and reverse); each can take up to ~1
hour and may time out. Follow B1's rule: do not auto-retry; return the RID. If
either primer's search is unresolved, verdict is `inconclusive` with
`inconclusiveReason: "blast_timeout"`, and `evidence.blastRidByPrimer` carries
both RIDs so the agent or a later call can resume from the results.

`inconclusive` is distinct from `specific`: "could not evaluate" must never be
reported as "no off-target found."

### Binding cap (runtime safety)

Amplicon enumeration is O(forward bindings x reverse bindings) per subject. A
short-query flood can make this explode. If either primer yields more than
`maxEvaluatedBindings` (default 100) amplification-competent bindings, stop and
return `inconclusive` with `inconclusiveReason: "excessive_low_specificity_hits"`
rather than attempting the full pairing. This bounds runtime and is the same
signal as a genuinely non-specific primer -- both warrant manual review.

## BLAST Parameters (short query)

Primers are ~18-25 nt. Ordinary `blastn` (megablast, word size 28) will not seed
a 20 nt query. B2 must submit explicit short-query parameters, per NCBI's URL API
and the BLASTN manual's `blastn-short` task:

```text
SHORT_QUERY_ADJUST=true
WORD_SIZE=7
FILTER=F
```

Do not rely on `SHORT_QUERY_ADJUST` alone mapping to the right word size. The
fixture capture confirms these live, but the spec commits to the documented
values. Short queries produce many hits with high E-values (query length drives
the E-value statistic), so B2 defaults to a permissive `eValueThreshold` (1000)
and a larger `hitlistSize` (50). E-value here is a retrieval filter, not the
specificity signal -- the verdict comes from 3'-end competence plus amplicon
geometry.

## nextAction Behavior

- `specific` or `low_risk`: `nextAction.tool = "upsert_primer"` (if IDs were not
  already persisted) with the pair arguments, so the agent can persist a
  validated primer.
- `high_off_target_risk` or `inconclusive`: `nextAction.tool = "manual_review"`
  with a summary of the blocking amplicons or the inconclusive reason. Do not
  auto-persist a risky pair.

## Errors

| Code | Trigger |
|---|---|
| `INVALID_ARGUMENT` | Mixed/partial pair, ambiguous primer bases, both IDs and sequences given |
| `PRIMER_NOT_FOUND` | A referenced primer ID is not in the workspace |
| `MOLECULE_NOT_FOUND` | `intendedTarget.moleculeId` is not in the workspace |
| `PARSE_ERROR` | BLAST response could not be parsed (delegated to the B1 parser) |
| `NCBI_UNAVAILABLE` | Network/transport failure reaching NCBI (live path only) |

## Fixture Requirement (gate)

B2 does not start until one short-query BLAST fixture is captured and frozen,
the same discipline as B1:

- Query: one real ~20-25 nt primer, not the 300 bp B1 window.
- Settings: short-query (`SHORT_QUERY_ADJUST=true`, `WORD_SIZE=7`, `FILTER=F`),
  captured verbatim.
- Save under `fixtures/blast/<primer-fixture-id>/` with the same layout as B1
  (`query.fa`, `put-response.txt`, `status-*.txt`, `result.json`,
  `metadata.json`), redacted, with DB provenance in `metadata.json`.
- The fixture must exhibit the "many short hits" reality so the parser and the
  `excessive_low_specificity_hits` path are testable offline.

Capture is manual and out of CI (network + email), like B1.

## Test Contract (offline, no live BLAST in CI)

Amplicon-prediction logic is pure and must be unit-tested independently of the
network, using injected/frozen BLAST results:

- 3'-end competence: a binding with a 3'-terminal mismatch is not competent; a
  binding with only 5' mismatches within tolerance is competent.
- Amplicon geometry: opposing strands within `maxAmpliconSize` form an amplicon;
  same-strand, outward-facing, or over-distance do not.
- Intended-target exclusion: the intended product is excluded, but a second
  amplicon on the intended molecule still counts.
- Verdict thresholds: strong vs weak amplicon -> `high_off_target_risk` vs
  `low_risk`; zero -> `specific`.
- Inconclusive: unresolved RID -> `inconclusive` + `blast_timeout`, RIDs present
  in evidence; hit-flood -> `excessive_low_specificity_hits`.
- Envelope carries no raw alignment strings.

Use the frozen short-query fixture for the parser/client boundary and
handcrafted BLAST results (like the empty-hits fixture) for the amplicon-logic
edge cases, so no case depends on a live NCBI call.

## Scope Boundaries

| Feature | B2 v1 | Deferred |
|---|---|---|
| Paired-primer off-target amplicon prediction | yes | -- |
| 3'-end competence classification | yes | -- |
| Intended-target per-amplicon exclusion | yes | -- |
| Self-priming amplicon (one primer both ends) | yes | -- |
| Thermodynamic Tm/dG of mismatched duplex | no | later (needs a nearest-neighbor model) |
| Hairpin / primer-dimer prediction | no | separate tool |
| Multiplex (>2 primers) specificity | no | later |
| Local/custom BLAST database | no | later |

## Guardrails Carried Forward

- No fallback that "fixes" a risky pair or reinterprets a verdict. Report and
  route via `nextAction`.
- No live BLAST in CI. The live transport is manual/opt-in, like the B1 capture
  helper; tests use frozen fixtures and injected transports.
- Reuse the B1 client (`runNcbiBlast`) and parser (`parseBlastJson2`); B2 adds
  only the amplicon-prediction and classification layer on top.
- Agent-facing structured errors, not human prose.
- Prose in this repo is ASCII: `->`, `--`, "section N".
