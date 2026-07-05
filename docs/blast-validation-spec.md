# BLAST Validation Spec

This document scopes B1 `blast_sequence` and B2 `validate_primer_specificity`.

## Why BLAST Belongs Here

Traditional wet labs say "we use NCBI BLAST, not Primer3." They mean they use
NCBI Primer-BLAST, which runs Primer3 internally for design then BLAST for
off-target specificity. Primer3 remains the local design engine. BLAST is the
missing specificity-validation layer.

The complete agent primer workflow:

```text
design_primers (Primer3, local)
-> simulate_pcr (local construct check)
-> validate_primer_specificity (NCBI BLAST, off-target check)
-> upsert_primer (if assessment passes)
```

This is equivalent to a biologist's Primer-BLAST habit, with full provenance in
the workspace.

## NCBI BLAST URL API Implementation Notes

BLAST via NCBI is asynchronous:

```text
Step 1: PUT request to blast.ncbi.nlm.nih.gov/blast/Blast.cgi
        -> returns Request ID (RID) and estimated wait time
Step 2: Poll GET with RID until STATUS=READY or FAILED or UNKNOWN
Step 3: GET results in JSON or XML format
```

The agent-facing tool hides this. `blast_sequence` submits, polls with
backoff, and returns structured results synchronously from the agent's
perspective.

Implementation constraints:
- Require `NCBI_BLAST_API_KEY` environment variable for production use.
  Without it, NCBI rate-limits to 3 requests/second. With it, 10/second.
- Polling interval: start at 5 seconds, increase to 15 seconds after 30
  seconds of waiting.
- Max wait: 120 seconds. Return `BLAST_TIMEOUT` structured error if exceeded.
- RID is always returned even on timeout so the user can check NCBI manually.
- Do not retry automatically on timeout. Let the agent decide.

If `NCBI_BLAST_API_KEY` is not set, `blast_sequence` should still work but
include a `rateLimit: "unauthenticated"` field in the result to make the
constraint visible.

## B1: `blast_sequence`

### Input

```ts
type BlastSequenceInput = {
  workspacePath?: string;
  moleculeId?: string;    // if provided, queries the workspace molecule sequence
  sequence?: string;      // raw sequence string (alternative to moleculeId)
  database: "nt" | "nr" | "refseq_rna" | "refseq_select";
  program: "blastn" | "blastp" | "blastx" | "tblastn";
  hitlistSize?: number;    // default 10, max 100
  eValueThreshold?: number; // default 0.001
  entrezQuery?: string;    // NCBI Entrez filter, e.g. "Homo sapiens[Organism]"
  outputPath?: string;     // workspace-relative path for JSON artifact
};
```

Exactly one of `moleculeId` or `sequence` must be provided. If `moleculeId` is
given, `workspacePath` is required.

`database` and `program` combinations:

| Program | Suitable databases |
|---|---|
| blastn | nt, refseq_select |
| blastp | nr |
| blastx | nr |
| tblastn | nt, refseq_rna |

Reject incompatible combinations with `INVALID_ARGUMENT`.

### Output

```ts
type BlastHit = {
  accession: string;
  title: string;
  taxId?: number;
  organism?: string;
  alignments: BlastAlignment[];
};

type BlastAlignment = {
  identityPercent: number;    // 0-100
  coveragePercent: number;    // query coverage, 0-100
  eValue: number;
  bitScore: number;
  alignedLength: number;
  queryStart: number;         // 1-based
  queryEnd: number;           // 1-based
  subjectStart: number;       // 1-based
  subjectEnd: number;         // 1-based
  strand: "plus" | "minus" | null;  // null for protein programs
};

type BlastSequenceResult = {
  queryId: string;            // moleculeId or "raw_sequence"
  queryLength: number;
  queryDigest: string;        // SHA-256 of the query sequence for provenance
  database: string;
  program: string;
  parameters: {
    hitlistSize: number;
    eValueThreshold: number;
    entrezQuery?: string;
  };
  rid: string;                // NCBI Request ID — always present
  submittedAt: string;        // ISO 8601
  completedAt: string;        // ISO 8601
  rateLimit: "authenticated" | "unauthenticated";
  hits: BlastHit[];
  hitsTruncated: boolean;     // true if database has more hits than hitlistSize
  ncbiUrl: string;            // https://blast.ncbi.nlm.nih.gov/Blast.cgi?RID=<rid>&CMD=Get
};
```

The `queryDigest` + `rid` + `submittedAt` together form the provenance record
an agent can include in a replay bundle.

### Artifact

`blast_sequence` writes a JSON artifact containing the full result:

```text
reports/blast/<queryId>.<program>.<database>.<timestamp>.json
```

Returns:

```ts
artifacts: [{
  kind: "blast_result",
  mimeType: "application/json",
  path: "...",
  description: "NCBI BLAST result for <queryId> against <database>."
}]
```

### Error Codes

| Code | Condition |
|---|---|
| `INVALID_ARGUMENT` | Incompatible program+database, missing sequence+moleculeId, invalid hitlistSize |
| `DEPENDENCY_MISSING` | No network access or NCBI endpoint unreachable |
| `BLAST_TIMEOUT` | NCBI did not return results within 120 seconds; RID included in error details |
| `BLAST_FAILED` | NCBI returned STATUS=FAILED; RID and reason in error details |

