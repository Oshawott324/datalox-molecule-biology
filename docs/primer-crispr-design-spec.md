# Primer And CRISPR Design Spec

This document scopes W2 `design_primers` and CR1/CR2 `design_grnas`.

The goal is agent-callable deterministic design assistance. These tools should
produce structured candidates and evidence that an agent can inspect, validate,
and then explicitly write into the workspace through existing revision-safe
write tools.

These tools do not depend on P5 `align_sequences`.

Roadmap naming: W-series remains the plasmid/cloning roadmap. CR-series is the
CRISPR guide-design roadmap. `docs/snapgene-basics-agent-roadmap.md` keeps W3
for `simulate_assembly`; this document uses CR1 and CR2 for guide design.

## Biological Review

### W2 Primer Design

Primer design should use Primer3 through the official `primer3_core` binary.
That is the correct boundary: Primer3 owns primer scoring, melting-temperature
calculation, product-size constraints, and pair penalties. This repo should own
BoulderIO formatting, subprocess execution, output parsing, coordinate
conversion, and the MCP/CLI contract.

The design tool should be read-only in W2. It returns primer-pair candidates.
If an agent wants to persist a chosen pair, it should call the existing
`upsert_primer` tool with `expectedRevision`. This keeps mutation explicit and
preserves the existing revision-safe write pattern.

Overhangs are allowed as 5' prefixes for restriction adapters or ordering
convenience. Primer3 scoring, Tm, GC, and product-size calculations apply only
to the annealing portion. The output may include `sequenceWithOverhang`, but the
overhang must not be treated as part of the Primer3-designed annealing sequence.

Circular plasmids are out of scope for W2 design. For v1, reject target regions
that wrap around the origin with structured `COORDINATE_OUT_OF_RANGE`. Agents
can still design primers on a non-wrapping plasmid interval.

### CR1/CR2 CRISPR Guide Design

CRISPR guide design should be split:

- **CR1**: deterministic SpCas9 PAM scanning, guide extraction, basic filters,
  and workspace-scale off-target reporting.
- **CR2**: validated on-target scoring, such as Doench Rule Set 2, only after
  the coefficient source, license, and reference test scores are pinned.

This split avoids a common failure mode: shipping a CRISPR score that looks
precise but has not been independently validated. CR1 can still be useful for
plasmid-scale design and agent reasoning, as long as it clearly reports
`offTargetScope: "workspace_molecules_only"` and does not claim genome-scale
safety.

For CR1, SpCas9 means NGG PAM only. A plus-strand candidate is:

```text
 strand: 5' N20 NGG 3'
```

A minus-strand candidate corresponds to a CCN motif on the plus-strand molecule;
the reported guide sequence is the reverse complement protospacer in guide
orientation.

All reported coordinates are plus-strand molecule coordinates with
`start <= end`; the `strand` field carries orientation. For a minus-strand
candidate with a CCN motif at plus-strand positions `p..p+2`, report
`pamStart = p`, `pamEnd = p+2`, protospacer `start = p+3`, protospacer
`end = p+22`, and `strand = "-"`.

Off-target scanning in CR1 should require a compatible PAM and count mismatches
across the 20 bp protospacer. Seed-region mismatches are reported separately.
Do not count non-NGG PAMs as low-mismatch off-targets for SpCas9.

## W2: `design_primers`

### Dependency

Spawn `primer3_core` as a subprocess and communicate through BoulderIO
stdin/stdout.

Do not use an npm Primer3 wrapper. The official binary is the authoritative
implementation.

Licensing boundary: this repo should spawn `primer3_core` as an external
process and parse its text output. Do not distribute Primer3 source, link
against Primer3 libraries, or vendor Primer3 binaries into this package without
a separate license review. The subprocess boundary is intentional architecture:
Primer3 remains the external executable dependency, while this project remains
responsible only for BoulderIO input, output parsing, and agent-facing contracts.

If `primer3_core` is not available on `PATH`, return a structured error:

```json
{
  "ok": false,
  "tool": "design_primers",
  "error": {
    "code": "DEPENDENCY_MISSING",
    "message": "primer3_core was not found on PATH.",
    "details": {
      "dependency": "primer3_core",
      "install": [
        "brew install primer3",
        "apt install primer3",
        "or install the binary from primer3.org"
      ]
    }
  }
}
```

### Files

```text
src/core/primer-design.ts
src/tools/handlers.ts
src/tools/descriptors.ts
src/cli/main.ts
src/index.ts
tests/primer-design.test.ts
```

### Input

