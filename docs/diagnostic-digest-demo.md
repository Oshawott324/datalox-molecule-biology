# D1: Diagnostic Digest Demo Design Document

This document defines the biological and computational parameters for the D1
demo. The demo is falsifiable: expected fragment sizes are derived from actual
sequence construction, and the demo script must verify them by running the
deterministic tools.

## Scenario

We model a synthetic 700 bp payload inserted into the EcoRI/BamHI-opened pUC19
backbone. The demo distinguishes three construct states:

```text
1. Empty vector: pUC19 only, 2686 bp
2. Forward orientation control: pUC19 + insert in forward direction, 3365 bp
3. Reverse orientation control: pUC19 + insert in reverse-complement direction, 3365 bp
```

Important biological boundary: EcoRI/BamHI cloning is directional in normal
wet-lab ligation because the sticky ends are incompatible. The reverse
orientation is included here as an in-silico orientation-control state for the
agent demo, not as a likely colony outcome from a standard EcoRI/BamHI
directional clone.

## Insert Fixture

The insert file is:

```text
fixtures/fasta/datalox_insert_v1.fa
```

The FASTA sequence is the payload only. It does not include EcoRI or BamHI
recognition sites.

Pinned properties:

| Property | Value |
|---|---|
| Name | `datalox_insert_v1` |
| Length | 700 bp |
| GC content | 50.143% |
| Max homopolymer run | 1 |
| Internal diagnostic site | XhoI (`CTCGAG`) |
| XhoI recognition coordinates | insert positions 250..255 |
| XhoI cut position | insert position 250 |

The sequence is `ACACGTGT` repeated, with `CTCGAG` spliced at insert positions
250..255. Verification against all 20 panel enzymes returns exactly one site:
XhoI at cut position 250.

Required verification before D1 code changes:

```ts
findRestrictionSites(insertWorkspacePath, insertMoleculeId, Object.keys(RESTRICTION_ENZYMES))
```

Expected result:

```json
[{ "enzyme": "XhoI", "start": 250, "end": 255, "cutPosition": 250 }]
```

Any other site requires redesigning the payload.

## Construct States

The recombinant sequences are assembled from pUC19 and the payload:

```text
pUC19 vector cuts:
  EcoRI cutPosition 396 (cut between 396 and 397)
  BamHI cutPosition 417 (cut between 417 and 418)
  Removed MCS fragment: pUC19[397..417] = 21 bp

Empty vector: pUC19 = 2686 bp
Forward:      pUC19[1..396] + INSERT[1..700]          + pUC19[418..2686] = 3365 bp
Reverse:      pUC19[1..396] + revcomp(INSERT[1..700]) + pUC19[418..2686] = 3365 bp
```

Because the payload FASTA is payload-only, the EcoRI and BamHI recognition sites
are not assumed to be regenerated at the junctions. The demo must therefore not
use EcoRI or BamHI as diagnostic enzymes in the recombinant constructs unless a
future fixture explicitly models regenerated junction sites.

The D1 script should write the recombinant constructs as circular GenBank
records before importing them with `open_sequence`. FASTA import defaults to
linear topology and would give the wrong digest model for plasmids.

Molecule IDs:

```text
mol_empty      pUC19, 2686 bp circular DNA
mol_forward    pUC19 + payload, forward orientation, 3365 bp circular DNA
mol_reverse    pUC19 + payload, reverse orientation, 3365 bp circular DNA
```

## Diagnostic Enzyme Pair

### Choice: HindIII + XhoI

HindIII is retained in the pUC19 backbone outside the EcoRI/BamHI-excised
fragment. XhoI is present once in the insert and absent from pUC19.

| Enzyme | Empty pUC19 | Forward construct | Reverse construct |
|---|---|---|---|
| HindIII | 447 | 1126 | 1126 |
| XhoI | absent | 646 | 842 |

Coordinate derivation:

```text
pUC19 position 418 maps to recombinant position 1097
HindIII pUC19 position 447 maps to 1126
Forward XhoI maps to 396 + 250 = 646
Reverse XhoI maps to 396 + 446 = 842
```

The reverse XhoI start is 842 because reverse-complementing a 700 bp insert
moves the palindromic XhoI recognition sequence from original positions
250..255 to reversed positions 446..451.

### Expected Fragment Sizes

The demo script must verify these by running `simulateDigest` on circular
constructs.

