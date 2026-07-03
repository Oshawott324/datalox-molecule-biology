# SnapGene Basics, Agent-Native Roadmap

This document scopes the minimum SnapGene-like molecular biology experience that
Datalox should support without becoming a SnapGene clone.

The product frame is unchanged:

```text
agent intent
-> deterministic domain tools
-> revision-safe workspace state
-> recognizable scientific artifacts
-> replayable tool I/O
```

The goal is not a GUI wizard system. The goal is agent-callable deterministic
tools that produce visual artifacts molecular biologists recognize.

## Why This Matters

The MCP architecture is validated by the current repo and by the broader
bio-agent direction: agents need structured, deterministic tool environments
instead of answering quantitative biology questions from memory.

For a molecular biology demo, however, the visual language still matters. A
biologist expects to see:

- annotated plasmid/DNA map
- restriction enzyme cut sites
- feature tracks
- primer binding sites
- predicted gel bands
- sequence-level annotations

Datalox should borrow these basic affordances while keeping the agent-native
architecture as the product differentiator.

## SnapGene Basics We Should Mimic

### Annotation Layers

Three annotation layers should be visible and agent-addressable:

- **Features**: canonical workspace state, revision-safe writes.
- **Primers**: canonical workspace state, revision-safe writes, binding arrows
  when binding coordinates exist.
- **Restriction sites**: deterministic computed output from enzyme tools,
  visualized as map/sequence annotations. Do not persist every computed site in
  `molecule.workspace.json` unless a later saved-analysis object is introduced.

### Analysis Tools

These are natural MCP tools because they are deterministic and composable:

- ORF detection
- translation
- reverse complement
- restriction site search
- digest simulation
- PCR simulation
- gel rendering
- pairwise alignment

### Workflows

The first workflow should be agent-orchestrated diagnostic digest design:

```text
correct insert orientation
reverse insert orientation
empty vector
-> choose diagnostic enzyme or enzyme pair
-> simulate expected fragments
-> render gel lanes
-> render plasmid map
-> validate workspace
-> pack replay bundle
```

Do not build GUI cloning wizards in this cycle.

## What We Will Not Copy Yet

Out of scope for this cycle:

- Gibson, Golden Gate, Gateway, In-Fusion, and full restriction-ligation wizards
- full auto-annotation library on import
- Sanger chromatogram / AB1 viewer
- multi-sequence alignment viewer
- synthesis ordering
- registry / ELN system

These are roadmap items that should be pulled forward only for a specific
customer or demo need.

## Implementation Plan

### P0: Workspace-Relative GenBank Export

Status: **complete**.

Commit:

```text
dd74dc1 Resolve GenBank exports relative to workspace
```

`export_genbank` now resolves relative `outputPath` values from the workspace
root, not the process cwd. A regression test covers an agent-style path such as:

```text
reports/exports/relative.gb
```

### P3: Feature Type Color Conventions

Add stable biological colors to `src/core/render-map.ts` and reuse them in the
HTML editor feature table.

Suggested map:

```ts
const FEATURE_COLORS: Record<string, string> = {
  CDS: "#E9A227",
  gene: "#E9A227",
  promoter: "#4CAF50",
  terminator: "#E53935",
  rep_origin: "#78909C",
  primer_bind: "#AB47BC",
  RBS: "#29B6F6",
  regulatory: "#26A69A",
  misc_feature: "#90A4AE",
};

function featureColor(type: string): string {
  return FEATURE_COLORS[type] ?? "#546E7A";
}
```

Acceptance:

- pUC19 renders with recognizable colors.
- No source-verified biology data changes.
- SVG output changes only by expected color values.

### P1: `render_digest_gel`

Status: **complete**.

Add deterministic gel SVG rendering.

Core:

```text
src/core/render-gel.ts
```

Tool:

```text
render_digest_gel
```

CLI:

```text
render-digest-gel
```

Input:

```json
{
  "workspacePath": "...",
  "gelId": "puc19_digest",
  "lanes": [
    {
      "label": "EcoRI + HindIII",
      "fragments": [{ "size": 51 }, { "size": 2635 }]
    }
  ],
  "customLadder": [50, 100, 250, 500, 1000, 2000, 3000, 5000]
}
```

Default ladder:

```text
250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000 bp
```

Output:

- SVG at `reports/gels/<gelId>.gel.svg`
- `artifacts[{ kind: "gel", mimeType: "image/svg+xml", path }]`
- structured `bands[]` metadata with lane, fragment size, y-position, and
  out-of-ladder-range warnings

Migration model:

```text
linear digest/PCR fragments only
y-position scales with log10(fragment_size)
calibration range comes from the ladder min/max
```

Do not claim accurate supercoiled plasmid migration in this first version.

Acceptance:

- Same input produces byte-identical SVG.
- Band positions are log-scaled and pinned by tests.
- Ladder size labels are rendered in the SVG.
- Fragments outside the ladder range are marked in SVG and metadata instead of
  silently treated as normally calibrated bands.
- pUC19 digest fragments render in expected lane order.
- Output is confined to the workspace artifact directory.

### P2: Plasmid Map Overlay: Features, Primers, Cut Sites

Status: **complete**.

`render_plasmid_map` supports three visual layers:

1. Feature arcs
2. Primer binding arrows
3. Restriction cut-site ticks

Suggested input extension:

```json
{
  "workspacePath": "...",
  "moleculeId": "mol_puc19",
  "cutSites": [
    { "enzyme": "EcoRI", "position": 396 },
    { "enzyme": "HindIII", "position": 447 }
  ],
  "showPrimers": true
}
```

Layer rules:

- Backbone circle remains the base layer.
- Feature arcs use P3 feature colors.
- Primer arrows read binding segments from workspace when `showPrimers: true`.
- Primer arrow color encodes strand:
  - forward: blue
  - reverse: red
- Cut sites render as ticks on the backbone with enzyme labels outside.

Agent composition rule:

```text
find_restriction_sites -> render_plasmid_map(cutSites=..., showPrimers=true)
```

Do not make `render_plasmid_map` secretly compute enzyme sites. The agent should
compose deterministic tools explicitly. UI convenience routes may orchestrate the
same core calls internally.

Acceptance:

- pUC19 map shows `bla`, `ori`, `lacZalpha`, MCS, EcoRI, and HindIII at correct
  positions.
- Primer arrows appear when bound primers exist.
- No overlapping implementation shortcuts or coordinate heuristics.
- SVG geometry remains pinned by tests.

### D1: Diagnostic Digest MCP Demo

Status: **complete**.

Pre-condition: insert sequence designed and verified per
`docs/diagnostic-digest-demo.md`. That document defines the exact insert,
cloning coordinates, expected fragment sizes, and acceptance rule before any
demo code is written. The demo script is:

```text
demo:diagnostic-digest:mcp
```

Scenario:

```text
Model a synthetic insert in the EcoRI/BamHI-opened pUC19 backbone.
Design a diagnostic digest to distinguish:
1. forward orientation-control construct
2. reverse orientation-control construct
3. empty vector
```

The same payload should be modeled in two orientations, not described as two
different inserts. The reverse construct is an in-silico orientation-control
state for the demo; `docs/diagnostic-digest-demo.md` documents why this is not
claimed as a likely standard EcoRI/BamHI ligation product.

The agent/script should:

1. Open or construct the three expected molecule states.
2. Find candidate restriction sites.
3. Simulate diagnostic digests.
4. Select an enzyme or enzyme pair with distinguishable band patterns.
   *(This step is agent reasoning over the simulated fragment sizes, not a
   deterministic tool call. The agent evaluates which enzyme produces maximally
   different band patterns across the three conditions and justifies the choice
   in the replay. The selected pair should give clearly separated,
   distinguishable bands across all three construct states, and the script must
   verify the exact fragment sizes pinned in `docs/diagnostic-digest-demo.md`.)*
5. Render gel lanes for each scenario.
6. Render plasmid map with feature/cut-site overlays.
7. Validate the workspace.
8. Pack and verify a replay bundle.
9. Print a camera-readable replay summary.

