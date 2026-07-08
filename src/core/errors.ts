export type MoleculeErrorCode =
  | "INVALID_ARGUMENT"
  | "FILE_NOT_FOUND"
  | "UNSUPPORTED_FORMAT"
  | "PARSE_ERROR"
  | "VALIDATION_ERROR"
  | "STALE_REVISION"
  | "NO_CHANGE"
  | "MOLECULE_NOT_FOUND"
  | "FEATURE_NOT_FOUND"
  | "PRIMER_NOT_FOUND"
  | "GUIDE_NOT_FOUND"
  | "COORDINATE_OUT_OF_RANGE"
  | "ALPHABET_MISMATCH"
  | "AMBIGUOUS_SEQUENCE"
  | "DEPENDENCY_MISSING"
  | "DETERMINISTIC_TOOL_UNAVAILABLE"
  | "UNSUPPORTED_ENZYME_PROFILE"
  | "AMBIGUOUS_FRAGMENT_SELECTION"
  | "NO_CUT_SITE"
  | "AMBIGUOUS_CUT_SITES"
  | "INCOMPATIBLE_RESTRICTION_ENDS"
  | "INTERNAL_ERROR";

export type ValidationIssue = {
  path: string;
  code: MoleculeErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

export class MoleculeError extends Error {
  readonly code: MoleculeErrorCode;
  readonly details?: Record<string, unknown>;
  readonly agentActionable: boolean;

  constructor(code: MoleculeErrorCode, message: string, details?: Record<string, unknown>, agentActionable = true) {
    super(message);
    this.name = "MoleculeError";
    this.code = code;
    this.details = details;
    this.agentActionable = agentActionable;
  }
}

export class WorkspaceValidationError extends MoleculeError {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("VALIDATION_ERROR", "Workspace validation failed.", { issues });
    this.name = "WorkspaceValidationError";
    this.issues = issues;
  }
}

export class WorkspaceRevisionError extends MoleculeError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super("STALE_REVISION", "Workspace revision mismatch.", { expectedRevision, actualRevision });
    this.name = "WorkspaceRevisionError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function validationIssue(
  path: string,
  code: MoleculeErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ValidationIssue {
  return details === undefined ? { path, code, message } : { path, code, message, details };
}
