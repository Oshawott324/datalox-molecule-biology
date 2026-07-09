# mRNA Construct Spec

This document scopes M1 `validate_mrna_construct` and describes the workspace
conventions for mRNA-relevant annotations.

## Biological Review

### Why mRNA Is A Separate Track

The W-series plasmid/cloning tools assume a circular DNA molecule, restriction
enzymes, and insert orientation. mRNA therapeutic and research design has a
different primary object:

```text
5' cap (assumed or annotated)
5' UTR
Kozak sequence context
CDS (start codon -> stop codon, in-frame)
3' UTR
polyA signal + polyA tail
```

For plasmid-template workflows (IVT = in vitro transcription):

```text
T7 or SP6 promoter (upstream of 5' UTR)
polyA tail or run-off transcription site
IVT linearization restriction site (downstream of polyA)
```

These elements are absent from the plasmid-cloning W-series. An mRNA engineer
needs to confirm:

1. All required elements are annotated and in the correct order.
2. CDS integrity: ATG present, in-frame, stop codon present, no premature stop.
3. Kozak context: A/G at -3 position, G at +4 is the canonical strong context.
4. polyA signal: AATAAA or ATTAAA within or adjacent to the 3'UTR annotation.
5. Promoter and IVT site if designing a plasmid template for transcription.

### The IL-27 Example

The mRNA engineer described designing IL-27 as a single-chain fusion (one
protein, one CDS) vs. natural two-subunit form. `validate_mrna_construct`
would:

- Confirm the CDS encodes a single continuous ORF (no internal stop).
- Confirm the linker region between IL-27A and EBI3 domains is in-frame.
- Flag if the Kozak context is suboptimal.
- Confirm 5'UTR, 3'UTR, and polyA annotations are present and ordered.

This is validation, not design. The agent designs the sequence using existing
tools (`translate_region`, manual editing); M1 confirms the result is
biologically sound.

## Workspace Conventions For mRNA Features

mRNA elements should be annotated as workspace features using these canonical
`type` values:

| Element | Feature type | Notes |
|---|---|---|
| 5' UTR | `5'UTR` | GenBank standard |
| Kozak sequence | `regulatory` | qualifier `regulatory_class: "ribosome_binding_site"` |
| Coding sequence | `CDS` | qualifier `codon_start: 1`, `translation` optional |
| Linker / fusion | `misc_feature` | qualifier `note: "fusion_linker"` |
| 3' UTR | `3'UTR` | GenBank standard |
| polyA signal | `polyA_signal` | GenBank standard |
| polyA tail | `polyA_site` | GenBank standard |
| T7 promoter | `promoter` | qualifier `note: "T7"` |
| SP6 promoter | `promoter` | qualifier `note: "SP6"` |
| IVT linearization site | `misc_feature` | qualifier `note: "IVT_linearization_site"` |

These are GenBank-compatible feature types. No schema changes are required in
`MoleculeWorkspace` beyond what `Feature` already supports.

## M1: `validate_mrna_construct`

### Input

```ts
type MrnaElementReference = {
  type:
    | "five_utr"
    | "kozak"
    | "cds"
    | "three_utr"
    | "polya_signal"
    | "polya_tail"
    | "t7_promoter"
    | "sp6_promoter"
    | "ivt_site";
  featureId?: string;       // ID of an existing workspace feature for this element
  coordinates?: {           // explicit coordinates if not from a feature
    start: number;          // 1-based inclusive
    end: number;            // 1-based inclusive
  };
};

type ValidateMrnaConstructInput = {
  workspacePath: string;
  moleculeId: string;
  templateType: "mrna" | "plasmid_template";
  elements: MrnaElementReference[];
};
```

`elements` is the agent-supplied map of which features or coordinate ranges
correspond to which biological roles. Elements may reference existing workspace
features by `featureId`, or provide explicit `coordinates`. Both are optional
per element; if neither is given, the check is attempted by scanning known
feature types in the workspace.

For `templateType: "mrna"`, the required elements are:
`five_utr`, `cds`, `three_utr`. `kozak`, `polya_signal`, and `polya_tail` are
checked if provided or inferrable; absence is a warning, not a failure.

