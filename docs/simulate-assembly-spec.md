# W3 `simulate_assembly` Spec

Status: specification pinned; implementation pending.

This document scopes W3 as deterministic restriction-ligation simulation only.
Gibson, Golden Gate, Gateway, In-Fusion, overlap-primer design, and wet-lab
protocol planning remain out of scope.

The goal is an agent-callable tool that answers a narrow question:

```text
Given explicit vector and insert molecules and explicit restriction enzymes,
what sequence product(s) are produced by ligating compatible restriction ends?
```

The tool must not guess enzyme chemistry, choose cloning strategies, or invent
assembly products when the input is ambiguous.

## Boundary

### In Scope

- Restriction ligation using enzymes in a verified ligation-end table.
- Linearizing a circular vector with one or two cuts.
- Excising an insert fragment with one or two cuts.
- Checking end compatibility deterministically.
- Constructing candidate product sequences.
- Returning structured candidates and a `nextAction` for explicit persistence.

### Out Of Scope

- Gibson assembly.
- Golden Gate / Type IIS assembly.
- Gateway / recombinase systems.
- Blunt-end efficiency modeling.
- Methylation sensitivity.
- Partial digests.
- CIP/dephosphorylation, ligase concentration, insert:vector ratio, or any wet
  lab yield prediction.
- Automatic strategy design. Agents may search strategies by calling existing
  tools, but `simulate_assembly` consumes explicit inputs.

## Required Enzyme Metadata

The current `RESTRICTION_ENZYMES` table has `recognitionSequence` and
`cutOffset`. That is sufficient for `find_restriction_sites` and
`simulate_digest`, but not sufficient for faithful ligation-end modeling.

W3 must add a verified ligation profile for every supported enzyme:

```ts
type RestrictionLigationProfile = {
  enzyme: string;
  recognitionSequence: string;
  topCutOffset: number;    // cut after this many bases on the recognition top strand
  bottomCutOffset: number; // cut after this many bases on the recognition bottom strand
  endType: "five_prime_overhang" | "three_prime_overhang" | "blunt";
  overhangSequence: string; // top-strand overhang in recognition orientation; "" for blunt
  source: "NEB" | "REBASE";
};
```

Do not infer `bottomCutOffset`, `endType`, or `overhangSequence` from memory or
from `cutOffset`. Add profiles only after source verification. Enzymes without a
verified ligation profile return `UNSUPPORTED_ENZYME_PROFILE`.

Compatibility rule:

```text
Two ends are compatible when endType matches and their annealing overhangs are
reverse complements, or when both are blunt.
```

Examples that must be pinned:

```text
EcoRI  G^AATTC / CTTAA^G  -> 5' overhang AATT
BamHI  G^GATCC / CCTAG^G  -> 5' overhang GATC
BglII  A^GATCT / TCTAG^A  -> 5' overhang GATC, compatible with BamHI
SmaI   CCC^GGG / GGG^CCC  -> blunt
XmaI   C^CCGGG / GGGCC^C  -> 5' overhang CCGG
```

## Tool Contract

Tool name:

```text
simulate_assembly
```

CLI:

```text
molecule-biology simulate-assembly --input assembly.json
```

The CLI should take a JSON file path, matching `render-digest-gel --lanes` and
`render-plasmid-map --cut-sites`, because the input is structured.

### Input

```ts
type SimulateAssemblyInput = {
  workspacePath: string;
  method: "restriction_ligation";
  vector: {
    moleculeId: string;
    leftEnzyme: string;
    rightEnzyme?: string; // omitted means single-cut vector
    backbone?: "largest_fragment"; // W3 only supports largest fragment
  };
  insert: {
    moleculeId: string;
    leftEnzyme: string;
    rightEnzyme?: string; // omitted means single-cut insert
    fragment?: "largest_fragment"; // W3 only supports largest fragment
    orientation?: "forward" | "reverse" | "both"; // default "forward"
  };
  product?: {
    moleculeId?: string;
    name?: string;
    topology?: "circular" | "linear"; // default "circular"
  };
};
```

Input rules:

- `method` must be `"restriction_ligation"` in W3.
- All molecule IDs must resolve inside the same workspace.
- Vector and insert molecules must be DNA with `iupac_dna` alphabet.
- All enzymes must exist in both the restriction enzyme table and the ligation
  profile table.
