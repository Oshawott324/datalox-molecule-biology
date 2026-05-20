# Datalox Molecule Biology Environment

Date: 2026-05-18

Status: implementation spec

## Decision

Build an agent-native molecular biology environment component for Datalox, not a
clone of Scispot or SnapGene.

The product boundary is:

```text
FASTA / GenBank / SnapGene-compatible GenBank / later SBOL / later AB1
  -> molecule.workspace.json
  -> MCP tools
  -> CLI parity
  -> compact sequence / plasmid UI
  -> revision-safe structured writes
  -> Datalox Agent Replay capture
```

The clean positioning is:

```text
frontier agent = reasoning and action layer
molecule biology MCP = domain environment
Datalox Agent Replay = replay, audit, and data layer
Datalox UI = local shell and review surface
```

This repository should define a robust molecular biology environment that an
agent can operate through files, tools, deterministic algorithms, and compact
visual state. The human can review the results, but the backend messages and
tool contracts are primarily for the agent.

## Strategic Fit

This project is a vertical scientific workflow proof for the broader Datalox
thesis:

> Datalox captures what the agent actually saw and did.

The molecule biology environment should therefore produce useful domain work
and useful replay data:

```text
agent task
  -> MCP tool calls
  -> agent-visible observations
  -> file-backed workspace mutations
  -> verification
  -> replay bundle / audit artifact
  -> optional eval or training derivative
```

Do not pitch this as "we are replacing SnapGene" or "we are replacing Scispot."
The stronger claim is:

> Agents need reliable domain environments. This is one such environment for
> molecular biology.

## Product Boundary

### MVP Scope

The MVP should support sequence and construct workflows:

- open FASTA files
- open GenBank files
- open SnapGene-compatible GenBank files
- create and validate `molecule.workspace.json`
- inspect sequence context without screenshots
- render plasmid and linear sequence views
- annotate features through structured writes
- manage primers through structured writes
- find ORFs deterministically
- list restriction enzyme sites deterministically
- simulate restriction digests deterministically
- simulate PCR deterministically
- translate a region deterministically
- reverse complement a sequence deterministically
- export GenBank
- capture MCP tool I/O with Datalox Agent Replay

### Later Scope

These are useful, but they should not block the MVP:

- SBOL import/export
- AB1 parsing and Sanger trace rendering
- Sanger read alignment
- Gibson assembly simulation
- Golden Gate assembly simulation
- Primer3-backed primer design
- construct lineage graphs
- protocol objects
- experiment objects
- attachment indexing
- richer lab inventory objects
- multi-user hosted workspaces

### Non-Goals

Do not start by replacing all of SnapGene.

Do not start by replacing all of Scispot.

Do not start with full ELN, LIMS, LIS, QMS, or SDMS parity.

Do not control physical lab instruments.

Do not claim GxP, clinical, or 21 CFR Part 11 compliance.

Do not use native `.dna` as the canonical format.

Do not hide canonical state inside a database-only or GUI-only session.

Do not use LLM-generated sequence facts without deterministic validation.

Do not implement biological heuristics as fallback patches. If a workflow needs
logic, expose a deterministic tool or let the agent write explicit code and
validate the result.

## FlowCyto Pattern To Reuse

Sibling repo:

```text
/Users/yifanjin/datalox-flow-cyto-mcp
```

Static check observed:

```bash
cd /Users/yifanjin/datalox-flow-cyto-mcp
npm run check
```

Result: passed.

Reusable product pattern:

```text
raw domain file
  -> canonical workspace JSON
  -> MCP tools
  -> compact UI
  -> revision-safe JSON updates
  -> replayable tool I/O
```

Important implementation choices to copy:

- MCP tool descriptors and tool results carry the agent workflow.
- Tool results include `nextAction`, `agentContract`, and expected revisions.
- `AGENTS.md` is optional guidance, not product correctness.
- Writes go through tools such as `upsert_*`, not direct JSON patching.
- The CLI mirrors the MCP path for setup, validation, and hosts without MCP.
- The compact UI refreshes from workspace revision changes.
- Domain algorithms stay deterministic; the agent plans around them.
- Tool outputs are structured enough for another agent to continue the task.

Relevant FlowCyto files:

```text
/Users/yifanjin/datalox-flow-cyto-mcp/README.md
/Users/yifanjin/datalox-flow-cyto-mcp/docs/agent-native-flow-cytometry-mcp.md
/Users/yifanjin/datalox-flow-cyto-mcp/src/mcp/server.ts
/Users/yifanjin/datalox-flow-cyto-mcp/src/core/workspace.ts
/Users/yifanjin/datalox-flow-cyto-mcp/skills/flowcyto/SKILL.md
```

## Core Invariants

These are product correctness rules, not preferences.

1. `molecule.workspace.json` is the canonical workspace artifact.
2. Raw sequence files stay in `data/sequences/`.
3. Reads stay in `data/reads/`.
4. Generated reports and renders stay outside the canonical workspace file.
5. Every structured write requires `expected_revision`.
6. Every successful structured write increments `revision` by exactly 1.
7. Agents must not patch `molecule.workspace.json` directly.
8. UI edits must call the same core write functions as MCP tools.
9. CLI commands must call the same core functions as MCP tools.
10. Sequence facts must come from parsers or deterministic tools.
11. Visual output is never the only source of truth.
12. Tool errors must be structured for agent recovery.
13. Validation must fail loudly on invalid state.
14. No compatibility fallback should silently reinterpret biological data.
15. Datalox Agent Replay should be able to capture the full tool I/O boundary.

