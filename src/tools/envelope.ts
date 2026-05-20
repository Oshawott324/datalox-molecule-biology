import { MoleculeError } from "../core/errors.js";

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

export type ToolSuccessEnvelope<T> = {
  ok: true;
  tool: string;
  agentContract: AgentContract;
  data: T;
  workspacePath?: string;
  revision?: number;
  nextAction?: ToolNextAction;
};

export type ToolResultEnvelope<T = unknown> = ToolSuccessEnvelope<T> | ToolErrorEnvelope;

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
  metadata: Pick<ToolSuccessEnvelope<T>, "workspacePath" | "revision" | "nextAction"> = {},
): ToolSuccessEnvelope<T> {
  return { ok: true, tool, agentContract: moleculeAgentContract, data, ...metadata };
}

export function toolFailure(
  tool: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  agentActionable = true,
): ToolErrorEnvelope {
  return {
    ok: false,
    tool,
    error: details === undefined ? { code, message, agentActionable } : { code, message, agentActionable, details },
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
