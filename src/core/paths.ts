import path from "node:path";

import { type ValidationIssue, validationIssue } from "./errors.js";

export function workspaceRootFromPath(workspacePath: string): string {
  return path.dirname(path.resolve(workspacePath));
}

export function resolveWorkspaceRelativePath(workspaceRoot: string, relativePath: string): string {
  return path.resolve(workspaceRoot, relativePath);
}

export function validateWorkspaceRelativePath(pathValue: unknown, issuePath: string, workspaceRoot: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return [validationIssue(issuePath, "VALIDATION_ERROR", "Path must be a non-empty string.")];
  }
  if (path.isAbsolute(pathValue)) {
    issues.push(validationIssue(issuePath, "VALIDATION_ERROR", "Workspace path must be relative.", { path: pathValue }));
  }
  const resolved = path.resolve(workspaceRoot, pathValue);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    issues.push(validationIssue(issuePath, "VALIDATION_ERROR", "Workspace path escapes the workspace root.", { path: pathValue }));
  }
  return issues;
}