## Workspace Layout

The workspace is filesystem-backed:

```text
molecule-run/
  molecule.workspace.json
  data/
    sequences/
      p_example.gb
      insert_a.fasta
    reads/
      sample_01.ab1
    attachments/
  reports/
    maps/
    alignments/
    exports/
  .datalox/
    cache/
    ui-state.json
    replay/
```

Rules:

- Paths in `molecule.workspace.json` are workspace-relative.
- Absolute input paths are allowed only as tool arguments, not stored canonical
  state.
- Imported files are copied into `data/` unless the tool explicitly supports a
  content-addressed import mode.
- The workspace must validate without network access.
- The workspace must be readable and editable by a normal coding agent.
- `.datalox/cache/` may be deleted without losing canonical state.
- `reports/` may be regenerated from workspace state and source files.

## Coordinate System

Use one public coordinate convention everywhere in MCP results, CLI JSON, and
workspace JSON.

Coordinate rules:

- Biological positions are 1-based and inclusive.
- `start` and `end` are both included.
- `start <= end` is always required.
- `start >= 1` is always required.
- `end <= molecule.length` is always required.
- Wrap-around features on circular molecules use multiple segments.
- Do not encode wrap-around as `start > end`.
- Strand values are `"+"`, `"-"`, or `"none"`.
- Sequence strings are uppercase IUPAC symbols.
- DNA alphabet accepts `ACGTRYSWKMBDHVN`.
- RNA alphabet accepts `ACGURYSWKMBDHVN`.
- Protein alphabet accepts standard amino acid symbols plus `X` and `*`.

Example circular wrap-around feature:

```json
{
  "segments": [
    { "start": 5300, "end": 5386, "strand": "+" },
    { "start": 1, "end": 120, "strand": "+" }
  ]
}
```

Pass criteria:

- A validator rejects `start > end`.
- A validator rejects out-of-range coordinates.
- A validator accepts a valid two-segment circular feature.
- Region extraction returns bases in biological order across wrap-around
  segments.
- Reverse-strand region extraction returns the reverse complement of the joined
  biological segments.

## Workspace Schema

The canonical artifact should be small, explicit, and agent-readable.

Minimum MVP shape:

```json
{
  "schema": "datalox.molecule.workspace",
  "version": 1,
  "revision": 0,
  "workspaceId": "molws_01hx_example",
  "createdAt": "2026-05-18T00:00:00.000Z",
  "updatedAt": "2026-05-18T00:00:00.000Z",
  "molecules": [
    {
      "id": "mol_p_example",
      "name": "p_example",
      "path": "data/sequences/p_example.gb",
      "sourceFormat": "genbank",
      "sequenceDigest": "sha256:...",
      "length": 5386,
      "topology": "circular",
      "moleculeType": "dna",
      "alphabet": "iupac_dna",
      "description": "Example plasmid"
    }
  ],
  "features": [
    {
      "id": "feat_bla",
      "moleculeId": "mol_p_example",
      "name": "bla",
      "type": "CDS",
      "segments": [
        { "start": 1000, "end": 1859, "strand": "+" }
      ],
      "qualifiers": {
        "product": "beta-lactamase"
      },
      "source": {
        "kind": "import",
        "tool": "open_sequence"
      }
    }
  ],
  "primers": [
    {
      "id": "primer_fwd_01",
      "name": "p_example_fwd",
      "sequence": "ACGTACGTACGTACGTACGT",
      "moleculeId": "mol_p_example",
      "binding": {
        "segments": [
          { "start": 120, "end": 139, "strand": "+" }
        ],
        "mismatches": []
      },
      "metadata": {}
    }
  ],
  "constructs": [],
  "experiments": [],
  "auditEvents": []
}
```

Schema rules:

- `schema` must equal `"datalox.molecule.workspace"`.
- `version` must equal `1` for the first implementation.
- `revision` must be a non-negative integer.
- Every `id` must be unique within its object collection.
- Every reference must point to an existing object.
- `molecule.length` must match the parsed sequence length.
- `molecule.sequenceDigest` must match the parsed sequence content.
- `features[].segments[]` must be non-empty.
- `primers[].sequence` must validate against the molecule alphabet when bound.
- `auditEvents` is lightweight local history, not a replacement for Datalox
  Agent Replay.

## File Format Policy

### FASTA

MVP behavior:

- Parse one or more records.
- Preserve each record as a molecule.
- Use FASTA header as molecule name.
- Store original file copy in `data/sequences/`.
- Normalize parsed sequence to uppercase for validation and tools.
- Reject empty sequence records.
- Reject invalid alphabet symbols unless the caller explicitly declares an
  alphabet that permits them.

Pass criteria:

- Single-record FASTA imports as one molecule.
- Multi-record FASTA imports as multiple molecules.
- Empty records fail validation.
- Sequence digest remains stable across line wrapping changes.

### GenBank

MVP behavior:

- Parse LOCUS metadata.
- Parse topology.
- Parse molecule type.
- Parse DEFINITION as description.
- Parse FEATURES into workspace features.
- Parse ORIGIN into sequence content.
- Preserve known qualifiers as string or string array.
- Preserve unknown qualifiers without interpreting them.
- Reject files without sequence content.
- Reject coordinate syntax that the parser does not support.

Pass criteria:

- Circular GenBank imports as `topology: "circular"`.
- Linear GenBank imports as `topology: "linear"`.
- Simple features import with correct coordinates.
- `join(...)` imports as multiple ordered segments.
- `complement(...)` imports with strand `"-"`.
- `complement(join(...))` imports as ordered reverse-strand segments.
- Unsupported fuzzy coordinates fail with a structured parser error.

### SnapGene-Compatible GenBank

MVP behavior:

- Treat as GenBank input.
- Preserve SnapGene-specific qualifiers if present.
- Export valid GenBank that SnapGene can import.
- Do not treat native `.dna` as a canonical source.

Pass criteria:

- A SnapGene-compatible GenBank fixture imports.
- Exported GenBank can be re-imported by this tool without losing core
  molecule, feature, and primer data.

### SBOL And AB1

Initial status: later scope.

Rules:

- Do not claim SBOL or AB1 support until fixture-backed import and validation
  exist.
- AB1 support must expose deterministic base calls and trace quality data.
- Sanger alignment must be deterministic and test-backed.

## Revision-Safe Writes

Every write tool must follow the same transaction shape:

```text
read workspace
  -> compare expected_revision
  -> apply deterministic transform
  -> validate full workspace
  -> write temp file
  -> fsync temp file if supported
  -> atomic rename
  -> return new revision and next action
```

Pseudo-code:

```ts
export async function writeWorkspaceTransaction<T>(
  workspacePath: string,
  expectedRevision: number,
  transform: (workspace: MoleculeWorkspace) => T
): Promise<WriteResult<T>> {
  const workspace = await readWorkspace(workspacePath);

  if (workspace.revision !== expectedRevision) {
    throw new WorkspaceRevisionError({
      expectedRevision,
      actualRevision: workspace.revision,
      nextAction: {
        tool: "read_workspace",
        arguments: { workspace_path: workspacePath }
      }
    });
  }

  const payload = transform(workspace);
  workspace.revision += 1;
  workspace.updatedAt = new Date().toISOString();

  validateWorkspaceOrThrow(workspace);
  await atomicWriteJson(workspacePath, workspace);

  return {
    workspace,
    payload,
    revision: workspace.revision
  };
}
```

Rules:

- `expected_revision` is mandatory for all write tools.
- Write tools must reject stale revisions.
- Write tools must not partially commit invalid state.
- A write that changes nothing should still be explicit: either reject as
  `NO_CHANGE` or commit a new revision with a clear audit event. Choose one
  behavior and test it.
- Tool responses must include `previousRevision` and `revision`.

Recommended behavior for no-op writes:

```text
Reject with NO_CHANGE.
```

This avoids meaningless revision churn and keeps agent traces cleaner.

Pass criteria:

- Two concurrent writes with the same `expected_revision` cannot both succeed.
- A stale write returns `STALE_REVISION` with `actualRevision`.
- A write that fails validation leaves the file byte-identical.
- A successful write increments revision by exactly 1.
- A successful write returns a `nextAction` that lets the agent continue.

## Tool Result Envelope

Use one consistent envelope for MCP tools and CLI JSON output.

Success:

```json
{
  "ok": true,
  "tool": "upsert_feature",
  "workspacePath": "/abs/path/molecule.workspace.json",
  "previousRevision": 3,
  "revision": 4,
  "agentContract": {
    "version": 1,
    "intent": "structured_molecule_workspace_edit",
    "forbiddenActions": [
      "do_not_patch_workspace_json_directly",
      "do_not_infer_sequence_from_screenshots",
      "do_not_guess_biology_when_a_deterministic_tool_exists"
    ]
  },
  "data": {
    "featureId": "feat_bla"
  },
  "artifacts": [],
  "nextAction": {
    "tool": "get_sequence_context",
    "arguments": {
      "workspace_path": "/abs/path/molecule.workspace.json",
      "molecule_id": "mol_p_example"
    }
  }
}
```

Error:

```json
{
  "ok": false,
  "tool": "upsert_feature",
  "workspacePath": "/abs/path/molecule.workspace.json",
  "error": {
    "code": "STALE_REVISION",
    "message": "Workspace revision mismatch.",
    "details": {
      "expectedRevision": 3,
      "actualRevision": 4
    },
    "agentActionable": true
  },
  "nextAction": {
    "tool": "read_workspace",
    "arguments": {
      "workspace_path": "/abs/path/molecule.workspace.json"
    }
  }
}
```

Rules:

- `message` should be concise.
- `details` should contain the exact recovery facts.
- `nextAction` should be present whenever recovery is obvious.
- Errors are for the agent first, not a polished human UI.
- Do not hide parser or validation failures behind generic text.

Required error codes:

```text
INVALID_ARGUMENT
FILE_NOT_FOUND
UNSUPPORTED_FORMAT
PARSE_ERROR
VALIDATION_ERROR
STALE_REVISION
NO_CHANGE
MOLECULE_NOT_FOUND
FEATURE_NOT_FOUND
PRIMER_NOT_FOUND
COORDINATE_OUT_OF_RANGE
ALPHABET_MISMATCH
DETERMINISTIC_TOOL_UNAVAILABLE
INTERNAL_ERROR
```

## MCP Tool Loop

Primary agent path:

```text
open_sequence
  -> open_sequence_editor
  -> get_sequence_context
  -> deterministic tool or structured write
  -> validate_workspace
  -> get_workspace_revision
```

Opening a file should push the agent forward:

```json
{
  "ok": true,
  "workspacePath": "/path/to/molecule.workspace.json",
  "moleculeId": "mol_p_example",
  "revision": 0,
  "agentContract": {
    "version": 1,
    "intent": "open_then_context_then_edit",
    "forbiddenActions": [
      "do_not_patch_workspace_json_directly",
      "do_not_infer_sequence_from_screenshots",
      "do_not_guess_biology_when_a_deterministic_tool_exists"
    ]
  },
  "nextAction": {
    "tool": "get_sequence_context",
    "arguments": {
      "workspace_path": "/path/to/molecule.workspace.json",
      "molecule_id": "mol_p_example"
    }
  }
}
```

## MCP Tools

### Read And Open Tools

#### `open_sequence`

Purpose:

Create or update a molecule workspace from a sequence file.

Arguments:

```json
{
  "input_path": "/abs/path/input.gb",
  "workspace_dir": "/abs/path/molecule-run",
  "format": "auto",
  "molecule_id": "mol_p_example",
  "copy_mode": "copy_into_workspace"
}
```

Rules:

- `format` may be `"auto"`, `"fasta"`, or `"genbank"` for MVP.
- `copy_mode` is `"copy_into_workspace"` for MVP.
- Auto-detection must be deterministic and extension plus content based.
- The tool must parse and validate before writing workspace state.
- The tool must create `molecule.workspace.json` if missing.
- If the workspace exists, this is a write and needs `expected_revision`.

Pass criteria:

- Opens a FASTA fixture.
- Opens a GenBank fixture.
- Creates the expected workspace layout.
- Returns molecule IDs and sequence digests.
- Returns `nextAction: get_sequence_context`.

#### `open_workspace`

Purpose:

Read and validate a workspace for use by an agent.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json"
}
```

Pass criteria:

- Returns revision and object counts.
- Returns available next actions.
- Rejects invalid workspace JSON with `VALIDATION_ERROR`.

#### `read_workspace`

Purpose:

Return canonical workspace JSON.

Rules:

- Use this when the agent needs exact state.
- Do not include large sequence strings unless they are actually stored in the
  workspace.

Pass criteria:

- Output is valid JSON.
- Output includes `revision`.
- Output can be piped to a validator.

#### `validate_workspace`

Purpose:

Validate workspace structure, references, paths, sequence digests, and
coordinate ranges.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json",
  "check_sequence_digests": true
}
```

Pass criteria:

- Valid workspace returns `ok: true`.
- Missing molecule path returns `VALIDATION_ERROR`.
- Bad coordinate returns `VALIDATION_ERROR`.
- Digest mismatch returns `VALIDATION_ERROR`.

#### `list_molecules`

Purpose:

Return compact molecule summaries.

Pass criteria:

- Returns IDs, names, lengths, topology, molecule type, and source format.
- Does not return full sequences by default.

#### `get_sequence_context`

Purpose:

Return agent-usable sequence context for one molecule.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json",
  "molecule_id": "mol_p_example",
  "region": {
    "start": 1,
    "end": 500,
    "strand": "+"
  },
  "include_sequence": true,
  "include_features": true,
  "include_primers": true
}
```

Rules:

- Full sequence should be returned only when small or explicitly requested.
- Large molecules should return windows, digest, length, and feature summaries.
- Region extraction must use the public coordinate system.

Pass criteria:

- Returns correct subsequence for a linear region.
- Returns correct joined sequence for a circular wrap-around region.
- Returns overlapping feature summaries.
- Does not infer facts from rendered images.

#### `get_feature_context`

Purpose:

Return exact feature records and surrounding sequence context.

Pass criteria:

- Returns feature coordinates, qualifiers, and extracted feature sequence.
- Reverse-strand features return reverse-complement sequence.

### Visualization Tools

#### `open_sequence_editor`

Purpose:

Open the compact sequence and plasmid viewer.

Rules:

- The viewer is a live view over the workspace.
- The viewer must poll or subscribe to workspace revision changes.
- The viewer must not be the canonical state.
- UI edits must call the same core write APIs.

Pass criteria:

- Opens a local URL or app route for the workspace.
- Displays current revision.
- Refreshes when workspace revision changes.

#### `render_plasmid_map`

Purpose:

Render a plasmid map artifact and return structured map metadata.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json",
  "molecule_id": "mol_p_example",
  "output_dir": "/abs/path/molecule-run/reports/maps",
  "format": "svg"
}
```

Rules:

- For circular molecules, render circular map.
- For linear molecules, either reject or render a linear map depending on
  requested mode.
- Return feature label positions as structured metadata.

Pass criteria:

- Produces an SVG or PNG artifact.
- Artifact path is returned.
- Structured metadata includes feature IDs and coordinates.
- Rendering the same workspace twice produces deterministic metadata.

#### `render_sequence_region`

Purpose:

Render a linear sequence view for a region.

Pass criteria:

- Shows bases, coordinates, overlapping features, and primers.
- Returns artifact path and structured region metadata.

#### `render_alignment`

Initial status: later scope.

Pass criteria before enabling:

- Alignment algorithm is deterministic.
- Fixture-backed expected alignment output exists.
- Rendered image and structured alignment agree.

### Structured Write Tools

#### `upsert_feature`

Purpose:

Create or update a feature.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json",
  "expected_revision": 3,
  "feature": {
    "id": "feat_bla",
    "moleculeId": "mol_p_example",
    "name": "bla",
    "type": "CDS",
    "segments": [
      { "start": 1000, "end": 1859, "strand": "+" }
    ],
    "qualifiers": {
      "product": "beta-lactamase"
    }
  }
}
```

Rules:

- Feature ID may be supplied by the caller or generated deterministically.
- Existing feature IDs update the existing object.
- Coordinates must validate before commit.
- `expected_revision` is mandatory.

Pass criteria:

- Creates a new feature.
- Updates an existing feature.
- Rejects stale revision.
- Rejects invalid coordinates.
- Returns `previousRevision`, `revision`, and `featureId`.

#### `delete_feature`

Purpose:

Delete a feature by ID.

Pass criteria:

- Deletes an existing feature.
- Rejects missing feature with `FEATURE_NOT_FOUND`.
- Rejects stale revision.
- Leaves unrelated objects unchanged.

#### `upsert_primer`

Purpose:

Create or update a primer.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json",
  "expected_revision": 4,
  "primer": {
    "id": "primer_fwd_01",
    "name": "p_example_fwd",
    "sequence": "ACGTACGTACGTACGTACGT",
    "moleculeId": "mol_p_example"
  },
  "bind_to_molecule": true
}
```

Rules:

- Primer sequence must validate against DNA alphabet.
- Binding is deterministic exact matching unless a mismatch policy is explicitly
  supplied.
- Do not guess primer binding sites from names.

Pass criteria:

- Creates a primer.
- Finds exact binding sites when requested.
- Reports no binding sites when none exist.
- Rejects invalid alphabet symbols.
- Rejects stale revision.

#### `delete_primer`

Purpose:

Delete a primer by ID.

Pass criteria:

- Deletes an existing primer.
- Rejects missing primer with `PRIMER_NOT_FOUND`.
- Rejects stale revision.

#### `upsert_construct`

Initial status: later MVP or P1.

Minimum pass criteria before enabling:

- Construct references existing molecules or fragments.
- Assembly plan validates deterministically.
- Output construct sequence is reproducible from inputs.

#### `upsert_experiment`

Initial status: later scope.

Minimum pass criteria before enabling:

- Experiment references existing samples, molecules, constructs, or reports.
- It does not imply ELN/LIMS parity.
- It does not claim compliance.

### Deterministic Biology Tools

#### `reverse_complement`

Purpose:

Return reverse complement for DNA or RNA.

Pass criteria:

- Handles all accepted IUPAC symbols.
- Rejects alphabet mismatch.
- Round trip returns original sequence.

#### `translate_region`

Purpose:

Translate a DNA region using an explicit genetic code.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json",
  "molecule_id": "mol_p_example",
  "region": {
    "start": 1000,
    "end": 1859,
    "strand": "+"
  },
  "genetic_code": "standard",
  "frame": 1
}
```

Rules:

- Genetic code must be explicit.
- Ambiguous codons should translate to `X`.
- Partial terminal codons should be reported, not silently ignored.

Pass criteria:

- Translates known coding fixture correctly.
- Reverse-strand translation matches expected protein.
- Ambiguous codon behavior is tested.

#### `find_orfs`

Purpose:

Find open reading frames deterministically.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json",
  "molecule_id": "mol_p_example",
  "min_aa": 50,
  "genetic_code": "standard",
  "start_codons": ["ATG"],
  "stop_codons": ["TAA", "TAG", "TGA"],
  "strands": ["+", "-"]
}
```

Rules:

- Search all requested frames.
- Circular molecule ORFs may cross origin only when explicitly enabled.
- Return coordinates, strand, frame, nucleotide length, amino acid length, start
  codon, and stop codon.

Pass criteria:

- Finds known ORFs in fixture.
- Does not report ORFs shorter than `min_aa`.
- Reverse-strand ORFs are reported with correct coordinates.
- Circular-origin ORF behavior is tested.

#### `find_restriction_sites`

Purpose:

Find restriction enzyme recognition sites.

Arguments:

```json
{
  "workspace_path": "/abs/path/molecule.workspace.json",
  "molecule_id": "mol_p_example",
  "enzymes": ["EcoRI", "BamHI", "HindIII"],
  "include_ambiguous_matches": false
}
```

Rules:

- Enzyme definitions come from a versioned local enzyme table.
- Recognition sequences and cut offsets must be deterministic.
- Ambiguous matching must be explicitly requested.
- Do not fetch enzyme definitions at runtime.

Pass criteria:

- Finds expected sites for known enzyme fixtures.
- Reports zero sites correctly.
- Reports cut positions.
- Circular boundary sites are tested.
- Enzyme table version is included in output.

#### `simulate_digest`

Purpose:

Simulate restriction digest fragments.

Rules:

- Input sites come from deterministic enzyme definitions.
- Fragment sizes must sum to molecule length for complete digests.
- Linear and circular molecules must have distinct behavior.

Pass criteria:

- Single-cutter circular plasmid returns one linear fragment of full length.
- Two-cutter circular plasmid returns two fragments whose sizes sum to length.
- Linear digest behavior matches expected fixture.
- Output includes enzyme names, cut sites, fragment coordinates, and sizes.

#### `simulate_pcr`

Purpose:

Simulate PCR using explicit primer sequences or primer IDs.

Rules:

- Primer binding uses deterministic exact matching by default.
- Mismatch policy must be explicit if supported.
- Product must include coordinates, strand, amplicon length, and sequence digest.
- Multiple possible products must be returned as multiple products, not guessed.

Pass criteria:

- Fixture primers produce expected amplicon.
- No-binding primers return no products.
- Multiple binding sites return all valid products.
- Circular template behavior is tested.

#### `design_primers`

Initial status: later scope unless backed by a deterministic implementation.

Allowed implementation paths:

- Use Primer3 through a pinned dependency and exact parameters.
- Or implement an explicit exhaustive enumerator with exact constraints.

Rules:

- Do not present heuristic primer design as authoritative.
- If melting temperature or secondary-structure scoring is requested and no
  deterministic implementation exists, return `DETERMINISTIC_TOOL_UNAVAILABLE`.

Pass criteria before enabling:

- Given fixed inputs and parameters, output order is stable.
- Constraints are explicit in the result.
- Rejected candidates include machine-readable rejection reasons.

#### `simulate_assembly`

Initial status: later scope.

Minimum pass criteria before enabling:

- Assembly method is explicit: Gibson, Golden Gate, or restriction ligation.
- Input fragments are explicit.
- Overlaps or cut sites are computed deterministically.
- Ambiguous assemblies return all candidates or a clear validation error.

#### `align_sanger_reads`

Initial status: later scope.

Minimum pass criteria before enabling:

- AB1 parser exposes bases and quality values.
- Alignment algorithm is pinned and deterministic.
- Output includes mismatches, insertions, deletions, and quality context.
- Fixture alignments have expected outputs.

#### `export_genbank`

Purpose:

Export workspace molecule state to GenBank.

Rules:

- Export sequence from the molecule source file.
- Export workspace features.
- Preserve qualifiers where possible.
- Include generated metadata only when explicit.
- Re-importing the exported file should preserve core state.

Pass criteria:

- Exports a valid GenBank file.
- Exported file re-imports successfully.
- Core features survive export/import round trip.
- Sequence digest survives export/import round trip.

## CLI Parity

Every MCP tool needed for the MVP must have a CLI equivalent.

Required commands:

```bash
molecule doctor
molecule open-sequence input.gb --workspace-dir ./run
molecule open-workspace ./run/molecule.workspace.json
molecule read-workspace ./run/molecule.workspace.json
molecule validate ./run/molecule.workspace.json
molecule list-molecules ./run/molecule.workspace.json
molecule context ./run/molecule.workspace.json --molecule mol_p_example
molecule upsert-feature ./run/molecule.workspace.json --expected-revision 0 --feature feature.json
molecule upsert-primer ./run/molecule.workspace.json --expected-revision 1 --primer primer.json
molecule render-map ./run/molecule.workspace.json --molecule mol_p_example
molecule find-orfs ./run/molecule.workspace.json --molecule mol_p_example --min-aa 50
molecule find-restriction-sites ./run/molecule.workspace.json --molecule mol_p_example --enzymes EcoRI,BamHI
molecule simulate-digest ./run/molecule.workspace.json --molecule mol_p_example --enzymes EcoRI,BamHI
molecule simulate-pcr ./run/molecule.workspace.json --molecule mol_p_example --forward primer_fwd --reverse primer_rev
molecule export-genbank ./run/molecule.workspace.json --molecule mol_p_example --output ./run/reports/exports/p_example.gb
```

Rules:

- CLI JSON output uses the same envelope as MCP output.
- CLI commands call core functions, not duplicated logic.
- CLI exit code `0` means `ok: true`.
- CLI non-zero exit means `ok: false`.
- Human-readable CLI output may exist, but JSON must be available.

Pass criteria:

- For each MVP tool, MCP and CLI outputs match after normalizing absolute paths
  and timestamps.
- CLI can run without an MCP host.
- CLI can be used by a coding agent to complete the first tool loop.

## Compact UI

The UI is a compact domain viewer/editor, not the product source of truth.

Required first screen:

- workspace path
- molecule selector
- current revision
- circular or linear sequence view
- feature track
- primer track
- selected region context
- deterministic tool output panel

Required behavior:

- Opens from `open_sequence_editor`.
- Reads workspace state from disk or a local server.
- Polls or subscribes to revision changes.
- Refreshes when `revision` changes.
- Calls core write APIs for UI edits.
- Shows structured validation errors without hiding agent details.

Pass criteria:

- Opening a workspace shows the correct molecule length and topology.
- Adding a feature through MCP updates the UI after revision refresh.
- Adding a feature through UI increments workspace revision through the same
  write path.
- UI never becomes the only place where state exists.
- Rendered plasmid labels do not overlap in the basic fixture.

## Datalox Agent Replay Integration

The molecule environment should be useful as replay data from the start.

Required capture path:

```text
agent uses MCP or CLI
  -> Datalox records tool request
  -> Datalox records agent-visible observation
  -> workspace file changes are summarized
  -> replay bundle is packed
  -> replay bundle verifies
  -> exact tool observation can be replayed
```

Rules:

- Tool inputs and outputs must be JSON-serializable.
- Tool outputs should not depend on unstable process-local objects.
- Artifact paths should be explicit.
- Large artifacts should be referenced by path and digest.
- Approval/export gates belong to Datalox Agent Replay, not the molecule
  workspace schema.

Minimum replay demo:

```text
open_sequence
get_sequence_context
upsert_feature
validate_workspace
pack_replay_bundle
verify_replay_bundle
replay_tool_io
```

Current command path:

```bash
npm run replay:demo
```

The command runs the four-tool demo through existing tool handlers, writes a
bundle under `<workspaceDir>/.datalox/replay-bundles/<bundleId>/`, verifies the
bundle, and replays one stored tool observation from the record JSON.

Pass criteria:

- A complete molecule task produces tool I/O records.
- A replay bundle can be packed.
- The replay bundle verifies.
- Replaying a stored tool observation returns the same observation.
- The final workspace revision and replay turn summary agree.

