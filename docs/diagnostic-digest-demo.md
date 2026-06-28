# D1: Diagnostic Digest Demo — Design Document

This document defines all biological and computational parameters for the D1
demo before any code is written. The demo is falsifiable: the expected fragment
sizes are derived from the insert sequence, and the demo script verifies them
by running the deterministic tools.

## Scenario

We cloned a synthetic insert into pUC19 at EcoRI/BamHI. Design a diagnostic
digest to distinguish three colony outcomes:

```text
1. Empty vector (no insert): pUC19 only, 2686 bp
2. Correct orientation: pUC19 + insert in forward direction, 3365 bp
3. Reverse orientation: pUC19 + insert in reverse direction, 3365 bp
```

## Insert Design

### Parameters

| Property | Value |
|---|---|
| Name | `datalox_insert_v1` |
| Length | 700 bp |
| GC content | 48–52% |
| Cloning sites | EcoRI left end / BamHI right end |
| Internal diagnostic site | XhoI (CTCGAG), recognition at insert positions 250–255 |
| XhoI cut position in insert | 250 (between insert bp 250 and 251) |

XhoI (CTCGAG) is **confirmed absent from pUC19** by `findRestrictionSites` on
the fixture. It is a palindromic 6-cutter present in both insert orientations.
The cut at position 250 is deliberately asymmetric within the 700 bp insert:
250 bp on the EcoRI side, 450 bp on the BamHI side.

### Sequence requirements

The insert sequence file lives at:

```text
fixtures/fasta/datalox_insert_v1.fa
```

Requirements:

- Exactly 700 bp
- Bases 250–255 (1-based, inclusive) = `CTCGAG`
- No other occurrences of `CTCGAG` in the insert
- No sites for any other panel enzyme:
  ApaI, BglII, ClaI, EcoRI, BamHI, HindIII, KpnI, NcoI, NdeI, NheI, NotI,
  PstI, SacI, SalI, SmaI, SpeI, SphI, XbaI, XmaI
- GC content 48–52%
- No homopolymer run > 6 bp

### Verification step (required before D1 code)

Import the insert as a workspace molecule and run:

```ts
findRestrictionSites(insertWorkspacePath, insertMoleculeId, [...all20enzymes])
```

Expected result: exactly one site, `XhoI` at insert position 250. Any other
site requires a redesign of the flanking sequence.

## Three Molecule States

### Construction

The recombinant sequences are assembled from pUC19 and insert:

```text
pUC19 cloning junction:
  EcoRI cutPosition 396 (cut between 396 and 397)
  BamHI cutPosition 417 (cut between 417 and 418)
  Removed MCS fragment: pUC19[397..417] = 21 bp

Empty vector:  pUC19 (2686 bp, from fixture)
Correct:       pUC19[1..396] + INSERT[1..700]  + pUC19[418..2686] = 3365 bp
Reverse:       pUC19[1..396] + revcomp(INSERT) + pUC19[418..2686] = 3365 bp
```

EcoRI is regenerated at both cloning junctions. XhoI is present once in the
insert in both orientations (it is palindromic).

### Molecule IDs

```text
mol_empty      pUC19 2686 bp
mol_correct    pUC19 + insert (forward) 3365 bp
mol_reverse    pUC19 + insert (reverse) 3365 bp
```

## Diagnostic Enzyme Pair

### Choice: EcoRI + XhoI

| Enzyme | pUC19 site | Recombinant sites |
|---|---|---|
| EcoRI | 396 | 396 (regenerated cloning junction) |
| XhoI | none (verified) | 646 (correct) / 841 (reverse) |

### Expected Fragment Sizes

Computed from the parameters above. The demo script must verify these by
running `simulateDigest` and asserting the results.

| Condition | EcoRI cut | XhoI cut | Fragment 1 | Fragment 2 |
|---|---|---|---|---|
| Empty vector | 396 | — | 2686 bp | — |
| Correct orientation | 396 | 646 | 250 bp | 3115 bp |
| Reverse orientation | 396 | 841 | 445 bp | 2920 bp |

XhoI cut positions in recombinant coordinates:
- Correct: insert position 250 → recombinant position 397 + 250 − 1 = 646
- Reverse: XhoI site is at position 445 of the reversed insert → recombinant
  position 397 + 445 − 1 = 841

