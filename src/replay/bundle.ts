import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { MoleculeWorkspace } from "../core/schema.js";
import {
  MCP_SCHEMA_VERSION,
  PACKAGE_VERSION,
  PROVENANCE_BUNDLE_VERSION,
  PROVENANCE_REDACTION_POLICY_VERSION,
} from "../core/version.js";
import { readWorkspace } from "../core/workspace.js";
import { moleculeToolDescriptors } from "../tools/descriptors.js";
import type { ToolInputByName, ToolName, ToolResultEnvelope } from "../tools/index.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ReplayToolRecord<TTool extends ToolName = ToolName> = {
  id: string;
  index: number;
  toolName: TTool;
  previousRecordHash: string | null;
  recordHash: string;
  hashAlgorithm: "sha256";
  calledAt: string;
  durationMs: number;
  request: JsonValue;
  observation: JsonValue;
  requestDigest: string;
  observationDigest: string;
};

export type ReplayRecorder = {
  records: ReplayToolRecord[];
};

export type ReplayManifestRecord = {
  id: string;
  index: number;
  toolName: ToolName;
  path: string;
  requestDigest: string;
  observationDigest: string;
};

export type ReplayWorkspaceSummary = {
  workspacePath: string;
  workspaceDigest: string;
  workspaceId: string;
  revision: number;
  moleculeCount: number;
  featureCount: number;
  primerCount: number;
  moleculeIds: string[];
  featureIds: string[];
  primerIds: string[];
};

export type ReplayBundleManifest = {
  schema: "datalox.molecule.replay_bundle";
  version: 1;
  bundleVersion: typeof PROVENANCE_BUNDLE_VERSION;
  bundleId: string;
  workspaceDir: string;
  workspaceSummary: ReplayWorkspaceSummary;
  producer: {
    hubName: "datalox-local-review";
    hubVersion: typeof PACKAGE_VERSION;
    mcpServerName: "molecule-biology";
    mcpServerVersion: typeof PACKAGE_VERSION;
    mcpSchemaVersion: typeof MCP_SCHEMA_VERSION;
  };
  toolCatalog: {
    catalogDigest: string;
    toolNames: string[];
  };
  records: ReplayManifestRecord[];
  finalRecordHash?: string;
  bundleHash?: string;
  redaction: {
    policyVersion: typeof PROVENANCE_REDACTION_POLICY_VERSION;
    redactedPatterns: string[];
    redactionApplied: boolean;
  };
  summary: {
    toolCount: number;
    tools: ToolName[];
    finalRevision: number;
  };
};

export type PackReplayBundleOptions = {
  workspaceDir: string;
  bundleId?: string;
  workspacePath?: string;
};

export type PackReplayBundleResult = {
  bundleId: string;
  bundlePath: string;
  manifestPath: string;
  manifest: ReplayBundleManifest;
};

export type VerifyReplayBundleResult = {
  ok: boolean;
  bundlePath: string;
  manifestPath: string;
  recordCount: number;
  issues: string[];
  manifest?: ReplayBundleManifest;
};

export function createReplayRecorder(): ReplayRecorder {
  return { records: [] };
}

export async function recordToolCall<TTool extends ToolName>(
  recorder: ReplayRecorder,
  toolName: TTool,
  input: ToolInputByName[TTool],
  run: () => Promise<ToolResultEnvelope>,
): Promise<ToolResultEnvelope> {
  const request = toJsonValue(input, "request");
  const calledAt = new Date().toISOString();
  const startedAt = Date.now();
  const observation = toJsonValue(await run(), "observation");
  const durationMs = Date.now() - startedAt;
  const index = recorder.records.length + 1;
  const previousRecordHash = recorder.records[recorder.records.length - 1]?.recordHash ?? null;
  const recordWithoutHash = {
    id: recordId(index, toolName),
    index,
    toolName,
    previousRecordHash,
    hashAlgorithm: "sha256" as const,
    calledAt,
    durationMs,
    request,
    observation,
    requestDigest: sha256Json(request),
    observationDigest: sha256Json(observation),
  };
  const record: ReplayToolRecord<TTool> = {
    ...recordWithoutHash,
    recordHash: sha256Json(toJsonValue(recordWithoutHash, "record")),
  };
  recorder.records.push(record);
  return observation as ToolResultEnvelope;
}

