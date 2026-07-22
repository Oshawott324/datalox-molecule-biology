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
Step 1: PUT request to https://blast.ncbi.nlm.nih.gov/Blast.cgi
        -> returns Request ID (RID) and estimated wait time (RTOE)
Step 2: Poll GET with RID until STATUS=READY or FAILED or UNKNOWN
Step 3: GET results in JSON or XML format
```

The agent-facing tool hides this. `blast_sequence` submits, polls with
backoff, and returns structured results synchronously from the agent's
perspective.

Implementation constraints (per the NCBI BLAST URL API usage policy):
- **No API key.** The BLAST URL API does not use NCBI API keys; API keys apply
  to E-utilities and the Datasets API, not to `Blast.cgi`. Do not gate the tool
  on an `NCBI_BLAST_API_KEY` or assume a key raises the rate limit.
- Identify the client with the `tool` and `email` URL parameters so NCBI can
  make contact before throttling.
- Do not contact the server more often than once every 10 seconds, and do not
  poll any single RID more often than once per minute. Seed the first wait from
  the `RTOE` estimate in the Put response, then poll on a `>= 60 s` interval.
- Keep submissions modest: NCBI moves users past ~100 searches in 24 hours to a
  slower queue. Run large batches on weekends or 9 pm-5 am Eastern.
- Max wait is a configurable budget (default a few minutes, well above one poll
  interval). On expiry return a `BLAST_TIMEOUT` structured error.
- The RID is always returned even on timeout so the agent or user can retrieve
  results later at the NCBI results URL.
- Do not retry automatically on timeout. Let the agent decide.

## B1: `blast_sequence`

Status: **implemented locally**. The live fixture gate is cleared by
`fixtures/blast/puc19-bla-blastn-nt/`, and automated tests use frozen fixture
bytes only. Live BLAST remains manual/opt-in.

### Live Fixture Capture Helper

The helper below exists only to capture or refresh manual fixtures. It is not
called from CI, from `npm test`, or from the MCP server.

```bash
# Required by NCBI's BLAST URL API usage policy.
export NCBI_BLAST_EMAIL="you@example.com"

npm run fixture:blast:capture -- \
  --fixture-id puc19-bla-blastn-nt \
  --sequence CAATGCTTAATCAGTGAGGCACCTATCTCAGCGATCTGTCTATTTCGTTCATCCATAGTTGCCTGACTCCCCGTCGTGTAGATAACTACGATACGGGAGGGCTTACCATCTGGCCCCAGTGCTGCAATGATACCGCGAGACCCACGCTCACCGGCTCCAGATTTATCAGCAATAAACCAGCCAGCCGGAAGGGCCGAGCGCAGAAGTGGTCCTGCAACTTTATCCGCCTCCATCCAGTCTATTAATTGTTGCCGGGAAGCTAGAGTAAGTAGTTCGCCAGTTAATAGTTTGCGCAACGTT \
  --program blastn \
  --database nt \
  --hitlist-size 5 \
  --expect 0.001
```

On Windows PowerShell:

```powershell
$env:NCBI_BLAST_EMAIL = "you@example.com"
npm run fixture:blast:capture -- `
  --fixture-id puc19-bla-blastn-nt `
  --sequence CAATGCTTAATCAGTGAGGCACCTATCTCAGCGATCTGTCTATTTCGTTCATCCATAGTTGCCTGACTCCCCGTCGTGTAGATAACTACGATACGGGAGGGCTTACCATCTGGCCCCAGTGCTGCAATGATACCGCGAGACCCACGCTCACCGGCTCCAGATTTATCAGCAATAAACCAGCCAGCCGGAAGGGCCGAGCGCAGAAGTGGTCCTGCAACTTTATCCGCCTCCATCCAGTCTATTAATTGTTGCCGGGAAGCTAGAGTAAGTAGTTCGCCAGTTAATAGTTTGCGCAACGTT `
  --program blastn `
  --database nt `
  --hitlist-size 5 `
  --expect 0.001