## Skill Documentation

Add:

```text
skills/molecule/SKILL.md
```

The skill should teach the agent to use the environment, not repeat marketing.

Required skill content:

- Always open or validate a workspace first.
- Use `get_sequence_context` before making sequence claims.
- Use deterministic tools for ORFs, enzymes, PCR, translation, and reverse
  complement.
- Never infer sequence facts from screenshots.
- Never patch `molecule.workspace.json` directly.
- Use `expected_revision` for every write.
- On `STALE_REVISION`, read the workspace and retry intentionally.
- Prefer code when the task requires custom deterministic analysis.
- Validate the workspace before final response.

Example skill snippet:

```md
When asked to annotate a plasmid:

1. Call `open_sequence` or `open_workspace`.
2. Call `get_sequence_context`.
3. Use deterministic tools for biological facts.
4. Call `upsert_feature` with `expected_revision`.
5. Call `validate_workspace`.
6. Report changed feature IDs and final revision.
```

Pass criteria:

- A new agent can complete the first tool loop by following the skill.
- The skill includes code-oriented guidance for custom deterministic checks.
- The skill does not encourage direct JSON patching.

## Implementation Modules

Recommended TypeScript layout:

```text
src/
  core/
    workspace.ts
    schema.ts
    errors.ts
    ids.ts
    paths.ts
    coordinates.ts
    alphabets.ts
    sequence.ts
    fasta.ts
    genbank.ts
    features.ts
    primers.ts
    enzymes.ts
    orfs.ts
    digest.ts
    pcr.ts
    translate.ts
    export-genbank.ts
  mcp/
    server.ts
    tools/
      open-sequence.ts
      read-workspace.ts
      validate-workspace.ts
      context.ts
      writes.ts
      deterministic.ts
  cli/
    index.ts
    commands/
  ui/
    app/
    components/
    lib/
  fixtures/
    fasta/
    genbank/
    expected/
  tests/
    unit/
    integration/
```

Module rules:

- `core/` has no MCP-specific logic.
- `mcp/` adapts core functions to MCP schemas.
- `cli/` adapts core functions to commands.
- `ui/` calls core-backed local APIs.
- Tests should target `core/` first.
- Parser fixtures live in repo and are small.

## Data Validation Details

Validation should be strict and deterministic.

Required validators:

- workspace schema validator
- molecule reference validator
- path validator
- sequence digest validator
- feature coordinate validator
- primer alphabet validator
- primer binding validator
- construct reference validator when constructs are enabled

Validation should catch:

- malformed JSON
- unknown schema version
- duplicate IDs
- missing molecule references
- missing source files
- path escape outside workspace
- bad sequence digest
- invalid alphabet symbols
- out-of-range coordinates
- empty segment arrays
- unsupported topology
- unsupported molecule type

Pass criteria:

- Every validation error includes object path and error code.
- Invalid fixture tests cover every required error category.
- Validation never mutates workspace state.

## ID Policy

IDs should be stable and agent-readable.

Rules:

- IDs are strings.
- IDs use lowercase letters, numbers, and underscores.
- IDs are unique within each object collection.
- Imported features may use deterministic IDs based on molecule, type, name,
  and coordinates.
- Agent-created objects may use caller-supplied IDs if valid.
- If generated, return the generated ID in the tool result.

Example:

```text
mol_p_example
feat_bla_1000_1859_plus
primer_p_example_fwd
```

Pass criteria:

- Importing the same file twice into a fresh workspace generates stable IDs.
- Duplicate caller-supplied IDs update existing objects for upsert tools.
- Invalid IDs are rejected with `INVALID_ARGUMENT`.

## Determinism Rules

The same inputs must produce the same outputs.

Rules:

- Sort object arrays deterministically when writing if ordering is not semantic.
- Preserve semantic order for segments and features imported from files.
- Include tool parameter values in deterministic tool outputs.
- Include enzyme table version in restriction outputs.
- Include genetic code in translation and ORF outputs.
- Do not use current time inside deterministic results except workspace
  `updatedAt` and audit metadata.
- Do not rely on network calls for biological algorithms.

Pass criteria:

- Re-running deterministic tools on the same fixture produces byte-identical
  JSON after normalizing absolute paths.
- Export/import round trips produce stable sequence digests.

## Testing Strategy

### Unit Tests

Required unit test groups:

- FASTA parser
- GenBank parser
- coordinate validation
- circular segment extraction
- reverse complement
- translation
- ORF finding
- restriction-site finding
- digest simulation
- PCR simulation
- workspace validation
- revision-safe writes
- GenBank export

### Integration Tests

Required integration tests:

- CLI open FASTA then validate.
- CLI open GenBank then validate.
- MCP open sequence then context.
- MCP upsert feature then validate.
- Stale revision write rejection.
- CLI and MCP output parity for MVP tools.
- Render map creates artifact.
- Replay demo captures and verifies a bundle.

### Fixture Set

Minimum fixtures:

```text
fixtures/
  fasta/
    single_linear_dna.fasta
    multi_record_dna.fasta
    invalid_symbol.fasta
  genbank/
    linear_simple.gb
    circular_plasmid.gb
    compound_join.gb
    reverse_complement_feature.gb
    snapgene_compatible.gb
  expected/
    circular_plasmid.context.json
    circular_plasmid.orfs.json
    circular_plasmid.restriction-sites.json
    circular_plasmid.digest.json
    pcr_product.json
```

### Required Commands

