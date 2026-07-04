# CR2 CRISPR Scoring Validation

Status: validation required before implementation.

CR1 `design_grnas` is intentionally filter-based. It scans SpCas9 NGG/CCN sites,
reports GC and seed-homopolymer filters, and reports workspace-scale off-targets.
It does not claim guide efficacy.

CR2 should add an optional efficacy score only after source, license, model, and
reference-score validation are pinned.

CR2 should be framed as Azimuth-compatible scoring unless a different validated
model is explicitly chosen. Do not describe CR2 as a hand-transcribed Doench
coefficient table.

## Current Source Findings

- The Microsoft Research Azimuth repository is archived and read-only.
- Its license file is BSD-3-Clause, not MIT.
- Its README describes Azimuth as a machine-learning predictive model package
  for CRISPR/Cas9 guide efficiency and cites Doench et al. 2016.
- The README describes the selected model as gradient-boosted regression trees,
  not a simple hand-transcribed 20-feature linear model.
- The README example scores are produced by
  `azimuth.model_comparison.predict(sequences, amino_acid_cut_positions,
  percent_peptides)`, using `V3_model_full` by default.

Sources checked:

- `https://github.com/MicrosoftResearch/Azimuth`
- `https://github.com/MicrosoftResearch/Azimuth/blob/master/LICENSE.txt`
- `https://github.com/MicrosoftResearch/Azimuth/blob/master/README.md`

## Do Not Implement Yet

Do not add `onTargetScore` to `GuideCandidate` until all of these are true:

1. **Model chosen**
   - Decide whether CR2 means Azimuth-compatible scoring, a specific published
     Rule Set 2 model, or a different explicitly named score.
   - Do not call a heuristic "Doench RS2".
   - Pick the implementation path before writing code:
     - **Python subprocess**: call a pinned Azimuth scorer script, following the
       same dependency-boundary pattern as `primer3_core`.
     - **TypeScript reimplementation**: only allowed if feature engineering,
       serialized model parameters, and reference-score fixtures are pinned.
   - The default recommendation is the Python subprocess path because it reduces
     the risk of silent feature-engineering drift.

2. **License reviewed**
   - Confirm the license for any code, model weights, serialized model files,
     and reference data used for validation.
   - Record whether the source is acceptable for this repo and intended product
     use.
   - Treat Azimuth code, saved model pickle files, training/reference data, and
     any redistributed dependency as separate assets.
   - Keep product/commercial notes in
     `docs/crispr-commercial-license-review.md`.

3. **Input convention pinned**
   - Document the exact required sequence window.
   - Include protospacer, PAM, strand convention, and any flanking context.
   - State whether coordinates are reported in plus-strand workspace coordinates
     while sequence input is model-orientation sequence.
   - For Azimuth-compatible CR2, the scoring input is a 30-mer:
     `4 bp upstream + 20 bp guide + 3 bp PAM + 3 bp downstream`.
   - If the guide protospacer is at 1-based molecule coordinates `start..end`,
     the plus-strand 30-mer starts at `start - 4` for plus-strand guides before
     orientation conversion.
   - For minus-strand guides, derive the 30-mer from the plus-strand molecule
     coordinates, then reverse-complement it into guide orientation before
     scoring.
   - For linear molecules, if the full 30-mer is unavailable because the guide
     lies within 4 bp of the 5' edge or lacks 3 downstream bases after the PAM,
     return no score with reason `INSUFFICIENT_FLANKING_CONTEXT`. Do not pad,
     trim, or infer missing context.
   - Circular molecules may wrap around the origin to provide the full 30-mer.

4. **Reference-score fixture added**
   - Add 5-10 guide sequences with expected scores from an authoritative
     reference implementation or publication.
   - Pin accepted numeric tolerance.
   - The implementation must fail tests if scores drift.
   - At minimum, include the three Azimuth README examples:
     - `ACAGCTGATCTCCAGATATGACCATGGGTT` -> `0.672298196907`
     - `CAGCTGATCTCCAGATATGACCATGGGTTT` -> `0.687944237021`
     - `CCAGAAGTTTGAGCCACAAACCCATGGTCA` -> `0.659245390401`
   - The initial fixture lives at
     `fixtures/crispr/azimuth-readme-reference.json`.
   - Validate it in a reviewed Azimuth Python environment with:

     ```bash
     npm run validate:cr2:azimuth
     ```

5. **Agent-facing semantics defined**
   - Keep CR1 `filterFailures` as hard-filter evidence.
   - Add efficacy scoring as a separate optional field, not a replacement for
     filter evidence.
   - Preserve `offTargetScope: "workspace_molecules_only"` unless genome-scale
     search is actually implemented.

## Proposed Output Shape

When CR2 is validated, extend `GuideCandidate` additively:

```ts
type GuideCandidate = {
  // existing CR1 fields stay unchanged
  onTargetScore?:
    | {
        method: "azimuth_v2";
        value: number;
        range: [0, 1];
        modelSource: string;
        validationSet: string;
        inputWindow: "4bp_upstream_20bp_guide_3bp_pam_3bp_downstream";
      }
    | {
        value: null;
        reason: "INSUFFICIENT_FLANKING_CONTEXT";
        inputWindow: "4bp_upstream_20bp_guide_3bp_pam_3bp_downstream";
      };
};
```

Ranking should remain auditable:

```text
passingFilters first
then fewer off-target hits
then validated on-target score, if present
then GC closeness to 50%
then coordinate order
then strand "+" before "-"
```

If `onTargetScore` is absent, CR1 ranking remains unchanged.

## Acceptance Criteria For CR2

- `docs/crispr-scoring-validation.md` names the selected model and source.
- License decision is recorded.
- Reference-score fixture is checked in.
- Tests validate score outputs to a documented tolerance.
- MCP/CLI output includes the method name and source metadata.
- SKILL.md tells agents not to treat CR1 ranking as efficacy scoring.
