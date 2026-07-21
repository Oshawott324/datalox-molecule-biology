# gRNA Report

CR1 SpCas9 guide report. No validated on-target efficacy score is included.

| Guide | Molecule | Strand | Coordinates | PAM | GC % | Filters | Workspace off-target count |
|---|---|---:|---|---|---:|---|---:|
| selected guide 1 | mol_crispr_eval | + | 1..20 | AGG | 50 | pass | 0 |

## grna_eval_1

- Name: selected guide 1
- Molecule: mol_crispr_eval
- Sequence: ACGTACGTACGTACGTACGT
- PAM: AGG (SpCas9)
- Strand: +
- Protospacer coordinates: 1..20
- PAM coordinates: 21..23
- GC percent: 50
- Seed max homopolymer run: 1
- Off-target scope: workspace_molecules_only
- Workspace off-target count: 0
- Passing filters: true
- Filter failures: none
- GC distance from 50: 0
- Efficacy score included: false

## Evidence Boundary

- This report uses persisted guide records from the workspace.
- CR1 does not include genome-scale off-target search.
- CR1 does not include validated Azimuth/Doench on-target efficacy scoring.
- Detailed off-target hit rows are not persisted in guide records. Rerun `design_grnas` with the same target/options to inspect full workspace off-target hits.

