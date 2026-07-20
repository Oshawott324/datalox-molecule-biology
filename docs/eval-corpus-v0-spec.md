# Eval Corpus v0 Spec

Status: draft spec. No implementation until this document is reviewed.

Purpose: create a local, deterministic benchmark corpus for the molecule-biology
MCP. The corpus should test whether an agent can call tools, preserve revision
safety, interpret structured outputs, and verify visual/artifact results without
guessing from language-model memory.

This is not a new biology feature. It is a regression and benchmark harness over
the shipped tool surface.

## Goals

- Pin expected tool behavior with JSON outputs and artifact hashes.
- Catch biologically meaningful regressions, such as incorrect CDS frame-impact
  reporting after sequence edits.
- Provide CEO/demo material for an agent-native biology benchmark story.
- Keep v0 local: no NCBI BLAST, no Primer3 live dependency, no external network.

## Non-Goals

- No hidden heuristics, fuzzy scoring, or post-processing cleanup.
- No remote BLAST tasks in v0.
- No comparison to SnapGene unless a reference output is checked in with
  provenance.
- No model-evaluation runner in v0. This corpus defines tasks and expected
  outputs; model-agent benchmarking can consume it later.

## Proposed Directory Layout

```text
eval-corpus/
  v0/
    corpus.manifest.json
    README.md
    tasks/
      mb-edit-puc19-mcs-insert/
        task.json
        inputs/
          puc19.gb
        expected/
          summary.json
          tool-observations.json
          artifacts.json
        artifacts/
          plasmid-map.svg
          edited.gb
        provenance/
          replay.manifest.json
          records/
```

Notes:

- `inputs/` contains task-local copies of source fixtures, not symlinks.
- `expected/summary.json` is the stable grading surface.
- `expected/tool-observations.json` stores selected exact tool outputs or
  normalized subsets, depending on the task.
- `expected/artifacts.json` stores SHA-256 hashes and MIME types for generated
  artifacts.
- `artifacts/` stores canonical expected artifact files only when byte-stable.
- `provenance/` is optional in v0 but should be supported because the MCP already
  has replay bundles.

## Root Manifest Schema

File: `eval-corpus/v0/corpus.manifest.json`

```ts
type CorpusManifest = {
  schema: "datalox.molecule.eval-corpus";
  version: "0.1.0";
  createdAt: string;                 // ISO timestamp
  packageName: "@datalox/molecule-biology";
  requiredToolSurface: {
    toolCount: number;                // expected: 30 at v0 start
    requiredTools: string[];
    descriptorDigest: string;         // sha256 over sorted tool descriptors
  };
  artifactHashAlgorithm: "sha256";
  tasks: Array<{
    id: string;
    title: string;
    path: string;                     // workspace-relative path to task.json
    category: "sequence_edit" | "digest" | "assembly" | "rendering" | "mrna" | "crispr";
    requiredTools: string[];
    expectedSummaryPath: string;
  }>;
};
```

## Task Manifest Schema

File: `eval-corpus/v0/tasks/<task-id>/task.json`

```ts
type EvalTask = {
  schema: "datalox.molecule.eval-task";
  version: "0.1.0";
  id: string;
  title: string;
  category: CorpusManifest["tasks"][number]["category"];
  objective: string;                  // agent-facing goal
  constraints: string[];              // hard rules for the agent
  inputs: Array<{
    id: string;
    path: string;
    kind: "genbank" | "fasta" | "json";
    sha256: string;
    source: string;                   // source/provenance note
  }>;
  toolPlan: Array<{
    step: number;
    tool: string;
    purpose: string;
    required: boolean;
  }>;
  expected: {
    summaryPath: string;
    toolObservationsPath?: string;
    artifactsPath?: string;
  };
  grading: {
    mode: "exact_json_subset";
    numericTolerance?: number;
    artifactHashRequired: boolean;
  };
  caveats: string[];
};
```

## Expected Summary Schema

File: `expected/summary.json`

```ts
type ExpectedSummary = {
  taskId: string;
  ok: true;
  workspace: {
    finalRevision: number;
    moleculeIds: string[];
  };
  checks: Array<{
    id: string;
    status: "pass";
    observed: unknown;
    expected: unknown;
  }>;
  artifacts: Array<{
    id: string;
    kind: "genbank" | "plasmid_map" | "gel" | "markdown" | "json";
    path: string;
    sha256: string;
    mimeType: string;
  }>;
};
```

Expected summaries should be small and agent-readable. They should not include
entire GenBank files or SVG bodies inline; use artifact hashes for that.

## Evaluator Rules

- Run tasks through the public MCP or CLI tool surface, not private helpers.
- Do not read or patch `molecule.workspace.json` directly during a task.
- Compare JSON through deterministic subset matching, not free-text matching.
- Hash artifact bytes exactly with SHA-256.
- If an artifact contains timestamps or non-deterministic IDs, the producing
  tool must be fixed before the task is accepted. Do not normalize away
  nondeterminism in the evaluator.
- A task passes only if `validate_workspace` succeeds with
  `checkSequenceDigests: true`.

## v0 Task Set

Start with tasks that use only shipped, local tools:

| ID | Category | Purpose | Required tools |
|---|---|---|---|
| `mb-edit-puc19-mcs-insert` | `sequence_edit` | Edit pUC19 in the MCS, verify workspace consistency, render map | `open_sequence`, `edit_sequence`, `validate_workspace`, `get_sequence_context`, `find_restriction_sites`, `render_plasmid_map` |
| `mb-digest-puc19-hindiii-xhoi` | `digest` | Reproduce the diagnostic digest table and gel from D1 | `open_sequence`, `simulate_digest`, `render_digest_gel` |
| `mb-assembly-restriction-ligation` | `assembly` | Simulate EcoRI/BamHI restriction ligation artifact generation | `open_sequence`, `simulate_assembly`, `validate_workspace` |
| `mb-crispr-puc19-ngg` | `crispr` | Scan local SpCas9 guides and persist one selected guide | `open_sequence`, `design_grnas`, `upsert_grna`, `export_grna_report` |
| `mb-mrna-il27-validation` | `mrna` | Validate an mRNA element layout and export translated protein FASTA | `open_sequence`, `validate_mrna_construct`, `export_protein_fasta` |

Only the first task is specified below. The remaining v0 tasks should get their
own task manifests after this spec is accepted.

## First Task: `mb-edit-puc19-mcs-insert`

### Objective

Import authentic pUC19, insert a short deterministic DNA payload into the MCS,
verify that the workspace remains valid, and render the edited plasmid map.

This task exists to catch failures in:

- revision-safe sequence editing;
- new-file sequence storage and digest consistency;
- feature remapping over a real multi-feature GenBank record;
- CDS frame-impact reporting;
- agent use of `translate_region` when a CDS edit could affect protein sequence.

### Input

```json
{
  "id": "puc19",
  "path": "inputs/puc19.gb",
  "kind": "genbank",
  "source": "Repo fixture copied from fixtures/genbank/puc19.gb"
}
```

The implementation should copy `fixtures/genbank/puc19.gb` into the task input
directory and record its SHA-256 hash in `task.json`.

### Tool Plan

```json
[
  {
    "step": 1,
    "tool": "open_sequence",
    "purpose": "Import pUC19 into a fresh task workspace.",
    "required": true
  },
  {
    "step": 2,
    "tool": "edit_sequence",
    "purpose": "Insert a deterministic payload at the pUC19 MCS EcoRI site.",
    "required": true
  },
  {
    "step": 3,
    "tool": "validate_workspace",
    "purpose": "Verify molecule length, digest, and feature coordinates after edit.",
    "required": true
  },
  {
    "step": 4,
    "tool": "get_sequence_context",
    "purpose": "Read the edited region and featureImpact-relevant annotations.",
    "required": true
  },
  {
    "step": 5,
    "tool": "find_restriction_sites",
    "purpose": "Find the inserted NotI site and return the exact cut-site coordinates from the enzyme table.",
    "required": true
  },
  {
    "step": 6,
    "tool": "render_plasmid_map",
    "purpose": "Render a deterministic visual artifact for the edited plasmid with the NotI site supplied as cutSites.",
    "required": true
  }
]
```

### Edit Parameters

Use a payload that is biologically inert for this v0 task and easy to verify:

```json
{
  "operation": "insert",
  "start": 402,
  "sequence": "GCGGCCGC"
}
```

Rationale:

- pUC19 EcoRI recognition sequence is at 396..401 in the authentic fixture.
- `start: 402` inserts immediately after the EcoRI site.
- `GCGGCCGC` is a NotI recognition sequence, giving a clear map/digest landmark.
- The insert is outside the `bla` CDS, so `bla` should be shifted if downstream
  in coordinate space but should not be marked `frameShifted`.

### Expected Invariants

The expected summary should pin:

- final molecule length is `2694` bp (`2686 + 8`);
- final workspace validates with `checkSequenceDigests: true`;
- edited sequence region around 396..409 contains `GAATTCGCGGCCGC`;
- `find_restriction_sites` reports a NotI recognition site at 402..409, with
  `cutPosition` determined by `datalox_rebase_common_v2`;
- `featureImpact` contains one entry for every pUC19 feature;
- no CDS feature reports `frameShifted: true` for this edit;
- plasmid map artifact exists, has kind `plasmid_map`, MIME type `image/svg+xml`,
  and a stable SHA-256 hash.

### Expected Summary Skeleton

```json
{
  "taskId": "mb-edit-puc19-mcs-insert",
  "ok": true,
  "workspace": {
    "finalRevision": 1,
    "moleculeIds": ["mol_puc19"]
  },
  "checks": [
    {
      "id": "length_after_insert",
      "status": "pass",
      "observed": 2694,
      "expected": 2694
    },
    {
      "id": "inserted_noti_site_present",
      "status": "pass",
      "observed": "GAATTCGCGGCCGC",
      "expected": "GAATTCGCGGCCGC"
    },
    {
      "id": "no_cds_frameshift",
      "status": "pass",
      "observed": false,
      "expected": false
    }
  ],
  "artifacts": [
    {
      "id": "edited_plasmid_map",
      "kind": "plasmid_map",
      "path": "artifacts/plasmid-map.svg",
      "sha256": "<filled-by-generation-step>",
      "mimeType": "image/svg+xml"
    }
  ]
}
```

## Implementation Order After Spec Approval

1. Commit the descriptor/handler parity test.
2. Add `docs/eval-corpus-v0-spec.md` and link it from
   `docs/roadmap-index-2026-07.md`.
3. Create the `eval-corpus/v0/` folders and task manifest for
   `mb-edit-puc19-mcs-insert`.
4. Add a generator/check script that runs the tool plan and writes expected
   summaries/artifact hashes.
5. Add an npm script that verifies the corpus without regenerating it.

Definition of done for v0: a CI-runnable command verifies all checked-in task
expected outputs and artifact hashes from a fresh workspace.
