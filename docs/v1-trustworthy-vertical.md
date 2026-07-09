# V1 Trustworthy Vertical

## Strategic Direction

Stop widening MCP feature breadth until one vertical is trustworthy end-to-end.

The most important finding is not "we need more biology features." It is:

> A deterministic tool can still be scientifically incomplete, and if it does
> not say so, the agent will overclaim.

That directly attacks the product thesis. V1 is defined as: the mol-bio MCP is
correct, bounded, and honest about its limits; the hub can invoke it and display
its provenance; a human can inspect and approve the output.

## Demo Spine

One reference path proves the company thesis:

```text
open pUC19 / mRNA construct
-> call deterministic tools (digest, primers, gRNAs, or mRNA validation)
-> show visual artifact + checks in hub UI
-> capture provenance bundle
-> replay / verify bundle
-> human approves / finalizes record
```

This is the demo. Everything else is deferred until this path is trustworthy.

## V1 Release Blockers

| # | Blocker | Owner | Status | Spec |
|---|---|---|---|---|
| MB1 | Restriction/PCR ambiguity policy | User | **done** (7620d30) | see below |
| MB2 | Reverse-strand default or explicit caveat | User | **done** (c055fec) | see below |
| MB3 | Bounded artifact output (+ stdio envelope ceiling) | User | **done** (a24e28e + 4351df0) | see below |
| MB4 | No absolute path leaks in agent-visible errors | User | **done** (adb4d2c) | see below |
| MB5 | Confine import paths to workspace (arbitrary file read) | User | **done** (4351df0) | see below |
| MB6 | Workspace write transactionality (TOCTOU) | User | **done** (7b27f5f) | see below |
| HB1 | Contract/version handshake between hub and mol-bio | User (spec) | **specified** | `docs/hub-mol-bio-contract.md` |
| HB2 | Provenance bundle with tool/schema versions | User (spec) | **specified** | `docs/provenance-bundle-schema.md`, `docs/hub-mol-bio-contract.md` |
| HB3 | Hub launches mol-bio and tears it down cleanly | Hub side | **specified** | `docs/hub-mol-bio-contract.md` |
| HB4 | UI shows artifact + provenance + final review | Hub side | **minimal path implemented** | `npm run demo:v1-review` |

MB1-MB6 are mol-bio MCP changes. HB1-HB4 are integration/hub-side changes.

MB5 and MB6 were added by the 2026-07-07 blindspot audit (see Review
Cross-Check below). MB1+MB2 are that audit's single top-ranked mol-bio finding
("reverse-strand + IUPAC ignored → false '0 sites'", rated High/scientific), so
they remain the highest-priority correctness blockers.

Ziyu's M1 + X1 and Jinting's B1 + live fixture are in parallel and unchanged;
they contribute to the demo spine once MB1-MB6 are resolved.

---

## Review Cross-Check (2026-07-07 Blindspot Audit)

An external read-only cross-repo audit (`datalox-review-2026-07`, Fable 5) graded
all five Datalox sub-projects against a fixed blindspot/correctness/security
contract. It independently confirms this plan's thesis and its top blockers, and
adds three items this plan did not previously track. Nothing in the review
contradicts the existing plan; every change below is additive.

### What the review confirms (no change needed)

- **The V1 thesis is correct.** The audit's headline product risk is "scientific
  results can be confidently wrong and nobody is told" and "determinism is being
  sold as a substitute for correctness." That is exactly the framing of this
  document. It also names mol-bio the reference integration to wire into the hub
  *first* ("Ship at least one wired MCP" / "make one vertical trustworthy
  end-to-end"), which is the demo spine here.
- **MB1 + MB2 are the top mol-bio finding.** Reverse-strand-not-searched and
  IUPAC-not-expanded are the audit's only High-severity mol-bio scientific
  blindspot ("0 cut sites" can be a false negative). Keep them highest priority.
- **MB4 (path leaks in errors)** is confirmed (rated Low-Med): ENOENT/parse
  errors carry absolute paths in `details`.
- **HB1/HB2 (contract + provenance)** map to the audit's Cluster D (contract
  drift) and its "provenance is a slogan, not a system" finding.

