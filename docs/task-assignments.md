# Task Assignments

Status note, 2026-07-02:

- D1 diagnostic digest demo is complete.
- Root README rewrite is complete.
- W2 primer design and CR1/CR2 CRISPR guide design are scoped in
  `docs/primer-crispr-design-spec.md`. These do not depend on P5.
- W2 `design_primers` is complete.
- CR1 `design_grnas` scaffold is complete.
- CR2 validated CRISPR on-target scoring is not implemented.
- P5 `align_sequences` supports both global Needleman-Wunsch and local
  Smith-Waterman modes. Use `mode: "local"` for short observed sequence strings
  against larger molecules.
- `align_sequences` does not parse AB1 chromatograms. Convert observed reads to
  sequence strings before alignment.

## Jingting — D1 Demo Script

### Goal

Write `scripts/demo-diagnostic-digest-mcp.mjs`.

This script demonstrates a complete diagnostic digest workflow over MCP: three
construct states (empty vector, forward insert, reverse insert), simulated
HindIII + XhoI digests, gel rendering, plasmid maps, and a verified replay
bundle. It is the D1 milestone.

The npm script already exists:

```bash
npm run demo:diagnostic-digest:mcp
```

It will fail until the script file exists. Your job is to make it pass and
produce the camera-readable summary defined in `docs/diagnostic-digest-demo.md`.

### Design spec

Read `docs/diagnostic-digest-demo.md` in full before writing any code. That
document defines:

- Exact construct sequences (do not invent these)
- Exact expected fragment sizes (copy them verbatim into assert checks)
- Lane order for the gel
- Camera-readable summary format
- Step sequence (14 steps)

### Pattern to follow

`scripts/demo-puc19-mcp.mjs` is the direct template. The same MCP client setup,
`recordMcpTool`, `packReplayBundle`, and `verifyReplayBundle` pattern applies.
Read that file first.

### Step-by-step implementation

**Step 1 — Import pUC19 as `mol_empty`**

```js
await recordMcpTool("open_sequence", {
  inputPath: path.join(repoRoot, "fixtures/genbank/puc19.gb"),
  workspaceDir,
  format: "genbank",
  moleculeId: "mol_empty",
});
```

**Step 2 — Get pUC19 sequence**

```js
const puc19ctx = await recordMcpTool("get_sequence_context", {
  workspacePath,
  moleculeId: "mol_empty",
  start: 1,
  end: 2686,
  includeSequence: true,
});
const puc19Seq = puc19ctx.data.sequence; // 2686-char string
```

**Step 3 — Read insert payload**

Parse `fixtures/fasta/datalox_insert_v1.fa`. The FASTA header line starts with
`>`. Everything after the first line is the sequence (strip newlines).

```js
const fastaRaw = await fs.readFile(
  path.join(repoRoot, "fixtures/fasta/datalox_insert_v1.fa"),
  "utf8"
);
const insertSeq = fastaRaw
  .split("\n")
  .filter((line) => !line.startsWith(">"))
  .join("")
  .trim(); // 700-char string
```

**Step 4 — Build recombinant sequences**

All indices below are 0-based JavaScript `.slice()` calls. The biological
coordinates in the design doc are 1-based inclusive.

```js
// pUC19[1..396] = JS slice(0, 396)
// pUC19[418..2686] = JS slice(417)
const forwardSeq = puc19Seq.slice(0, 396) + insertSeq + puc19Seq.slice(417);
// forwardSeq.length === 3365

// Get reverse complement of insert via MCP tool (keeps it in the replay record)
const rcResult = await recordMcpTool("reverse_complement", { sequence: insertSeq });
const insertRevComp = rcResult.data.reverseComplement; // 700-char string

const reverseSeq = puc19Seq.slice(0, 396) + insertRevComp + puc19Seq.slice(417);
// reverseSeq.length === 3365
```

**Step 5 — Write recombinant constructs as circular GenBank**

This step is critical. FASTA import defaults to linear topology, which gives
wrong digest results for plasmids. You must write GenBank records with
`circular` in the LOCUS line.

```js
function buildCircularGenBank(moleculeId, seq, definition) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "-").toUpperCase();
  let origin = "ORIGIN\n";
  for (let i = 0; i < seq.length; i += 60) {
    const pos = String(i + 1).padStart(9, " ");
    const chunk = seq.slice(i, i + 60);
    const groups = [];
    for (let j = 0; j < chunk.length; j += 10) groups.push(chunk.slice(j, j + 10));
    origin += `${pos} ${groups.join(" ")}\n`;
  }
  return [
    `LOCUS       ${moleculeId.padEnd(20)} ${seq.length} bp    DNA     circular SYN 28-JUN-2026`,
    `DEFINITION  ${definition}`,
    `FEATURES             Location/Qualifiers`,
    origin,
    `//`,
  ].join("\n");
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mol-d1-gb-"));

