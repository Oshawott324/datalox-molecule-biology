# Eval Corpus v0 Spec

Status: implemented. `npm run eval:corpus:v0:check` verifies the checked-in
v0 task manifests, expected summaries, selected observations, and artifact
hashes through the public MCP stdio server.

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
      mb-edit-puc19-laczalpha-frameshift/
        task.json
        inputs/
          puc19-laczalpha-cds.gb
        expected/
          summary.json
          tool-observations.json
          artifacts.json
        artifacts/
          plasmid-map.svg
      mb-digest-puc19-hindiii-xhoi/
      mb-assembly-restriction-ligation/
      mb-crispr-puc19-ngg/
      mb-mrna-il27-validation/
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
    kind: "genbank" | "plasmid_map" | "gel" | "markdown" | "json" | "protein_fasta";
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
| `mb-edit-puc19-laczalpha-frameshift` | `sequence_edit` | Edit a pUC19 variant with a benchmark-only lacZalpha CDS proxy and verify the frameshift is reported | `open_sequence`, `edit_sequence`, `validate_workspace`, `get_sequence_context`, `translate_region`, `render_plasmid_map` |
| `mb-digest-puc19-hindiii-xhoi` | `digest` | Reproduce the diagnostic digest table and gel from D1 | `open_sequence`, `simulate_digest`, `render_digest_gel` |
| `mb-assembly-restriction-ligation` | `assembly` | Simulate EcoRI/BamHI restriction ligation artifact generation | `open_sequence`, `simulate_assembly`, `validate_workspace` |
| `mb-crispr-puc19-ngg` | `crispr` | Scan local SpCas9 guides and persist one selected guide | `open_sequence`, `design_grnas`, `upsert_grna`, `export_grna_report` |
| `mb-mrna-il27-validation` | `mrna` | Validate an mRNA element layout and export translated protein FASTA | `open_sequence`, `validate_mrna_construct`, `export_protein_fasta` |

The first two sequence-edit tasks are specified below because together they pin
the most important v0 biology distinction:

- a coordinate edit that does not affect the `bla` CDS reading frame;
- a pUC19 MCS edit that frameshifts lacZalpha when lacZalpha is explicitly
  annotated as a CDS.

The digest, assembly, CRISPR, and mRNA tasks are implemented as checked-in task
manifests under `eval-corpus/v0/tasks/`; their generated expected summaries are
the authoritative grading surface.

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
    "purpose": "Import pUC19 into a fresh task workspace as moleculeId mol_puc19.",
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

Use a payload that does not affect the `bla` CDS and is easy to verify:

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
- The authentic fixture annotates lacZalpha as a non-CDS feature. Therefore this
  task MUST NOT claim lacZalpha protein consequences; that is tested separately
  in `mb-edit-puc19-laczalpha-frameshift`.

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

## Second Task: `mb-edit-puc19-laczalpha-frameshift`

### Objective

Use a pUC19 fixture variant with a benchmark-only lacZalpha CDS proxy that
includes the MCS, perform the same 8 bp MCS insertion, and verify that
`edit_sequence` reports a CDS frameshift for that proxy while leaving `bla`
reading-frame integrity intact.

This task turns the pUC19 blue/white-screening biology into a falsifiable corpus
check. An 8 bp insert in the MCS is expected to disrupt the lacZalpha alpha
peptide reading frame when the MCS is included in the CDS annotation.

### Input

```json
{
  "id": "puc19_laczalpha_cds",
  "path": "inputs/puc19-laczalpha-cds.gb",
  "kind": "genbank",
  "source": "Derived from fixtures/genbank/puc19.gb by adding a benchmark-only lacZalpha CDS proxy; sequence must be byte-identical after parsing"
}
```

The fixture variant must preserve the authentic pUC19 sequence. The current
source fixture annotates lacZalpha as `gene complement(join(238..395,455..682))`,
which excludes the MCS. Simply changing that joined feature's type to `CDS` would
NOT test MCS insertional frameshift. For this benchmark task, add a separate
feature named `lacZalpha_frame_proxy` with type `CDS`, strand `-`, and one
continuous segment spanning `238..681`. This proxy is a benchmark annotation used
only to test frame-impact reporting over an MCS-containing CDS interval.

