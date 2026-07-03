# Windows WSL Setup For Primer3

This guide is for Windows users who want to use the molecule-biology MCP server
with `design_primers`.

Most molecule-biology MCP tools work directly on Windows. `design_primers` is
different because it calls an external command-line program named
`primer3_core`.

Primer3 does not publish an official native Windows `primer3_core.exe`. For
Windows users, the recommended setup is to run the MCP server inside WSL Ubuntu,
where Primer3 is available through Linux package managers.

## Rule

`primer3_core` and the MCP server must run in the same environment.

If Primer3 is installed in WSL but the MCP server runs as a native Windows Node
process, `design_primers` will fail with:

```text
DEPENDENCY_MISSING
primer3_core was not found on PATH
```

Do not install Primer3 "in VS Code". VS Code is only the editor or terminal.
What matters is where the MCP server process runs.

## Install WSL Ubuntu

Open PowerShell as Administrator:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if prompted. Then open Ubuntu from the Start Menu and create
your Linux username and password.

## Install Primer3 Inside WSL

In the Ubuntu terminal:

```bash
sudo apt update
sudo apt install -y primer3 git curl
primer3_core --help
```

If `primer3_core --help` prints usage text, Primer3 is installed in WSL.

## Install Node.js Inside WSL

Install Node.js 20 or newer inside WSL:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

## Clone And Build The Repo Inside WSL

Still inside Ubuntu:

```bash
git clone https://github.com/Oshawott324/datalox-molecule-biology.git
cd datalox-molecule-biology
npm install
npm run build
```

Validate Primer3 and the MCP server from the same WSL environment:

```bash
which primer3_core
primer3_core --help
npm test -- tests/primer-design.test.ts
npm run smoke:mcp
node dist/src/cli/main.js doctor
```

Expected:

- `which primer3_core` prints a Linux path.
- The Primer3 live test runs instead of being skipped.
- `doctor` reports `optionalDependencies.primer3_core.available: true`.

## Claude Desktop Config On Windows

Claude Desktop runs on Windows, but it can launch the MCP server through WSL.

Use this config shape:

```json
{
  "mcpServers": {
    "molecule-biology": {
      "command": "C:\\Windows\\System32\\wsl.exe",
      "args": [
        "-d",
        "Ubuntu",
        "--",
        "bash",
        "-lc",
        "cd ~/datalox-molecule-biology && node dist/src/cli/main.js mcp-server"
      ]
    }
  }
}
```

Adjust `~/datalox-molecule-biology` if your repo folder has a different name or
location inside WSL.

After editing Claude Desktop config, fully restart Claude Desktop.

## Cursor Config On Windows

Use the same WSL launch pattern in Cursor's MCP config:

```json
{
  "mcpServers": {
    "molecule-biology": {
      "command": "C:\\Windows\\System32\\wsl.exe",
      "args": [
        "-d",
        "Ubuntu",
        "--",
        "bash",
        "-lc",
        "cd ~/datalox-molecule-biology && node dist/src/cli/main.js mcp-server"
      ]
    }
  }
}
```

Reload Cursor after editing the config.

## Codex

For best results, run Codex from the WSL repo directory:

```bash
cd ~/datalox-molecule-biology
codex
```

If Codex is running natively on Windows, it may not see WSL's `primer3_core`.
For Primer3 validation, use Codex inside WSL or use an MCP host that launches
the server through `wsl.exe` as shown above.

## Quick Check

Inside WSL:

```bash
cd ~/datalox-molecule-biology
node dist/src/cli/main.js doctor
```

Look for:

```json
{
  "optionalDependencies": {
    "primer3_core": {
      "available": true
    }
  }
}
```

## Troubleshooting

If `design_primers` returns `DEPENDENCY_MISSING`, the MCP server cannot see
`primer3_core`.

Common causes:

- Primer3 is installed in WSL, but the MCP server is running in Windows.
- Node.js was installed in Windows, but not inside WSL.
- The MCP host config points to `node dist/src/cli/main.js mcp-server` directly
  instead of launching through `wsl.exe`.

Fix: run Primer3, Node.js, the repo, and the MCP server all inside WSL.