For `templateType: "plasmid_template"`, additionally required:
one of `t7_promoter` or `sp6_promoter`, and `ivt_site`.

### Output

```ts
type MrnaCheckStatus = "pass" | "warning" | "fail";

type MrnaCheck = {
  checkId: string;          // e.g. "CDS_STARTS_WITH_ATG"
  element: string;          // e.g. "cds"
  status: MrnaCheckStatus;
  detail: string;           // human-readable explanation
  coordinates?: { start: number; end: number };
};

type ValidateMrnaConstructResult = {
  moleculeId: string;
  templateType: "mrna" | "plasmid_template";
  checks: MrnaCheck[];
  passCount: number;
  warningCount: number;
  failCount: number;
  summary: "valid" | "valid_with_warnings" | "invalid";
};
```

`summary`:

```text
"valid"               -- all checks pass, zero warnings
"valid_with_warnings" -- all pass/warn, zero failures
"invalid"             -- one or more fail
```

### Checks

The following checks are run when the relevant element is resolved:

**ELEMENT_ORDER**

Elements must appear in 5'->3' order. For both templateTypes, resolved elements
must be in this order:

```text
t7/sp6_promoter? < five_utr < kozak? < cds < three_utr < polya_signal? < polya_tail? < ivt_site?
```

Fail if any resolved element starts after a later-expected element. Adjacent
resolved elements must also be non-overlapping (`previous.end < current.start`),
except for `kozak`, which may overlap the 5'UTR/CDS boundary by design. This
check treats partial element sets gracefully: only resolved elements are
compared.

**CDS_STARTS_WITH_ATG**

The first three bases of the CDS region must be `ATG` (case-insensitive).

Fail if not ATG. Detail includes the actual codon found.

**CDS_IN_FRAME**

CDS length (end - start + 1) must be divisible by 3.

Fail if not. Detail includes the length and remainder.

**CDS_HAS_STOP_CODON**

The last codon of the CDS region must be `TAA`, `TAG`, or `TGA`.

Fail if absent. Detail includes the last three bases found.

**CDS_NO_PREMATURE_STOP**

No in-frame stop codon (TAA, TAG, TGA) may appear before the final codon.

Fail if one is found. Detail includes the position and codon.

**KOZAK_CONTEXT**

Check the sequence context at the start codon: positions -3 and +4 relative to
the A of ATG (1-based). Canonical strong Kozak: `(A/G)CCAUGG` where -3 is A or
G and +4 (the base after ATG) is G.

```text
Pass:    A or G at -3, AND G at +4
Warning: only one of the two is correct
Fail:    not run (this check never fails; only warns)
```

If the molecule is too short to read -3 or +4 from the CDS start, report
`warning` with a detail explaining the boundary condition.

**POLYA_SIGNAL_PRESENT**

Distinguishes polyA signal from polyA tail:
- polyA signal: the hexamer `AATAAA` or `ATTAAA` in the 3'UTR region; guides
  cellular polyadenylation machinery.
- polyA tail: an encoded A-run (e.g., A80) at the 3' end of the transcript;
  present in synthetic mRNA constructs. Annotated as `polya_tail` element type.

Scan for `AATAAA` or `ATTAAA` from the resolved `three_utr` start through 30
bases downstream of the resolved `three_utr` end. Do not scan upstream of the
3'UTR start; upstream AATAAA/ATTAAA motifs in 5'UTR or CDS sequence are not
polyadenylation signals for this check.

- If a `polya_tail` element is resolved: the encoded tail substitutes for
  signal-directed cleavage. Report `warning` if the hexamer is absent (absence
  is not unusual for synthetic constructs with an encoded tail).
- If no `polya_tail` is resolved: report `warning` if the hexamer is absent
  (non-fatal but unusual for most expression vectors).
- Report `pass` if the hexamer is found in either case.

This check never fails; only warns.

**PROMOTER_UPSTREAM_OF_5UTR** *(plasmid_template only)*

The T7 or SP6 promoter end coordinate must be less than the 5'UTR start
coordinate.

Fail if the resolved promoter is not upstream of the 5'UTR.

**IVT_SITE_DOWNSTREAM_OF_POLYA** *(plasmid_template only)*

