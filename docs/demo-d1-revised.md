# D1 Revised Demo Design (shipped-tools vertical)

Status: draft flow spec for review before recording. This revises the D1 demo in
`docs/diagnostic-digest-demo.md` to use the now-shipped tools. It does not change
the pinned biology in that document (insert, construct sequences, fragment
sizes); it changes HOW the constructs are built and adds two beats. Read this
alongside the original for the verified numbers.

## What Changed And Why

The original D1 pre-assembles the forward/reverse constructs by string
manipulation inside the script, then digests them. The product has since shipped
`edit_sequence`, `validate_primer_specificity`, and the review/export bundle. The
revision uses them so the demo shows the agent *doing* molecular biology, not
being handed pre-built constructs:

1. **Build the construct live with `edit_sequence`** instead of string assembly.
   This is the SnapGene-parity moment on camera: open pUC19, splice in the
   payload, and watch the tool report exactly what happened to every feature.
2. **Optionally add a primer-specificity insert** (Primer-BLAST-equivalent)
   using the frozen BLAST fixture, so it is reproducible on camera. This is a
   side insert, not part of the MCP replay chain, because MCP calls use the live
   BLAST transport.
3. **Close with the review bundle** -- one openable file that is "everything the
   agent saw and did."

## Biology Is Preserved (this is the key claim)

The forward construct in the original doc is:

```text
pUC19[1..396] + INSERT[1..700] + pUC19[418..2686]
```

That is exactly `edit_sequence` `replace(start=397, end=417, sequence=INSERT)` on
authentic pUC19: it removes the 21 bp MCS stuffer between the EcoRI cut (396) and
the BamHI cut (417) and splices the payload in its place -- the in-silico
equivalent of an EcoRI/BamHI directional clone. The edit-built construct is
**byte-identical** to the pre-assembled one, so every pinned fragment size in the
original doc still holds:

```text
empty     2686   HindIII+XhoI -> [2686]
forward   3365   HindIII+XhoI -> [480, 2885]
reverse   3365   HindIII+XhoI -> [284, 3081]
```

Reverse uses `replace(397, 417, revcomp(INSERT))`. Empty is unedited pUC19. The
demo remains falsifiable: `simulate_digest` must return these sizes or the demo
fails loudly.

### Verified Facts

These were reproduced by running the shipped tools on the authentic pUC19 +
`datalox_insert_v1` fixtures (not asserted from memory):

```text
edit_sequence replace(397, 417, INSERT):
  insert length      700
  length after       3365
  bla impact         shifted, no frameShifted true  (resistance preserved in frame)
  lacZalpha impact   shifted                        (MCS insert lands in the join gap)
  validate_workspace ok
simulate_digest HindIII+XhoI (circular): [480, 2885]
```

Circular-topology note: the MCS replace at 397..417 is a contiguous interior
range, not origin-spanning, so it is valid on the circular pUC19 molecule (unlike
an origin-crossing edit, which `edit_sequence` rejects by design).

## The `edit_sequence` Beat (new, deterministic)

This is the demo's strongest new frame. After `replace(397, 417, INSERT)`, the
tool returns `featureImpact` for every pUC19 feature. These values are verified
against the tools (see "Verified Facts"), so the narration matches tool output
exactly:

- `bla` (downstream) is reported `shifted` by the net length change, with no
  `frameShifted: true` on the CDS entry -- the ampicillin-resistance ORF is
  repositioned but the tool confirms it stays in frame. This is the headline beat: a deterministic
  computation on the actual sequence, not a guess.
- `lacZalpha` (annotated `join(238..395, 455..682)`) is reported `shifted`: the
  payload lands in the MCS, which sits in the gap between the two lacZalpha
  segments, so the downstream segment shifts around the insertion. Length goes
  2686 -> 3365; a follow-up `validate_workspace` returns no issues.

Narration: "The agent inserted 700 bp, and the tool computed exactly what
happened to every feature -- bla, the ampicillin-resistance gene, moved
downstream but stayed in frame; the tool confirms it, it does not guess."

### Optional: the blue/white (insertional inactivation) beat

Biologically, inserting into the MCS inactivates the lacZ alpha peptide -- the
basis of blue/white screening. The authentic fixture cannot show this as a
frameshift because it annotates lacZalpha as a gene/misc_feature join, not a CDS
spanning the insertion point (the same limitation the eval corpus solved with a
CDS proxy). If you want the frameshift beat on camera, run the edit against the
`puc19-laczalpha-cds.gb` variant from
`eval-corpus/v0/tasks/mb-edit-puc19-laczalpha-frameshift/inputs/`, where the same
MCS insert reports `frameShifted: true` on the alpha-peptide CDS proxy. Narrate
it as a CDS-annotated variant, not the authentic record. Do NOT claim a
frameshift on the authentic fixture -- the tool does not report one there, and
the demo must not overclaim.

