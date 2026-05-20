# Molecule Biology Workspace

Use this skill when working with molecular biology files or
`molecule.workspace.json` workspaces in this repository.

The environment is for agents. Use tools and deterministic code paths as the
source of truth. Do not infer sequence facts from screenshots or prose.

## Core Rules

- Always start with `open_sequence`, `open_workspace`, or `validate_workspace`.
- Treat `molecule.workspace.json` as canonical state, but never patch it
  directly.
- Use `get_sequence_context` before making claims about a molecule sequence,
  feature, primer, or region.
- Use deterministic tools for ORFs, restriction enzymes, digests, PCR,
  translation, reverse complement, and GenBank export.
- Every write must include the current `expectedRevision`.
- On `STALE_REVISION`, call `read_workspace` or `open_workspace`, inspect the
  new revision, then retry intentionally.
- Validate with `validate_workspace` before final response.
- Prefer writing short deterministic scripts when a task needs analysis that is
  not already exposed as a tool.
- Report changed object IDs, final revision, and validation status.

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
- `export_genbank`

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

Do not claim support for SBOL, AB1, Sanger alignment, Gibson assembly, Golden
Gate assembly, or Primer3 design unless those tools have been implemented and
validated in this repo.