### What the review adds (new to this plan)

| Review finding | Audit severity | Where it lands here |
|---|---|---|
| `open_sequence` imports any absolute path, no confinement (`import.ts:45`), while export is confined behind `MOLECULE_MCP_UNSAFE_EXPORT_OUTSIDE_WORKSPACE` — import/export asymmetry; prompt-injection can read `~/.ssh/id_rsa` | Med (security) | **MB5 (new)** |
| TOCTOU in `writeWorkspaceTransaction` (`workspace.ts:397`): read→check-revision→mutate→rename with no lock; two calls at revision N both pass, second overwrites first → lost update | Med-High | **MB6 (new)** |
| No stdio/envelope ceiling: every envelope serialized as pretty JSON *and* `structuredContent`; `read_workspace` returns whole workspace; large sequence can stall the stdio pipe | High (master list #10) | **MB3 extended** (stdio envelope, not just written files) |
| Hand-rolled schema validator silently ignores unsupported keywords; `matchesType` returns `true` for unknown types; no `maxLength`/`pattern`/`maxItems` enforcement (`validate-args.ts:100`) | Med | **New Requirements section** |
| Server version hard-coded `"0.1.0"` in two places, decoupled from `package.json` | (cross-repo) | **HB1 extended** |
| Workspace pinned `version:1` with no migration path and re-stamped on write (silent coercion of a newer schema) | (Cluster D) | **HB1 extended** |
| Alias-vs-`required` mismatch (`molecule`/`workspaceDir`): handlers accept aliases but the schema gate rejects them — a cross-repo footgun the hub will hit | (Cluster D) | **HB1 extended** |
| Enzyme/genetic-code table versions are embedded strings with no cross-MCP registry; determinism claims break silently if a sibling ships a different table under the same name | Med | **New Requirements section** |
| `translate_region` is frame-blind (no warning on non-canonical start); circular ORFs across the origin are never found; no alternative genetic-code tables | Low-Med / Med | **New Requirements section** (honesty caveats for V1; full fix deferred) |
| Determinism ≠ correctness: snapshot/round-trip coverage is high, ground-truth biological assertions near-zero | (ground rule 2) | **New Requirements section** (testing) |
| Windows MCP subprocess teardown leaks (SIGTERM/SIGKILL no-op; no process-group kill); stdio line-buffered with no max-line guard → deadlock | High | **HB3 (new body)** |

### Out of scope for mol-bio V1 (context only)

The review's roadmap docs (03/04/05) recommend, after this vertical is
trustworthy: an "agent-native Prism" *skill* (not an MCP — commodity stats),
then greenfield MCPs (Imaris/microscopy, mass-spec). It also flags a
protein-mcp license problem and ui-v3 secret/RCE blockers. None are mol-bio
work; they reinforce the Paused section's "do not widen" rule and are recorded
there.

---

## MB1: Restriction/PCR Ambiguity Policy

### Problem

`simulate_digest`, `find_restriction_sites`, and `design_primers` all use
literal `indexOf` / string matching on sequence input. IUPAC ambiguous bases
(R, Y, S, W, K, M, B, D, H, V, N) in the input sequence or enzyme recognition
site yield silent incorrect results: the tool reports "0 sites" when the correct
answer is "ambiguity exists; result is unresolvable without clarification."

### Decision for V1

**Reject** inputs containing IUPAC ambiguous bases with a structured error.

Do not silently resolve or silently ignore. A zero result from a search on an
ambiguous sequence is not the same as a true zero, and the agent cannot tell the
difference.

### Error Code

`AMBIGUOUS_SEQUENCE`

```ts
{
  ok: false,
  error: {
    code: "AMBIGUOUS_SEQUENCE",
    message: "Sequence contains ambiguous bases. Resolve before calling this tool.",
    details: {
      positions: [{ position: 42, base: "R" }, ...],  // 1-based, up to 10 examples
      totalAmbiguousCount: 3,
    },
  },
}
```

### Affected Tools

- `simulate_digest` — reject if molecule sequence contains ambiguous bases
- `find_restriction_sites` — same
- `simulate_pcr` — reject if primer sequences or molecule contains ambiguous bases
- `design_primers` — reject if molecule contains ambiguous bases
- `align_sequences` — already uses raw character matching; same policy applies

### What Is Not Ambiguous

Standard degenerate symbols in enzyme recognition sites that we explicitly
support (e.g., none yet) are also rejected for v1. All enzyme entries in the
current table are fully specified ACGT sequences; this is already satisfied.

### Acceptance

Every affected tool returns `AMBIGUOUS_SEQUENCE` with position details when
called on a sequence containing any IUPAC code outside ACGT (case-insensitive).
Tests must cover: single ambiguous base at start, middle, and end; all-ambiguous
sequence; enzyme-site input containing ambiguity.

---

## MB2: Reverse-Strand Default or Explicit Caveat

### Problem

Current enzyme table is palindromic, so forward-strand-only search correctly
identifies cut sites (palindrome at position N on forward = cut on forward at N,
nick on reverse also at N). But the implementation shape is dangerous:

- Non-palindromic / asymmetric enzyme requests would silently miss reverse-strand
  sites.
- The tool output does not state that only the forward strand was searched.

### Decision for V1

Add an explicit `strandScope` field to `find_restriction_sites` and
`simulate_digest` output:

```ts
strandScope: "both_strands_palindromic" | "forward_only";
```

For the current all-palindromic table, emit `"both_strands_palindromic"` with a
note that palindromic sites are equivalent on both strands.

Reject any enzyme whose recognition sequence is not a palindrome with:

```ts
{
  code: "NON_PALINDROMIC_ENZYME_NOT_SUPPORTED",
  message: "Non-palindromic enzymes require bidirectional strand search, which is not yet supported.",
  details: { enzyme: "BsaI", recognitionSequence: "GGTCTC" }
}
```

### Acceptance

- `strandScope` field present on all `find_restriction_sites` and
  `simulate_digest` results.
- Test: request a known non-palindromic enzyme (BsaI: GGTCTC), verify
  `NON_PALINDROMIC_ENZYME_NOT_SUPPORTED` error.
- Test: request EcoRI (palindromic), verify `strandScope: "both_strands_palindromic"`.

---

## MB3: Bounded Artifact Output

### Problem

No maximum size check on written artifacts. A large sequence or many BLAST hits
could produce an unbounded file. The agent-visible result would not indicate
truncation occurred.

### Decision for V1

Each tool that writes an artifact file enforces a per-tool size limit. If the
artifact would exceed the limit, the tool writes a truncated version and sets
`truncated: true` in the artifact descriptor.

Default limits (adjust per tool as needed):

| Artifact kind | Max size |
|---|---|
| `genbank` | 2 MB |
| `fasta` | 1 MB |
| `svg` (map, gel) | 512 KB |
| `markdown` (gRNA report) | 256 KB |
| `json` (BLAST result) | 1 MB |

Artifact descriptor gains:

```ts
type Artifact = {
  kind: string;
  mimeType: string;
  path: string;
  description: string;
  truncated?: boolean;    // present and true only if content was cut
  totalCount?: number;    // for list-type artifacts: actual count before truncation
};
```

### Also Bound the MCP Response Envelope (added per review)

The review found the risk is not only *written files* but the *tool result over
stdio*. Two specific issues:

- Every envelope is serialized as pretty JSON **and** duplicated into
  `structuredContent` (`server.ts:82`) - double payload.
- `read_workspace` returns the whole workspace; a megabase genome round-trips as
  multi-MB JSON over one line-buffered stdio pipe with no ceiling, which can
  stall/deadlock the transport.

For V1:

- Enforce a max response-envelope byte size. If exceeded, return a bounded
  `RESPONSE_TRUNCATED` stub with `byteSize` and an agent-readable instruction
  to use targeted queries instead of returning the full inline blob.
- Source tools should cap high-cardinality results before they reach the generic
  envelope guard. For V1 this includes `design_grnas`, `find_orfs`, and
  `find_restriction_sites`.
- `read_workspace` remains a whole-workspace reader for small workspaces. For
  large workspaces, the generic envelope ceiling prevents unbounded stdio output;
  agents and the hub should prefer `list_molecules`, `get_sequence_context`, and
  domain-specific render/export tools. Pagination or summarized `read_workspace`
  mode is a follow-up hardening item, not part of the generic ceiling shim.
- Avoid emitting the same large payload twice (pretty text + `structuredContent`).

### Acceptance

- Test: generate an artifact that would exceed limit; verify `truncated: true`
  and file is within size limit.
- Test: `design_grnas` caps candidates and reports `candidatesTotalCount` plus
  `candidatesTruncated`.
- Test: normal `find_orfs` and `find_restriction_sites` results report
  `*TotalCount` plus `*Truncated: false`.
- Test: a tool result that would exceed the envelope ceiling returns a
  `RESPONSE_TRUNCATED` stub instead of the inline blob; the emitted envelope is
  within the cap.
- No existing artifact test should fail (limits are generous for test-scale data).

---

## MB4: No Absolute Path Leaks

### Problem

File-not-found errors, workspace read failures, and path resolution errors may
expose absolute paths (e.g., `C:\Users\fangxf\...`) in `error.message` or
`error.details`. An agent should not see machine-local paths.

### Decision for V1

All error paths involving file system operations must strip or relativize
absolute paths before returning them in the result envelope. Use
`path.relative(workspacePath, absolutePath)` where possible; otherwise replace
with a descriptive token (`<workspace>/<filename>`).

### Audit Required

Walk every `catch` block and structured error construction in:
- `src/core/reads.ts`
- `src/core/writes.ts`
- `src/tools/handlers.ts`
- Any file that constructs `{ code, message, details }` error objects

Confirm no `error.message` or `error.details` value contains an absolute path.

---

## MB5: Confine Import Paths to Workspace

### Problem (from 2026-07-07 review, blindspot #4)

`open_sequence` / `importSequenceFile` does `path.resolve(options.inputPath)`
with **no confinement** (`import.ts:45`), while the export path *is* confined
behind the `MOLECULE_MCP_UNSAFE_EXPORT_OUTSIDE_WORKSPACE` override
(`export-genbank.ts:16`). This import/export asymmetry lets an agent - or a
prompt-injection payload inside a file the agent opens - import an arbitrary
host file (e.g. `~/.ssh/id_rsa`, `C:\Users\...\.env`). The file content is then
copied into the workspace and echoed back to the model.

This is distinct from MB4: MB4 stops us *leaking* paths in errors; MB5 stops us
*reading* files outside the workspace at all.

### Decision for V1

Import must resolve inside the workspace root by default, symmetric with export.
Reject out-of-root imports with a structured error. Do not add an unsafe import
override for V1; importing arbitrary host files is the capability this blocker is
removing.

```ts
{
  code: "PATH_OUTSIDE_WORKSPACE",
  message: "Input path must resolve inside the workspace root.",
  details: { inputPath: "<redacted>", workspaceRoot: "<redacted>" }  // sanitized by MB4 at the MCP boundary
}
```

Resolve symlinks (`fs.realpath`) before the containment check so a symlink inside
the workspace cannot point out of it.

### Acceptance

- Test: import a path outside the workspace root -> `PATH_OUTSIDE_WORKSPACE`.
- Test: import a path inside the workspace root -> succeeds.
- Test: a symlink inside the workspace pointing outside is rejected.
- Test: MCP `open_sequence` returns `PATH_OUTSIDE_WORKSPACE` without leaking the
  input path or workspace root in the serialized envelope.

---

## MB6: Workspace Write Transactionality (TOCTOU)

### Problem (from 2026-07-07 review, blindspot #3, Med-High)

`writeWorkspaceTransaction` reads → checks `expectedRevision` → mutates →
atomic-renames with **no lock** (`workspace.ts:397`). Two concurrent calls at
revision N both pass the revision check; the second rename overwrites the first's
committed write → a silently lost update. Atomic rename prevents *partial* files
but not *lost* writes. This is reachable because agents parallelize tool calls,
and it directly undermines the "revision-safe workspace" claim the provenance
story depends on.

### Decision for V1

Serialize writes to a workspace so a check-then-write cannot interleave.

Chosen V1 implementation: an atomic directory lock at
`<workspacePath>.lock`, held across the full read-check-mutate-validate-write
critical section. A same-revision concurrent writer waits for the lock, then
re-reads the workspace and returns the existing `STALE_REVISION` error instead
of overwriting the committed write.

### Acceptance

- Test: two writes issued at the same `expectedRevision` — exactly one commits;
  the other returns the existing stale-revision error. No lost update.
- Test: N sequential writes each increment the revision by exactly 1 with no gaps.

---

## HB1: Contract/Version Handshake

The hub must know which mol-bio schema version it is talking to. Mol-bio must
expose version metadata on startup.

### Minimum Contract

Mol-bio MCP exposes a `get_version` tool (or startup message) returning:

```ts
{
  name: "molecule-biology",
  version: string;          // semver from package.json
  schemaVersion: string;    // e.g. "1.0" — bumped on breaking workspace schema changes
  tools: string[];          // list of active tool names
}
```

Hub validates `schemaVersion` on connect. Mismatch returns a hub-level error
before any tool calls proceed.

### Fixes Required for a Trustworthy Handshake (added per review)

The 2026-07-07 audit found three defects that make the current version story
unreliable. All three must be closed as part of HB1:

1. **Single source of truth for version.** The server version is hard-coded
   `"0.1.0"` in two places, decoupled from `package.json`. `get_version.version`
   must read `package.json` at build/runtime so the reported version cannot drift
   from the published one.
2. **No silent schema coercion.** The workspace is pinned `version:1` with no
   migration path and is **re-stamped on write**, silently coercing a
   newer-schema workspace down to `version:1`. Instead, reject an unrecognized or
   newer workspace schema with `CONTRACT_VERSION_MISMATCH` (per the provenance
   replay contract) — never down-stamp.
3. **Resolve the alias-vs-`required` mismatch.** Handlers accept aliases
   (`molecule`/`moleculeId`, `workspaceDir`/`workspacePath`) but the schema gate
   rejects the alias forms — a live cross-repo footgun the hub will hit (also in
   memory `project-alias-required-mismatch`). Pick one: drop the aliases from the
   descriptors, or implement real `oneOf` acceptance in the validator. Document
   the decision in the contract doc.

Also note the hub side pins MCP protocol `2024-11-05`; the contract doc should
record the negotiated protocol version so a future protocol bump is a loud
mismatch, not a silent mis-negotiation.

Spec to write: `docs/hub-mol-bio-contract.md`

---

## HB2: Provenance Bundle Schema

The replay bundle already exists in demo scripts. It needs a formal schema so
the hub can consume and display it.

### Minimum Bundle Schema

```ts
type ToolCallRecord = {
  seq: number;              // call sequence number within the session
  tool: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;  // full envelope
  artifacts: Artifact[];
  calledAt: string;         // ISO 8601
  durationMs: number;
};

type ProvenanceBundle = {
  bundleVersion: "1.0";
  createdAt: string;
  molBioVersion: string;
  molBioSchemaVersion: string;
  workspaceRevision: number;
  calls: ToolCallRecord[];
  workspaceSnapshot: unknown;  // final workspace state
};
```

Spec to write: `docs/provenance-bundle-schema.md`
Status: this schema is now drafted in `docs/provenance-bundle-schema.md` (hash-
chained, redaction-mandatory, replay-contract with `CONTRACT_VERSION_MISMATCH`).
HB2 remaining work is wiring the recorder/replayer to that schema, not designing it.

---

## HB3: Clean Launch and Teardown (added per review)

This is a hub-side blocker, but it is mol-bio's problem when mol-bio is the
subprocess left orphaned. The 2026-07-07 audit rates it High and cites the
sibling `protein-mcp-stop-repro` folder as live evidence the failure class is
already real.

### Problems

- On Windows, `disconnect()` via SIGTERM→SIGKILL is effectively a no-op; MCP
  child processes (and their `npx`/`uvx` grandchildren) leak. `taskkill /T` does
  not reliably reach grandchildren.
- stdio is line-buffered with no max-line guard, so a large tool result can
  deadlock the transport (this is the read side of MB3's envelope ceiling).

### Requirements

- Launch each MCP in a job object / process group; kill the whole group on
  disconnect; add an orphan reaper that runs if the parent crashes.
- Enforce a max line/frame size on MCP stdout; reject or stream payloads over the
  cap rather than blocking the pipe (pairs with MB3).
- Pin the launch command (no bare `npx`/`uvx`) so a replayed provenance bundle
  resolves to the same MCP code on every machine.

### Acceptance

- E2e: hub launches mol-bio, drives one demo-spine session, tears down with zero
  orphaned processes on Windows (regression-test the `protein-mcp-stop-repro`
  scenario).
- Test: an oversized tool result does not deadlock the transport.

---

## New Requirements From the Review (Correctness, Testing, Contract Hygiene)

These are smaller than a numbered blocker but are release-relevant and were
called out by the audit. Group them into the MB work.

### R1: Ground-truth correctness tests, not just snapshots

The audit's sharpest process finding: snapshot/round-trip coverage is high, but
*ground-truth biological* assertions are near-zero, and "determinism is being
sold as a substitute for correctness." Every deterministic tool on the demo
spine needs at least one known-input → known-biologically-correct-output
assertion (e.g. a published EcoRI digest of pUC19 with known fragment sizes; a
known ORF; a known reverse complement), in addition to existing snapshot tests.

### R2: Harden the argument-schema validator

The hand-rolled validator (`validate-args.ts:100`) silently passes: `matchesType`
returns `true` for unknown types, and `maxLength`/`pattern`/`maxItems` are not
enforced. Any descriptor relying on those constraints gets no enforcement and no
failure. Either implement these keywords or fail loudly when a descriptor uses a
keyword the validator does not support. This underpins MB1/MB3/MB5 (bounds and
rejection can't be trusted if the validator silently no-ops).

### R3: Version the domain tables

Enzyme and genetic-code tables carry embedded version *strings* with no registry.
Determinism claims break silently if a sibling MCP ships a different table under
the same name. Stamp each table with a semver + `producedBy` and surface the
table versions in the provenance bundle so a replay can detect table drift.

### R4: Honesty caveats for known scientific limits (deferred fixes, disclosed now)

The audit flags three correctness gaps that are breadth items deferred past V1,
but that must not fail *silently* in the meantime. For V1, each must emit an
explicit `caveat`/`assumptions` field rather than returning a confident wrong or
partial answer:

- `translate_region` is frame-blind: warn when the requested span does not start
  at a canonical start codon / is not a multiple of 3, and state the frame used.
- ORF finding refuses circular molecules, so origin-spanning plasmid ORFs are
  never found: state `circular: "origin_spanning_not_searched"` on circular input
  rather than returning an implicitly complete list.
- Only the standard genetic code is supported: state `geneticCode: "standard"`.

Full fixes (six-frame, circular-aware ORF, alternative codon tables) stay in the
Paused list; the caveat fields are the V1 requirement.

---

## @datalox/contracts Package

A shared package is needed for the hub/mol-bio interface. Scope it tightly.

### Minimum Contents for V1

- Tool result envelope type (`ToolResult<T>`)
- Artifact type (with `truncated` field from MB3)
- Provenance bundle type (from HB2)
- `get_version` response type (from HB1)
- Molecule workspace schema version constants

### What to Exclude From V1

Do not extract domain schemas (enzyme tables, CRISPR types, mRNA element types)
into the contracts package yet. That becomes a migration project. Keep it to the
integration boundary only.

---

## Hub UI Target

The next UI should not be "more SnapGene clone inside mol-bio." It should be a
hub review UI that consumes MCP artifacts and provenance.

Four panels for the demo:

**Tool Calls / Provenance**
Every tool call in sequence: tool name, arguments, result summary, artifacts
produced, timestamp. Expandable to full JSON. This is the replay record.

**Scientific Artifacts**
Plasmid map SVG, gel SVG, gRNA report markdown, mRNA validation report,
future BLAST table. Rendered inline, not as download links.

**Workspace State**
Current molecule list, features, primers, gRNAs, revision number.

**Human Review Boundary**
A clear "Approve / Finalize Record" step for high-risk or externally meaningful
outputs (e.g., after `validate_mrna_construct` returns `invalid`, or after a
gRNA is upserted). This is what makes the system agent-native rather than
agent-only.

---

## Paused Until V1 Is Complete

| Item | Reason |
|---|---|
| CR2 Azimuth scoring | Does not prove integration trust story |
| M2 codon optimization | Breadth; gated anyway |
| B2 validate_primer_specificity | Depends on B1; not on demo spine |
| W6 Gibson / Golden Gate / Gateway | Breadth |
| New MCPs (protein, flow, etc.) | Do not widen until one vertical is trustworthy |
| Deep protein/PyMOL expert features | Downstream of hub vertical |
| P5-style local alignment in hub | Post-V1 UI refinement |
| Six-frame / circular-aware ORF, alternative genetic codes | Breadth; V1 discloses via R4 caveats instead (audit blindspots #5, #9) |
| Assembly beyond restriction_ligation (Gibson/Golden Gate/Type-IIS) | Breadth (audit "Missing") |
| Sequence-edit primitives (insert/delete/mutate) | Breadth; workspace stays import-only for V1 |
| "Agent-native Prism" (assay/graphing) | Review says build as a *skill*, not an MCP; after this vertical ships |
| New greenfield MCPs (Imaris/microscopy, mass-spec) | Review's next-vertical candidates; gated behind a trustworthy first vertical |

The review's roadmap (03/04/05) reinforces this section: it explicitly says
"finish/deepen before expanding" and names wiring one MCP (mol-bio) into the hub
with a version-checked handshake as the reference integration to do *before* any
new breadth. The protein-mcp license issue and ui-v3 secret/RCE/teardown
blockers are their own repos' release-blockers and are not mol-bio work.

Ziyu's M1 + X1 and Jinting's B1 + live fixture continue unchanged. They land on
the demo spine once MB1-MB6 are resolved and the hub integration exists.

---

## Near-Term Spec Work (User)

In priority order:

1. `docs/mb1-ambiguity-policy.md` — detailed implementation spec for MB1 + MB2
   (ambiguity rejection + strandScope field); reference this doc for the code change
2. `docs/provenance-bundle-schema.md` — formal HB2 schema with TypeScript types
   (drafted; wire the recorder/replayer to it)
3. `docs/hub-mol-bio-contract.md` — HB1 version handshake and minimum contract;
   include the version-decoupling, no-silent-coercion, and alias-vs-required
   decisions added per the review
4. MB3 + MB4 — code audit and implementation (no separate spec needed; change is
   self-contained). MB3 now also covers the stdio response-envelope ceiling.
5. MB5 + MB6 — new blockers from the 2026-07-07 audit: import path confinement
   (parity with export) and workspace write transactionality (advisory lock or
   documented single-writer). Self-contained; no separate spec required.
6. R1-R4 — ground-truth correctness tests, validator hardening, domain-table
   versioning, and honesty caveats for deferred scientific limits. Fold into the
   MB PRs above rather than a standalone spec.