```

The helper writes:

```text
fixtures/blast/<fixture-id>/query.fa
fixtures/blast/<fixture-id>/put-response.txt
fixtures/blast/<fixture-id>/status-*.txt
fixtures/blast/<fixture-id>/result.json
fixtures/blast/<fixture-id>/metadata.json
```

Review these raw files before using them as implementation fixtures. If the
live response shape differs from this spec, update the spec first, then
implement B1 against the observed contract.

Live fixture note: use `FORMAT_TYPE=JSON2_S` when retrieving JSON results.
NCBI may return `FORMAT_TYPE=JSON2` as a ZIP attachment, while `JSON2_S` returns
plain JSON suitable for checked-in parser fixtures.

Use a gene-length B1 query, not a short multiple-cloning-site motif. A 14 bp
restriction-site query such as `GAATTCGCGGCCGC` is too short for ordinary
`blastn` seeding and is biologically nonspecific even if short-query settings
are used. The example above is a 300 bp pUC19 `bla` window from positions
1629..1928 of the checked-in fixture, chosen to produce stable high-identity
nucleotide hits for parser and provenance tests.

The captured BLAST result is a frozen API observation, not a regenerable
truth artifact. `nt` changes over time and RIDs are random. B1 tests should
therefore assert parser structure and provenance fields from the saved fixture,
not exact future rank order or E-values from a new live query.

### Parser Contract Pinned By `puc19-bla-blastn-nt`

The first live fixture revealed the parser contract that B1 must implement:

- `BlastOutput2` is an array. Validate it has exactly one report for single-query
  B1 calls before reading `report`.
- The requested database may resolve to a different effective database. For
  example, requested `nt` returned `search_target.db: "core_nt"`. Surface both
  requested and effective database names in provenance.
- `result.json` does not contain the RID. Extract RID/RTOE/status from the Put
  and status responses, then combine them with parsed JSON hits.
- HSP records include full `qseq`, `hseq`, and `midline` strings. Do not put
  these sequence strings in the default agent-facing envelope. Return summary
  fields by default: identity, alignment length, coordinates, strands, E-value,
  and bit score.
- Empty hits are valid. A `hits: []` response should return `hits: []`, not an
  error. A missing `hits` key should be normalized to the same zero-hit result:
  `const hits = search.hits ?? []`. Parser tests must cover both shapes without
  a second live NCBI call.
- `search.stat` is useful provenance when present (`db_num`, `db_len`, scoring
  parameters) but must be optional. The empty-hit fixture includes a minimal
  `stat` block, and parser tests should also verify that deleting it does not
  crash parsing.

Parser tests should pin these frozen-fixture facts:

```text
BlastOutput2.length = 1
report.program = blastn
report.results.search.query_len = 300
report.results.search.hits.length = 5
report.search_target.db = core_nt
top hit accession = PX095324
top HSP identity = 300
top HSP align_len = 300
top HSP query_from/query_to = 1/300
top HSP hit_from/hit_to = 7277/7576
top HSP evalue parses as number 1.39168e-149
```

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
  requestedDatabase: string;
  effectiveDatabase?: string;  // NCBI may resolve nt -> core_nt
  program: string;
  parameters: {
    hitlistSize: number;
    eValueThreshold: number;
    entrezQuery?: string;
  };
  rid: string;                // NCBI Request ID — always present
  submittedAt: string;        // ISO 8601
  completedAt: string;        // ISO 8601
  hits: BlastHit[];
  hitsTruncated: boolean;     // true when returned hit count reaches hitlistSize
  hitlistLimitReached: boolean;
  truncationRule: "hit_count_equals_requested_hitlist_size";
  ncbiUrl: string;            // https://blast.ncbi.nlm.nih.gov/Blast.cgi?RID=<rid>&CMD=Get
};
```

The `queryDigest` + `rid` + `submittedAt` together form the provenance record
an agent can include in a replay bundle.

### Artifact

`blast_sequence` writes a JSON artifact containing the full result:

```text
reports/blast/<queryId>.<program>.<database>.<rid>.json
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
| `BLAST_TIMEOUT` | NCBI did not return results within the configured max-wait budget; RID included in error details so the search can be retrieved later |
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

**Authoritative spec: `docs/primer-specificity-spec.md`.** B2's full contract --
input/output types, the 3'-end competence rule, amplicon geometry, verdict
classification, timeout handling, short-query BLAST parameters, and fixture/test
requirements -- lives there. Do not implement B2 from this document.

An earlier draft of B2 here classified off-targets by BLAST identity percent
(`minIdentityPercent`, default 90%) and hit counts. That approach is superseded:
primer amplification is a 3'-end property, not an identity-percent property. A
primer with 5' mismatches still amplifies if its 3' end matches, and a single
3'-terminal mismatch usually blocks it -- so identity percent flags the wrong
bindings. B2 classifies bindings by 3' competence and predicts amplicons by
geometry (opposing strands, 3' ends facing inward, within an amplicon distance).
See the new spec for the full rationale and types.

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

## B-Series Gating Rule

B1 has cleared this gate. B2 must clear the short-query fixture gate in
`docs/primer-specificity-spec.md` before implementation starts.

The B1 gate was:

1. NCBI BLAST URL API async pattern (RID polling, backoff, timeout) is
   implemented and tested with a mock server. Network calls in tests must be
   skipped or use a recorded fixture.
2. Provenance schema above is confirmed final. The `queryDigest` + `rid` +
   `submittedAt` triple must be stable before the first real workspace writes it.
3. Usage-policy handling is agreed: identify with `tool`/`email`, poll no more
   than once per minute per RID, contact the server no more than once per 10 s,
   and keep submissions within NCBI's fair-use limits. The BLAST URL API has no
   API key, so there is no authenticated fast path to design for.
4. One live blastn query against `nt` or `refseq_select` has been executed and
   the raw RID, status-poll response, and result response saved as a test
   fixture. Without this, the async pattern is coded blindly against NCBI's
   actual API behavior.