const fwdGbPath = path.join(tmpDir, "mol_forward.gb");
await fs.writeFile(fwdGbPath, buildCircularGenBank(
  "mol_forward",
  forwardSeq,
  "pUC19 + datalox_insert_v1 forward orientation control.",
));

const revGbPath = path.join(tmpDir, "mol_reverse.gb");
await fs.writeFile(revGbPath, buildCircularGenBank(
  "mol_reverse",
  reverseSeq,
  "pUC19 + datalox_insert_v1 reverse orientation control.",
));
```

**Step 6 — Import recombinant constructs**

Because the workspace already has `mol_empty` (revision 0), you need
`expectedRevision` for each subsequent import.

```js
const fwdImport = await recordMcpTool("open_sequence", {
  inputPath: fwdGbPath,
  workspaceDir,
  format: "genbank",
  moleculeId: "mol_forward",
  expectedRevision: 0,
});
const fwdRevision = fwdImport.data.revision; // will be 1

await recordMcpTool("open_sequence", {
  inputPath: revGbPath,
  workspaceDir,
  format: "genbank",
  moleculeId: "mol_reverse",
  expectedRevision: fwdRevision,
});
```

**Step 7 — Find restriction sites for each molecule**

```js
const ENZYMES = ["HindIII", "XhoI"];

const emptySites  = await recordMcpTool("find_restriction_sites", { workspacePath, moleculeId: "mol_empty",   enzymes: ENZYMES });
const fwdSites    = await recordMcpTool("find_restriction_sites", { workspacePath, moleculeId: "mol_forward", enzymes: ENZYMES });
const revSites    = await recordMcpTool("find_restriction_sites", { workspacePath, moleculeId: "mol_reverse", enzymes: ENZYMES });
```

**Step 8 — Simulate digests**

```js
const emptyDigest = await recordMcpTool("simulate_digest", { workspacePath, moleculeId: "mol_empty",   enzymes: ENZYMES });
const fwdDigest   = await recordMcpTool("simulate_digest", { workspacePath, moleculeId: "mol_forward", enzymes: ENZYMES });
const revDigest   = await recordMcpTool("simulate_digest", { workspacePath, moleculeId: "mol_reverse", enzymes: ENZYMES });
```

**Step 9 — Assert fragment sizes (must throw on mismatch)**

```js
function assertFragments(label, digest, expected) {
  const actual = digest.data.fragments.map((f) => f.size).sort((a, b) => a - b);
  const exp    = [...expected].sort((a, b) => a - b);
  if (JSON.stringify(actual) !== JSON.stringify(exp)) {
    throw new Error(
      `Fragment size mismatch for ${label}:\n` +
      `  expected: ${JSON.stringify(exp)}\n` +
      `  actual:   ${JSON.stringify(actual)}`
    );
  }
}

assertFragments("mol_empty",   emptyDigest, [2686]);
assertFragments("mol_forward", fwdDigest,   [480, 2885]);
assertFragments("mol_reverse", revDigest,   [284, 3081]);
```

**Step 10 — Render gel**

```js
function toFragmentList(digest) {
  return digest.data.fragments.map((f) => ({ size: f.size }));
}

const gel = await recordMcpTool("render_digest_gel", {
  workspacePath,
  gelId: "diagnostic_digest",
  lanes: [
    { label: "Empty vector",        fragments: toFragmentList(emptyDigest) },
    { label: "Forward orientation", fragments: toFragmentList(fwdDigest)   },
    { label: "Reverse orientation", fragments: toFragmentList(revDigest)   },
  ],
  customLadder: [100, 250, 500, 1000, 2000, 3000, 5000],
});
```

**Step 11 — Render plasmid maps**

```js
function toCutSites(sitesResult) {
  return (sitesResult.data?.sites ?? []).map((s) => ({
    enzyme: s.enzyme,
    position: s.cutPosition,
  }));
}

