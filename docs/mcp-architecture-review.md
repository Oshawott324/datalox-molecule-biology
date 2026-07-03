# MCP Architecture, Protocol, and Security Review

This document records the review, the small scoped changes made during the pass,
the decisions taken (artifact path contract, resources/prompts, replay capture
design), the residual risk register, and the do-not-change-without-flagging list.

---

## 1. Method

- Read the full MCP layer: `src/mcp/server.ts`, `src/tools/{descriptors,handlers,envelope,index}.ts`,
  `src/ui/{index,server}.ts`, `src/replay/bundle.ts`, `src/core/{paths,errors}.ts`,
  `src/cli/main.ts`, and the smoke/demo scripts.
- Established a green baseline of every must-stay-green command before any change,
  and re-ran them after. See §11.

---

## 2. Architecture

The server is a thin, generic adapter over a descriptor table and a handler
table. It is tools only. The same handlers back the CLI, the demo
scripts, and the replay recorder, so there is exactly one execution path for tool
logic.

```text
                       molecule-biology mcp-server  (stdio)
                                   │
                    @modelcontextprotocol/sdk  Server
                    (JSON-RPC framing + CallToolRequest
                     / ListToolsRequest Zod validation)
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │  src/mcp/server.ts  (thin adapter — no domain logic) │
        │                                                      │
        │  tools/list  ─► moleculeToolDescriptors (23 schemas) │
        │  tools/call  ─► callMoleculeMcpTool:                 │
        │                  1. isToolName?      (registry gate) │
        │                  2. isRecord(args)?  (shape gate)    │
        │                  3. validateAgainstSchema (NEW gate) │
        │                  4. runToolHandler   (dispatch)      │
        └──────────────────────────┬──────────────────────────┘
                                   │  generic dispatch by name
                    ┌──────────────┴───────────────┐
                    │  src/tools/handlers.ts        │  ← domain validation
                    │  (one handler per tool,       │    + envelope shaping
                    │   returns ToolResultEnvelope) │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┼─────────────────────┐
       src/core/* (deterministic)  src/ui/* (editor)  src/replay/* (bundles)
       parse / workspace / writes  local HTTP server   capture + verify
       enzymes / render-map / pcr
```

Confirmed against the brief's review points:

- `tools/list` is produced only from `moleculeToolDescriptors`
  (`listMoleculeMcpTools`), and `tools/call` forwards generically to
  `runToolHandler` (`callMoleculeMcpTool`). No per-tool branching lives in
  `server.ts`. The adapter stays thin. ✅
- CLI parity holds: `src/cli/main.ts` maps command names to the same `ToolName`s
  and calls the same `runToolHandler`. The MCP server adds no behavior the CLI
  lacks except transport. ✅

### Tool surface: 23 advertised, `doctor` is CLI-only

`moleculeToolDescriptors` advertises 23 tools. `toolHandlers` defines 24
(it adds `doctor`). Because `isToolName` is built from the descriptor set,
`doctor` is *not reachable* over MCP** — a `tools/call` for `doctor` returns the
structured unknown-tool failure. `doctor` is reachable only via the CLI
(`molecule-biology doctor`). This is a correct and intentional boundary, but note
the asymmetry: the `ToolName` type includes `doctor` while the MCP surface
*excludes* it. If `doctor` should ever be MCP-visible, add a descriptor for it;
do not special-case it in `server.ts`.

---

## 3. The validation boundary (protocol / schema / domain)

The brief asks to "confirm schema-invalid requests are rejected by the MCP
protocol layer, while domain-invalid requests return structured `ok:false`
envelopes." On review, there were two distinct gates and a gap between
them. The pass closes the gap with a third gate so the boundary is now clean and
testable in three tiers:

| Tier | Gate | Rejects | Result form |
|---|---|---|---|
| **Protocol** | SDK `CallToolRequestSchema` (Zod) | Malformed JSON-RPC; `arguments` not an object | Thrown protocol error (client sees a transport-level rejection) |
| **Schema** *(new)* | `validateAgainstSchema(args, descriptor.inputSchema)` | Missing required, wrong type, unknown property (`additionalProperties:false`), bad `enum`, `minimum` violations | `ok:false`, `error.code = "SCHEMA_VALIDATION_ERROR"`, `details.violations[]` |
| **Domain** | per-tool handler (`assert*`, core logic) | File not found, molecule/feature not found, stale revision, coordinate out of range, alphabet mismatch | `ok:false` with a domain code (`FILE_NOT_FOUND`, `STALE_REVISION`, …) |