Use project-local scripts once the package exists:

```bash
npm run check
npm run test
npm run test:integration
```

If the implementation uses another build system, define equivalent commands
before adding functionality.

## Milestones And Pass Criteria

### M0: Project Skeleton

Implementation:

- package manifest
- TypeScript config
- formatter/linter
- test runner
- `src/core`
- `src/mcp`
- `src/cli`
- fixtures directory

Pass criteria:

- `npm run check` passes.
- `npm run test` passes with at least one placeholder-free test.
- CLI entrypoint prints version or help.
- MCP server starts without registering broken tools.

### M1: Workspace Schema And Validator

Implementation:

- workspace TypeScript types
- JSON schema or equivalent runtime validator
- path safety checks
- coordinate validator
- digest validator interface

Pass criteria:

- Valid minimal workspace passes.
- Invalid schema version fails.
- Duplicate IDs fail.
- Bad references fail.
- Bad coordinates fail.
- Path escape such as `../outside.gb` fails.

### M2: FASTA And GenBank Import

Implementation:

- FASTA parser
- GenBank parser
- file copy into workspace
- sequence digest computation
- workspace creation

Pass criteria:

- FASTA fixtures import.
- GenBank fixtures import.
- Imported workspaces validate.
- Parsed lengths and digests match expected fixtures.
- Unsupported GenBank coordinates fail clearly.

### M3: Read Context Tools

Implementation:

- `open_sequence`
- `open_workspace`
- `read_workspace`
- `validate_workspace`
- `list_molecules`
- `get_sequence_context`
- CLI equivalents

Pass criteria:

- Agent can open a sequence and retrieve context.
- Large sequence context does not dump full sequence by default.
- CLI and MCP outputs match after path normalization.
- Tool outputs include `agentContract` and `nextAction`.

### M4: Structured Writes

Implementation:

- transaction helper
- `upsert_feature`
- `delete_feature`
- `upsert_primer`
- `delete_primer`
- audit event append
- CLI equivalents

Pass criteria:

- Upsert feature succeeds and validates.
- Upsert primer succeeds and validates.
- Stale revision write fails.
- Failed validation leaves workspace unchanged.
- Direct write path is covered by tests.

### M5: Deterministic Biology Tools

Implementation:

- reverse complement
- translation
- ORF finder
- restriction enzyme table
- restriction-site finder
- digest simulator
- PCR simulator
- GenBank exporter

Pass criteria:

- Each tool has fixture-backed tests.
- Outputs include parameters and source digests.
- Repeated runs are deterministic.
- Exported GenBank re-imports successfully.

### M6: Compact UI

Implementation:

- local viewer route
- molecule selector
- revision display
- plasmid or linear map
- sequence region view
- feature and primer tracks
- write API integration

Pass criteria:

- Opens from `open_sequence_editor`.
- Displays imported GenBank fixture.
- Refreshes after MCP feature write.
- UI feature write uses revision-safe core path.
- Rendered map artifact passes basic visual smoke test.

### M7: Datalox Replay Demo

Implementation:

- documented replay command path
- tool I/O record capture
- replay bundle packing
- replay bundle verification
- replay of at least one observation

Pass criteria:

- Demo task is captured from start to finish.
- Replay bundle verifies.
- Tool observation replay matches original observation.
- Final workspace revision is included in the turn summary.

### M8: Agent Skill

Implementation:

- `skills/molecule/SKILL.md`
- concise MCP-first workflow
- code-oriented deterministic analysis examples

Pass criteria:

- Skill instructs agent to use tools before making biological claims.
- Skill forbids direct workspace JSON patching.
- Skill explains stale revision recovery.
- Skill includes a complete feature annotation example.

## Overall MVP Pass Criteria

The MVP is complete only when all of these pass:

1. `npm run check` passes.
2. `npm run test` passes.
3. `npm run test:integration` passes.
4. FASTA import works.
5. GenBank import works.
6. Workspace validation catches bad state.
7. `get_sequence_context` returns correct sequence and feature context.
8. `upsert_feature` and `upsert_primer` are revision-safe.
9. ORF finding, restriction search, digest, PCR, translation, and reverse
   complement are deterministic and fixture-tested.
10. GenBank export re-imports without losing core state.
11. CLI parity exists for the MVP tool loop.
12. Compact UI opens and reflects revision changes.
13. Datalox Agent Replay can capture and verify a molecule task.
14. `skills/molecule/SKILL.md` teaches the MCP-first loop.
15. No MVP workflow requires guessing biological facts from screenshots.

## Demo Script

Use one clean demo. Do not demo everything.

```text
1. Start with a GenBank plasmid fixture.
2. Agent calls open_sequence.
3. Agent calls get_sequence_context.
4. Agent opens compact sequence editor.
5. Agent calls find_restriction_sites.
6. Agent calls upsert_feature with expected_revision.
7. Agent calls validate_workspace.
8. UI refreshes and shows the new feature.
9. Datalox packs and verifies a replay bundle.
```

Narration:

> This is not a SnapGene clone. It is a molecular biology environment for an
> agent: structured files, deterministic tools, visual state, revision-safe
> writes, and replayable tool I/O.

## External References

- Scispot: https://www.scispot.com/
- SnapGene features: https://www.snapgene.com/features/
- SnapGene GenBank-SnapGene format: https://support.snapgene.com/hc/en-us/articles/10242682237588-What-is-Genbank-SnapGene-Format
- SnapGene supported file formats: https://www.snapgene.com/features/convert-file-formats
