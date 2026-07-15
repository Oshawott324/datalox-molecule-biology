import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/main.js";
import {
  readWorkspace,
  replayToolObservation,
  runReplayDemo,
  verifyReplayBundle,
  type ReplayToolRecord,
} from "../src/index.js";
import { MCP_SCHEMA_VERSION } from "../src/core/version.js";
import { stageFixture } from "./support/fixtures.js";

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-replay-"));
}

describe("Datalox replay demo", () => {
  it("captures, packs, verifies, and replays agent-visible tool observations", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await runReplayDemo({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      moleculeId: "mol_replay",
    });

    await expect(fs.stat(result.bundle.bundlePath)).resolves.toBeTruthy();
    await expect(fs.stat(result.bundle.manifestPath)).resolves.toBeTruthy();
    expect(result.bundle.manifest.records).toHaveLength(4);
    expect(result.bundle.manifest.summary.tools).toEqual([
      "open_sequence",
      "get_sequence_context",
      "upsert_feature",
      "validate_workspace",
    ]);
    expect(result.verification).toMatchObject({ ok: true, recordCount: 4, issues: [] });

    const replayedRecord = result.bundle.manifest.records[1];
    const storedRecord = JSON.parse(
      await fs.readFile(path.join(result.bundle.bundlePath, replayedRecord.path), "utf8"),
    ) as ReplayToolRecord;
    const firstRecord = JSON.parse(
      await fs.readFile(path.join(result.bundle.bundlePath, result.bundle.manifest.records[0].path), "utf8"),
    ) as ReplayToolRecord;
    const lastRecord = JSON.parse(
      await fs.readFile(path.join(result.bundle.bundlePath, result.bundle.manifest.records[result.bundle.manifest.records.length - 1].path), "utf8"),
    ) as ReplayToolRecord;
    await expect(replayToolObservation(result.bundle.bundlePath, replayedRecord.id)).resolves.toEqual(storedRecord.observation);
    expect(result.replayedObservation).toEqual(storedRecord.observation);

    const workspace = await readWorkspace(result.workspacePath, { checkSequenceDigests: true });
    expect(workspace.revision).toBe(result.finalRevision);
    expect(result.bundle.manifest.workspaceSummary.revision).toBe(workspace.revision);
    expect(result.bundle.manifest.summary.finalRevision).toBe(workspace.revision);
    expect(result.bundle.manifest.workspaceSummary.featureIds).toContain(result.featureId);
    expect(result.bundle.manifest).toMatchObject({
      bundleVersion: "1.0",
      producer: {
        hubName: "datalox-local-review",
        mcpServerName: "molecule-biology",
        mcpServerVersion: "0.1.0",
        mcpSchemaVersion: MCP_SCHEMA_VERSION,
      },
      redaction: {
        policyVersion: "1.0",
        redactionApplied: true,
      },
    });
    expect(result.bundle.manifest.workspaceSummary.workspaceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.bundle.manifest.toolCatalog.catalogDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.bundle.manifest.finalRecordHash).toBe(lastRecord.recordHash);
    expect(result.bundle.manifest.bundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstRecord.previousRecordHash).toBeNull();
    expect(storedRecord.previousRecordHash).toBe(firstRecord.recordHash);
    expect(storedRecord.recordHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails verification when a record observation is corrupted", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await runReplayDemo({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      moleculeId: "mol_replay_corrupt",
    });
    const recordPath = path.join(result.bundle.bundlePath, result.bundle.manifest.records[2].path);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as ReplayToolRecord;
    await fs.writeFile(recordPath, `${JSON.stringify({ ...record, observation: { ok: true, corrupted: true } }, null, 2)}\n`, "utf8");

    const verification = await verifyReplayBundle(result.bundle.bundlePath);

    expect(verification.ok).toBe(false);
    expect(verification.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("observation digest"),
    ]));
  });

  it("fails verification when the bundle summary disagrees with records", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await runReplayDemo({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      moleculeId: "mol_replay_summary",
    });
    const manifest = JSON.parse(await fs.readFile(result.bundle.manifestPath, "utf8")) as typeof result.bundle.manifest;
    await fs.writeFile(
      result.bundle.manifestPath,
      `${JSON.stringify({ ...manifest, summary: { ...manifest.summary, toolCount: 99 } }, null, 2)}\n`,
      "utf8",
    );

    const verification = await verifyReplayBundle(result.bundle.bundlePath);

    expect(verification.ok).toBe(false);
    expect(verification.issues).toContain("manifest summary toolCount does not match records");
  });

  it("fails verification when the provenance hash chain is corrupted", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await runReplayDemo({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      moleculeId: "mol_replay_hash_chain",
    });
    const secondManifestRecord = result.bundle.manifest.records[1];
    const secondRecordPath = path.join(result.bundle.bundlePath, secondManifestRecord.path);
    const secondRecord = JSON.parse(await fs.readFile(secondRecordPath, "utf8")) as ReplayToolRecord;
    await fs.writeFile(
      secondRecordPath,
      `${JSON.stringify({ ...secondRecord, previousRecordHash: "sha256:bad" }, null, 2)}\n`,
      "utf8",
    );

    const verification = await verifyReplayBundle(result.bundle.bundlePath);

    expect(verification.ok).toBe(false);
    expect(verification.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("previousRecordHash"),
      expect.stringContaining("record hash"),
    ]));
  });

  it("fails verification when the recorded tool catalog digest drifts", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await runReplayDemo({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      moleculeId: "mol_replay_catalog",
    });
    const manifest = JSON.parse(await fs.readFile(result.bundle.manifestPath, "utf8")) as typeof result.bundle.manifest;
    await fs.writeFile(
      result.bundle.manifestPath,
      `${JSON.stringify({ ...manifest, toolCatalog: { ...manifest.toolCatalog, catalogDigest: "sha256:bad" } }, null, 2)}\n`,
      "utf8",
    );

    const verification = await verifyReplayBundle(result.bundle.bundlePath);

    expect(verification.ok).toBe(false);
    expect(verification.issues).toContain("manifest toolCatalog digest does not match live descriptors");
  });

  it("fails verification when the bundle hash is corrupted", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const result = await runReplayDemo({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      moleculeId: "mol_replay_bundle_hash",
    });
    const manifest = JSON.parse(await fs.readFile(result.bundle.manifestPath, "utf8")) as typeof result.bundle.manifest;
    await fs.writeFile(
      result.bundle.manifestPath,
      `${JSON.stringify({ ...manifest, bundleHash: "sha256:bad" }, null, 2)}\n`,
      "utf8",
    );

    const verification = await verifyReplayBundle(result.bundle.bundlePath);

    expect(verification.ok).toBe(false);
    expect(verification.issues).toContain("manifest bundleHash does not match manifest metadata");
  });

  it("runs the replay demo through the CLI command path", async () => {
    const workspaceDir = await tempWorkspaceDir();
    const cli = await runCli([
      "replay-demo",
      "--input-path",
      await stageFixture(workspaceDir, "fasta/single.fa"),
      "--workspace-dir",
      workspaceDir,
      "--molecule-id",
      "mol_replay_cli",
    ]);

    const output = JSON.parse(cli.stdout) as Awaited<ReturnType<typeof runReplayDemo>>;

    expect(cli.exitCode).toBe(0);
    expect(output.verification).toMatchObject({ ok: true, recordCount: 4, issues: [] });
    expect(output.bundle.bundlePath).toContain(`${path.sep}.datalox${path.sep}replay-bundles${path.sep}`);
    expect(output.replayedObservation).toEqual(await replayToolObservation(output.bundle.bundlePath, output.replayedRecordId));
  });

  it("rejects unsafe bundle ids", async () => {
    const workspaceDir = await tempWorkspaceDir();

    await expect(runReplayDemo({
      inputPath: await stageFixture(workspaceDir, "fasta/single.fa"),
      workspaceDir,
      moleculeId: "mol_replay_unsafe",
      bundleId: "../outside",
    })).rejects.toThrow("Replay bundle id is invalid");
  });
});