**Why this was needed.** The MCP SDK validates only the *request envelope*
(`name` is a string, `arguments` is an object). It does *not* validate
`arguments` against each tool's advertised `inputSchema` — that is the server's
responsibility, and it was previously unenforced. Concretely, before this pass:

- `additionalProperties:false` was advertised in every descriptor but *never
  enforced* — unknown/typo'd fields were silently dropped.
- Wrong-typed or missing fields were caught only opportunistically by hand-written
  `assert*` helpers inside handlers, producing `INVALID_ARGUMENT` that read as a
  domain error rather than a contract violation.

**What changed.** `src/mcp/validate-args.ts` is a small, dependency-free validator
for exactly the JSON-Schema subset the descriptors use (`type`,
`properties`, `required`, `additionalProperties:false`, `enum`, `minimum`,
array `items`). `callMoleculeMcpTool` runs it after the shape gate and before
dispatch. Schema-invalid requests now fail fast with `SCHEMA_VALIDATION_ERROR`
and a precise `violations` list (e.g. `{ path: "arguments.format", message: "must be one of [...]" }`),
distinct from domain failures. The result is surfaced through
`toolEnvelopeToMcpResult`, so it carries `isError: true` at the MCP layer and
a structured, agent-actionable body — chosen deliberately over throwing, because
agents recover better from structured violations than from a bare protocol error,
matching the project's existing "even unknown-tool is a structured envelope"
convention.

**Design note — descriptor is now the source of truth.** Several descriptors mark
`workspacePath` as `required` even though the handler's `workspacePathFromInput`
also accepts `workspaceDir`. The schema gate enforces the advertised contract
(it will reject a `workspaceDir`-only call to those tools). This is intentional —
the advertised schema is what agents read — but it means descriptor and handler
leniency must be kept in sync. If `workspaceDir`-only is meant to be valid for a
tool, widen that descriptor's `required`/`properties` accordingly (and add a test);
do not loosen the gate. No must-stay-green path is affected (all use `workspacePath`).

Adding a descriptor that relies on a JSON-Schema keyword the validator does not
implement (e.g. `pattern`, `oneOf`) must come with matching support in
`validate-args.ts` and a test — otherwise that constraint silently won't be enforced.

---

## 4. Envelope consistency audit

Every tool returns a `ToolResultEnvelope` via `toolSuccess` / `toolFailure` /
`toolFailureFromError` (`src/tools/envelope.ts`). Audit result: *consistent*.

- Success: `{ ok:true, tool, agentContract, data, workspacePath?, revision?, artifacts?, nextAction? }`.
- Failure: `{ ok:false, tool, error:{ code, message, agentActionable, details? } }`.
- `agentContract` is injected centrally in `toolSuccess`, so it is present on every
  success without per-handler effort. The smoke test asserts it on multiple tools.
- `nextAction` is present on the workflow-advancing tools (open → context →
  validate; writes → validate; render → validate), nudging the documented loop.
- `artifacts` appears only where a file is produced (`render_plasmid_map`). See §6.
- Errors funnel through `toolFailureFromError`, which maps `MoleculeError`
  (domain), `SyntaxError` (→ `VALIDATION_ERROR`), `ENOENT` (→ `FILE_NOT_FOUND`),
  and unknown throwables (→ `INTERNAL_ERROR`, `agentActionable:false`). Non-actionable
  internal errors are correctly flagged so an agent does not loop on them.

One small inconsistency to note (not changed): the *editor HTTP API*
(`src/ui/server.ts`) emits ad-hoc `{ ok, error:{ code, message } }` JSON rather
than the canonical envelope. That is acceptable because it is a browser-facing
local API, not the MCP tool surface — but it should not be confused for the
contract, and any future "editor action returns a tool envelope" work should reuse
`toolFailure`/`toolSuccess`.

---

## 5. Artifact path contract — decision

**Current behavior (verified, after this pass):**

- `render_plasmid_map` returns `artifacts:[{ kind:"plasmid_map", path, mimeType, description }]`.
  The `path` is *absolute* (`render-map.ts` joins `workspaceRoot` + a workspace-relative
  output), and the output is *confined to the workspace* — `render-map.ts` rejects
  `..` and absolute `outputPath` with `INVALID_ARGUMENT`.
- `export_genbank` now follows the same rule: it confines `outputPath` to the
  workspace (resolve-then-relative escape check), returns an absolute `outputPath`
  plus `relativePath`, and emits `artifacts:[{ kind:"genbank", ... }]`. An explicit
  `MOLECULE_MCP_UNSAFE_EXPORT_OUTSIDE_WORKSPACE=1` opt-out preserves deliberate
  export-anywhere. *(Was the one divergent tool; brought into line this pass — see §13.)*

