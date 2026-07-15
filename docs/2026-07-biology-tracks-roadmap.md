# Biology Tracks Roadmap (2026-07)

> **Status note (2026-07-15):** M1 `validate_mrna_construct` and X1
> `export_protein_fasta` have shipped since this document was written; their
> per-section statuses below are updated to reflect that. B1/B2 remain planned,
> M2/CR2 remain gated. Cross-track current status and sequencing are owned by
> `docs/roadmap-index-2026-07.md`.

This document adds three tracks to the existing W/CR roadmap in
`docs/snapgene-basics-agent-roadmap.md`. The motivation is feedback from a
traditional wet-lab mRNA engineer whose workflow is:

```text
SnapGene -> NCBI Primer-BLAST / BLAST -> PyMOL / AlphaFold3 -> experiment
```

Key observations:

- "We use NCBI BLAST, not Primer3" — they are using both without realizing it.
  NCBI Primer-BLAST runs Primer3 internally for design, then BLAST for
  off-target specificity. Primer3 stays as the local design engine. BLAST
  validation is the missing layer.
- mRNA constructs (5'UTR, Kozak, CDS, linker/fusion, 3'UTR, polyA, IVT site)
  are not covered by the plasmid-cloning W-series.
- Structure workflows (AlphaFold3, PyMOL) are downstream of sequence design,
  not inside this MCP. The bridge is `translate_region -> export_protein_fasta`.

The product framing stays the same:

```text
agent intent
-> deterministic domain tools
-> revision-safe workspace state
-> recognizable scientific artifacts
-> replayable tool I/O
```

Traditional labs buy confidence that the sequence is right, primers work, BLAST
checks out, and the result maps to experiments they run. This MCP is the backend
that gives agents that confidence reliably. The B and M tracks directly serve
that claim.

## Track Naming

Existing:
- **W-series**: plasmid and cloning workflows
- **CR-series**: CRISPR guide design
- **P-series**: infrastructure, rendering, visualization

New:
- **B-series**: BLAST and external sequence validation
- **M-series**: mRNA construct design and validation
- **X-series**: structural bridge (translate -> export -> external structure tools)

## B-Series: BLAST And Primer Specificity Validation

See `docs/blast-validation-spec.md` for full input/output types and agent
workflows.

### B1: `blast_sequence`

Status: **planned**.

General homology search via NCBI BLAST URL API. Returns structured hits
with full provenance. Designed for agent workflows where the agent needs to
report "what does BLAST say" as part of a design record.

Use cases:
- Confirm a synthetic construct has no unexpected homologs.
- Check that a designed primer does not hit unwanted genomic regions.
- Validate that a fusion protein CDS encodes what is expected.

### B2: `validate_primer_specificity`

Status: **planned**. Depends on B1.

Primer-specific BLAST wrapper. Takes persisted primer IDs from the workspace,
BLASTs each sequence, evaluates potential off-target amplification from
primer-pair hits, and returns a per-primer specificity assessment.

Agent workflow:

```text
design_primers
-> simulate_pcr (local construct check)
-> validate_primer_specificity (NCBI BLAST off-target check)
-> upsert_primer (if assessment passes)
-> validate_workspace / replay bundle / future export_primer_report
```

This makes the full primer workflow comparable to NCBI Primer-BLAST while
keeping Primer3 as the local design engine and maintaining workspace
provenance.

### B-Series Scope Boundaries

| Feature | B1 | B2 | Deferred |
|---|---:|---:|---:|
| General nucleotide BLAST (blastn) | yes | via B1 | no |
| Protein BLAST (blastp / blastx) | yes | no | later |
| Primer pair off-target amplicon prediction | no | yes | no |
| Genome-scale CRISPR off-target (cas-offinder) | no | no | CR-series |
| Local FASTA database search | no | no | later |
| Rate-limit / usage-policy compliance | yes | via B1 | no |

### B-Series Gating Rule

`docs/blast-validation-spec.md` holds the authoritative gate (endpoint, usage
policy, provenance schema, error taxonomy, and fixture requirement); the two
points below are the roadmap-level summary. Do not implement B1 until:

1. The NCBI BLAST URL API async pattern (submit RID, poll, parse XML/JSON) is
   specced and the provenance schema is pinned. See
   `docs/blast-validation-spec.md`.
2. One live blastn query against `nt` or `refseq_select` has been executed and
   the raw RID, status-poll response, and result response saved as a test
   fixture. Without this, the async pattern is coded blindly against NCBI's
   actual API behavior.

## M-Series: mRNA Construct Validation

See `docs/mrna-construct-spec.md` for full input/output types and validation
rules.

### M1: `validate_mrna_construct`

Status: **shipped** (`b83e71d`, edge cases hardened in `5cd13dd`).

Validates that a molecule's workspace features contain the required mRNA
elements in the correct 5'->3' order and that each element passes biological
integrity checks.

