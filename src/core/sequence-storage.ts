import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";

import { workspaceRootFromPath } from "./paths.js";

export function sequenceDataDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, "data", "sequences");
}

export async function ensureSequenceDataDir(workspaceRoot: string): Promise<string> {
  const dataDir = sequenceDataDir(workspaceRoot);
  await fs.mkdir(dataDir, { recursive: true });
  return dataDir;
}

export function uniqueSequenceFileName(dataDir: string, preferred: string): string {
  const extension = path.extname(preferred);
  const base = path.basename(preferred, extension);
  let candidate = preferred;
  for (let index = 2; existsSync(path.join(dataDir, candidate)); index += 1) {
    candidate = `${base}_${index}${extension}`;
  }
  return candidate;
}

export async function writeStoredSequenceFile(options: {
  workspacePath: string;
  preferredFileName: string;
  content: string;
}): Promise<{ absolutePath: string; relativePath: string }> {
  const workspaceRoot = workspaceRootFromPath(options.workspacePath);
  const dataDir = await ensureSequenceDataDir(workspaceRoot);
  const fileName = uniqueSequenceFileName(dataDir, options.preferredFileName);
  const absolutePath = path.join(dataDir, fileName);
  await fs.writeFile(absolutePath, options.content, "utf8");
  return {
    absolutePath,
    relativePath: path.relative(workspaceRoot, absolutePath),
  };
}