**Decision / recommended convention** (one clear rule for all artifact-producing tools):

1. **Confine artifact writes to the workspace root by default**, using the
   `render_plasmid_map` rule as the canonical implementation (reject `..`/absolute
   unless an explicit opt-out). `export_genbank` now conforms to this.
2. **Return paths as absolute in the envelope**, but **derive them from a
   workspace-relative path** so the artifact is portable and replay bundles stay
   relocatable. Absolute is friendlier for an agent host that needs to open the
   file; the workspace-relative form is what guarantees containment.
3. **Every file-producing tool should populate `artifacts[]`**, not just `data`.
   Both `render_plasmid_map` (`kind:"plasmid_map"`) and `export_genbank`
   (`kind:"genbank"`) now do, so hosts have one place to look for produced files.

This keeps a single, predictable contract: *artifacts are absolute paths to files
that live inside the workspace.*

---

## 6. Resources and prompts — decision


- Molecule MCP has *no MCP-App / widget surface*. The compact editor is a
  separate local HTTP server (`open_sequence_editor`), not an HTML resource served
  through MCP. Protein MCP declares a resource specifically because its viewer *is*
  an MCP-App HTML resource (`ui://protein-mcp/...`). That justification does not
  exist here, so *do not add resources*.
- *Prompts are an optional, low-risk future add*, mirroring Protein MCP's three
  workflow prompts. The natural candidates map to `skills/molecule/SKILL.md`'s
  "First Loop": an `open_and_contextualize` prompt (open_sequence → get_sequence_context
  → validate_workspace) and an `annotate_feature` prompt (context → upsert_feature →
  validate). These are guidance only and duplicate what skill-aware hosts already
  read, so they are *not required for hardening* and are deferred.

The capability declaration (`capabilities: { tools: {} }`) correctly matches the
tools-only surface; leave it as-is until/unless prompts are added (then add
`prompts: {}`).

---

## 7. Path-safety and workspace boundaries

What is already solid:

- `paths.ts` `validateWorkspaceRelativePath` rejects absolute and `..`-escaping
  refs for workspace-internal sequence-file references.
- `render-map.ts` confines plasmid-map output to the workspace.
- `replay/bundle.ts` `assertSafeBundleId` (no `/`, `.`, `..`) and
  `resolveBundleRecordPath` (record paths must stay under `records/`) prevent path
  traversal in bundle layout and verification.

Findings:

1. **`export_genbank` wrote outside the workspace (medium) — fixed this pass.**
   `exportGenBank` previously did `path.resolve(outputPath)` with no containment, so
   an agent-supplied `outputPath` could overwrite any file the process can write. It
   now applies the `render-map.ts` rule (resolve, then reject `..`/absolute escapes
   with `INVALID_ARGUMENT`), surfaces the result as a `kind:"genbank"` artifact, and
   honors a `MOLECULE_MCP_UNSAFE_EXPORT_OUTSIDE_WORKSPACE=1` opt-out for the
   deliberate export-anywhere case. See §13. GenBank *formatting* was not touched.
2. **`inputPath` / `workspaceDir` are unconfined by design (accepted).** `open_sequence`
   reads any readable file and writes a workspace anywhere. This is inherent to a
   local stdio tool running with user privileges and is consistent with the trust
   model (the agent already has the CLI). No change; documented so it is a conscious
   acceptance, not an oversight.

---

## 8. `open_sequence_editor` lifecycle

Findings and fixes:

1. **Server leak on repeated calls (fixed).** `openSequenceEditor` started a fresh
   HTTP server on every call and stored it in a module map that **nothing ever
   drained** from the MCP path (`closeManagedSequenceEditors` existed but was
   unused by `server.ts`). Each call leaked a listener and a port for the life of
   the process. *Fix:* the managed map is now keyed by resolved workspace path
   and holds the in-flight startup promise, so repeated calls for the same workspace
   reuse the running server (result now carries `reused: boolean`), and
   concurrent calls converge on one server. A failed startup is evicted so the next
   call can retry. Distinct workspaces still get their own editor (bounded by the
   number of distinct workspaces).
