# Roadmap Index (2026-07-15)

Single source of truth for "what is built, what is specced, what is next."
This supersedes the status fields in `2026-07-biology-tracks-roadmap.md` and
`roadmap-snapgene-core.md`, which are stale. Those two documents remain the
detailed track specs; this document owns current status and sequencing.

Verification basis: `src/tools/descriptors.ts` in this UI-5 implementation
commit, which has 32 registered tools including the HB1 `get_version`
handshake, `edit_sequence`, `blast_sequence`, and `render_review_bundle`.
Eval corpus v0 is shipped on
`main` at `516a2fe` with the independent biological anchor tests in `851f70b`.

## 1. Shipped

V1 hardening and roadmap status are shipped on `main`:

- `e3f6050` implements the MCP handshake, schema-gate hardening, provenance
  bundle metadata, and V1 review-runner lifecycle limits.
- `6b1225d` updates roadmap status and sequencing.
- `135aedf` ships `edit_sequence`.
- `516a2fe` ships eval corpus v0 task coverage.
- `851f70b` adds independent biological anchor tests for the corpus.

32 MCP tools are registered and dispatched generically. Grouped by track:

| Track | Tools |
|---|---|
| Workspace | `open_workspace`, `read_workspace`, `list_molecules`, `open_sequence`, `get_sequence_context`, `validate_workspace`, `get_version` |
| Sequence biology | `find_restriction_sites`, `simulate_digest`, `simulate_pcr`, `find_orfs`, `translate_region`, `reverse_complement`, `align_sequences` |
| Editing entities | `upsert_feature`, `delete_feature`, `edit_sequence`, `upsert_primer`, `delete_primer`, `upsert_grna` |
| Cloning | `simulate_assembly` (restriction-ligation) |
| Design | `design_primers` (Primer3), `design_grnas` (CR1 SpCas9 scan), `export_grna_report` |
| mRNA / protein | `validate_mrna_construct` (M1), `export_protein_fasta` (X1) |
| BLAST | `blast_sequence` (B1 NCBI BLAST URL API) |
| Export | `export_genbank` |
| Rendering / UI | `render_plasmid_map`, `render_digest_gel`, `render_review_bundle`, `open_sequence_editor` |

Also present: FASTA/GenBank import, revision-safe transactional writes,
replay/provenance path, V1 review demo, source-verified pUC19 fixture,
`datalox_rebase_common_v2` enzyme table, gel + plasmid SVG renderers.

Status corrections (marked "planned" in older docs but actually built):
M1 `validate_mrna_construct`, X1 `export_protein_fasta`, CR1 `design_grnas`,
CR1.1-CR1.4 guide persistence/rendering/report, `simulate_assembly`,
`design_primers`, `edit_sequence`.

## 2. Not Built -- Mapped To Existing Specs

Two readiness states matter here. "Track doc exists" means a scope bullet is
written but there is NO implementation-grade contract (input/output types, edge
cases, provenance). "Impl spec" means a document detailed enough to code
against safely. Do not start coding an item that only has a track doc.

| Bucket | Item | Doc state | Gating condition |
|---|---|---|---|
| BLAST | B2 `validate_primer_specificity` | Impl spec (`blast-validation-spec.md`) | B1 shipped |
| Cloning | `simulate_gibson` | Track doc only (`roadmap-snapgene-core.md` s3) -- impl spec needed | Customer/demo pull |
| Cloning | `simulate_golden_gate` (Type IIS) | Track doc only (`roadmap-snapgene-core.md` s4) -- impl spec needed | Customer/demo pull |
| Annotation | `find_known_features` + curated library | No doc | Needs curated feature-library source decision |
| Sanger | AB1 parse + chromatogram + verify | Track bullet (W4) | No impl spec -- sequencing-confirmation customer |
| CRISPR | CR2 Azimuth/Doench on-target score | Impl spec (`crispr-scoring-validation.md`) | Coefficient + license + reference-score fixture |
| CRISPR | PAM systems beyond SpCas9 NGG | Track bullet | Gated, later scoped task |
| mRNA | M2 `optimize_codon_usage` | Track bullet | Codon-table source + customer pull |
| mRNA | UTR / modified base / cap / MFE | No doc | Later |
| Design-to-order | IDT/Twist export + manufacturability | Track bullet (W5) | No impl spec -- ordering pipeline |
| Biology edge | Circular origin-spanning ORFs | Track bullet (`roadmap-snapgene-core.md` s5) | Post-V1 |
| Biology edge | Alternative genetic codes | Track bullet (`roadmap-snapgene-core.md` s6) | Post-V1 |
| Biology edge | Degenerate motif / enzyme recognition | Track bullet (`roadmap-snapgene-core.md` s7-8) | Revisits enzyme model |
| Benchmark | Eval corpus + expected JSON + hashes | Shipped (`516a2fe`, anchored in `851f70b`) | Keep checker green in CI |

