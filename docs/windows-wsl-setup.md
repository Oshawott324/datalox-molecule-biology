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

## Using Codex With MCP And Primer3

Codex must run inside WSL so it shares the same environment as the MCP server
and `primer3_core`. Running Codex natively on Windows means it cannot reach the
Linux `primer3_core` binary.

### Step 1 — Verify the environment before opening Codex

Open an Ubuntu terminal and run:

```bash
which primer3_core       # should print a path such as /usr/bin/primer3_core
node --version           # should print v20.x.x or newer
ls ~/datalox-molecule-biology/dist/src/cli/main.js   # should exist
```

If `which primer3_core` prints nothing:

```bash
sudo apt-get install -y primer3
```

If `dist/src/cli/main.js` does not exist:

```bash
cd ~/datalox-molecule-biology && npm run build
```

### Step 2 — Run the primer design tests to confirm the live path works

```bash
cd ~/datalox-molecule-biology
npm test -- tests/primer-design.test.ts --reporter=verbose
```

Expected output: the test `designs primers for a pUC19 target with primer3_core`
should **pass** (not be skipped). The test `returns DEPENDENCY_MISSING when
primer3_core is absent` should be **skipped** because primer3 is present.
If both are correct, Primer3 is wired up end-to-end.

### Step 3 — Configure the MCP server in Codex

Codex reads MCP server config from `~/.codex/config.toml`. Create or edit it:

```bash
mkdir -p ~/.codex
nano ~/.codex/config.toml
```

Add this block (adjust the path if your repo is named or located differently):

```toml
[mcp_servers.molecule-biology]
command = "node"
args = ["/home/YOUR_USERNAME/datalox-molecule-biology/dist/src/cli/main.js", "mcp-server"]
```

Replace `YOUR_USERNAME` with your WSL username (`whoami` prints it). Save and
close. Then start Codex from the repo directory:

```bash
cd ~/datalox-molecule-biology
codex
```

Type `/mcp` inside Codex to verify the server is connected and lists the 24
tools. Look for `design_primers` and `design_grnas` in the tool list.

### Step 4 — Test with an example prompt

Paste this into the Codex prompt to exercise the full chain:

```
Import the pUC19 GenBank fixture from fixtures/genbank/puc19.gb into a
temporary workspace under /tmp, then use design_primers to design primers
targeting the lacZ region (positions 149 to 507). Return the top 3
candidates with forward sequence, reverse sequence, Tm, and product size.
```

This exercises `open_sequence` → `design_primers` (primer3_core) → structured
result. Expected: three primer pairs with Tm near 60°C and product sizes in the
700–900 bp range.

## Your Own Project Files: /mnt/c vs Native WSL

Keep the MCP server repo on a **native WSL path** (`~/` or `/home/user/`).
Running `npm install` or `npm test` on `/mnt/c/` is significantly slower because
every file operation crosses the WSL filesystem boundary.

Your own sequence files and workspace directories can live anywhere:

| File location | Works? | Notes |
|---|---|---|
| `/home/user/myproject/` | Yes, fast | Recommended for active workspaces |
| `/mnt/c/Users/you/myproject/` | Yes, slower | Fine for occasional reads; avoid for npm |
| Windows path in MCP tool call | No | Always use Linux absolute paths inside WSL |

When passing paths to MCP tools from inside WSL, always use Linux-style absolute
paths. `/mnt/c/Users/fangxf/sequences/my.gb` is the correct form for a file on
the Windows C drive accessed from WSL.

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

## Planned: BLAST Tools And Network

The upcoming B-series BLAST tools (`blast_sequence`,
`validate_primer_specificity`) are not a Primer3-style local binary — they call
the NCBI BLAST URL API over the network. They need outbound HTTPS to
`https://blast.ncbi.nlm.nih.gov` from wherever the MCP server runs. Inside WSL
this works like any other HTTPS client: no extra install, no API key. See
[blast-validation-spec.md](blast-validation-spec.md) for the validation gate
those tools must clear first.

## Troubleshooting

If `design_primers` returns `DEPENDENCY_MISSING`, the MCP server cannot see
`primer3_core`.

Common causes:

- Primer3 is installed in WSL, but the MCP server is running in Windows.
- Node.js was installed in Windows, but not inside WSL.
- The MCP host config points to `node dist/src/cli/main.js mcp-server` directly
  instead of launching through `wsl.exe`.

Fix: run Primer3, Node.js, the repo, and the MCP server all inside WSL.