Summary shape:

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
Map artifacts: reports/maps/<molecule>.diagnostic.svg
Replay bundle verified
Bundle: .datalox/replay-bundles/<id>
```

Acceptance:

- Demo runs from one npm command.
- Gel artifact and plasmid map artifact are returned in tool envelopes.
- Replay bundle verifies.
- Summary is concise enough to show on camera.

### P4: Static Dual-View Editor

Status: **complete**.

Update `src/ui/server.ts` after P1-P3 exist.

Target layout:

```text
left: plasmid map artifact
right: sequence region with annotations
below: feature / primer / restriction tables
```

Add or extend API route:

```text
GET /api/map?moleculeId=&enzymes=EcoRI,HindIII
```

The route may call:

```text
findRestrictionSites -> renderPlasmidMap
```

but must reuse the same core functions as MCP/CLI.

Sequence panel:

- feature spans
- primer binding spans
- enzyme-site markers
- same color conventions as the map

No click-to-highlight is required for this cycle.

Acceptance:

- Opening a pUC19 workspace shows map + sequence + tables without user
  interaction.
- All three annotation layers are visible.
- The UI is a review surface; deterministic tools remain the source of truth.

### P5: `align_sequences`

Status: **complete**.

Add deterministic pairwise alignment.

Core:

```text
src/core/align.ts
```

Tool:

```text
align_sequences
```

CLI:

```text
align-sequences
```

Algorithms:

```text
Needleman-Wunsch global alignment for similarly sized sequences
Smith-Waterman local alignment for reads or short sequences against larger molecules
```

Inputs:

- two raw sequence strings, or
- two workspace molecule IDs

Output:

- aligned sequence pair
- identity percentage
- mismatch positions
- gap count
- scoring parameters used
- mode used: global or local

Acceptance:

- Identical inputs produce 100% identity.
- Known single-base mismatch reports the correct position.
- Gap examples are pinned.
- Local alignment reports the correct target interval for a short read against a
  larger molecule.
- No network calls or heuristic post-processing.

P5 enables construct-verification workflows, but it does not block the diagnostic
digest demo unless the demo explicitly includes expected-vs-observed sequence
verification.

## Recommended Order

```text
P0 complete
P3 feature colors
P1 render_digest_gel
P2 map overlay
D1 diagnostic digest MCP demo
P4 static dual-view editor
P5 align_sequences
README / SKILL updates
```

If the next customer/demo priority becomes observed construct verification, move
P5 before D1.

## MVP Boundary

| Layer | In | Out |
|---|---|---|
| Workspace state | Features, primers, molecule sequence, revisions | Full construct registry, ELN, experiment database |
| Deterministic analysis | ORFs, translation, reverse complement, restriction sites, digest, PCR, gel rendering, basic pairwise alignment | Sanger chromatogram, BLAST-style homology, thermodynamics beyond basic exact tools |
| Visual artifacts | Plasmid map with features/primers/cut sites, annotated sequence region, gel SVG, replay summary | Full interactive cloning wizard, chromatogram view, multi-sequence alignment viewer |
| Workflows | Restriction cloning / diagnostic digest, agent-orchestrated | Gibson, Golden Gate, Gateway, In-Fusion GUI workflows |

## Roadmap Not For This Demo

| ID | Feature | Trigger |
|---|---|---|
| W1 | `find_known_features` auto-annotation against curated library | Customer/demo requires instant annotation on import |
| W2 | Primer3-backed `design_primers` | PCR or cloning design workflow needs primer design |
| W3 | `simulate_assembly` for restriction ligation | Construct design workflow moves beyond digest planning; spec in `docs/simulate-assembly-spec.md` |
| W4 | Sanger alignment with AB1/chromatogram | Sequencing-confirmation workflow |
| W5 | IDT/Twist synthesis export | Design-to-order pipeline |
| W6 | Full Gibson / Golden Gate / Gateway workflows | Specific customer demo or customer pull |
| CR1 | SpCas9 `design_grnas` scaffold | CRISPR guide-design workflow needs plasmid/workspace-scale guide candidates |
| CR2 | Validated CRISPR on-target scoring | Coefficient source, license, sequence-context convention, and reference scores are pinned |

Naming boundary: W-series is reserved for plasmid/cloning workflows, so W3
remains `simulate_assembly`. CRISPR work uses CR1/CR2 and should not be labeled
W3a/W3b.

## Human-in-the-Loop Patterns

### How SnapGene and Benchling Actually Gate Decisions

**SnapGene** has no server or async workflow. Every action is a human click. The
relevant analog for an agent system is not "when does the UI confirm" but "at
which biological decision points would a real biologist pause before proceeding."

**Benchling** adds approval authority: PI-level sign-off before constructs are
registered, ordered, or signed off in the lab notebook. The pattern is not
per-action confirmation but committed-state approval.

Checkpoints in real lab work:

| Decision point | Real lab behavior | Datalox form |
|---|---|---|
| Diagnostic gel interpretation | Biologist reads gel, decides if bands match expectation | Replay bundle with gel SVG + band table; reviewer confirms after agent run |
| Before primer ordering | Biologist checks Tm/GC/off-targets; PI approves order | `nextAction: { type: "await_human_review" }` on primer output (W2/W5 scope) |
| Sequencing verification gate | Biologist aligns Sanger to design; proceeds only on match | `verify_construct` prompt (P5 scope) |
| Before construct registration | PI or senior approves; Benchling locks registry entry | Revision gate + `annotate_construct` prompt (post-demo) |

### The Replay Bundle as the Scientific Record

For an agent-native environment, the replay bundle is the right audit gate — not
mid-session GUI confirmation clicks.

A replay bundle is the complete, verifiable record of every tool call and
observation in an agent session. It is the scientific record a PI can review
after the session — analogous to a signed lab notebook entry.

D1 demonstrates this pattern: after the agent selects a diagnostic enzyme and
renders gel lanes, the replay records which enzymes were evaluated, why the
selected enzyme was chosen, and what the predicted band patterns are. The human
reviews the replay afterward. There is no mid-session pause. This is a stronger
accountability story than a wizard-step confirmation click, and it is the right
demo narrative.

### Three MCP Prompts for Post-Demo Workflows

These are not in-scope for D1. Define them now so tool contracts (`expectedRevision`
gating, artifact paths) are consistent when they land.

**`plan_diagnostic_digest`**

Human describes the cloning scenario. Agent plans enzyme candidates, simulates
expected bands, and surfaces a preview. Human approves before simulation is
committed to the workspace and replay is packed.

```text
Input: scenario description (molecule IDs, insert orientation variants)
Gate: agent presents candidates + predicted band sizes before workspace write
```

**`verify_construct`** *(depends on P5)*

Human provides expected molecule ID and observed Sanger sequence string. Agent
runs `align_sequences`, reports identity and mismatch positions, renders alignment
artifact. Human confirms pass/fail before workspace annotations update.

```text
Input: moleculeId (expected), sequenceString (observed Sanger result)
Gate: alignment artifact presented before upsert_features is called
```

**`annotate_construct`**

Agent identifies ORFs, restriction sites, and primer binding sites from sequence
analysis. Presents proposed annotations with tool-call evidence. Human approves
before `upsert_features` is called with `expectedRevision`.

```text
Input: moleculeId
Gate: proposed feature list and evidence shown before workspace write
```

### What We Are Not Building in This Cycle

- Mid-session GUI wizard confirmation dialogs
- Per-tool approval clicks (SnapGene-style)
- Multi-user approval and co-authorship (Benchling registry) — W-series
- Synthesis ordering approval gate — W5; pre-design `await_human_review` as a
  `nextAction` type now so it slots cleanly into the envelope contract when
  ordering lands

## Competitive Framing Notes

SnapGene's history tracking is a GUI document-history and undo/redo feature. It
is useful for human editing, but it is not the same thing as this repo's
revision gates and replay bundles.

For agent-operated biology, the Datalox audit story should be framed as:

```text
expectedRevision gates every structured write
tool calls return structured envelopes
replay bundles capture the exact tool I/O
bundle verification proves the record was not silently changed
```

Do not describe this as "SnapGene-style history." It is a stronger audit model
for agent-driven workflows, even though it is not a familiar GUI history panel.

P5 `align_sequences` should support both global and local pairwise alignment.
Needleman-Wunsch global alignment is appropriate for similarly sized construct
versions. Smith-Waterman local alignment is required for Sanger reads, primer
annealing checks, and amplicon-vs-plasmid checks where one sequence is much
shorter than the other.

RNA/mRNA design is a separate future product track, not a bolt-on to plasmid
cloning. If mRNA therapeutics becomes a target segment, scope a separate track
for codon optimization, UTR design, cap/poly(A) considerations, modified bases,
and synthesis constraints.

## Decision Notes

- Keep map rendering deterministic and source-of-truth driven.
- Keep restriction sites as computed annotations unless saved-analysis state is
  explicitly designed.
- Keep UI as a review surface. The agent should call tools; the UI should show
  what those tools produced.
- Avoid cloning-wizard scope until a customer pull justifies it.
- Human-in-the-loop is a post-agent-run audit pattern, not a mid-session
  interruption. The replay bundle is the scientific record. MCP prompts are the
  workflow entry points.