Infrastructure (not tools): hosted hub UI to replace `demo:v1-review`, live MCP
replay capture as middleware, shared cross-MCP contract package, Windows
process-group cleanup, release/version handshake. Tracked in
`mcp-architecture-review.md` -- Ziyu's scope, not blocking biology work.

## 3. The Sequencing Decision

The priority order branches on which business goal we are serving. That is the
actual decision, and it should be made explicitly before committing engineering
time. The four goals and their first move:

| Goal | First build | Why |
|---|---|---|
| Marketing / demo | Demo revision using `edit_sequence` | Eval corpus v0 is shipped; demo spine is ready |
| Lab usefulness | B1/B2 BLAST | Wet-lab feedback names Primer-BLAST as the missing layer |
| Benchmark credibility | Eval corpus (section 4) | Nothing is claimable as parity without it |
| SnapGene surface | Auto-annotation -> Sanger -> Gibson/Golden Gate | Largest remaining product-surface blocks |

### Recommended sequence

`edit_sequence`, eval corpus v0, and B1 `blast_sequence` have shipped locally.
B1 used the required frozen NCBI BLAST URL API fixture under `fixtures/blast/`,
so its parser/client/tool path is grounded in observed API behavior rather than
a guessed async contract.

Proposed order:

```text
1. B2 validate_primer_specificity
2. find_known_features    (needs a curated-library source decision first)
3. Gibson / Golden Gate, Sanger, CR2 -- customer-pull gated, each needs an impl spec
```

CR2 and M2 stay gated on explicit customer pull plus their validation fixtures
(license, coefficients, codon tables). Do not pull them forward without that.

## 4. Eval Corpus As A Named Deliverable

Eval corpus v0 is shipped as `eval-corpus/v0/` with checked-in task fixtures,
expected outputs, and artifact hashes.

Implementation spec: `docs/eval-corpus-v0-spec.md`.

- `npm run eval:corpus:v0:check` is read-only and runs in CI.
- `npm run eval:corpus:v0:generate` is manual only; never run it in CI.
- `tests/eval-corpus-reality.test.ts` anchors the highest-risk biological facts
  outside the corpus expected files, so regenerate-to-match drift is caught.
- Cross-MCP visual-reasoning tasks (gel/map/BLAST/flow/protein) are the next
  benchmark expansion once their underlying tool surfaces are shipped.

## 5. edit_sequence Implementation Spec

This was the implementation contract for shipped `edit_sequence`. It remains as
the reference for future review and regression-corpus task design.

### Tool: `edit_sequence`

Mutate a molecule's nucleotide sequence in one revision-safe transaction and
report the exact effect on the sequence and on every annotated feature.

The sequence is stored in a separate file at `molecule.path`, not inside the
workspace JSON. `edit_sequence` therefore touches two artifacts: the stored
sequence file and the workspace record. Because there is no cross-file atomic
commit available, it must NOT overwrite the existing sequence file in place. See
"Two-artifact write model" below.

### Input

```text
workspacePath:     string  (required)
moleculeId:        string  (required)
expectedRevision:  number  (required -- optimistic lock, same contract as other writes)
operation:         "insert" | "delete" | "replace" | "mutate"  (required)
start:             number  (required -- 1-based inclusive)
end:               number  (required for delete/replace/mutate; omitted for insert)
sequence:          string  (required for insert/replace/mutate; the new bases; unambiguous ACGT/ACGU)
```

Semantics per operation:

- insert: splice `sequence` immediately before `start`. Length grows by
  `sequence.length`. `start` may equal `length + 1` to append bases at the 3'
  end of a linear molecule; this is the only clean append path, so it is
  explicitly allowed.
