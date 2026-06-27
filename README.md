# Datalox Molecule Biology

Agent-native molecular biology environment for deterministic sequence work.

This is not a SnapGene or Scispot clone. The boundary is:

```text
FASTA / GenBank
  -> molecule.workspace.json
  -> deterministic biology tools
  -> revision-safe structured writes
  -> compact sequence/plasmid UI
  -> replayable agent tool I/O
```

The human can review results, but the backend contracts are primarily for
agents. Biological facts should come from parsers or deterministic tools, not
screenshots or prose.

## Quickstart

```bash
npm install
npm run check
npm run test
```

Run the original small replay demo:

```bash
npm run replay:demo
```

Run the real-stdio MCP smoke test:

```bash
npm run smoke:mcp
```

Run the pUC19 MCP demo:

```bash
npm run demo:puc19:mcp
```

The pUC19 demo launches the built stdio MCP server as a child process, imports
`fixtures/genbank/puc19.gb`, gets sequence context, finds restriction sites,
renders a deterministic SVG plasmid map, validates the workspace, and packs a
Datalox replay bundle.

## MCP Server

Build and launch:

```bash
npm run build
node dist/src/cli/main.js mcp-server
```

For package consumers, the bin command is:

```bash
molecule-biology mcp-server
```

Agent hosts should discover tools through `tools/list`. The server currently
exposes tools including:

```text
open_sequence
open_workspace
open_sequence_editor
read_workspace
validate_workspace
list_molecules
get_sequence_context
upsert_feature
delete_feature
upsert_primer
delete_primer
reverse_complement
translate_region
find_orfs
find_restriction_sites
simulate_digest
simulate_pcr
export_genbank
render_plasmid_map
```

To connect this server to Claude Desktop, Cursor, or the MCP Inspector, see
[docs/mcp-host-setup.md](docs/mcp-host-setup.md).

Tool results use a structured envelope with `ok`, `agentContract`, `data`,
`workspacePath`, `revision`, `nextAction`, and when files are produced,
`artifacts`.

## CLI Examples

Import pUC19:

```bash
npm run build
node dist/src/cli/main.js open-sequence fixtures/genbank/puc19.gb --workspace-dir ./run-puc19 --format genbank --molecule-id mol_puc19
```

Find common MCS restriction sites:

```bash
node dist/src/cli/main.js find-restriction-sites ./run-puc19/molecule.workspace.json --molecule mol_puc19 --enzymes EcoRI,BamHI,HindIII,PstI,XbaI,SmaI
```

Render a deterministic plasmid map:

```bash
node dist/src/cli/main.js render-plasmid-map ./run-puc19/molecule.workspace.json --molecule mol_puc19
```

Open the compact local editor:

```bash
node dist/src/cli/main.js open-sequence-editor ./run-puc19/molecule.workspace.json --molecule mol_puc19
```

## Demo Script

Use one clean demo:

```text
1. Run npm run demo:puc19:mcp.
2. Show that the MCP server handled open_sequence, get_sequence_context,
   find_restriction_sites, render_plasmid_map, and validate_workspace.
3. Open the returned SVG map artifact.
4. Point out that the map artifact is returned through the tool envelope.
5. Show the replay bundle path and verified record count.
```

Narration:

```text
This is not a SnapGene clone. It is a molecular biology environment for an
agent: structured files, deterministic tools, visual state, revision-safe
writes, and replayable tool I/O.
```

## Current Scope

Implemented:

- FASTA import
- GenBank import
- canonical `molecule.workspace.json`
- strict workspace validation
- sequence context
- revision-safe feature and primer writes
- reverse complement
- translation
- ORF finding
- restriction-site search
- restriction digest simulation
- exact-match PCR simulation
- GenBank export
- deterministic circular plasmid SVG rendering
- stdio MCP server
- CLI parity for the main tool loop
- compact local sequence/plasmid editor
- replay bundle capture and verification

Not yet implemented:

- SBOL import/export
- AB1 parsing
- Sanger trace rendering or alignment
- Gibson assembly
- Golden Gate assembly
- Primer3-backed primer design
- native SnapGene `.dna` parsing
- GxP, clinical, or 21 CFR Part 11 compliance

Do not claim unsupported operations are available until fixture-backed tools and
tests exist.

## Biology Data Notes

`fixtures/genbank/puc19.gb` uses the authentic pUC19c `L09137.2` sequence from
NCBI. The fixture is hand-authored only in formatting and qualifiers so it stays
inside the current parser contract. It intentionally omits cached
`/translation`; agents should call `translate_region` when protein sequence is
needed.

Restriction enzyme definitions are local and versioned. The common table in
`src/core/enzymes.ts` was populated from REBASE caret-marked cut positions and
is pinned by tests.
