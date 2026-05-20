import path from "node:path";

import type { Feature } from "../core/schema.js";
import { runToolHandler, type ToolResultEnvelope } from "../tools/index.js";
import {
  createReplayRecorder,
  packReplayBundle,
  recordToolCall,
  replayToolObservation,
  verifyReplayBundle,
  type JsonValue,
  type PackReplayBundleResult,
  type VerifyReplayBundleResult,
} from "./bundle.js";

export type RunReplayDemoOptions = {
  inputPath: string;
  workspaceDir: string;
  moleculeId?: string;
  bundleId?: string;
};

export type RunReplayDemoResult = {
  workspaceDir: string;
  workspacePath: string;
  moleculeId: string;
  featureId: string;
  finalRevision: number;
  bundle: PackReplayBundleResult;
  verification: VerifyReplayBundleResult;
  replayedRecordId: string;
  replayedObservation: JsonValue;
};

export async function runReplayDemo(options: RunReplayDemoOptions): Promise<RunReplayDemoResult> {
  const recorder = createReplayRecorder();
  const workspaceDir = path.resolve(options.workspaceDir);
  const inputPath = path.resolve(options.inputPath);

  const open = await recordToolCall(
    recorder,
    "open_sequence",
    {
      inputPath,
      workspaceDir,
      format: "fasta",
      ...(options.moleculeId ? { moleculeId: options.moleculeId } : {}),
    },
    () => runToolHandler("open_sequence", {
      inputPath,
      workspaceDir,
      format: "fasta",
      ...(options.moleculeId ? { moleculeId: options.moleculeId } : {}),
    }),
  );
  assertOk(open, "open_sequence");

  const workspacePath = open.workspacePath ?? (open.data as { workspacePath?: unknown }).workspacePath;
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    throw new Error("open_sequence did not return a workspace path");
  }
  const moleculeIds = (open.data as { moleculeIds?: unknown }).moleculeIds;
  const moleculeId = options.moleculeId ?? (Array.isArray(moleculeIds) && typeof moleculeIds[0] === "string" ? moleculeIds[0] : undefined);
  if (!moleculeId) throw new Error("open_sequence did not return a molecule id");

  const context = await recordToolCall(
    recorder,
    "get_sequence_context",
    {
      workspacePath,
      moleculeId,
      includeSequence: true,
    },
    () => runToolHandler("get_sequence_context", {
      workspacePath,
      moleculeId,
      includeSequence: true,
    }),
  );
  assertOk(context, "get_sequence_context");

  const molecule = (context.data as { molecule?: { length?: unknown } }).molecule;
  const moleculeLength = typeof molecule?.length === "number" ? molecule.length : undefined;
  if (moleculeLength === undefined || moleculeLength < 1) throw new Error("get_sequence_context did not return a valid molecule length");
  if (typeof context.revision !== "number") throw new Error("get_sequence_context did not return a revision");
  const expectedRevision = context.revision;

  const featureId = "feat_replay_demo";
  const feature: Feature = {
    id: featureId,
    moleculeId,
    name: "replay demo feature",
    type: "misc_feature",
    segments: [{ start: 1, end: Math.min(4, moleculeLength), strand: "+" }],
    qualifiers: {
      note: "captured through replay demo tool I/O",
    },
    source: { kind: "agent", tool: "upsert_feature" },
  };

  const upsert = await recordToolCall(
    recorder,
    "upsert_feature",
    {
      workspacePath,
      expectedRevision,
      feature,
    },
    () => runToolHandler("upsert_feature", {
      workspacePath,
      expectedRevision,
      feature,
    }),
  );
  assertOk(upsert, "upsert_feature");

  const validate = await recordToolCall(
    recorder,
    "validate_workspace",
    {
      workspacePath,
    },
    () => runToolHandler("validate_workspace", {
      workspacePath,
    }),
  );
  assertOk(validate, "validate_workspace");

  const bundle = await packReplayBundle(recorder, {
    workspaceDir,
    workspacePath,
    ...(options.bundleId ? { bundleId: options.bundleId } : {}),
  });
  const verification = await verifyReplayBundle(bundle.bundlePath);
  const replayedRecordId = bundle.manifest.records[1]?.id ?? bundle.manifest.records[0]?.id;
  if (!replayedRecordId) throw new Error("replay demo produced no records");
  const replayedObservation = await replayToolObservation(bundle.bundlePath, replayedRecordId);

  return {
    workspaceDir,
    workspacePath,
    moleculeId,
    featureId,
    finalRevision: bundle.manifest.workspaceSummary.revision,
    bundle,
    verification,
    replayedRecordId,
    replayedObservation,
  };
}

function assertOk(result: ToolResultEnvelope, toolName: string): asserts result is ToolResultEnvelope & { ok: true } {
  if (!result.ok) {
    throw new Error(`${toolName} failed: ${JSON.stringify(result.error)}`);
  }
}