- W3 supports one or two cuts per vector and one or two cuts per insert.
- W3 rejects more than two cut sites for any selected enzyme on a molecule with
  `AMBIGUOUS_CUT_SITES`.
- W3 rejects missing cut sites with `NO_CUT_SITE`.
- W3 rejects incompatible ends with `INCOMPATIBLE_RESTRICTION_ENDS`.
- W3 does not mutate workspace state.

The tool is intentionally read-only. It returns candidate product sequences and
a `nextAction` that tells the agent how to persist the chosen product by writing
the returned GenBank artifact through `open_sequence` with `expectedRevision`.
This preserves the existing explicit workspace-write pattern.

## Coordinate Rules

All public coordinates are 1-based inclusive. Internal sequence construction
may use 0-based JavaScript slices, but output must report 1-based coordinates.

For an enzyme site:

```text
cutIndex = number of bases before the top-strand cut
left segment ends at cutIndex
right segment starts at cutIndex + 1
```

This matches the existing `RestrictionSite.cutIndex` convention.

For circular molecules, sequence fragments may wrap around the origin. The
returned `sourceSegments` must list one or two plus-strand segments in molecule
coordinates so agents can audit exactly where the product came from.

## Fragment Selection

W3 only supports the deterministic `"largest_fragment"` selector.

Vector:

- One cut in circular vector: the vector backbone is the full linearized vector.
- Two cuts in circular vector: compute both circular digest fragments and choose
  the largest fragment as the backbone.
- Linear vector: one or two cuts produce linear fragments; choose the largest
  fragment.
- Ties return `AMBIGUOUS_FRAGMENT_SELECTION`, not an arbitrary choice.

Insert:

- One cut in circular insert: the insert fragment is the full linearized insert.
- Two cuts in circular insert: choose the largest fragment.
- Linear insert: one or two cuts produce linear fragments; choose the largest
  fragment.
- Ties return `AMBIGUOUS_FRAGMENT_SELECTION`.

If an agent wants a smaller insert fragment, it should first create a dedicated
workspace molecule for that fragment or W3 should later add explicit
`fragmentStart` / `fragmentEnd` inputs. W3 must not guess intent.

## End Model

Each selected fragment has two ordered ends:

```ts
type RestrictionFragmentEnd = {
  sourceMoleculeId: string;
  enzyme: string;
  side: "left" | "right";
  endType: "five_prime_overhang" | "three_prime_overhang" | "blunt";
  overhangSequence: string;
  compatibleWith: string[];
};
```

For a double-digested vector and insert:

```text
vector.left must be compatible with insert.right
insert.left must be compatible with vector.right
```

For a single-cut vector and single-cut insert, compatible ends can ligate in two
orientations. If `insert.orientation` is `"both"`, return both forward and
reverse candidates. If orientation is `"forward"` or `"reverse"`, return only
that candidate after compatibility checks.

For directional cloning with two different incompatible ends, reverse
orientation should usually fail because the ends do not match. This is a
biological feature, not an error in the tool.

## Product Sequence Construction

Restriction ligation joins fragment ends at the cut points. The product sequence
is deterministic string construction:

```text
product = vector backbone segment + insert fragment segment
```

The chosen orientation determines whether the insert fragment is used as-is or
reverse-complemented.

W3 must report junctions explicitly:

```ts
type AssemblyJunction = {
  leftSource: { moleculeId: string; enzyme: string; side: "left" | "right" };
  rightSource: { moleculeId: string; enzyme: string; side: "left" | "right" };
  compatible: true;
  endType: "five_prime_overhang" | "three_prime_overhang" | "blunt";
  overhangSequence: string;
  regeneratedRecognitionSequence?: string;
};
```

`regeneratedRecognitionSequence` is present only when the joined sequence
contains the original recognition sequence across the junction. Do not assume
mixed compatible ends regenerate a site; for example BamHI + BglII compatible
ends produce a scar that is not necessarily either original recognition site.

## Output