## Revised Step Sequence

```text
1.  open_sequence         authentic pUC19 -> mol_forward (circular GenBank fixture)
2.  edit_sequence         replace(397, 417, INSERT) -> forward construct; inspect featureImpact
3.  validate_workspace    prove the edited construct is internally consistent
4.  (repeat 1-2 for mol_reverse with revcomp(INSERT); mol_empty stays unedited)
5.  find_restriction_sites  HindIII+XhoI on all three
6.  simulate_digest       HindIII+XhoI on all three; ASSERT fragment sizes match the pinned table
7.  render_digest_gel     one 3-lane gel (empty / forward / reverse), log-scaled
8.  render_plasmid_map    mol_forward with the XhoI/HindIII cut sites overlaid
9.  optional B2 insert      show frozen-fixture primer specificity output; do not run live BLAST on camera
10. validate_workspace
11. pack + verify replay bundle
12. export_review_bundle  -> review.html + raw artifacts + workspace snapshot + provenance ZIP
13. print the camera-readable summary
```

Steps 1-8 and 10-13 are fully deterministic and offline -- the reproducible core.

## Primer Specificity Insert (new, external -- use the frozen fixture on camera)

`validate_primer_specificity` is the Primer-BLAST-equivalent capability, but it
is a **live NCBI call** -- non-deterministic, minutes long, and network-dependent.
That conflicts with the demo's "deterministic and replayable" thesis and risks a
slow or failed call on camera. Also, fixture transport injection is a core-test
seam, not an MCP protocol feature: an MCP call cannot pass an injected transport
through JSON arguments.

For the recording, treat B2 as a short insert outside the MCP replay chain:
render or print the frozen-fixture result from a demo helper that calls the core
function with injected transport, or cut the beat entirely and mention the
capability in narration. Do not present the frozen-fixture run as a live MCP
call.

- Show a primer pair's verdict (e.g. `specific` / `low_risk` /
  `high_off_target_risk`) driven by 3'-end competence and amplicon geometry.
- Narration: "This is the Primer-BLAST layer. It does not judge specificity by
  identity percent -- short primers hit many sequences at 100%. It asks whether
  two primers can actually form an off-target product. Live, it queries NCBI; for
  a reproducible recording we replay a captured result."

If you prefer to keep the demo purely to the deterministic vertical, cut this
beat and mention the capability in narration instead. Do not do a live NCBI call
during recording.

## Review-Bundle Close (new)

End on `export_review_bundle`. The ZIP (and the `review.html` inside it) is the
tangible form of the product thesis: the plasmid map, the gel, the digest table,
and a human-readable replay summary in one openable file. The closing frame is
`review.html` on one side and the terminal transcript on the other -- the visual
argument that the computed values equal what the human sees, and that it is all
captured.

## Camera Structure

| Beat | Seconds | On screen |
|---|---|---|
| Hook | 0-3 | the 3-lane gel, no explanation |
| Prompt | 3-8 | the agent task |
| Live cloning | 8-25 | `edit_sequence` call + `featureImpact` (bla shifted, in frame; lacZalpha shifted) |
| Diagnostic | 25-40 | digest table + gel + plasmid map, split screen |
| Primer-BLAST | 40-50 | specificity verdict (frozen fixture) |
| Close | 50-60 | `review.html` + "Replay verified" |

## Falsifiability

Unchanged and extended: `simulate_digest` must return the pinned fragment sizes,
AND `edit_sequence` must report `bla` as `shifted` with no `frameShifted: true`
on the CDS entry and `lacZalpha` as `shifted` (see "Verified Facts"). Any
deviation fails the demo build; do not continue past a mismatch.

## What This Demo Does Not Do

- Does not do a live NCBI BLAST call during recording (frozen fixture only).
- Does not claim reverse orientation is a normal EcoRI/BamHI cloning product
  (carried over from the original doc).
- Does not model incomplete digestion, star activity, or supercoiled migration.
- Does not import a natural gene as the payload.

## Decisions To Confirm Before The Script

1. **Construct construction via `edit_sequence` replace** (my recommendation) vs
   keeping the pre-assembled constructs. The edit path is byte-identical and adds
   the feature-impact beat, so I recommend it.
2. **Primer beat: frozen fixture vs cut entirely.** I recommend the frozen
   fixture with the live caveat; a live call on camera is the one real risk.
3. **Close artifact: `export_review_bundle` (ZIP) vs `render_review_bundle`
   (bare HTML).** The ZIP is the stronger "everything the agent did" object; the
   bare HTML is simpler to open on camera. Either works.
