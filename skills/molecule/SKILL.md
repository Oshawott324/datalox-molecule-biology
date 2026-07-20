# Molecule Biology Workspace

Use this skill when working with molecular biology files or
`molecule.workspace.json` workspaces in this repository.

The environment is for agents. Use tools and deterministic code paths as the
source of truth. Do not infer sequence facts from screenshots or prose.

## Core Rules

- Always start with `open_sequence`, `open_workspace`, or `validate_workspace`.
- In MCP hosts, discover tools with `tools/list`; do not rely on memorized
  tool names when the server can report its current contract.
- Treat `molecule.workspace.json` as canonical state, but never patch it
  directly.
- Use `get_sequence_context` before making claims about a molecule sequence,
  feature, primer, or region.
- Use deterministic tools for ORFs, restriction enzymes, digests, PCR,
  Primer3-backed primer design, translation, reverse complement, GenBank
  export, and gel rendering.
- Every write must include the current `expectedRevision`.
- On `STALE_REVISION`, call `read_workspace` or `open_workspace`, inspect the
  new revision, then retry intentionally.
- Validate with `validate_workspace` before final response.
- Prefer writing short deterministic scripts when a task needs analysis that is
  not already exposed as a tool.
- Report changed object IDs, final revision, and validation status.

## MCP Server

Launch the stdio MCP server when an agent host needs live molecule biology
tools:

```bash
molecule-biology mcp-server
```

For local development before packaging, build first and launch the compiled CLI:

```bash
npm run build
node dist/src/cli/main.js mcp-server
```

The MCP server is a thin adapter over the same descriptors and handlers used by
the CLI. Use `tools/list` to discover available tools, then call tools through
the MCP host. Tool results return the same structured envelope used elsewhere:
`ok`, `agentContract`, `data`, `workspacePath`, `revision`, `nextAction`, or a
structured `error`.