- delete: remove bases `start..end` inclusive. Length shrinks.
- replace: remove `start..end`, splice `sequence` in its place. Length delta =
  `sequence.length - (end - start + 1)`.
- mutate: same span as replace but require `sequence.length == end - start + 1`
  (in-place substitution, no length change). This is a distinct operation so the
  agent's intent is explicit and the validator can enforce equal length.

### Output (success envelope `data`)

```text
revision:          number  (new revision after the write)
previousRevision:  number
lengthBefore:      number
lengthAfter:       number
delta:             number  (lengthAfter - lengthBefore)
editedRange:       { start, end }
diffSummary:       string  (human-free, agent-facing: e.g. "replace 396..401 (6 bp) with 8 bp")
featureImpact:     FeatureImpact[]
```

`featureImpact` contains one entry for EVERY feature on the molecule, including
those with `impact: "unaffected"`. Omitting unaffected features would leave the
agent unable to tell "unaffected" from "not evaluated", so the report is always
complete.

Features can be multi-segment (e.g. pUC19 `lacZalpha` is
`join(238..395,455..682)`). A single `{start,end,strand}` before/after would lose
segment structure, so the authoritative fields are segment lists:

```text
featureId:      string
name:           string
impact:         "unaffected" | "shifted" | "resized" | "truncated" | "split" | "deleted"
frameShifted?:  boolean  (optional; additive -- a CDS can be shifted/resized/truncated AND frame-shifted)
beforeSegments: CoordinateSegment[]                 (CoordinateSegment = { start, end, strand })
afterSegments:  CoordinateSegment[] | null          (null when the whole feature is deleted)
boundingSpan:   { start, end } | null               (optional convenience: min start / max end of afterSegments)
notes:          string[]                            (e.g. ["CDS length no longer divisible by 3"])
```

`impact` and `frameShifted` are two independent dimensions: `impact` describes
what happened to the feature's span, `frameShifted` describes reading-frame
integrity for CDS features. Do not collapse them into one enum. `beforeSegments`
/ `afterSegments` are the source of truth; `boundingSpan` is a convenience for
quick agent reading only, never used for coordinate math.

Coordinate remap rules (deterministic, no heuristics; applied per segment, then
aggregated to one `impact` per feature):

- A segment entirely downstream of the edit is `shifted` by `delta`.
- A segment entirely upstream is `unaffected`.
- An edit strictly inside a segment resizes it by `delta` (`resized`); if the
  edit deletes the segment's start or end boundary it is `truncated`.
- A delete/replace that removes a whole segment drops it; if all of a feature's
  segments are removed the feature is `deleted`: the report shows
  `afterSegments: null`, and the feature record is REMOVED from
  `workspace.features`. It cannot remain with an empty segment array, because
  `validate_workspace` requires every feature to have a non-empty segment array
  (`workspace.ts`: "Feature segments must be a non-empty array"). Reporting
  `deleted` and dropping the record are the same event described two ways.
- An insert inside a single segment that would break it into two disjoint spans
  is NOT auto-split; return `impact: "split"` with `afterSegments` = the merged
  enclosing span and a note. Do not fabricate two segments or two features
  silently.
- For CDS features, additionally set `frameShifted: true` when `delta % 3 != 0`
  and the edit is at or upstream of the CDS. This is independent of the primary
  `impact` (a CDS can be e.g. `shifted` and frame-shifted at once). Add a note;
  do not correct it.

### Errors (structured, agent-facing)

- `STALE_REVISION` when `expectedRevision` != current (same code the existing
  workspace writes and tests use; do not introduce a new code).
- `INVALID_ARGUMENT` for out-of-range coordinates, `end < start`, missing
  `sequence` for insert/replace/mutate, `mutate` length mismatch, or ambiguous
  bases.
- `MOLECULE_NOT_FOUND`.

### Two-artifact write model (write-new, never in-place)

There is no cross-file atomic commit spanning the sequence file and the
workspace JSON. In-place overwrite is unsafe in both orders: overwrite-file-first
leaves the old workspace pointing at changed bytes if the JSON write fails;
write-JSON-first fails digest validation because the file has not changed yet.

Therefore, inside the `writeWorkspaceTransaction` transform:

1. Serialize the edited sequence to a NEW stored file under the workspace data
   directory `data/sequences/` (the same directory `import.ts` writes to). Note
   `import.ts`'s `dataDir` const and `uniqueFileName` are currently private to
   that module, so extract a shared storage helper (e.g. `sequence-storage.ts`)
   rather than duplicating the path logic, and have both `import.ts` and
   `edit_sequence` call it. A content-addressed name such as
   `<moleculeId>.<digest>.fa` / `.gb` is fine.
2. Point `molecule.path` at that new workspace-relative file.
3. Update `molecule.length` and `molecule.sequenceDigest` (via `sequenceDigest`
   from `sequence.ts`).
4. Replace the molecule's features with the remapped draft features. Features
   whose segments were all removed are dropped entirely (not kept with empty
   segments).
5. Commit the workspace JSON transaction.
6. Leave the OLD sequence file untouched.

If the JSON write fails, the old workspace stays valid and still references the
old file. The only cost is an orphaned generated sequence file, which is
harmless and can be garbage-collected later. Do not delete the old file as part
of this transaction.

### Stored-file serialization (pure formatter)

The stored file must be re-serialized in the molecule's `sourceFormat` from the
DRAFT (in-memory, not-yet-persisted) sequence and features:

- FASTA-backed molecule: write the edited sequence as FASTA.
- GenBank-backed molecule: re-serialize, do NOT patch only the ORIGIN block (a
  patched ORIGIN would leave the inline feature table stale relative to the
  remapped features).

Do NOT call `exportGenBank(workspacePath, ...)` for this: it reads the workspace
from disk (`readWorkspace` with `checkSequenceDigests: true`), so it would
serialize stale state and fail the digest check against the not-yet-updated file.
Extract a pure `formatGenBank(molecule, features, sequence)` helper from
`export-genbank.ts` (or add `stored-sequence-writer.ts`) that formats from
passed-in draft state with no disk reads. `exportGenBank` can then be refactored
to call the same pure helper.

### Guardrails

- One workspace-JSON write per call through the existing
  `writeWorkspaceTransaction` path. No direct workspace patching. The new
  sequence file is written inside the same transform, before the JSON commit.
- Never overwrite the existing `molecule.path` file in place (see above).
- No fallback that "fixes" a broken CDS or re-anneals a split feature. Report,
  do not repair.
- `nextAction` should point at `validate_workspace` so the agent verifies
  integrity after the edit.
- Circular molecules: an edit spanning the origin is out of scope for v1; return
  `INVALID_ARGUMENT` with a note rather than guessing wrap semantics. This tracks
  the same deferral as circular ORF support (section 2).

### Tests to pin

- insert/delete/replace/mutate each produce correct `lengthAfter` and `delta`.
- insert with `start == length + 1` appends bases at the 3' end.
- downstream segment shift equals `delta`; upstream segment unchanged.
- multi-segment feature (join) remaps each segment independently and returns
  correct `beforeSegments` / `afterSegments`.
- delete covering a whole feature marks it `deleted` with `afterSegments: null`
  in the report AND removes the feature record from `workspace.features` (proven
  by a follow-up `validate_workspace` returning no issues).
- CDS edit with `delta % 3 != 0` sets `frameShifted: true` while keeping its
  primary `impact` (e.g. `shifted`).
- `expectedRevision` mismatch returns `STALE_REVISION` and does not write (no new
  sequence file left behind, or if written, workspace still references old file).
- origin-spanning edit on a circular molecule returns `INVALID_ARGUMENT`.
- `featureImpact` has one entry per feature on the molecule (including
  unaffected).
- after an edit, `validate_workspace` returns no issues (proves file,
  `length`, `sequenceDigest`, and features stayed mutually consistent).
- round-trip on a GenBank-backed molecule: reopen and `get_sequence_context`
  returns the edited sequence.

## 6. Guardrails Carried Forward

- Do not modify without flagging: `src/core/render-map.ts`, `src/core/enzymes.ts`,
  `fixtures/genbank/puc19.gb`.
- No fallbacks, heuristics, or silent coercion. Deterministic tools only.
- MCP layer stays generic: `tools/list` from descriptors, `tools/call` via
  `runToolHandler`. No per-tool branching in the server.
- Errors are agent-facing structured envelopes, not human prose.
- Live-test before claiming done; use a cheap model for the loop.
- Prose in this repo is ASCII: use `->`, `--`, and "section N" rather than
  Unicode arrows, em dashes, or the section sign.