### CLI

```bash
molecule-biology blast-sequence \
  <workspacePath> \
  --molecule-id mol_my_construct \
  --database nt \
  --program blastn \
  --hitlist-size 20 \
  --entrez-query "Homo sapiens[Organism]"

# Raw sequence form:
molecule-biology blast-sequence \
  --sequence ACGTACGTACGT \
  --database nt \
  --program blastn
```

## B2: `validate_primer_specificity`

### Biological Review

A primer is specific if it does not produce significant off-target amplicons
in the target organism's genome. BLAST identifies binding sites; off-target
amplification risk arises when a forward primer hit and a reverse primer hit
are in opposite orientations within an amplifiable distance.

B2 does not implement full Primer-BLAST in-silico PCR. It BLASTs each primer
individually and flags potential off-target binding based on:

1. Hits with identity above `minIdentityPercent` (default 90%).
2. If both a forward and reverse primer hit the same accession within
   `maxAmpliconSize` bp in opposing orientations, flag as potential off-target
   amplification.

### Input

```ts
type ValidatePrimerSpecificityInput = {
  workspacePath: string;
  primerIds: string[];           // IDs of persisted primers to check
  database: "nt" | "refseq_select";
  organism?: string;             // e.g. "Homo sapiens" — prepended to entrezQuery
  minIdentityPercent?: number;   // default 90, threshold for flagging a hit
  maxAmpliconSize?: number;      // default 5000, for off-target amplicon prediction
  pairIds?: [string, string][];  // optional: forward+reverse pairs to check together
  intendedTarget?: {
    accession?: string;          // NCBI accession of the intended template; excluded from off-target count
    moleculeId?: string;         // workspace molecule ID of the intended template
    expectedAmplicon?: {
      start: number;             // 1-based expected amplicon start on the intended target
      end: number;               // 1-based expected amplicon end on the intended target
    };
  };
  outputPath?: string;
};
```

### Output

```ts
type PrimerSpecificityAssessment = "likely_specific" | "potential_off_targets" | "high_off_target_risk";

type PrimerSpecificityResult = {
  primerId: string;
  sequence: string;
  assessment: PrimerSpecificityAssessment;
  significantHits: BlastHit[];   // hits above minIdentityPercent
  rid: string;
  ncbiUrl: string;
};

type PairAmpliconWarning = {
  forwardPrimerId: string;
  reversePrimerId: string;
  accession: string;
  predictedAmpliconSize: number;
  forwardHitStart: number;
  reverseHitStart: number;
};

type ValidatePrimerSpecificityResult = {
  primerResults: PrimerSpecificityResult[];
  pairWarnings: PairAmpliconWarning[];
  database: string;
  organism?: string;
  submittedAt: string;
  completedAt: string;
};
```

Assessment logic:

```text
likely_specific:
  No hits with identity >= minIdentityPercent other than hits to the
  intendedTarget accession or moleculeId (if provided).

potential_off_targets:
  1-3 hits above threshold (excluding intendedTarget), none forming a
  predicted off-target amplicon with a paired primer within maxAmpliconSize.

high_off_target_risk:
  Any hit forming a predicted off-target amplicon, OR more than 3 hits above
  threshold (excluding intendedTarget).
```

### CLI

```bash
molecule-biology validate-primer-specificity \
  <workspacePath> \
  --primer-ids primer_fwd,primer_rev \
  --database refseq_select \
  --organism "Homo sapiens" \
  --pair-ids primer_fwd:primer_rev
```

### Agent Workflow

```text
design_primers -> simulate_pcr -> validate_primer_specificity -> upsert_primer
```

The `validate_primer_specificity` result should be included in the replay
bundle. If `assessment: "high_off_target_risk"`, the nextAction should be:

```ts
nextAction: {
  tool: "manual_review";
  instruction: "High off-target risk detected. Review BLAST hits before calling upsert_primer.";
}
```

## Scope Boundaries

| Feature | B1 | B2 | Deferred |
|---|---:|---:|---:|
| blastn (nucleotide query) | yes | via B1 | no |
| blastp / blastx (protein) | yes | no | later |
| Primer off-target BLAST | no | yes | no |
| Predicted off-target amplicon from pair | no | yes | no |
| cas-offinder CRISPR genome-scale | no | no | CR-series |
| Local FASTA database | no | no | later |
| Primer Tm / hairpin recheck | no | no | W2 already covers design |

## Gating Rule

Do not start B1 implementation until:

1. NCBI BLAST URL API async pattern (RID polling, backoff, timeout) is
   implemented and tested with a mock server. Network calls in tests must be
   skipped or use a recorded fixture.
2. Provenance schema above is confirmed final. The `queryDigest` + `rid` +
   `submittedAt` triple must be stable before the first real workspace writes it.
3. Rate-limit handling is agreed: unauthenticated fallback vs. hard require API
   key.
4. One live blastn query against `nt` or `refseq_select` has been executed and
   the raw RID, status-poll response, and result response saved as a test
   fixture. Without this, the async pattern is coded blindly against NCBI's
   actual API behavior.