const emptyMap = await recordMcpTool("render_plasmid_map", {
  workspacePath, moleculeId: "mol_empty",
  cutSites: toCutSites(emptySites), showPrimers: false,
});
const fwdMap = await recordMcpTool("render_plasmid_map", {
  workspacePath, moleculeId: "mol_forward",
  cutSites: toCutSites(fwdSites), showPrimers: false,
});
const revMap = await recordMcpTool("render_plasmid_map", {
  workspacePath, moleculeId: "mol_reverse",
  cutSites: toCutSites(revSites), showPrimers: false,
});
```

**Step 12 — Validate workspace**

```js
await recordMcpTool("validate_workspace", { workspacePath });
```

**Step 13 — Pack and verify replay bundle**

```js
const bundle       = await packReplayBundle(recorder, { workspaceDir, workspacePath });
const verification = await verifyReplayBundle(bundle.bundlePath);
if (!verification.ok) throw new Error("Replay bundle verification failed");
```

**Step 14 — Print camera-readable summary**

Print to stdout in the format shown in `docs/diagnostic-digest-demo.md`:

```js
console.log(`
Replay verified
Scenario: pUC19 diagnostic digest orientation-control demo
Insert:   datalox_insert_v1, 700 bp payload, XhoI at insert cut position 250
Enzyme pair: HindIII + XhoI

Molecule   Size    HindIII+XhoI fragments
empty      2686    [2686]
forward    3365    [480, 2885]
reverse    3365    [284, 3081]

Gel artifact: ${gel.artifacts?.[0]?.path ?? "(none)"}
Map artifacts:
  ${emptyMap.artifacts?.[0]?.path ?? "(none)"}
  ${fwdMap.artifacts?.[0]?.path   ?? "(none)"}
  ${revMap.artifacts?.[0]?.path   ?? "(none)"}
Replay bundle verified
Bundle: ${bundle.bundlePath}
`.trim());
```

### Acceptance

- `npm run demo:diagnostic-digest:mcp` completes without error.
- Fragment assertions pass (they will throw loudly if not).
- Gel SVG and three map SVGs are produced as artifacts.
- Replay bundle verifies.
- Camera-readable summary printed to stdout.
- `npm test` still passes (81 tests, no regressions).

---

## Ziyu — P5 `align_sequences` + README

Status: **complete**. `align_sequences` now exposes both `mode: "global"` and
`mode: "local"` through core, MCP, and CLI.

### Goal A: `align_sequences` MCP tool

Implement deterministic pairwise alignment as a new MCP tool, following the
exact same layered pattern as every other tool in this repo.

The tool must support both algorithms:

- `mode: "global"`: Needleman-Wunsch, for similarly sized sequences such as two
  construct versions.
- `mode: "local"`: Smith-Waterman, for Sanger reads, primer/amplicon checks, or
  any short observed sequence aligned against a larger molecule.

**Files to create or modify (in order):**

```text
src/core/align.ts          ← algorithm + types (create)
src/tools/handlers.ts      ← add handleAlignSequences (modify)
src/tools/descriptors.ts   ← add align_sequences descriptor (modify)
src/cli/main.ts            ← add align-sequences CLI command (modify)
src/index.ts               ← export new types and functions (modify)
tests/deterministic.test.ts ← add alignment test cases (modify)
```

#### Layer 1 — `src/core/align.ts`

Export these types:

```ts
export type AlignmentResult = {
  mode: "global" | "local";
  queryAligned: string;      // query with gaps inserted, e.g. "ACG-T"
  targetAligned: string;     // target with gaps inserted, e.g. "ACGAT"
  queryAlignedStart?: number; // local mode only, 1-based inclusive coordinate in query
  queryAlignedEnd?: number;   // local mode only, 1-based inclusive coordinate in query
  targetAlignedStart?: number; // local mode only, 1-based inclusive coordinate in target
  targetAlignedEnd?: number;   // local mode only, 1-based inclusive coordinate in target
  identityPercent: number;   // 0–100, two decimal places
  identicalPositions: number;
  alignedLength: number;     // includes gap columns
  mismatches: number;
  gaps: number;
  score: number;
  scoringParams: {
    match: number;
    mismatch: number;
    gap: number;
  };
};