export async function packReplayBundle(
  recorder: ReplayRecorder,
  options: PackReplayBundleOptions,
): Promise<PackReplayBundleResult> {
  const workspaceDir = path.resolve(options.workspaceDir);
  const workspacePath = path.resolve(options.workspacePath ?? path.join(workspaceDir, "molecule.workspace.json"));
  const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
  const bundleId = options.bundleId ?? defaultBundleId(recorder, workspace);
  assertSafeBundleId(bundleId);
  const bundlePath = path.join(workspaceDir, ".datalox", "replay-bundles", bundleId);
  const recordsDir = path.join(bundlePath, "records");
  const manifestPath = path.join(bundlePath, "manifest.json");

  await fs.rm(bundlePath, { recursive: true, force: true });
  await fs.mkdir(recordsDir, { recursive: true });

  const manifestRecords: ReplayManifestRecord[] = [];
  for (const record of recorder.records) {
    const recordPath = path.join("records", `${String(record.index).padStart(4, "0")}_${sanitizeToolName(record.toolName)}.json`);
    await writeJsonFile(path.join(bundlePath, recordPath), record);
    manifestRecords.push({
      id: record.id,
      index: record.index,
      toolName: record.toolName,
      path: recordPath,
      requestDigest: record.requestDigest,
      observationDigest: record.observationDigest,
    });
  }

  const workspaceSummary = summarizeWorkspace(workspacePath, workspace);
  const finalRecordHash = manifestRecords.length > 0
    ? recorder.records[recorder.records.length - 1]?.recordHash
    : undefined;
  const manifestWithoutBundleHash: ReplayBundleManifest = {
    schema: "datalox.molecule.replay_bundle",
    version: 1,
    bundleVersion: PROVENANCE_BUNDLE_VERSION,
    bundleId,
    workspaceDir,
    workspaceSummary,
    producer: {
      hubName: "datalox-local-review",
      hubVersion: PACKAGE_VERSION,
      mcpServerName: "molecule-biology",
      mcpServerVersion: PACKAGE_VERSION,
      mcpSchemaVersion: MCP_SCHEMA_VERSION,
    },
    toolCatalog: currentToolCatalog(),
    records: manifestRecords,
    ...(finalRecordHash ? { finalRecordHash } : {}),
    redaction: {
      policyVersion: PROVENANCE_REDACTION_POLICY_VERSION,
      redactedPatterns: [
        "apiKey",
        "api_key",
        "token",
        "secret",
        "password",
        "bearer",
        "absolute_host_paths",
        "workspacePath",
      ],
      redactionApplied: true,
    },
    summary: {
      toolCount: manifestRecords.length,
      tools: manifestRecords.map((record) => record.toolName),
      finalRevision: workspaceSummary.revision,
    },
  };
  const manifest: ReplayBundleManifest = {
    ...manifestWithoutBundleHash,
    bundleHash: bundleHashForManifest(manifestWithoutBundleHash),
  };
  await writeJsonFile(manifestPath, manifest);

  return { bundleId, bundlePath, manifestPath, manifest };
}

