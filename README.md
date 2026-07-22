# Datalox Molecule Biology

An agent-native molecular biology workspace exposed over the Model Context Protocol (MCP). It imports FASTA/GenBank into a canonical `molecule.workspace.json`, runs deterministic sequence tools (restriction, digest, PCR, ORFs, translation), performs revision-safe structured writes, renders SVG plasmid maps and digest gels, and captures replayable tool I/O. Biological facts come from parsers and deterministic tools and never prose or screenshots, so agent results are reproducible and auditable.

## MCP server

Build, then register the stdio server with an MCP host (Claude Desktop, Cursor, MCP Inspector):

```bash
npm run build
```

```json
{
  "mcpServers": {
    "molecule-biology": {
      "command": "node",
      "args": ["dist/src/cli/main.js", "mcp-server"]
    }
  }
}
```

Installed as a package, the equivalent launch is `molecule-biology mcp-server`. Hosts discover tools via `tools/list`. Results use a structured envelope (`ok`, `agentContract`, `data`, `workspacePath`, `revision`, `nextAction`, and `artifacts` when files are produced). See [docs/mcp-host-setup.md](docs/mcp-host-setup.md) for host-specific setup.

Windows users: `design_primers` requires Primer3, which has no official native Windows binary. See [docs/windows-wsl-setup.md](docs/windows-wsl-setup.md) for the WSL setup walkthrough.

## Demos

Both demos launch the built stdio server as a child process and exercise the real MCP boundary:

```bash
npm run demo:diagnostic-digest:mcp   # import -> context -> digest -> sites -> gel + map -> validate -> replay
npm run demo:puc19:mcp               # import pUC19 -> context -> restriction sites -> plasmid map -> replay bundle
```

## Tools

| Tool | Description |
| --- | --- |
| `open_sequence` | Import a FASTA or GenBank sequence file into a molecule workspace. |
| `open_workspace` | Open and validate a molecule workspace. |
| `open_sequence_editor` | Open a compact local sequence and plasmid workspace editor. |
| `read_workspace` | Read and validate a molecule workspace. |
| `validate_workspace` | Validate a molecule workspace and return structured validation issues. |
| `list_molecules` | List molecules in a validated workspace. |
| `get_sequence_context` | Read molecule context, features, primers, and optional sequence for a region. |
| `upsert_feature` | Create or update a feature through a revision-safe workspace write. |
| `edit_sequence` | Mutate a molecule sequence through a revision-safe write and report feature-coordinate impacts. |
| `delete_feature` | Delete a feature through a revision-safe workspace write. |
| `upsert_primer` | Create or update a primer through a revision-safe workspace write. |
| `delete_primer` | Delete a primer through a revision-safe workspace write. |
| `upsert_grna` | Create or update a selected guide RNA through a revision-safe workspace write. |
| `reverse_complement` | Return the reverse complement of an explicit DNA/RNA sequence. |
| `translate_region` | Translate a DNA region using the standard genetic code. |
| `find_orfs` | Find deterministic ORFs in a DNA molecule. |
| `find_restriction_sites` | Find restriction enzyme sites from the deterministic local enzyme table. |
| `simulate_digest` | Simulate a deterministic restriction digest. |
| `simulate_pcr` | Simulate deterministic exact-match PCR. |
| `simulate_assembly` | Simulate read-only restriction-ligation candidates and GenBank artifacts. |
| `export_genbank` | Export a molecule and workspace features to GenBank. |
| `export_grna_report` | Write a Markdown report artifact for selected persisted guide RNA records. |
| `render_plasmid_map` | Render a deterministic circular plasmid SVG map artifact. |
| `render_digest_gel` | Render a deterministic SVG gel artifact from digest or PCR fragment sizes. |
| `align_sequences` | Align two sequences with deterministic Needleman-Wunsch global or Smith-Waterman local alignment. |
| `blast_sequence` | Submit a nucleotide or protein query to the NCBI BLAST URL API and return summarized hits plus a raw JSON artifact. |
| `design_primers` | Design PCR primer candidates with the external primer3_core binary and return read-only structured candidates. |
| `design_grnas` | Design SpCas9 NGG guide RNA candidates with deterministic PAM scanning and workspace-scale off-target reporting. |
| `export_protein_fasta` | Translate a CDS region and write the protein sequence to a FASTA artifact for external structure tools. |
| `validate_mrna_construct` | Validate that a molecule's features contain the required mRNA elements in 5'->3' order and pass CDS/Kozak/polyA integrity checks. |

Every MCP tool has a matching `molecule-biology <command>` CLI subcommand for scripting and testing.

## Development

Requires Node >= 20.

```bash
npm install
npm run check     # tsc --noEmit type check
npm test          # vitest deterministic + MCP boundary tests
npm run build     # emit dist/
```

Real-stdio smoke tests and the replay demo:

```bash
npm run smoke:mcp
npm run smoke:mcp:cwd
npm run replay:demo
```

Layout: `src/core` (deterministic biology), `src/tools` (handlers + JSON-Schema descriptors), `src/mcp` (stdio server), `src/cli` (command parity), `src/replay` (tool I/O capture). License: AGPL-3.0-or-later.