export type AlignSequencesOptions = {
  mode?: "global" | "local"; // default: "global"
  match?: number;     // default: 1
  mismatch?: number;  // default: -1
  gap?: number;       // default: -2
};
```

Export one function:

```ts
export function alignSequences(
  query: string,
  target: string,
  options?: AlignSequencesOptions,
): AlignmentResult
```

For `mode: "global"`, use classic Needleman-Wunsch. For `mode: "local"`, use
classic Smith-Waterman. There is no web search or library needed; implement the
DP table and traceback directly. The matrix is
`(query.length + 1) × (target.length + 1)`.

Linear gap penalty (not affine): each gap character costs `gap` points. Default
scoring: match +1, mismatch −1, gap −2. For Smith-Waterman, cells are floored
at 0 and traceback starts from the highest-scoring cell.

For `mode: "local"`, populate `queryAlignedStart`, `queryAlignedEnd`,
`targetAlignedStart`, and `targetAlignedEnd` from the traceback coordinates.
For `mode: "global"`, omit those four fields. Empty local alignments should
return aligned length 0, score 0, and no aligned coordinate fields.

Do not use uppercase normalization, ambiguity codes, or heuristics. The caller
is responsible for passing uppercase sequences if they want case-insensitive
matching.

#### Layer 2 — handler in `src/tools/handlers.ts`

Look at `handleReverseComplement` or `handleSimulateDigest` for the handler
pattern. The `align_sequences` handler accepts two input shapes:

1. Raw sequences: `{ sequence: string, targetSequence: string }`
2. Workspace molecules: `{ workspacePath: string, moleculeId: string, targetMoleculeId: string }`

For the workspace path, read both sequences via `readMoleculeSequence`, then
call `alignSequences`. Return the `AlignmentResult` in `data`.

The handler accepts optional `mode`, `match`, `mismatch`, and `gap` fields.
Default `mode` is `"global"`.

#### Layer 3 — descriptor in `src/tools/descriptors.ts`

Add to `moleculeToolDescriptors`. The input schema should accept both raw
sequence and workspace molecule inputs as optional fields (not two separate
schemas). Required fields: either (`sequence` + `targetSequence`) or
(`workspacePath` + `moleculeId` + `targetMoleculeId`). Both raw sequences
and molecule IDs are optional at the schema level; the handler validates the
combination.

#### Layer 4 — CLI command in `src/cli/main.ts`

Look at an existing command (e.g., `reverse-complement` or `find-restriction-sites`)
for the pattern. Add:

```bash
molecule-biology align-sequences \
  --sequence ACGT \
  --target-sequence ACGAT
```

Or workspace form:

```bash
molecule-biology align-sequences \
  --workspace-path /path/to/molecule.workspace.json \
  --molecule-id mol_a \
  --target-molecule-id mol_b
```

#### Layer 5 — exports in `src/index.ts`

Add `alignSequences` and `AlignmentResult` and `AlignSequencesOptions` to
the existing export list.

#### Layer 6 — tests in `tests/deterministic.test.ts`

Add a new `describe` block or add cases to the existing block. Pin these
exact cases:

| Test | Query | Target | Expected |
|---|---|---|---|
| Identical sequences | `ACGT` | `ACGT` | 100% identity, 0 gaps, 0 mismatches |
| Single substitution | `ACGT` | `ACTT` | 75% identity, 1 mismatch, 0 gaps |
| Single insertion in target | `ACGT` | `ACGAT` | correct gap in `queryAligned`, aligned length 5 |
| Empty sequences | `""` | `""` | 100% identity, 0 aligned length |

For the insertion case, pin `queryAligned = "ACG-T"` and
`targetAligned = "ACGAT"` (or verify the gap is at the correct position).

Also add a workspace-molecule alignment case: import two short FASTA sequences
and call `handleAlignSequences` with workspace inputs.

Add local-alignment cases:

| Test | Query | Target | Expected |
|---|---|---|---|
| Local read against larger target | `ACGT` | `TTTACGTTT` | `mode: "local"`, `queryAlignedStart: 1`, `queryAlignedEnd: 4`, `targetAlignedStart: 4`, `targetAlignedEnd: 7`, 100% identity |
| Local no positive match | `AAAA` | `TTTT` with mismatch -1 | aligned length 0, score 0 |

The Sanger/observed-read use case must use `mode: "local"`; global alignment is
not appropriate for aligning a short read against a larger plasmid.

### Goal B: README

Write `README.md` at the repository root.

Sections (in order):

1. **One-paragraph description** — what this is (agent-native molecular biology
   MCP environment), what it produces (deterministic tools, visual SVG
   artifacts, replay bundles), who it is for (AI agents, not a GUI tool).
2. **MCP server config** — how to add this to an MCP host (e.g., Claude Desktop
   `claude_desktop_config.json`). The command to run the server is:
   ```bash
   node dist/src/cli/main.js mcp-server
   ```
   Show the JSON config block a user would paste.
3. **Demo commands** — the two runnable demos:
   ```bash
   npm run demo:puc19:mcp
   npm run demo:diagnostic-digest:mcp
   ```
   One sentence describing what each produces.
4. **Available MCP tools** — a table listing the tool names with one-line
   descriptions. Do not invent descriptions; pull them from the `description`
   fields in `src/tools/descriptors.ts`.
5. **Development** — `npm run build`, `npm test`, `npm run check`.

Keep it short. No marketing prose, no feature roadmap, no badges. The audience
is a developer evaluating the repo.

### Acceptance

- `npm test` still passes after P5 lands (add tests, do not break existing ones).
- `npm run check` passes (TypeScript clean).
- `align-sequences` CLI command works with both raw sequence and workspace inputs.
- README exists at repo root, renders cleanly, MCP config block is copy-pasteable.