Checks:
- Element order: 5'UTR before CDS before 3'UTR before polyA
- CDS starts with ATG
- CDS length is divisible by 3 (in-frame)
- CDS ends with a stop codon (TAA, TAG, or TGA)
- No premature in-frame stop codons inside CDS
- Kozak context at start codon (warning if suboptimal)
- polyA signal (AATAAA or ATTAAA) present in or adjacent to annotated 3'UTR
- T7 or SP6 promoter upstream of 5'UTR if `templateType: "plasmid_template"`
- IVT linearization site downstream of polyA for plasmid template workflow

Use cases:
- Verify a synthetic IL-27 single-chain fusion mRNA construct.
- Confirm a codon-modified CDS is in-frame after modification.
- Check a plasmid template has promoter, UTRs, CDS, and polyA in correct order.

### M2: `optimize_codon_usage`

Status: **gated**. Separate track, not near-term.

Requires: organism-specific codon usage tables, restriction-site avoidance,
GC-window constraints, repeat avoidance, and sequence identity provenance.
Do not implement as a quick add. Scope separately when a customer pull
requires it.

### M-Series Scope Boundaries

| Feature | M1 | M2 | Deferred |
|---|---:|---:|---:|
| mRNA element order validation | yes | no | no |
| CDS integrity (ATG, in-frame, stop) | yes | no | no |
| Kozak context check | yes (warning) | no | no |
| polyA signal detection | yes | no | no |
| No premature stop codon in CDS | yes | no | no |
| T7/SP6 promoter + IVT site for plasmid template | yes | no | no |
| Codon frequency optimization | no | yes | when customer requires |
| Modified base support (m1Psi, 5mC) | no | no | later |
| Cap structure validation | no | no | later |
| Minimum free energy folding / UTR structure | no | no | later |

## X-Series: Structural Bridge

No new tool. This is a narrative track connecting the existing molecule-biology
MCP to external structure tools.

### X1: `translate_region` -> `export_protein_fasta`

Status: **shipped** (`b83e71d`, edge cases hardened in `5cd13dd`). The bridge is
complete on the molecule-biology side:

```text
translate_region (shipped)
-> export_protein_fasta (shipped)
-> AlphaFold3 / ESMFold (external, agent submits sequence)
-> PyMOL (external, agent loads structure file)
```

`export_protein_fasta` writes the protein sequence to an artifact file that the
agent can pass to an external structure prediction service. It is a thin wrapper
over `translate_region` output. The remaining X-series work is entirely external
(AlphaFold/PyMOL) and lives in the protein MCP, not this repository.

The protein MCP (separate repository in the Research Tools folder) is the
integration point for structured PyMOL annotations, domain labeling, and pocket
analysis. Until that MCP is concrete, position this as a narrative bridge:
design mRNA in molecule-biology MCP -> translate -> export -> agent runs
AlphaFold -> agent loads result into protein MCP.

Do not build PyMOL or AlphaFold integration inside this repository.

## UI Track

The P4 static dual-view editor is complete. The near-term UI additions that
support mRNA and BLAST workflows are:

**Sequence region panel extensions:**
- Show mRNA element annotations (5'UTR, CDS, 3'UTR, polyA) with distinct color
  convention alongside existing feature colors.
- Show `validate_mrna_construct` check results as inline warnings in the
  sequence view.

**BLAST result surface:**
- `blast_sequence` returns structured artifacts. The UI should be able to render
  a BLAST hit table from the artifact JSON, similar to how the gel view renders
  band metadata.

These are post-M1/B1 additions that the UI server can pick up once the tool
artifacts exist.

## Priority Order

Done since this list was written: M1 `validate_mrna_construct` and X1
`export_protein_fasta` are shipped. The remaining B/M/CR order is:

```text
1. B1 blast_sequence — spec first (blast-validation-spec.md), then implement
2. B2 validate_primer_specificity — depends on B1
3. UI: mRNA element colors and BLAST hit table rendering
4. M2 codon optimization — gated, wait for customer pull
5. CR2 Azimuth scoring — gated, wait for coefficient/license/fixture validation
```

For where these sit against the non-B/M tracks (`edit_sequence`, eval corpus,
cloning), see the cross-track sequencing in `docs/roadmap-index-2026-07.md`.
CR2 does not move up unless a CRISPR-focused customer explicitly asks for
validated efficacy scoring.

## Updated Roadmap Table

Extending `docs/snapgene-basics-agent-roadmap.md` Roadmap Not For This Demo
table:

| ID | Feature | Status / Trigger |
|---|---|---|
| M1 | `validate_mrna_construct` construct integrity | **Shipped** (`b83e71d`) |
| X1 | `export_protein_fasta` for structure handoff | **Shipped** (`b83e71d`) |
| W4 | Sanger alignment with AB1/chromatogram | Sequencing confirmation workflow |
| W5 | IDT/Twist synthesis export | Design-to-order pipeline |
| W6 | Full Gibson / Golden Gate / Gateway workflows | Specific customer demo |
| CR2 | Validated CRISPR on-target scoring | Gated: coefficient, license, fixture pins all done |
| B1 | `blast_sequence` general homology search | Planned: NCBI BLAST spec complete and API async pattern pinned |
| B2 | `validate_primer_specificity` primer off-target | Planned: B1 complete |
| M2 | `optimize_codon_usage` | Gated: customer pull, codon table source confirmed |
