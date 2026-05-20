import { type ValidationIssue, validationIssue } from "./errors.js";
import type { CoordinateSegment } from "./schema.js";
import { reverseComplement } from "./sequence.js";

const STRANDS = new Set(["+", "-", "none"]);

export function validateSegments(
  segments: unknown,
  moleculeLength: number,
  issuePath: string,
  allowEmpty = false,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(segments)) {
    return [validationIssue(issuePath, "VALIDATION_ERROR", "Segments must be an array.")];
  }
  if (!allowEmpty && segments.length === 0) {
    return [validationIssue(issuePath, "VALIDATION_ERROR", "Segments must be non-empty.")];
  }
  segments.forEach((segment, index) => {
    const segmentPath = `${issuePath}[${index}]`;
    if (typeof segment !== "object" || segment === null || Array.isArray(segment)) {
      issues.push(validationIssue(segmentPath, "VALIDATION_ERROR", "Segment must be an object."));
      return;
    }
    const candidate = segment as Record<string, unknown>;
    if (!Number.isInteger(candidate.start)) {
      issues.push(validationIssue(`${segmentPath}.start`, "VALIDATION_ERROR", "Segment start must be an integer."));
    }
    if (!Number.isInteger(candidate.end)) {
      issues.push(validationIssue(`${segmentPath}.end`, "VALIDATION_ERROR", "Segment end must be an integer."));
    }
    if (typeof candidate.strand !== "string" || !STRANDS.has(candidate.strand)) {
      issues.push(validationIssue(`${segmentPath}.strand`, "VALIDATION_ERROR", "Segment strand must be '+', '-', or 'none'."));
    }
    if (Number.isInteger(candidate.start) && Number.isInteger(candidate.end)) {
      const start = candidate.start as number;
      const end = candidate.end as number;
      if (start > end) {
        issues.push(validationIssue(segmentPath, "COORDINATE_OUT_OF_RANGE", "Segment start must be less than or equal to end.", { start, end }));
      }
      if (start < 1 || end > moleculeLength) {
        issues.push(validationIssue(segmentPath, "COORDINATE_OUT_OF_RANGE", "Segment coordinates are outside the molecule range.", {
          start,
          end,
          moleculeLength,
        }));
      }
    }
  });
  return issues;
}

export function extractSegments(sequence: string, segments: CoordinateSegment[]): string {
  const joined = segments.map((segment) => sequence.slice(segment.start - 1, segment.end)).join("");
  if (segments.some((segment) => segment.strand === "-")) return reverseComplement(joined);
  return joined;
}

export function extractCircularRegion(sequence: string, start: number, end: number, strand: "+" | "-" = "+"): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > sequence.length || end > sequence.length) {
    throw new RangeError("Circular region coordinates must be inside the sequence range.");
  }
  const region = start <= end ? sequence.slice(start - 1, end) : `${sequence.slice(start - 1)}${sequence.slice(0, end)}`;
  return strand === "-" ? reverseComplement(region) : region;
}
