import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/main.js";
import {
  handleOpenSequence,
  handleRenderDigestGel,
  renderDigestGel,
  type ToolResultEnvelope,
} from "../src/index.js";

async function tempWorkspaceDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mol-gel-"));
}

async function createWorkspace(): Promise<{ workspaceDir: string; workspacePath: string }> {
  const workspaceDir = await tempWorkspaceDir();
  const inputPath = path.join(workspaceDir, "input.fa");
  await fs.writeFile(inputPath, ">gel\nACGTACGTACGT\n", "utf8");
  const opened = await handleOpenSequence({
    inputPath,
    workspaceDir,
    format: "fasta",
    moleculeId: "mol_gel",
  });
  expect(opened.ok).toBe(true);
  return { workspaceDir, workspacePath: path.join(workspaceDir, "molecule.workspace.json") };
}

describe("digest gel rendering", () => {
  it("writes a deterministic log-scaled SVG gel artifact", async () => {
    const { workspaceDir, workspacePath } = await createWorkspace();
    const result = await renderDigestGel(
      workspacePath,
      "gel_math",
      [
        {
          label: "Digest",
          fragments: [
            { size: 100, label: "small" },
            { size: 1000, label: "middle" },
            { size: 10000, label: "large" },
          ],
        },
      ],
      {
        width: 500,
        height: 400,
        customLadder: [100, 10000],
      },
    );
    const svg = await fs.readFile(result.outputPath, "utf8");

    expect(result).toMatchObject({
      gelId: "gel_math",
      relativePath: path.join("reports", "gels", "gel_math.gel.svg"),
      mimeType: "image/svg+xml",
      width: 500,
      height: 400,
      laneCount: 2,
      ladder: [100, 10000],
      rules: {
        migrationScale: "log10_fragment_size",
        supportedFragments: "linear_digest_or_pcr_products",
      },
    });
    expect(result.outputPath).toBe(path.join(workspaceDir, result.relativePath));
    expect(svg).toContain("gel_math");
    expect(svg).toContain("Digest");
    expect(svg).toContain("log10-scaled linear DNA fragment migration");

    const digestBands = result.bands.filter((band) => band.laneLabel === "Digest");
    expect(digestBands.map((band) => ({ size: band.size, y: band.y }))).toEqual([
      { size: 100, y: 342 },
      { size: 1000, y: 212 },
      { size: 10000, y: 82 },
    ]);

    const second = await renderDigestGel(
      workspacePath,
      "gel_math_repeat",
      [{ label: "Digest", fragments: [{ size: 100 }, { size: 1000 }, { size: 10000 }] }],
      {
        outputPath: "reports/gels/repeat.gel.svg",
        width: 500,
        height: 400,
        customLadder: [100, 10000],
      },
    );
    const secondSvg = await fs.readFile(second.outputPath, "utf8");
    expect(secondSvg.replaceAll("gel_math_repeat", "gel_math")).toBe(svg);
  });

  it("returns artifact metadata from the tool handler", async () => {
    const { workspacePath } = await createWorkspace();
    const result = await handleRenderDigestGel({
      workspacePath,
      gelId: "handler_gel",
      lanes: [{ label: "EcoRI", fragments: [{ size: 500 }, { size: 1500 }] }],
      customLadder: [250, 500, 1000, 1500],
      width: 520,
      height: 360,
    });

    expect(result).toMatchObject({
      ok: true,
      tool: "render_digest_gel",
      artifacts: [
        {
          kind: "gel",
          mimeType: "image/svg+xml",
        },
      ],
      nextAction: {
        tool: "validate_workspace",
      },
    });
    if (!result.ok) throw new Error("expected render_digest_gel success");
    await expect(fs.stat(result.artifacts?.[0]?.path ?? "")).resolves.toBeTruthy();
  });

  it("runs through the CLI command path", async () => {
    const { workspacePath, workspaceDir } = await createWorkspace();
    const lanesPath = path.join(workspaceDir, "lanes.json");
    await fs.writeFile(lanesPath, JSON.stringify([
      { label: "CLI digest", fragments: [{ size: 250 }, { size: 1000 }] },
    ]), "utf8");

    const cli = await runCli([
      "render-digest-gel",
      workspacePath,
      "--gel-id",
      "cli_gel",
      "--lanes",
      lanesPath,
      "--custom-ladder",
      "250,1000",
    ]);

    expect(cli.exitCode).toBe(0);
    const envelope = JSON.parse(cli.stdout) as ToolResultEnvelope;
    expect(envelope).toMatchObject({
      ok: true,
      tool: "render_digest_gel",
      artifacts: [{ kind: "gel" }],
    });
  });

  it("rejects output paths outside the workspace", async () => {
    const { workspacePath } = await createWorkspace();
    await expect(renderDigestGel(
      workspacePath,
      "escape_gel",
      [{ label: "Digest", fragments: [{ size: 1000 }] }],
      { outputPath: "../escape.gel.svg" },
    )).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