The IVT linearization site start coordinate must be greater than the end
coordinate of whichever polyadenylation element is resolved (`polya_signal` or
`polya_tail`). If neither is resolved, this check is skipped.

For plasmid templates using run-off transcription, the polyA tail is not encoded
in the transcript; the IVT site marks the downstream transcription boundary and
must be downstream of the polyA signal (or polyA tail if annotated).

Fail if the resolved IVT site is not downstream.

### nextAction

After a valid or valid-with-warnings result:

```ts
nextAction: {
  tool: "validate_workspace";
}
```

After an invalid result:

```ts
nextAction: {
  tool: "manual_review";
  instruction: "Resolve the failed mRNA construct checks before proceeding.";
}
```

### CLI

```bash
molecule-biology validate-mrna-construct \
  <workspacePath> \
  --molecule-id mol_il27_fusion \
  --template-type mrna \
  --elements elements.json
```

Where `elements.json` is an array of `MrnaElementReference` objects:

```json
[
  { "type": "five_utr",      "featureId": "feat_5utr" },
  { "type": "cds",           "featureId": "feat_cds_il27_fusion" },
  { "type": "three_utr",     "featureId": "feat_3utr" },
  { "type": "polya_signal",  "coordinates": { "start": 1850, "end": 1855 } }
]
```

## M2: Codon Optimization

Status: **gated**.

Do not implement until:

1. Organism-specific codon usage table source is confirmed (e.g., Kazusa
   database, GenBank CDS-derived tables).
2. License for the codon table source is reviewed.
3. GC-window constraints, repeat avoidance, and restriction-site avoidance
   rules are specced.
4. Provenance requirements are agreed: the optimized sequence must carry a
   record of which table was used, which version, and which constraints were
   applied.
5. Reference-sequence fixtures are validated (input CDS -> expected output for a
   known example).

Codon optimization changes the nucleotide sequence while preserving the amino
acid sequence. This is not a validation operation. It belongs in a separate
spec when the above gate is passed.

## Structure Handoff (X1)

`validate_mrna_construct` completes M1. The downstream connection for
structure analysis is:

```text
validate_mrna_construct (CDS verified)
-> translate_region (existing tool)
-> export_protein_fasta (add in this cycle -- thin wrapper)
-> AlphaFold3 / ESMFold (external)
-> PyMOL / protein MCP (external or separate repository)
```

`export_protein_fasta` takes a workspace molecule ID and a CDS coordinate
range in transcript/plus-strand coordinates, calls `translate_region`
internally with `strand: "+"`, and writes a FASTA artifact:

```ts
type ExportProteinFastaInput = {
  workspacePath: string;
  moleculeId: string;
  cdsStart: number;       // 1-based inclusive
  cdsEnd: number;         // 1-based inclusive
  proteinId?: string;     // ID for the FASTA header, defaults to moleculeId
  outputPath?: string;
};
```

Output artifact:

```text
reports/proteins/<proteinId>.fa
```

This is a read-only tool. It does not add the protein to the workspace. The
agent passes the artifact path to an external structure tool. CDS ranges whose
length is not divisible by 3 are rejected with `INVALID_ARGUMENT`; exporting a
protein FASTA from a partial terminal codon would silently produce truncated
protein sequence.

## Scope Boundaries

| Feature | M1 | X1 | M2 | Deferred |
|---|---:|---:|---:|---:|
| mRNA element order validation | yes | no | no | no |
| CDS integrity (ATG, in-frame, stop, no premature stop) | yes | no | no | no |
| Kozak context warning | yes | no | no | no |
| polyA signal detection (hexamer in 3'UTR) | yes | no | no | no |
| polyA tail detection (encoded A-run) | yes | no | no | no |
| T7/SP6 + IVT site for plasmid template | yes | no | no | no |
| Protein FASTA export for structure tools | no | yes | no | no |
| Codon optimization | no | no | yes | when gated |
| Modified bases (m1Psi, 5mC) | no | no | no | later |
| MFE / UTR secondary structure | no | no | no | later |
| Cap structure annotation | no | no | no | later |
| Multi-CDS polycistronic construct | no | no | no | later |