The generator/checker must verify:

- original sequence digest matches the authentic pUC19 fixture digest;
- the source `lacZalpha` gene feature remains unchanged from the source fixture;
- the added `lacZalpha_frame_proxy` feature is type `CDS`, strand `-`, one
  segment `238..681`, and length `444` bp before editing.

### Tool Plan

```json
[
  {
    "step": 1,
    "tool": "open_sequence",
    "purpose": "Import the lacZalpha-CDS pUC19 variant into a fresh task workspace as moleculeId mol_puc19_laczalpha_cds.",
    "required": true
  },
  {
    "step": 2,
    "tool": "translate_region",
    "purpose": "Translate the lacZalpha_frame_proxy CDS before editing to capture the pre-edit amino-acid consequence boundary.",
    "required": true
  },
  {
    "step": 3,
    "tool": "edit_sequence",
    "purpose": "Insert the same 8 bp NotI payload immediately after the EcoRI site in the MCS.",
    "required": true
  },
  {
    "step": 4,
    "tool": "validate_workspace",
    "purpose": "Verify molecule length, digest, and feature coordinates after edit.",
    "required": true
  },
  {
    "step": 5,
    "tool": "get_sequence_context",
    "purpose": "Read feature impacts and edited sequence context.",
    "required": true
  },
  {
    "step": 6,
    "tool": "translate_region",
    "purpose": "Translate the remapped lacZalpha_frame_proxy CDS after editing so amino-acid consequence is checked outside edit_sequence.",
    "required": true
  },
  {
    "step": 7,
    "tool": "render_plasmid_map",
    "purpose": "Render a deterministic visual artifact for the edited plasmid.",
    "required": true
  }
]
```

### Edit Parameters

Use the same edit as `mb-edit-puc19-mcs-insert`:

```json
{
  "operation": "insert",
  "start": 402,
  "sequence": "GCGGCCGC"
}
```

### Expected Invariants

The expected summary should pin:

- final molecule length is `2694` bp (`2686 + 8`);
- final workspace validates with `checkSequenceDigests: true`;
- edited sequence region around 396..409 contains `GAATTCGCGGCCGC`;
- `lacZalpha_frame_proxy` appears in `featureImpact` with `impact: "split"`,
  `beforeSegments: [{ "start": 238, "end": 681, "strand": "-" }]`,
  `afterSegments: [{ "start": 238, "end": 689, "strand": "-" }]`, and
  `frameShifted: true`;
- `bla` appears in `featureImpact` without `frameShifted: true`;
- the task does not infer protein consequence from `edit_sequence` alone; any
  amino-acid claim must be checked by `translate_region`;
- plasmid map artifact exists, has kind `plasmid_map`, MIME type `image/svg+xml`,
  and a stable SHA-256 hash.

### Expected Summary Skeleton

```json
{
  "taskId": "mb-edit-puc19-laczalpha-frameshift",
  "ok": true,
  "workspace": {
    "finalRevision": 1,
    "moleculeIds": ["mol_puc19_laczalpha_cds"]
  },
  "checks": [
    {
      "id": "length_after_insert",
      "status": "pass",
      "observed": 2694,
      "expected": 2694
    },
    {
      "id": "laczalpha_frame_proxy_frameshift_reported",
      "status": "pass",
      "observed": true,
      "expected": true
    },
    {
      "id": "bla_no_frameshift",
      "status": "pass",
      "observed": false,
      "expected": false
    }
  ],
  "artifacts": [
    {
      "id": "edited_laczalpha_plasmid_map",
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
3. Create the `eval-corpus/v0/` folders and task manifests for
   `mb-edit-puc19-mcs-insert` and `mb-edit-puc19-laczalpha-frameshift`.
4. Add a generator/check script that runs the tool plan and writes expected
   summaries/artifact hashes.
5. Add an npm script that verifies the corpus without regenerating it.

Definition of done for v0: a CI-runnable command verifies all checked-in task
expected outputs and artifact hashes from a fresh workspace.