2. **Unguarded bind host (fixed).** `host` was agent-overridable to `0.0.0.0`,
   which would expose workspace reads and the `POST /api/features` write
   endpoint (no auth) to the LAN. *Fix:* `assertBindHost` refuses non-loopback
   binds unless `MOLECULE_MCP_UNSAFE_PUBLIC_BIND=1`, mirroring Protein MCP's
   `validate_live_http_bind`. Default behavior (loopback) is unchanged.
3. **Unbounded request body (fixed).** `readJsonBody` buffered the whole request
   with no cap. *Fix:* a 1 MB limit; oversized bodies fail with `INVALID_ARGUMENT`.
4. **Port handling (reviewed, acceptable).** Default `port: 0` yields an ephemeral
   port, so there is no collision crash; an explicit in-use port surfaces a
   structured error via `toolFailureFromError`. With dedupe (fix 1), a second call
   for the same workspace no longer attempts a second bind at all.

Residual: the editor write endpoint remains *unauthenticated* on loopback. That
is acceptable for a single-user local tool but should be revisited if the editor is
ever exposed deliberately (the opt-out env var is the only path to that today).

---

## 9. Hang-safety review

Brief: "confirm no tool can hang the server process under ordinary bad input."

- All `core/*` tools are bounded by input size (sequence length, enzyme list,
  region span). No unbounded `while`/recursion was found in the dispatch path.
- The stdio server relies on the SDK for framing; handlers are `async` and return
  envelopes, so a domain error cannot wedge the event loop — it returns `ok:false`.
- The one unbounded read (editor `readJsonBody`) is now capped (§8).
- **Low-risk note (not changed):** `simulate_pcr` / `find_restriction_sites` with a
  pathologically short query (e.g. a 1–2 base primer or a degenerate enzyme) can
  produce a very large but *finite* result set — heavy, not a hang. Recommend a
  minimum primer/site length guard in the relevant `core` tools if agent input is
  ever untrusted at scale. Left as a recommendation to avoid changing biology
  semantics in a hardening pass.

---

## 10. Replay capture for live MCP sessions — design (not implemented)

Today, replay capture is *explicit* in demo scripts: the harness wraps each
`client.callTool` in `recordToolCall` and calls `packReplayBundle` at the end
(`scripts/demo-puc19-mcp.mjs`). There is *no* automatic capture inside
`server.ts`. The brief asks to *design* MCP-wide capture before implementing it.

**Proposed design (generic around `callMoleculeMcpTool`, no per-tool branches):**

- **Hook point.** Wrap the single dispatch in `callMoleculeMcpTool` (steps 3→4 in
  §2). After a successful schema gate, record `{ tool, args }` → run handler →
  record the observation, reusing the existing `recordToolCall` digest logic. One
  hook covers all tools because dispatch is already generic. Schema-invalid and
  unknown-tool rejections should *not* be recorded as tool calls (they never
  dispatched) — optionally logged to a separate "rejected" channel for debugging.
- **Opt-in + location.** Off by default. Enable via env (e.g.
  `MOLECULE_MCP_REPLAY_DIR=<dir>`). Records stream to that directory; on a session
  boundary the recorder is packed into a bundle under
  `<workspaceDir>/.datalox/replay-bundles/<id>/` (the existing layout). Discovery:
  surface the bundle path to the agent via a `doctor`-style tool or a session-end
  log line, since stdio has no natural "session end" event the agent observes.
- **Session boundary.** stdio servers do not get an explicit "session over" signal.
  Pack incrementally (append per call, rewrite manifest) so a killed process still
  leaves a verifiable partial bundle, rather than relying on a clean shutdown.
- **Privacy / noise control.** Sequences and file paths are sensitive. The recorder
  should support (a) a redaction list for large `data.sequence` / absolute path
  fields (store digest + length, not the bytes) and (b) an allowlist of tools to
  capture, so read-only or noisy tools can be excluded. Default to capturing
  request/observation *digests* plus structured metadata, and make raw payload
  capture explicit opt-in.
- **What not to do.** Do not add replay branches inside individual handlers, and do
  not capture inside the SDK transport — keep it at the one generic dispatch seam so
  the adapter stays thin and the CLI path can share the exact same recorder.

Implementation is deferred to a follow-up; this section is the design gate the brief
asked for.

---

## 11. Verification (this pass)

Baseline (before changes) and post-change runs of every must-stay-green command:

| Command | Baseline | After changes |
|---|---|---|
| `npm run check` | pass | pass |
| `npm test` | 63 passed | 71 passed (+8 new) |
| `npm run smoke:mcp` | pass | pass |
| `npm run smoke:mcp:cwd` | pass | pass |
| `npm run demo:puc19:mcp` | pass | pass |
| `npm run replay:demo` | pass | pass |

