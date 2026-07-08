import { promises as fs } from "node:fs";
import path from "node:path";

const fixturesRoot = path.resolve("fixtures");

export async function stageFixture(workspaceDir: string, relativePath: string): Promise<string> {
  const sourcePath = path.join(fixturesRoot, relativePath);
  const stagedPath = path.join(workspaceDir, "imports", relativePath);
  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  await fs.copyFile(sourcePath, stagedPath);
  return stagedPath;
}
