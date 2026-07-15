# MCP Host Setup

How to connect the `@datalox/molecule-biology` stdio MCP server to real agent
hosts: Claude Desktop, Cursor, and the MCP Inspector. All three speak the same
contract — they launch the built CLI with the `mcp-server` subcommand and talk
JSON-RPC over stdio.

The server advertises itself as `@datalox/molecule-biology` and exposes its tool
set via `tools/list`. Discover tools at runtime; do not rely on a memorized list
or a fixed count (the tool set changes as tracks land).

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

1. **`tools/list`** -- verify the response includes the core tools you expect
   (for example `open_sequence`, `reverse_complement`, `simulate_digest`,
   `render_plasmid_map`, `design_primers`, `design_grnas`). Do not assert a fixed
   tool count; the set grows as tracks land. Treat `tools/list` as the source of
   truth for what is available.

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

## Optional dependencies

Most tools are pure TypeScript and need only Node.js. One tool currently
requires an external binary on the server's `PATH`:

| Tool | Binary | Required for |
|---|---|---|
| `design_primers` | `primer3_core` | PCR primer design |

If the binary is absent the tool returns `DEPENDENCY_MISSING` with the name of
the missing binary, so agents can surface a clear error instead of a silent
failure. No other tools are affected.

### Network / live-service dependencies (planned)

The B-series BLAST tools (`blast_sequence`, `validate_primer_specificity`) are
**not implemented yet** and are not in the tool list above. When they land they
add a *network* dependency rather than a binary: outbound HTTPS to
`https://blast.ncbi.nlm.nih.gov`. There is no API key to configure — the NCBI
BLAST URL API is unauthenticated and governed by a fair-use polling policy. See
[blast-validation-spec.md](blast-validation-spec.md) for the gate that must be
satisfied before those tools ship.

### Installing primer3_core

**macOS**

```bash
brew install primer3
primer3_core --version   # verify
```

**Linux (Debian / Ubuntu)**

```bash
sudo apt-get install primer3
primer3_core --version
```

**Linux via Conda (any distro)**

```bash
conda install -c bioconda primer3
primer3_core --version
```

**Windows**

Primer3 does not publish a pre-built Windows `.exe`. The binary is distributed
as source for Unix systems only. For a step-by-step Windows walkthrough, see
[windows-wsl-setup.md](windows-wsl-setup.md). On Windows you have two options:

*Option A — WSL (recommended).* Install Ubuntu in WSL 2, then install primer3
inside it:

```bash
# inside WSL Ubuntu shell
sudo apt-get install primer3
primer3_core --version
```

Then run the **entire MCP server stack inside WSL** as well, so that
`spawn("primer3_core")` resolves against the WSL PATH:

```bash
# inside WSL Ubuntu shell — clone, build, and run from there
cd /path/to/repo
npm install && npm run build
node dist/src/cli/main.js mcp-server
```

Point Claude Desktop or Cursor at the WSL launch command using the WSL path.
Running primer3 inside WSL but the Node.js server on Windows will not work —
both must live in the same process environment.

*Option B — Docker.* Use a Dockerfile that installs Node.js and primer3 together
in a Linux container. The MCP server runs inside the container and the host
connects via stdio using Docker's `run -i` flag.

### Verifying primer3_core is reachable

```bash
# macOS / Linux / WSL
which primer3_core
primer3_core --help | head -5
```

```powershell
# Windows PowerShell (only if you placed a native binary on PATH)
(Get-Command primer3_core).Source
```

If `which` / `Get-Command` returns a path the server can call it. If not, the
binary is either not installed or not on the PATH that the MCP host uses when
spawning the server process.

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

**`design_primers` returns `DEPENDENCY_MISSING`.** `primer3_core` is not on the
PATH used by the MCP host process. See the [Optional dependencies](#optional-dependencies)
section above for installation instructions. On Windows this almost always means
primer3 is inside WSL but the server is running on Windows — both must run in the
same environment.
