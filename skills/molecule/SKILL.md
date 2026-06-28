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
  translation, reverse complement, GenBank export, and gel rendering.
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
- `render_digest_gel`

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
minimum (250 bp). The default ladder is 250–10000 bp; a 51 bp fragment
requires a ladder starting at 50 bp or lower to be visible on the gel.

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
Gate assembly, accurate supercoiled gel migration, or Primer3 design unless
those tools have been implemented and validated in this repo.