export async function verifyReplayBundle(bundlePath: string): Promise<VerifyReplayBundleResult> {
  const resolvedBundlePath = path.resolve(bundlePath);
  const manifestPath = path.join(resolvedBundlePath, "manifest.json");
  const issues: string[] = [];
  let manifest: ReplayBundleManifest | undefined;

  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ReplayBundleManifest;
  } catch (error) {
    return {
      ok: false,
      bundlePath: resolvedBundlePath,
      manifestPath,
      recordCount: 0,
      issues: [`manifest.json could not be read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (manifest.schema !== "datalox.molecule.replay_bundle") issues.push("manifest schema is invalid");
  if (manifest.version !== 1) issues.push("manifest version is invalid");
  if (manifest.bundleVersion !== PROVENANCE_BUNDLE_VERSION) issues.push("manifest bundleVersion is invalid");
  if (manifest.producer?.mcpServerName !== "molecule-biology") issues.push("manifest producer mcpServerName is invalid");
  if (manifest.producer?.mcpServerVersion !== PACKAGE_VERSION) issues.push("manifest producer mcpServerVersion does not match this package");
  if (manifest.toolCatalog?.catalogDigest !== currentToolCatalog().catalogDigest) {
    issues.push("manifest toolCatalog digest does not match live descriptors");
  }
  if (manifest.bundleHash !== bundleHashForManifest({ ...manifest, bundleHash: undefined })) {
    issues.push("manifest bundleHash does not match manifest metadata");
  }
  if (!Array.isArray(manifest.records)) issues.push("manifest records must be an array");

  const records = Array.isArray(manifest.records) ? manifest.records : [];
  verifyManifestSummary(manifest, records, issues);
  let previousRecordHash: string | null = null;
  let finalRecordHash: string | undefined;
  for (const manifestRecord of records) {
    const recordPath = resolveBundleRecordPath(resolvedBundlePath, manifestRecord, issues);
    if (recordPath === undefined) continue;
    try {
      const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as ReplayToolRecord;
      verifyRecordAgainstManifest(record, manifestRecord, issues);
      if (record.previousRecordHash !== previousRecordHash) {
        issues.push(`${manifestRecord.id}: previousRecordHash does not match prior record`);
      }
      previousRecordHash = record.recordHash;
      finalRecordHash = record.recordHash;
    } catch (error) {
      issues.push(`${manifestRecord.id}: record could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (records.length > 0 && manifest.finalRecordHash !== finalRecordHash) {
    issues.push("manifest finalRecordHash does not match the last record");
  }

  return {
    ok: issues.length === 0,
    bundlePath: resolvedBundlePath,
    manifestPath,
    recordCount: records.length,
    issues,
    manifest,
  };
}

export async function replayToolObservation(bundlePath: string, recordIdOrIndex: string | number): Promise<JsonValue> {
  const resolvedBundlePath = path.resolve(bundlePath);
  const manifest = JSON.parse(await fs.readFile(path.join(resolvedBundlePath, "manifest.json"), "utf8")) as ReplayBundleManifest;
  const manifestRecord = manifest.records.find((record) => record.id === recordIdOrIndex || record.index === recordIdOrIndex);
  if (!manifestRecord) {
    throw new Error(`Replay record was not found: ${String(recordIdOrIndex)}`);
  }

  const issues: string[] = [];
  const recordPath = resolveBundleRecordPath(resolvedBundlePath, manifestRecord, issues);
  if (recordPath === undefined) {
    throw new Error(`Replay record failed verification: ${issues.join("; ")}`);
  }
  const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as ReplayToolRecord;
  verifyRecordAgainstManifest(record, manifestRecord, issues);
  if (issues.length > 0) {
    throw new Error(`Replay record failed verification: ${issues.join("; ")}`);
  }
  return record.observation;
}

export function sha256Json(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;
}

export function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
}

function verifyRecordAgainstManifest(record: ReplayToolRecord, manifestRecord: ReplayManifestRecord, issues: string[]): void {
  if (record.id !== manifestRecord.id) issues.push(`${manifestRecord.id}: record id mismatch`);
  if (record.index !== manifestRecord.index) issues.push(`${manifestRecord.id}: record index mismatch`);
  if (record.toolName !== manifestRecord.toolName) issues.push(`${manifestRecord.id}: record tool name mismatch`);

  const requestDigest = sha256Json(toJsonValue(record.request, `${manifestRecord.id}.request`));
  const observationDigest = sha256Json(toJsonValue(record.observation, `${manifestRecord.id}.observation`));
  if (record.requestDigest !== requestDigest) issues.push(`${manifestRecord.id}: request digest does not match record request`);
  if (record.observationDigest !== observationDigest) issues.push(`${manifestRecord.id}: observation digest does not match record observation`);
  if (manifestRecord.requestDigest !== requestDigest) issues.push(`${manifestRecord.id}: request digest does not match manifest`);
  if (manifestRecord.observationDigest !== observationDigest) issues.push(`${manifestRecord.id}: observation digest does not match manifest`);

  const recordHash = sha256Json(toJsonValue({ ...record, recordHash: undefined }, `${manifestRecord.id}.record`));
  if (record.recordHash !== recordHash) issues.push(`${manifestRecord.id}: record hash does not match record contents`);
}

function verifyManifestSummary(
  manifest: ReplayBundleManifest,
  records: ReplayManifestRecord[],
  issues: string[],
): void {
  const seenIds = new Set<string>();
  const seenIndexes = new Set<number>();

  for (const record of records) {
    if (seenIds.has(record.id)) issues.push(`${record.id}: duplicate record id`);
    seenIds.add(record.id);
    if (seenIndexes.has(record.index)) issues.push(`${record.id}: duplicate record index ${record.index}`);
    seenIndexes.add(record.index);
  }

  const expectedIndexes = records.map((record) => record.index).sort((left, right) => left - right);
  for (let index = 0; index < expectedIndexes.length; index += 1) {
    if (expectedIndexes[index] !== index + 1) {
      issues.push("manifest record indexes must be sequential starting at 1");
      break;
    }
  }

  if (manifest.summary.toolCount !== records.length) {
    issues.push("manifest summary toolCount does not match records");
  }
  if (JSON.stringify(manifest.summary.tools) !== JSON.stringify(records.map((record) => record.toolName))) {
    issues.push("manifest summary tools do not match records");
  }
  if (manifest.summary.finalRevision !== manifest.workspaceSummary.revision) {
    issues.push("manifest summary finalRevision does not match workspace summary revision");
  }
  if (records.length === 0 && manifest.finalRecordHash !== undefined) issues.push("manifest finalRecordHash must be absent when there are no records");
  if (records.length > 0 && manifest.finalRecordHash === undefined) issues.push("manifest finalRecordHash is missing");
}

function resolveBundleRecordPath(
  bundlePath: string,
  manifestRecord: ReplayManifestRecord,
  issues: string[],
): string | undefined {
  if (typeof manifestRecord.path !== "string" || manifestRecord.path.length === 0) {
    issues.push(`${manifestRecord.id}: record path is invalid`);
    return undefined;
  }
  if (path.isAbsolute(manifestRecord.path)) {
    issues.push(`${manifestRecord.id}: record path must be relative`);
    return undefined;
  }

  const recordsDir = path.join(bundlePath, "records");
  const recordPath = path.resolve(bundlePath, manifestRecord.path);
  const relativePath = path.relative(recordsDir, recordPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    issues.push(`${manifestRecord.id}: record path must stay inside records/`);
    return undefined;
  }
  return recordPath;
}

function summarizeWorkspace(workspacePath: string, workspace: MoleculeWorkspace): ReplayWorkspaceSummary {
  return {
    workspacePath,
    workspaceDigest: sha256Json(toJsonValue(workspace, "workspace")),
    workspaceId: workspace.workspaceId,
    revision: workspace.revision,
    moleculeCount: workspace.molecules.length,
    featureCount: workspace.features.length,
    primerCount: workspace.primers.length,
    moleculeIds: workspace.molecules.map((molecule) => molecule.id),
    featureIds: workspace.features.map((feature) => feature.id),
    primerIds: workspace.primers.map((primer) => primer.id),
  };
}

function currentToolCatalog(): { catalogDigest: string; toolNames: string[] } {
  const toolNames = moleculeToolDescriptors.map((descriptor) => descriptor.name);
  return {
    catalogDigest: sha256Json(toJsonValue(moleculeToolDescriptors, "toolCatalog")),
    toolNames,
  };
}

function bundleHashForManifest(manifest: ReplayBundleManifest): string {
  const { bundleHash: _bundleHash, ...hashable } = manifest;
  return sha256Json(toJsonValue(hashable, "manifest"));
}

function defaultBundleId(recorder: ReplayRecorder, workspace: MoleculeWorkspace): string {
  const payload: JsonValue = {
    workspaceId: workspace.workspaceId,
    revision: workspace.revision,
    records: recorder.records.map((record) => ({
      id: record.id,
      requestDigest: record.requestDigest,
      observationDigest: record.observationDigest,
    })),
  };
  return `replay_${sha256Json(payload).slice("sha256:".length, "sha256:".length + 16)}`;
}

function recordId(index: number, toolName: ToolName): string {
  return `record_${String(index).padStart(4, "0")}_${sanitizeToolName(toolName)}`;
}

function sanitizeToolName(toolName: ToolName): string {
  return toolName.replace(/[^a-z0-9_]+/g, "_");
}

function assertSafeBundleId(bundleId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(bundleId) || bundleId === "." || bundleId === "..") {
    throw new Error(`Replay bundle id is invalid: ${bundleId}`);
  }
}

function toJsonValue(value: unknown, label: string): JsonValue {
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value as JsonPrimitive;
  if (valueType === "number") {
    const numberValue = value as number;
    if (!Number.isFinite(numberValue)) throw new Error(`${label} contains a non-finite number`);
    return numberValue;
  }
  if (Array.isArray(value)) return value.map((entry, index) => toJsonValue(entry, `${label}[${index}]`));
  if (valueType === "object") {
    const output: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      output[key] = toJsonValue(entry, `${label}.${key}`);
    }
    return output;
  }
  throw new Error(`${label} contains a non-JSON value`);
}

async function writeJsonFile(filePath: string, value: JsonValue): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