Smoke-test the stdio server with code when host behavior matters:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/src/cli/main.js", "mcp-server"]
});
const client = new Client({ name: "molecule-smoke", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
if (!tools.tools.some((tool) => tool.name === "open_sequence")) {
  throw new Error("open_sequence not exposed by MCP server");
}

const result = await client.callTool({
  name: "reverse_complement",
  arguments: { sequence: "ACGT" }
});
if (result.isError) throw new Error(JSON.stringify(result.structuredContent));

await client.close();
```

Do not wrap MCP failures with local fallback behavior. Return or inspect the
structured tool error so the agent can choose the next action.

## First Loop

When given a FASTA or GenBank file:

```text
open_sequence
  -> get_sequence_context
  -> deterministic tool or structured write
  -> validate_workspace
```

Example:

```json
{
  "tool": "open_sequence",
  "arguments": {
    "inputPath": "/path/input.gb",
    "workspaceDir": "/path/run",
    "format": "genbank"
  }
}
```

Then use the returned `workspacePath`, `moleculeIds[0]`, and `revision`.

```json
{
  "tool": "get_sequence_context",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_example",
    "start": 1,
    "end": 500,
    "includeSequence": true
  }
}
```

## Existing Workspace Loop

When the user gives a workspace path:

```json
{
  "tool": "open_workspace",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json"
  }
}
```

If you need exact canonical state:

```json
{
  "tool": "read_workspace",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json"
  }
}
```

Use `list_molecules` to choose a molecule when the target is ambiguous.

## Structured Feature Edits

Do not edit `molecule.workspace.json` directly. Use `upsert_feature`.

```json
{
  "tool": "upsert_feature",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "expectedRevision": 0,
    "feature": {
      "id": "feat_promoter_001",
      "moleculeId": "mol_example",
      "name": "promoter",
      "type": "promoter",
      "segments": [
        { "start": 10, "end": 65, "strand": "+" }
      ],
      "qualifiers": {
        "note": "agent annotated from deterministic context"
      }
    }
  }
}
```

After every write:

```json
{
  "tool": "validate_workspace",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json"
  }
}
```

If the write returns `STALE_REVISION`, do not guess. Read the workspace,
compare the current state, and retry with the new revision only if the edit is
still correct.

## Structured Sequence Edits

Use `edit_sequence` to change molecule bases. Do not patch
`molecule.workspace.json`, do not overwrite `molecule.path`, and do not hand-edit
stored FASTA/GenBank files. `edit_sequence` writes a new stored sequence file,
updates the molecule digest, remaps features, and returns a complete
`featureImpact` list for the agent to inspect.

```json
{
  "tool": "edit_sequence",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_example",
    "expectedRevision": 2,
    "operation": "replace",
    "start": 396,
    "end": 401,
    "sequence": "GAATTC"
  }
}
```

After the call, inspect `featureImpact`. If a CDS has `frameShifted: true`, do
not silently repair it. Use the returned `nextAction` and call
`validate_workspace` before continuing.

If an edit lands inside a CDS but does not set `frameShifted`, the protein may
still change through a missense mutation or in-frame indel. Call
`translate_region` on the CDS to confirm the amino-acid consequence;
`edit_sequence` reports coordinates and reading-frame integrity only.

## Structured Primer Edits

Use `upsert_primer`. If exact binding should be computed, set
`bindToMolecule` to `true`.

```json
{
  "tool": "upsert_primer",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "expectedRevision": 1,
    "bindToMolecule": true,
    "primer": {
      "id": "primer_insert_fwd",
      "name": "insert_fwd",
      "sequence": "ACGTACGTACGTACGTACGT",
      "moleculeId": "mol_example"
    }
  }
}
```

Exact binding may return zero segments. That means no exact site was found; do
not invent a binding site.

## Deterministic Biology Tools

Use these tools instead of reasoning from memory:

- `reverse_complement`
- `translate_region`
- `find_orfs`
- `find_restriction_sites`
- `simulate_digest`
- `simulate_pcr`
- `simulate_assembly`
- `export_genbank`
- `render_digest_gel`
- `align_sequences`
- `design_primers`
- `design_grnas`
- `upsert_grna`
- `export_grna_report`

Examples:

```json
{
  "tool": "find_restriction_sites",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_example",
    "enzymes": ["EcoRI", "BamHI", "HindIII"]
  }
}
```

```json
{
  "tool": "simulate_pcr",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_example",
    "forwardPrimer": "ATGGGG",
    "reversePrimer": "CCCGG"
  }
}
```

```json
{
  "tool": "translate_region",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_example",
    "start": 100,
    "end": 450,
    "strand": "+",
    "geneticCode": "standard"
  }
}
```

Always compute fragment sizes from `simulate_digest` or `simulate_pcr` first,
then pass the results to `render_digest_gel`. Do not invent or guess fragment
sizes. Example for pUC19 EcoRI + HindIII (51 + 2635 bp, verified by the pinned
digest test):

```json
{
  "tool": "render_digest_gel",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "gelId": "diagnostic_digest",
    "lanes": [
      {
        "label": "EcoRI + HindIII",
        "fragments": [
          { "size": 51 },
          { "size": 2635 }
        ]
      }
    ],
    "customLadder": [50, 100, 250, 500, 1000, 2000, 3000, 5000]
  }
}
```

Use `customLadder` when expected fragments fall below the default ladder
minimum (250 bp). The default ladder is 250-10000 bp; a 51 bp fragment
requires a ladder starting at 50 bp or lower to be calibrated normally.
`render_digest_gel` uses the ladder as the calibrated range, adds ladder size
labels to the SVG, and marks fragments outside the ladder range with
`outOfLadderRange` / `rangeWarning` metadata.

Use `simulate_assembly` for W3 restriction-ligation candidate generation. This
tool is read-only with respect to workspace molecules: it resolves cut sites,
checks verified ligation-end compatibility, writes candidate GenBank artifacts,
and returns a concrete `open_sequence` next action when exactly one candidate is
produced. Persist a candidate only by calling `open_sequence` with the artifact
path and current `expectedRevision`.

```json
{
  "tool": "simulate_assembly",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "method": "restriction_ligation",
    "vector": {
      "moleculeId": "mol_vector",
      "leftEnzyme": "EcoRI",
      "rightEnzyme": "BamHI"
    },
    "insert": {
      "moleculeId": "mol_insert",
      "leftEnzyme": "EcoRI",
      "rightEnzyme": "BamHI",
      "orientation": "forward"
    },
    "product": {
      "moleculeId": "mol_candidate_product",
      "name": "candidate_product",
      "topology": "circular"
    }
  }
}
```

If `simulate_assembly` returns `NO_CUT_SITE`, `AMBIGUOUS_CUT_SITES`,
`AMBIGUOUS_FRAGMENT_SELECTION`, `UNSUPPORTED_ENZYME_PROFILE`, or
`INCOMPATIBLE_RESTRICTION_ENDS`, do not repair the result heuristically. Choose
different explicit enzymes/fragments or ask for a clarified cloning design.

Use `design_primers` when primer candidates are needed. This tool calls the
external `primer3_core` binary; if it is not installed, return the structured
`DEPENDENCY_MISSING` error to the user or agent instead of inventing primers.
The tool is read-only: it returns candidates, and the agent must explicitly
choose a candidate before calling `upsert_primer` with `expectedRevision`.

```json
{
  "tool": "design_primers",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_example",
    "target": { "start": 100, "end": 500 },
    "options": {
      "productSizeRange": [200, 1000],
      "tmRange": [57, 63],
      "primerSizeRange": [18, 27],
      "numReturn": 5,
      "leftOverhang": "GAATTC"
    }
  }
}
```

`target` means the interval that must be included inside the amplicon; Primer3
will normally place primers outside that interval. Overhangs are reported as
`sequenceWithOverhang` and are not part of Primer3's annealing-sequence scoring.

Use `align_sequences` for deterministic pairwise alignment. Use
`mode: "global"` for similarly sized constructs and `mode: "local"` when a
short observed sequence should align inside a larger molecule. Local mode
returns `queryAlignedStart`, `queryAlignedEnd`, `targetAlignedStart`, and
`targetAlignedEnd`.

```json
{
  "tool": "align_sequences",
  "arguments": {
    "sequence": "ACGT",
    "targetSequence": "TTTACGTTT",
    "mode": "local"
  }
}
```

For workspace molecules:

```json
{
  "tool": "align_sequences",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_observed_read",
    "targetMoleculeId": "mol_expected_construct",
    "mode": "local"
  }
}
```

Use `design_grnas` for CR1 SpCas9 guide candidates. This tool is deterministic
PAM scanning plus workspace-scale off-target reporting. It does not perform
genome-scale off-target search and does not return Doench or other efficacy
scores.

```json
{
  "tool": "design_grnas",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_example",
    "targetRegion": { "start": 100, "end": 500 },
    "options": {
      "pamType": "SpCas9",
      "strand": "both",
      "gcRange": [20, 80],
      "offTargetMoleculeIds": ["mol_example"],
      "maxOffTargetMismatches": 3
    }
  }
}
```

Interpret `offTargetScope: "workspace_molecules_only"` literally. If a user
needs genome-scale CRISPR safety, say that CR1 does not support it yet.

To persist a selected guide, call `upsert_grna` with `expectedRevision`. Do not
edit `molecule.workspace.json` directly and do not persist every candidate by
default. Select one candidate using its `rankingEvidence`, then write one guide
record.

```json
{
  "tool": "upsert_grna",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "expectedRevision": 0,
    "guide": {
      "id": "grna_example_1",
      "moleculeId": "mol_example",
      "name": "example guide 1",
      "sequence": "ACGTACGTACGTACGTACGT",
      "pam": "AGG",
      "strand": "+",
      "start": 100,
      "end": 119,
      "pamStart": 120,
      "pamEnd": 122,
      "pamType": "SpCas9",
      "gcPercent": 50,
      "seedRegionMaxHomopolymer": 1,
      "offTargetScope": "workspace_molecules_only",
      "offTargetHitCount": 0,
      "rankingEvidence": {
        "passingFilters": true,
        "filterFailures": [],
        "offTargetHitCount": 0,
        "gcDistanceFrom50": 0,
        "guideStart": 100,
        "strand": "+",
        "efficacyScoreIncluded": false
      },
      "sourceTool": "design_grnas"
    }
  }
}
```

To produce a human-readable guide summary artifact, call `export_grna_report`
on persisted guide ids. The report states the CR1 evidence boundary explicitly:
workspace-scale off-target count is included, genome-scale off-target search and
validated efficacy scoring are not.

```json
{
  "tool": "export_grna_report",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "guideIds": ["grna_example_1"],
    "outputPath": "reports/guides/grna_example_1.md"
  }
}
```

For plasmid maps with restriction ticks, call `find_restriction_sites` first and
pass the returned cut positions into `render_plasmid_map`. The renderer draws
caller-supplied annotations; it does not secretly compute enzyme sites.

```json
{
  "tool": "find_restriction_sites",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_puc19",
    "enzymes": ["EcoRI", "HindIII"]
  }
}
```

Then map each returned site to `{ "enzyme": site.enzyme, "position":
site.cutPosition }`:

```json
{
  "tool": "render_plasmid_map",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_puc19",
    "cutSites": [
      { "enzyme": "EcoRI", "position": 396 },
      { "enzyme": "HindIII", "position": 447 }
    ],
    "showPrimers": true
  }
}
```

`showPrimers: true` renders only primers that already have canonical
`binding.segments` in workspace state. If primer binding is needed, call
`upsert_primer` with `bindToMolecule: true` before rendering the map.
`showGuides: true` renders only guide records already persisted with
`upsert_grna`; it does not rerun `design_grnas`.

## Visual Context

Use `open_sequence_editor` only as a viewer/editor over workspace state.
Screenshots are not biological evidence.

```json
{
  "tool": "open_sequence_editor",
  "arguments": {
    "workspacePath": "/path/run/molecule.workspace.json",
    "moleculeId": "mol_example"
  }
}
```

If the UI shows something surprising, verify with `read_workspace`,
`get_sequence_context`, or a deterministic biology tool.

## Code-Oriented Analysis

When the request needs logic that is not a built-in tool, write explicit code
against the workspace and source sequence files. Keep it deterministic.

Pattern:

```ts
import { getSequenceContext, readWorkspace } from "./src/index.js";

const workspacePath = "/path/run/molecule.workspace.json";
const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
const moleculeId = workspace.molecules[0].id;
const context = await getSequenceContext(workspacePath, moleculeId, {
  includeSequence: true
});

if (!context.sequence) throw new Error("expected sequence context");
// Write explicit deterministic checks here.
```

Do not use ad hoc string parsing of `molecule.workspace.json` when a core API
or tool exists.

## Final Response Checklist

Before answering the user:

1. Validate the workspace.
2. Mention any changed feature or primer IDs.
3. Mention the final workspace revision.
4. Mention deterministic tools used.
5. State any unsupported biological operation clearly.

Do not claim support for SBOL, AB1 chromatogram parsing/viewing, Gibson
assembly, Golden Gate assembly, accurate supercoiled gel migration,
genome-scale CRISPR off-target search, or CRISPR efficacy scoring unless those
tools have been implemented and validated in this repo.

`simulate_assembly` currently supports restriction ligation only. Do not claim
support for Gibson, Golden Gate, Gateway, or In-Fusion assembly until those
methods are implemented as explicit deterministic tools.