```ts
type SimulateAssemblyResult = {
  method: "restriction_ligation";
  workspacePath: string;
  vector: AssemblyInputSummary;
  insert: AssemblyInputSummary;
  candidates: AssemblyCandidate[];
  nextAction: {
    tool: "open_sequence";
    instruction: "Choose one candidate GenBank artifact, then call open_sequence with expectedRevision to persist it.";
  };
};

type AssemblyCandidate = {
  candidateId: string;
  name: string;
  topology: "circular" | "linear";
  length: number;
  sequenceDigest: string;
  orientation: "forward" | "reverse";
  sourceSegments: Array<{
    role: "vector_backbone" | "insert";
    moleculeId: string;
    segments: Array<{ start: number; end: number; strand: "+" | "-" }>;
  }>;
  ends: RestrictionFragmentEnd[];
  junctions: AssemblyJunction[];
  artifacts: Array<{
    kind: "genbank";
    path: string;
    mimeType: "chemical/x-genbank";
    description: string;
  }>;
};
```

The tool writes candidate GenBank files under:

```text
reports/assembly/<candidateId>.gb
```

Artifact paths are confined to the workspace root using the same convention as
`export_genbank`, `render_plasmid_map`, and `render_digest_gel`.

## Error Codes

Use structured errors intended for agents:

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENT` | Malformed input, unsupported method, invalid orientation, or invalid product options |
| `MOLECULE_NOT_FOUND` | Vector or insert molecule ID is absent |
| `ALPHABET_MISMATCH` | Molecule is not DNA / `iupac_dna` |
| `UNSUPPORTED_ENZYME_PROFILE` | Enzyme lacks verified ligation-end metadata |
| `NO_CUT_SITE` | Required enzyme does not cut the specified molecule |
| `AMBIGUOUS_CUT_SITES` | Required enzyme cuts more than the W3-supported count |
| `AMBIGUOUS_FRAGMENT_SELECTION` | Largest-fragment selection has a tie |
| `INCOMPATIBLE_RESTRICTION_ENDS` | Required ends cannot ligate |

Do not silently drop candidates. Return either all valid candidates requested by
the input or a structured error explaining why no faithful simulation exists.

## Implementation Files

Expected implementation files:

```text
src/core/assembly.ts          ← sequence construction and end compatibility
src/tools/handlers.ts         ← handleSimulateAssembly
src/tools/descriptors.ts      ← simulate_assembly descriptor
src/cli/main.ts               ← simulate-assembly command with --input JSON
src/index.ts                  ← exports
tests/assembly.test.ts        ← core + handler + CLI coverage
skills/molecule/SKILL.md      ← code-oriented usage examples
README.md                     ← tool table row
```

## Tests

Minimum tests before enabling MCP:

1. **EcoRI single-cut circular vector + EcoRI single-cut insert**
   - Compatible 5' AATT ends.
   - `orientation: "both"` returns two candidates.
   - Candidate lengths equal vector length + insert length.

2. **EcoRI/BamHI directional vector + EcoRI/BamHI insert**
   - Forward candidate succeeds.
   - Reverse orientation returns `INCOMPATIBLE_RESTRICTION_ENDS` or no reverse
     candidate when `"both"` is requested.
   - Product length equals vector backbone + insert fragment.

3. **BamHI + BglII compatible scar**
   - Ends are compatible through GATC.
   - Junction does not falsely claim regenerated BamHI or BglII unless the
     actual junction sequence contains the recognition sequence.

4. **SmaI blunt ligation**
   - Blunt ends are compatible.
   - `overhangSequence` is `""`.

5. **Incompatible ends**
   - EcoRI end cannot ligate to BamHI end.
   - Error is `INCOMPATIBLE_RESTRICTION_ENDS`.

6. **Unsupported profile**
   - Any enzyme added to the digest table without a ligation profile fails with
     `UNSUPPORTED_ENZYME_PROFILE`.

7. **Read-only behavior**
   - `simulate_assembly` writes GenBank artifacts but does not add molecules to
     `molecule.workspace.json`.
   - Persisting a candidate requires an explicit later `open_sequence` call with
     `expectedRevision`.

8. **Workspace confinement**
   - Candidate artifacts are written under `reports/assembly/`.
   - Output path traversal is not accepted.

## Agent Usage Pattern

Agents should compose tools explicitly:

```text
find_restriction_sites
-> simulate_digest
-> simulate_assembly
-> inspect candidates
-> open_sequence(candidate artifact, expectedRevision)
-> validate_workspace
-> render_plasmid_map / render_digest_gel
```

The assembly tool is not a planning wizard. It validates and simulates a
specified assembly. Strategy search belongs in agent code or a later MCP prompt.