```ts
type DesignPrimersInput = {
  workspacePath: string;
  moleculeId: string;
  target: {
    start: number; // 1-based inclusive molecule coordinate
    end: number;   // 1-based inclusive molecule coordinate
  };
  options?: {
    productSizeRange?: [number, number]; // default [200, 1000]
    tmRange?: [number, number];          // default [57, 63]
    primerSizeRange?: [number, number];  // default [18, 27]
    numReturn?: number;                  // default 5
    leftOverhang?: string;               // 5' prefix on left primer output
    rightOverhang?: string;              // 5' prefix on right primer output
  };
};
```

Input rules:

- `target.start` and `target.end` use this repo's standard 1-based inclusive
  coordinate convention.
- `target.start <= target.end` is required in W2.
- `target` must lie inside the molecule bounds.
- Molecule alphabet must be DNA-compatible.
- Product size range, Tm range, and primer size range must be positive and
  ordered.
- `leftOverhang` and `rightOverhang`, when present, must be DNA alphabet strings.

Primer3 target conversion:

```text
SEQUENCE_TARGET = target.start - 1, target.end - target.start + 1
```

This asks Primer3 to return primer pairs whose amplicon includes the target
interval.

Primers flank the target interval. The amplicon will usually be larger than the
target by at least one primer-binding length on each side; `target.start` and
`target.end` are not primer binding boundaries.

### Output

```ts
type PrimerPairCandidate = {
  rank: number;
  penalty: number;
  left: DesignedPrimer;
  right: DesignedPrimer;
  productSize: number;
};

type DesignedPrimer = {
  sequence: string;              // annealing portion only
  sequenceWithOverhang?: string; // 5' overhang + annealing portion
  tm: number;
  gcPercent: number;
  start: number;                 // 1-based inclusive molecule coordinate
  end: number;                   // 1-based inclusive molecule coordinate
  strand: "+" | "-";
};

type DesignPrimersResult = {
  moleculeId: string;
  target: { start: number; end: number };
  dependency: {
    name: "primer3_core";
    version?: string;
  };
  optionsUsed: {
    productSizeRange: [number, number];
    tmRange: [number, number];
    primerSizeRange: [number, number];
    numReturn: number;
  };
  candidates: PrimerPairCandidate[];
  nextAction: {
    type: "select_primer_pair";
    instruction: "Choose a candidate, then call upsert_primer twice with expectedRevision if it should be persisted.";
  };
};
```

Right-primer coordinate parsing must account for Primer3's right-primer
coordinate convention. Pin this in tests with a captured Primer3 output fixture.

### CLI

```bash
molecule-biology design-primers \
  --workspace-path /path/to/molecule.workspace.json \
  --molecule-id mol_puc19 \
  --target-start 1629 \
  --target-end 2028 \
  --product-size-range 200,1000 \
  --tm-range 57,63 \
  --primer-size-range 18,27 \
  --num-return 5
```

### Tests

Always-on unit tests:

- BoulderIO generation for a pinned input.
- Primer3 output parsing from a captured fixture.
- Coordinate conversion for left and right primers.
- Overhang output does not change annealing sequence, Tm, GC, or product size.
- Invalid wrapping target is rejected.
- Missing dependency maps to `DEPENDENCY_MISSING`.

Optional live integration test:

- Skip when `primer3_core` is absent.
- Use the pUC19 fixture.
- Request primers for a non-wrapping ~400 bp region in `bla`.
- Confirm at least one candidate is returned and product size falls inside the
  requested range.

## CR1: `design_grnas`

### Scope

CR1 is pure TypeScript:

- SpCas9 NGG PAM scanning.
- Guide extraction on both strands.
- GC and seed homopolymer filters.
- Workspace-scale off-target reporting.

No external binary is required in CR1.

No genome-scale off-target claim is allowed in CR1.

No Doench Rule Set 2 score is shipped in CR1 unless the validated-scoring gate
below is completed.

### Files

```text
src/core/crispr.ts
src/tools/handlers.ts
src/tools/descriptors.ts
src/cli/main.ts
src/index.ts
tests/crispr.test.ts
```

### Input

```ts
type DesignGrnasInput = {
  workspacePath: string;
  moleculeId: string;
  targetRegion: {
    start: number; // 1-based inclusive
    end: number;   // 1-based inclusive
  };
  options?: {
    pamType?: "SpCas9";               // default "SpCas9"; NGG only
    guideLength?: number;             // default 20
    strand?: "both" | "+" | "-";      // default "both"
    gcRange?: [number, number];       // default [20, 80]
    maxSeedHomopolymerRun?: number;   // seed = PAM-proximal 12 bp, default 4
    offTargetMoleculeIds?: string[];  // workspace molecules to scan
    maxOffTargetMismatches?: number;  // default 3
  };
};
```