New tests added: schema-gate rejection (missing required, wrong type, unknown
property, bad enum) and schema-vs-domain separation in `tests/mcp.test.ts`; editor
reuse and loopback-bind rejection in `tests/ui.test.ts`; `export_genbank` workspace
containment + opt-out in `tests/deterministic.test.ts`; and two descriptor/validator
invariant guards in `tests/mcp.test.ts` (keyword-subset coverage, required-field
enforcement at the gate).

---

## 12. Changes made in this pass (small, scoped, generic)

| File | Change |
|---|---|
| `src/mcp/validate-args.ts` *(new)* | Dependency-free JSON-Schema-subset validator. |
| `src/mcp/server.ts` | Run `validateAgainstSchema` at the boundary; reject with `SCHEMA_VALIDATION_ERROR` before dispatch. |
| `src/ui/index.ts` | Dedupe managed editors by resolved workspace path (in-flight-promise map); add `reused` to the result; robust cleanup. |
| `src/ui/server.ts` | `assertBindHost` loopback guard (env opt-out); 1 MB request-body cap. |
| `src/core/export-genbank.ts` | Confine `outputPath` to the workspace using the `render-map.ts` resolve-then-relative rule; reject escapes with `INVALID_ARGUMENT` unless `MOLECULE_MCP_UNSAFE_EXPORT_OUTSIDE_WORKSPACE=1`; return `relativePath`. |
| `src/tools/handlers.ts` | `export_genbank` now emits an `artifacts[]` entry of `kind:"genbank"`, matching `render_plasmid_map`. |
| `tests/mcp.test.ts`, `tests/ui.test.ts`, `tests/deterministic.test.ts` | Coverage for the above, plus descriptor/validator invariant guards. |

No source-verified file was touched. No dependency was added. `export-genbank.ts` is
not a source-verified pinned file; its GenBank *formatting* is unchanged — only the
output-path boundary and the returned metadata changed.

---

## 13. Recommended changes (for decision)

1. **Minimum primer/site length guard** in `simulate_pcr` / `find_restriction_sites`
   (§9) if untrusted input at scale becomes a concern. Deferred: a primer-length
   floor is a biology-validation policy, out of scope for a hardening-only pass.
2. **Optional workflow prompts** mirroring `SKILL.md`'s First Loop (§6), if hosts
   that don't read skills would benefit.
3. **Automatic replay capture** per the §10 design, when prioritized.
4. **Editor write-endpoint auth** if the editor is ever bound beyond loopback (§9).
5. **Alias advertisement vs `required` mismatch (§3).** The `molecule` and
   `workspaceDir` aliases are advertised in `properties` (as "Alias for moleculeId"
   / workspace-dir), but on tools whose `required` lists `moleculeId`/`workspacePath`
   (e.g. `translate_region`, `export_genbank`) the schema gate now rejects an
   alias-only call for the missing canonical field — while `get_sequence_context`
   (which does not require `moleculeId`) accepts it. The new keyword/required guards
   lock the gate's behavior but do not resolve this inconsistency. Resolving it is a
   descriptor-contract change (see §14) — either drop `moleculeId`/`workspacePath`
   from `required` so the domain layer enforces "one of" (loosening, mirrors
   `get_sequence_context`), or stop advertising the aliases on those tools
   (tightening). Both are behavior changes; left for a deliberate contract decision.

---

## 15. Do not change without flagging

- **`src/core/render-map.ts`**, **`src/core/enzymes.ts`**, **`fixtures/genbank/puc19.gb`** —
  source-verified biology/geometry, pinned by tests (per the hardening brief).
- **`src/tools/envelope.ts`** — the envelope shape is the cross-cutting agent
  contract; the smoke test and many host integrations depend on it. Changes here
  ripple to every tool and to replay digests.
- **`src/mcp/server.ts` dispatch order** — registry gate → shape gate → schema gate
  → dispatch. Reordering (e.g. dispatching before the schema gate) reopens the
  protocol/schema/domain separation in §3.
- **`src/tools/descriptors.ts` schemas** — these are the advertised contract and the
  input to the schema gate. Tightening `required`/`enum` is a breaking change for
  agents; loosening silently widens what reaches handlers. Pair any change with a
  validator update and a test.
- **`src/replay/bundle.ts` digest / path rules** — `stableJsonStringify`,
  `sha256Json`, `assertSafeBundleId`, and `resolveBundleRecordPath` underpin replay
  verification and traversal safety; changing them invalidates existing bundles.
