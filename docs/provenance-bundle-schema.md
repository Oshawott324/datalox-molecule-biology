# Provenance Bundle Schema

Status: V1 draft. This document formalizes the provenance bundle used by the
mol-bio -> hub trustworthy vertical.

The goal is not a pretty log. The goal is a machine-verifiable lab record:
every tool call, input, output envelope, artifact, and contract version needed
to inspect or replay the agent's work.

## Design Rules

- Append-only records. A bundle is a sequence of immutable tool-call records.
- Hash chained. Each record commits to the previous record hash.
- Versioned. Bundle, tool envelope, workspace schema, and producer versions are
  explicit.
- Bounded. Large artifacts are referenced by digest/path metadata, not embedded.
- Redacted before write. Secrets must be scrubbed before a record is persisted.
- Replay-aware. Replayers compare live tool contracts against recorded
  contracts and fail loudly on drift.

## TypeScript Contract

```ts
type ProvenanceBundleVersion = "1.0";
type HashAlgorithm = "sha256";

type ProvenanceBundle = {
  bundleVersion: ProvenanceBundleVersion;
  bundleId: string;              // stable generated id, e.g. prov_<timestamp>_<random>
  createdAt: string;             // ISO 8601
  completedAt?: string;          // ISO 8601, present after finalization
  producer: ProvenanceProducer;
  workspace: ProvenanceWorkspaceRef;
  toolCatalog: ProvenanceToolCatalogRef;
  records: ProvenanceToolCallRecord[];
  finalRecordHash?: string;      // hash of the last record after finalization
  bundleHash?: string;           // hash of canonical bundle metadata + finalRecordHash
  redaction: ProvenanceRedactionPolicy;
};

type ProvenanceProducer = {
  hubName: "datalox-hub";
  hubVersion: string;
  mcpServerName: "molecule-biology";
  mcpServerVersion: string;      // semver from package.json
  mcpSchemaVersion: string;      // mol-bio workspace / contract schema version
};

type ProvenanceWorkspaceRef = {
  workspacePath?: string;        // optional local path; may be omitted in shared bundles
  workspaceDigest: string;       // sha256 of canonical final workspace JSON
  initialRevision: number;
  finalRevision: number;
};

type ProvenanceToolCatalogRef = {
  catalogDigest: string;         // sha256 of canonical tools/list descriptor set
  toolNames: string[];
};

type ProvenanceArtifact = {
  kind: string;
  mimeType: string;
  path: string;                  // local or workspace-relative path
  digest?: string;               // sha256 of artifact bytes when available
  sizeBytes?: number;
  description?: string;
  truncated?: boolean;
  totalCount?: number;
};

type ProvenanceToolCallRecord = {
  seq: number;                   // 1-based call order
  recordId: string;              // e.g. rec_0001_open_sequence
  previousRecordHash: string | null;
  recordHash: string;            // sha256 canonical JSON of this record without recordHash
  hashAlgorithm: HashAlgorithm;
  calledAt: string;              // ISO 8601
  durationMs: number;
  tool: string;
  argumentsDigest: string;       // sha256 of canonical redacted arguments
  arguments: Record<string, unknown>;
  resultDigest: string;          // sha256 of canonical redacted result envelope
  result: Record<string, unknown>;
  artifacts: ProvenanceArtifact[];
  contract: {
    mcpServerVersion: string;
    mcpSchemaVersion: string;
    toolCatalogDigest: string;
  };
};

type ProvenanceRedactionPolicy = {
  policyVersion: "1.0";
  redactedPatterns: string[];    // names/classes, not secret values
  redactionApplied: boolean;
};
```

## Record Hashing

Hashing uses canonical JSON:

1. Object keys sorted lexicographically.
2. No insignificant whitespace.
3. UTF-8 encoding.
4. `recordHash` omitted from the record before hashing.
5. `previousRecordHash` included.

`recordHash = sha256(canonicalJson(recordWithoutRecordHash))`.

`bundleHash = sha256(canonicalJson({
  bundleVersion,
  bundleId,
  producer,
  workspace,
  toolCatalog,
  finalRecordHash,
  redaction
}))`.

## Redaction

Redaction is mandatory before persistence. The recorder must scrub:

- HTTP headers and authorization values.
- `apiKey`, `api_key`, `token`, `secret`, `password`, `bearer`.
- Values matching common key patterns (`sk-...`, JWT-looking tokens).
- Absolute host paths when a workspace-relative path is sufficient.
- `workspacePath` and other local path fields in shared/exported bundles when a
  workspace-relative reference or digest is sufficient.

Redaction must preserve shape. Replace values with:

```text
<redacted:api_key>
<redacted:token>
<redacted:absolute_path>
```

The bundle must never rely on callers remembering to redact.

## Artifact Policy

Artifacts are referenced, not embedded. Each artifact record should include:

- `kind`
- `mimeType`
- `path`
- `digest`
- `sizeBytes`
- `truncated` when applicable

If the artifact file is unavailable at bundle finalization time, the recorder
must include the artifact metadata and omit `digest`, with a warning record in
the finalization report. Do not silently drop the artifact.

## Replay Contract

Before replaying records, the replayer must compare:

- recorded `mcpServerName`
- recorded `mcpServerVersion`
- recorded `mcpSchemaVersion`
- recorded `toolCatalogDigest`

If incompatible, return:

```ts
{
  code: "CONTRACT_VERSION_MISMATCH",
  message: "Recorded provenance bundle does not match the live MCP contract.",
  details: {
    recorded: { mcpServerVersion, mcpSchemaVersion, toolCatalogDigest },
    live: { mcpServerVersion, mcpSchemaVersion, toolCatalogDigest }
  }
}
```

Do not silently replay against a different contract.

## Human Review Boundary

A finalized bundle represents a human-reviewed record. Finalization adds:

```ts
type ProvenanceReview = {
  reviewedAt: string;
  reviewerId?: string;
  decision: "approved" | "rejected" | "needs_revision";
  notes?: string;
};
```

The V1 hub UI should make this explicit with an Approve / Finalize Record
action. Tool execution can be agent-driven; record finalization is a human
boundary.

## Acceptance Criteria

- Creating a bundle with three tool calls produces a hash chain where each
  `previousRecordHash` equals the prior `recordHash`.
- Tampering with any argument, result, artifact metadata, or timestamp changes
  the affected record hash and invalidates every downstream record.
- Replay refuses a bundle when the live tool catalog digest differs.
- Secret-like values in arguments/results are redacted before they touch disk.
- Artifact metadata includes digest and byte size for generated files.
- The hub can render the bundle as a chronological tool-call list with artifact
  previews and a final human-review state.
