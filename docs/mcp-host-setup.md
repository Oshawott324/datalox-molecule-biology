# MCP Host Setup

How to connect the `@datalox/molecule-biology` stdio MCP server to real agent
hosts: Claude Desktop, Cursor, and the MCP Inspector. All three speak the same
contract — they launch the built CLI with the `mcp-server` subcommand and talk
JSON-RPC over stdio.

The server advertises itself as `@datalox/molecule-biology` and exposes 23 tools
via `tools/list`. Discover tools at runtime; do not rely on a memorized list.

## Prerequisites

- Node.js >= 20 (`node --version`).
- Install and build once so the compiled CLI exists at `dist/src/cli/main.js`:

  ```bash
  npm install
  npm run build
  ```

The package is not published to npm yet, so hosts must point at the **absolute
path** to the built CLI in your local clone. (Alternatively, `npm link` once and
use the `molecule-biology mcp-server` bin command — see below.)

## The launch command (the contract every host uses)

```bash
node <absolute-path-to-repo>/dist/src/cli/main.js mcp-server
```

Replace `<absolute-path-to-repo>` with the absolute path to **your** local clone.
Do not copy a path from another developer's machine.

Find it with:

```bash
# macOS / Linux
pwd
# Windows (PowerShell)
(Get-Location).Path
```

If you ran `npm link`, you can instead use the bin command, which resolves to the
same entry point:

```bash
molecule-biology mcp-server
```

## Claude Desktop

Edit the Claude Desktop config file (create it if it does not exist):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server under `mcpServers`.

**Windows** (note the doubled backslashes — JSON escapes `\`):

```json
{
  "mcpServers": {
    "molecule-biology": {
      "command": "node",
      "args": [
        "<absolute-path-to-repo>\\dist\\src\\cli\\main.js",
        "mcp-server"
      ]
    }
  }
}
```

**macOS / Linux** (forward-slash absolute path):

```json
{
  "mcpServers": {
    "molecule-biology": {
      "command": "node",
      "args": [
        "<absolute-path-to-repo>/dist/src/cli/main.js",
        "mcp-server"
      ]
    }
  }
}
```

Replace `<absolute-path-to-repo>` with your local clone path. Fully restart
Claude Desktop after editing the config. The server then appears in the tools
menu; the host calls `tools/list` for you.

## Cursor

Edit `~/.cursor/mcp.json` for a global server, or `.cursor/mcp.json` in the
project root for a project-scoped server. Same command/args shape:

```json
{
  "mcpServers": {
    "molecule-biology": {
      "command": "node",
      "args": [
        "<absolute-path-to-repo>/dist/src/cli/main.js",
        "mcp-server"
      ]
    }
  }
}
```

On Windows, double the backslashes in the path exactly as in the Claude Desktop
Windows block above. Reload Cursor (or toggle the server in Settings → MCP) after
editing.

## MCP Inspector

The Inspector is not a dependency of this project; run it on demand with `npx`:

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/src/cli/main.js mcp-server
```

This opens the Inspector UI in a browser, connected to the server over stdio.
Verify the server end to end:

1. **`tools/list`** — expect 23 tools (`open_sequence`, `open_workspace`,
   `open_sequence_editor`, `read_workspace`, `validate_workspace`,
   `list_molecules`, `get_sequence_context`, `upsert_feature`, `delete_feature`,
   `upsert_primer`, `delete_primer`, `reverse_complement`, `translate_region`,
   `find_orfs`, `find_restriction_sites`, `simulate_digest`, `simulate_pcr`,
   `export_genbank`, `render_plasmid_map`, `render_digest_gel`,
   `align_sequences`, `design_primers`, `design_grnas`).

2. **`reverse_complement`** — a pure tool with no workspace needed:

   ```json
   { "sequence": "AATTC" }
   ```

   Expect the reverse complement `GAATT` in the result envelope's `data`. (Use a
   non-palindromic sequence so the transform is visible.)

3. **`open_sequence`** — imports a file into a workspace. Use **absolute** paths
   for `inputPath` and `workspaceDir` so the call does not depend on the server's
   working directory:

   ```json
   {
     "inputPath": "<absolute-path-to-repo>/fixtures/genbank/puc19.gb",
     "workspaceDir": "<absolute-path-to-a-writable-dir>",
     "format": "genbank"
   }
   ```

   `inputPath` and `workspaceDir` are required; `format` (`auto` | `fasta` |
   `genbank`), `moleculeId`, and `expectedRevision` are optional. The result
   envelope returns `workspacePath`, `moleculeIds`, and `revision` for the next
   call.

## Troubleshooting

**"The server appears to hang" when I launch it directly.** This is normal. A
stdio MCP server blocks on stdin waiting for a client to connect, so
`node dist/src/cli/main.js mcp-server` will sit with no output. That means it
started correctly. Stop it with Ctrl+C. In real use you never launch it by hand —
the host (Claude Desktop, Cursor, Inspector) spawns it and speaks the protocol.

**"Cannot find module .../dist/src/cli/main.js" / "command not found".** The
project has not been built, or the path is wrong. Run `npm install && npm run
build`, then use the absolute path to `dist/src/cli/main.js`.

**A tool fails on a relative path.** Hosts may launch the server from an arbitrary
working directory, so relative `inputPath` / `workspaceDir` values resolve against
a directory you did not expect. Always pass absolute paths in tool arguments. The
`npm run smoke:mcp:cwd` check proves the built server works when launched from a
directory other than the repo root using absolute paths.

**Node version errors.** The package requires Node >= 20. Check `node --version`
and upgrade if needed.
