# MCP Hardening Brief

This project is an agent-native molecular biology MCP server, not a SnapGene or Scispot clone. The core product thesis is that agents need reliable domain environments with deterministic tools, revision-safe writes, visual artifacts, and replayable tool I/O.

Current state: MVP phases 1-6 are complete and pushed to `main` at <https://github.com/Oshawott324/datalox-molecule-biology>. The repo has a real stdio MCP server, an authentic source-verified pUC19 fixture, a REBASE-derived common enzyme table, deterministic SVG artifact renderers, and Datalox replay-bundle capture.

Must-stay-green commands:

```bash
npm run check
npm test
npm run smoke:mcp
npm run smoke:mcp:cwd
npm run demo:puc19:mcp
npm run replay:demo
```

## Out Of Scope For This Pass

Do not add SBOL, AB1/Sanger, Gibson, Golden Gate, Primer3, hosted auth, multi-user support, or a database backend in this pass. This is an MCP hardening and verification pass, not new biology scope.

Do not change these files incidentally during refactors without explicitly flagging why:

- `src/core/render-map.ts`
- `src/core/enzymes.ts`
- `fixtures/genbank/puc19.gb`

Those files have source-verified biology or geometry behavior and are pinned by tests.

## Ziyu: Architecture, Protocol, And Security

Goal: harden the MCP layer for real agent-host use while preserving the current architecture boundary. Any code changes should be small, generic, and scoped to findings from the review.

Review points:

- Confirm `src/mcp/server.ts` stays a thin adapter: `tools/list` comes from `moleculeToolDescriptors`, and `tools/call` forwards generically to `runToolHandler`.
- Verify envelope consistency across all MCP tools: `ok`, `agentContract`, `data`, `workspacePath`, `revision`, `nextAction`, `artifacts`, and `error`.
- Compare the FlowCyto MCP and Protein MCP architecture patterns if local copies are available. Extract architecture conventions only; do not copy domain code.
- Decide whether this server should declare MCP resources or prompts. The current server intentionally declares tools only.
- Confirm schema-invalid requests are rejected by the MCP protocol layer, while domain-invalid requests return structured `ok:false` envelopes.
- Confirm no tool can hang the server process under ordinary bad input.
- Review artifact path contract. Decide whether artifacts should return absolute paths, workspace-relative paths, or both, and implement one clear convention if the current contract is insufficient.
- Review workspace and path-safety boundaries for file inputs, workspace outputs, and artifact writes.
- Review `open_sequence_editor` local HTTP server lifecycle: repeated calls, cleanup behavior, and port handling.

Replay design task:

- Design replay capture for live MCP sessions before implementing it.
- Current replay capture is explicit in demo scripts, not automatic middleware in `server.ts`.
- If implementing MCP-wide capture, define where records are written, how agents discover the replay artifact, and how privacy/noise is controlled.
- Keep any implementation generic around `CallTool`; do not add per-tool replay branches.

Deliverable:

- `docs/mcp-architecture-review.md`
- Include a short architecture diagram, FlowCyto/Protein comparison notes when available, risks, recommended changes, and a "do not change without flagging" list.

## Jinting: Mechanical Verification And Host Setup

Goal: make the MCP package easy to verify from a clean clone and easy to connect from real agent hosts.

Tasks:

- From a clean clone, run:

```bash
npm install
npm run build
node dist/src/cli/main.js mcp-server
```

The final command should appear to wait. That is normal for a stdio MCP server; stop it with Ctrl+C after confirming it starts.

- Verify package contents:

```bash
npm pack --dry-run
```

Confirm `dist`, `docs`, `fixtures`, and `skills` are included.

- Run MCP Inspector against the built server. Use the command form:

```bash
node dist/src/cli/main.js mcp-server
```

In Inspector, call `tools/list`, then call at least `reverse_complement` and `open_sequence`.

- Write `docs/mcp-host-setup.md` with literal setup commands for Claude Desktop, Cursor, and MCP Inspector. Include this Windows config shape:

```json
{
  "molecule-biology": {
    "command": "node",
    "args": [
      "<absolute-path-to-repo>\\dist\\src\\cli\\main.js",
      "mcp-server"
    ]
  }
}
```

Replace `<absolute-path-to-repo>` with the absolute path to the local clone. Do not copy a path from another developer's machine.

- Include troubleshooting for "the server appears to hang": it is normal when launched directly because stdio MCP servers wait for a client.
- Confirm `npm run smoke:mcp:cwd` passes. This checks that the built server works when launched from a directory other than the repo root.
- Confirm GitHub Actions CI passes after the workflow is pushed. The workflow is intended to be platform-neutral, but it has only been live-tested locally on Windows so far; treat the first Ubuntu CI run as a real verification step.
- Note that the package currently ships `docs/**/*.md`, which includes this hardening brief and the feasibility document. This is not blocking, but flag it if package contents should be narrowed before publishing.

Final report should list pass/fail for each must-stay-green command and include exact error text for any failure.