| Condition | HindIII cut | XhoI cut | Expected fragments |
|---|---:|---:|---|
| Empty vector | 447 | absent | `[2686]` |
| Forward orientation | 1126 | 646 | `[480, 2885]` |
| Reverse orientation | 1126 | 842 | `[284, 3081]` |

Fragment-size checks should compare sorted fragment sizes because digest
fragment order is a coordinate traversal detail.

### Acceptance Rule

A diagnostic enzyme pair is accepted for this demo if and only if:

1. All diagnostic small bands are at least 250 bp.
2. The forward and reverse small bands differ by at least 150 bp.
3. The orientation pattern is distinguishable by the small-band position alone.
4. The empty vector pattern is visibly distinct as a single full-length band.
5. No conclusion relies on fragments at or below 100 bp.

HindIII + XhoI passes:

```text
Empty:   [2686]
Forward: [480, 2885]
Reverse: [284, 3081]

Small-band difference: 196 bp
Small-band ratio: 1.69x
```

### Gel Rendering

Use the default ladder or this compact ladder:

```json
"customLadder": [100, 250, 500, 1000, 2000, 3000, 5000]
```

Lane order:

```text
Lane 1: Ladder
Lane 2: Empty vector        (HindIII + XhoI)
Lane 3: Forward orientation (HindIII + XhoI)
Lane 4: Reverse orientation (HindIII + XhoI)
```

## D1 Demo Script: `demo:diagnostic-digest:mcp`

Script location:

```text
scripts/demo-diagnostic-digest-mcp.mjs
```

Step sequence:

1. Import pUC19 fixture as `mol_empty`.
2. Read pUC19 sequence via `get_sequence_context`.
3. Load `fixtures/fasta/datalox_insert_v1.fa`.
4. Construct forward and reverse circular plasmid sequences exactly as specified
   above.
5. Write temporary circular GenBank records for `mol_forward` and `mol_reverse`.
6. Import both recombinant GenBank records with `open_sequence`.
7. For each molecule, call `find_restriction_sites(["HindIII", "XhoI"])`.
8. For each molecule, call `simulate_digest(["HindIII", "XhoI"])`.
9. Assert sorted fragment sizes match this document.
10. Build gel lanes from `simulate_digest`; call `render_digest_gel`.
11. Build cut-site arrays from `find_restriction_sites`; call
    `render_plasmid_map` for each molecule with `cutSites` and
    `showPrimers: false`.
12. Call `validate_workspace`.
13. Pack and verify a replay bundle.
14. Print a camera-readable summary.

## Camera-Readable Summary

```text
Replay verified
Scenario: pUC19 diagnostic digest orientation-control demo
Insert:   datalox_insert_v1, 700 bp payload, XhoI at insert cut position 250
Enzyme pair: HindIII + XhoI

Molecule   Size    HindIII+XhoI fragments
empty      2686    [2686]
forward    3365    [480, 2885]
reverse    3365    [284, 3081]

Gel artifact: reports/gels/diagnostic_digest.gel.svg
Map artifacts: reports/maps/<molecule>.plasmid.svg
Replay bundle verified
Bundle: .datalox/replay-bundles/<id>
```

## Falsifiability

If `simulateDigest` returns fragment sizes different from those in this
document, the construct sequence, topology, or enzyme coordinates are wrong. The
demo must fail loudly instead of continuing.

## Candidate Enzyme Evaluation

The D1 replay should document that the selected pair was chosen from simulated
candidates. Minimum candidates to evaluate:

| Pair | Empty bands | Forward bands | Reverse bands | Verdict |
|---|---|---|---|---|
| HindIII + XhoI | `[2686]` | `[480, 2885]` | `[284, 3081]` | Selected |
| XbaI + XhoI | tool-computed | tool-computed | tool-computed | Candidate |
| PstI + XhoI | tool-computed | tool-computed | tool-computed | Candidate |

The selected pair should be justified by tool output, not by memory.
The implemented selection rule is:

```text
1. Keep only pairs that pass the acceptance rule.
2. Select the pair with the largest minimum orientation small band.
3. Break ties by larger forward-vs-reverse small-band difference.
4. Break remaining ties by lexical pair name for determinism.
```

## What This Demo Does Not Do

- Does not claim reverse orientation is a normal EcoRI/BamHI cloning product.
- Does not import a natural gene sequence as the insert.
- Does not model incomplete digestion or star activity.
- Does not model supercoiled vs. linear gel migration differences.
- Does not include primer design.
- Does not call a synthesis vendor.
