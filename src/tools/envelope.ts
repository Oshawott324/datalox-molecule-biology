import { Buffer } from "node:buffer";
import { MoleculeError } from "../core/errors.js";
import path from "node:path";

export type ToolErrorEnvelope = {
  ok: false;
  tool: string;
  error: {
    code: string;
    message: string;
    agentActionable: boolean;
    details?: Record<string, unknown>;
  };
};

export type AgentContract = {
  version: 1;
  intent: string;
  forbiddenActions: string[];
};

export type ToolNextAction = {
  tool: string;
  arguments: Record<string, unknown>;
};

export type ToolArtifact = {
  kind: string;
  path: string;
  mimeType?: string;
  description?: string;
  truncated?: boolean;
  totalCount?: number;
};

export type ToolSuccessEnvelope<T> = {
  ok: true;
  tool: string;
  agentContract: AgentContract;
  data: T;
  workspacePath?: string;
  revision?: number;
  artifacts?: ToolArtifact[];
  nextAction?: ToolNextAction;
};

export type ToolResultEnvelope<T = unknown> = ToolSuccessEnvelope<T> | ToolErrorEnvelope;

export const RESPONSE_ENVELOPE_BYTE_CEILING = 512_000;

export const moleculeAgentContract: AgentContract = {
  version: 1,
  intent: "structured_molecule_workspace_operation",
  forbiddenActions: [
    "do_not_patch_workspace_json_directly",
    "do_not_infer_sequence_from_screenshots",
    "do_not_guess_biology_when_a_deterministic_tool_exists",
  ],
};

export function toolSuccess<T>(
  tool: string,
  data: T,
  metadata: Pick<ToolSuccessEnvelope<T>, "workspacePath" | "revision" | "artifacts" | "nextAction"> = {},
): ToolSuccessEnvelope<T> {
  const envelope: ToolSuccessEnvelope<T> = { ok: true, tool, agentContract: moleculeAgentContract, data, ...metadata };
  const byteSize = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (byteSize > RESPONSE_ENVELOPE_BYTE_CEILING) {
    return {
      ...envelope,
      data: {
        RESPONSE_TRUNCATED: true,
        reason: `Response envelope exceeded the ${RESPONSE_ENVELOPE_BYTE_CEILING}-byte ceiling. Use more targeted queries to retrieve this data.`,
        byteSize,
      } as unknown as T,
    };
  }
  return envelope;
}

export function toolFailure(
  tool: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  agentActionable = true,
): ToolErrorEnvelope {
  const sanitizedMessage = sanitizeErrorValue(message) as string;
  const sanitizedDetails = details === undefined ? undefined : sanitizeErrorValue(details) as Record<string, unknown>;
  return {
    ok: false,
    tool,
    error: sanitizedDetails === undefined ? { code, message: sanitizedMessage, agentActionable } : { code, message: sanitizedMessage, agentActionable, details: sanitizedDetails },
  };
}

export function toolFailureFromError(tool: string, error: unknown): ToolErrorEnvelope {
  if (error instanceof MoleculeError) {
    return toolFailure(tool, error.code, error.message, error.details, error.agentActionable);
  }

  if (error instanceof SyntaxError) {
    return toolFailure(tool, "VALIDATION_ERROR", "JSON parsing failed.", { cause: error.message });
  }

  if (isNodeError(error) && error.code === "ENOENT") {
    return toolFailure(tool, "FILE_NOT_FOUND", "Required file was not found.", { path: error.path });
  }

  if (error instanceof Error) {
    return toolFailure(tool, "INTERNAL_ERROR", error.message, { name: error.name }, false);
  }

  return toolFailure(tool, "INTERNAL_ERROR", "Unknown error.", { value: String(error) }, false);
}

function sanitizeErrorValue(value: unknown): unknown {
  if (typeof value === "string") return redactAbsolutePaths(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeErrorValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeErrorValue(entry)]));
  }
  return value;
}

function redactAbsolutePaths(value: string): string {
  if (path.isAbsolute(value)) return redactedPath(value);
  return value
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, (match) => redactedPath(match))
    .replace(/(^|[\s([{=])\/(?!\/)(?:[^/\s]+\/)*[^/\s]*/g, (match, prefix: string) => `${prefix}${redactedPath(match.slice(prefix.length))}`);
}

function redactedPath(value: string): string {
  const base = path.basename(value.replace(/[\\/]$/, ""));
  return base ? `<redacted:absolute_path:${base}>` : "<redacted:absolute_path>";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