Input rules:

- `targetRegion.start <= targetRegion.end` is required in CR1.
- Circular wraparound target regions are rejected in CR1.
- Molecule alphabet must be DNA-compatible.
- `pamType` is only `"SpCas9"` in CR1.
- `guideLength` must be 20 in CR1 unless a later PAM model explicitly supports
  another length.

### Output

```ts
type GuideCandidate = {
  sequence: string;       // 20 bp protospacer, no PAM, guide orientation
  pam: string;            // observed PAM in guide orientation
  strand: "+" | "-";
  start: number;          // 1-based inclusive molecule coordinate
  end: number;            // 1-based inclusive molecule coordinate
  pamStart: number;
  pamEnd: number;
  gcPercent: number;
  seedRegionMaxHomopolymer: number;
  offTargets?: OffTargetHit[];
  passingFilters: boolean;
  filterFailures: string[];
};

type OffTargetHit = {
  moleculeId: string;
  start: number;
  end: number;
  strand: "+" | "-";
  pam: string;
  mismatches: number;     // protospacer mismatches only
  seedMismatches: number; // PAM-proximal 12 bp mismatches
};

type DesignGrnasResult = {
  moleculeId: string;
  targetRegion: { start: number; end: number };
  pamType: "SpCas9";
  offTargetScope: "workspace_molecules_only";
  candidates: GuideCandidate[];
};
```

Candidate ordering:

```text
passingFilters first
then fewer off-target hits
then higher GC closeness to 50%
then coordinate order
then strand "+" before "-"
```

This is deterministic ranking, not biological efficacy scoring.

The default GC range `[20, 80]` is a permissive first-pass filter. Agents may
tighten this range for demanding SpCas9 design tasks; guides around 40-70% GC
are often preferable in efficiency screens, but CR1 does not treat that as an
efficacy score.

### Off-Target Scan

For each guide:

1. Scan each requested workspace molecule on both strands.
2. Consider only sites with a compatible SpCas9 PAM.
3. Count mismatches across the 20 bp protospacer in guide orientation.
4. Include hits with `mismatches <= maxOffTargetMismatches`.
5. Count seed mismatches separately in the PAM-proximal 12 bp.

Exclude the on-target site from `offTargets`. If `offTargetMoleculeIds` includes
the source molecule, skip the exact on-target protospacer plus PAM at the
candidate coordinates. A 0-mismatch hit at the designed locus is not an
off-target and should not appear in the result.

### Tests

- Plus-strand NGG candidate coordinates and sequence are pinned.
- Minus-strand CCN candidate coordinates and reverse-complement guide sequence
  are pinned.
- GC filter marks out-of-range guides.
- Seed homopolymer filter marks guides exceeding the maximum run.
- Off-target detection finds a synthetic two-mismatch hit in another workspace
  molecule.
- Off-target detection excludes the on-target site even when the source molecule
  is included in `offTargetMoleculeIds`.
- Workspace-scale scope is reported as `workspace_molecules_only`.

## CR2: Validated On-Target Scoring

Do not implement Doench Rule Set 2 as an unvalidated transcription task.

Before adding an `onTargetScore` field:

1. Pin the exact coefficient source and license.
2. Pin the exact model input sequence convention, including required flanking
   context around the protospacer and PAM.
3. Add a fixture with 5-10 published or reference-score guides.
4. Validate scores to a documented tolerance before exposing them through MCP.

Until this gate is complete, CR1 should not return a fake score or a heuristic
score labeled as Doench RS2.

## Scope Boundaries

| Feature | W2 | CR1 | Deferred |
|---|---:|---:|---:|
| Amplification primer pairs | yes | no | no |
| Restriction adapter overhangs | yes | no | no |
| Gibson/overlap primer design | no | no | `simulate_assembly` |
| Sequencing/mutagenesis primers | no | no | later |
| SpCas9 NGG guide extraction | no | yes | no |
| Cas12a / SaCas9 PAM types | no | no | later |
| Deterministic GC/homopolymer filters | no | yes | no |
| Doench RS2 scoring | no | no | CR2 after validation |
| Off-target vs workspace molecules | no | yes | no |
| Genome-scale off-target search | no | no | cas-offinder or equivalent |

## Ownership And Sequence

You can implement W2 and CR1 independently of P5 `align_sequences`.

Recommended sequence:

1. W2 `design_primers`.
2. CR1 `design_grnas` scaffold.
3. CR2 scoring only after reference-score validation.

W2 should land first because the Primer3 subprocess pattern, dependency error
shape, and candidate-output style will give CR1 a cleaner implementation model.
