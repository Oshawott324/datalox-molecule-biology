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
| MB1 | Restriction/PCR ambiguity policy | User | not started | see below |
| MB2 | Reverse-strand default or explicit caveat | User | not started | see below |
| MB3 | Bounded artifact output | User | not started | see below |
| MB4 | No absolute path leaks in agent-visible errors | User | not started | audit needed |
| HB1 | Contract/version handshake between hub and mol-bio | User (spec) | not started | to write |
| HB2 | Provenance bundle with tool/schema versions | User (spec) | partial | to finalize |
| HB3 | Hub launches mol-bio and tears it down cleanly | Hub side | not started | to write |
| HB4 | UI shows artifact + provenance + final review | Hub side | not started | to write |

MB1-MB4 are mol-bio MCP changes. HB1-HB4 are integration/hub-side changes.

Ziyu's M1 + X1 and Jinting's B1 + live fixture are in parallel and unchanged;
they contribute to the demo spine once MB1-MB4 are resolved.

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

### Acceptance

- Test: generate an artifact that would exceed limit; verify `truncated: true`
  and file is within size limit.
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

Ziyu's M1 + X1 and Jinting's B1 + live fixture continue unchanged. They land on
the demo spine once MB1-MB4 are resolved and the hub integration exists.

---

## Near-Term Spec Work (User)

In priority order:

1. `docs/mb1-ambiguity-policy.md` — detailed implementation spec for MB1 + MB2
   (ambiguity rejection + strandScope field); reference this doc for the code change
2. `docs/provenance-bundle-schema.md` — formal HB2 schema with TypeScript types
3. `docs/hub-mol-bio-contract.md` — HB1 version handshake and minimum contract
4. MB3 + MB4 — code audit and implementation (no separate spec needed; change is
   self-contained)