### Acceptance Rule

A diagnostic enzyme pair is accepted for the demo if and only if:

1. All fragments are ≥ 250 bp (within the default ladder range or covered by
   a custom ladder starting at 100 bp)
2. The small fragments across all three conditions differ by ≥ 150 bp from
   each other, producing a visually unambiguous gel pattern
3. The pattern for correct vs. reverse is distinguishable by the small-band
   position alone (the large bands are secondary confirmation)
4. No reliance on fragments ≤ 100 bp

EcoRI + XhoI passes this rule:
- Empty: 1 band at 2686 bp (no small band)
- Correct small band: 250 bp
- Reverse small band: 445 bp
- Difference: 195 bp ✓, ratio 1.78× ✓

### Gel Rendering

Use a custom ladder to keep the 250 bp band calibrated:

```json
"customLadder": [100, 250, 500, 1000, 2000, 3000, 5000]
```

Lane order:

```text
Lane 1: Ladder
Lane 2: Empty vector   (EcoRI + XhoI)
Lane 3: Correct insert (EcoRI + XhoI)
Lane 4: Reverse insert (EcoRI + XhoI)
```

## D1 Demo Script: `demo:diagnostic-digest:mcp`

### Script location

```text
scripts/demo-diagnostic-digest-mcp.mjs
```

### Step sequence

1. Import pUC19 fixture → `mol_empty`
2. Get pUC19 sequence via `get_sequence_context`
3. Load insert FASTA (700 bp) → build correct and reverse sequences
4. Write sequences to temp files; import via `open_sequence` → `mol_correct`, `mol_reverse`
5. For each molecule: `find_restriction_sites(["EcoRI","XhoI"])` → collect cut positions
6. For each molecule: `simulate_digest(["EcoRI","XhoI"])` → collect fragment sizes
7. Assert fragment sizes match the values in this document
8. Build gel lanes from `simulateDigest` results; call `render_digest_gel`
9. Build cut-site arrays from `findRestrictionSites` results; call `render_plasmid_map`
   for each molecule with `cutSites` and `showPrimers: false`
10. Call `validate_workspace` for each molecule
11. Pack and verify replay bundle via CLI replay tools
12. Print camera-readable summary

### Camera-readable summary format

```text
Replay verified
Scenario: pUC19 diagnostic digest (3 colony outcomes)
Insert:   datalox_insert_v1, 700 bp, XhoI at 250 bp from EcoRI junction
Enzyme pair: EcoRI + XhoI

Molecule   Size    EcoRI+XhoI fragments
empty      2686    [2686]
correct    3365    [250, 3115]
reverse    3365    [445, 2920]

Gel artifact:   reports/gels/diagnostic_digest.gel.svg
4 tool calls per molecule × 3 molecules
Replay bundle verified
Bundle: .datalox/replay-bundles/<id>
```

### Falsifiability

If `simulateDigest` returns fragment sizes different from those in this
document, the insert sequence or enzyme positions are wrong. The demo must
fail loudly (throw, not continue) so the discrepancy is visible.

## Candidate Enzyme Evaluation (for D1 step 4 replay justification)

The agent reasoning in D1 step 4 should document that alternative enzyme
pairs were evaluated. Minimum candidates to record:

| Pair | Empty bands | Correct bands | Reverse bands | Verdict |
|---|---|---|---|---|
| EcoRI + XhoI | 2686 | 250 + 3115 | 445 + 2920 | **Selected** |
| EcoRI + SpeI | TBD (SpeI absent from pUC19) | TBD | TBD | Candidate |
| EcoRI + NheI | TBD (NheI absent from pUC19) | TBD | TBD | Candidate |

EcoRI + XhoI is selected because:
- Both enzymes verified as single-cutters in the relevant molecules
- All fragments ≥ 250 bp
- Small-band difference 195 bp, ratio 1.78×

The D1 demo does NOT need to actually evaluate the alternates programmatically;
it may document the reasoning inline. If the demo script evaluates all
candidate pairs via `simulateDigest`, that is preferred.

## What This Demo Does Not Do

- Does not import a natural gene sequence as the insert
- Does not model incomplete digestion or star activity
- Does not model supercoiled vs. linear gel migration differences
- Does not include primer design (P5 / W2 scope)
- Does not call a real synthesis vendor
