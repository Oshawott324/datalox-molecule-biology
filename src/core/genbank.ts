import { MoleculeError } from "./errors.js";
import type { Alphabet, CoordinateSegment, MoleculeType, Topology } from "./schema.js";
import { defaultAlphabetForMoleculeType, normalizeSequence } from "./sequence.js";

export type ParsedGenBankFeature = {
  key: string;
  location: string;
  segments: CoordinateSegment[];
  qualifiers: Record<string, string | string[]>;
};

export type ParsedGenBankRecord = {
  name: string;
  description?: string;
  sequence: string;
  topology: Topology;
  moleculeType: MoleculeType;
  alphabet: Alphabet;
  features: ParsedGenBankFeature[];
};

type MutableFeature = {
  key: string;
  locationParts: string[];
  qualifiers: Record<string, string | string[]>;
  activeQualifier?: string;
};

export function parseGenBank(content: string): ParsedGenBankRecord {
  const lines = content.split(/\r?\n/);
  const locusLine = lines.find((line) => line.startsWith("LOCUS"));
  if (!locusLine) {
    throw new MoleculeError("PARSE_ERROR", "GenBank file is missing a LOCUS line.");
  }
  const locus = parseLocus(locusLine);
  const description = parseDefinition(lines);
  const sequence = parseOrigin(lines, locus.alphabet);
  const features = parseFeatures(lines);

  if (sequence.length !== locus.length) {
    throw new MoleculeError("PARSE_ERROR", "GenBank ORIGIN sequence length does not match LOCUS length.", {
      locusLength: locus.length,
      sequenceLength: sequence.length,
    });
  }

  return {
    name: locus.name,
    description,
    sequence,
    topology: locus.topology,
    moleculeType: locus.moleculeType,
    alphabet: locus.alphabet,
    features,
  };
}

function parseLocus(line: string): { name: string; length: number; topology: Topology; moleculeType: MoleculeType; alphabet: Alphabet } {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] !== "LOCUS") {
    throw new MoleculeError("PARSE_ERROR", "Invalid GenBank LOCUS line.", { line });
  }
  const name = parts[1];
  const length = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(length) || length < 1) {
    throw new MoleculeError("PARSE_ERROR", "GenBank LOCUS length must be a positive integer.", { line });
  }
  const lowerParts = parts.map((part) => part.toLowerCase());
  const topology: Topology = lowerParts.includes("circular") ? "circular" : "linear";
  let moleculeType: MoleculeType = "dna";
  if (lowerParts.includes("rna")) moleculeType = "rna";
  if (lowerParts.includes("aa") || lowerParts.includes("protein")) moleculeType = "protein";
  return {
    name,
    length,
    topology,
    moleculeType,
    alphabet: defaultAlphabetForMoleculeType(moleculeType),
  };
}

function parseDefinition(lines: string[]): string | undefined {
  const startIndex = lines.findIndex((line) => line.startsWith("DEFINITION"));
  if (startIndex === -1) return undefined;
  const parts = [lines[startIndex].slice("DEFINITION".length).trim()];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Z][A-Z0-9_ ]+\b/.test(line) && !line.startsWith(" ")) break;
    if (line.startsWith("            ")) parts.push(line.trim());
    else break;
  }
  const description = parts.join(" ").replace(/\s+/g, " ").trim();
  return description.length > 0 ? description : undefined;
}

function parseOrigin(lines: string[], alphabet: Alphabet): string {
  const originIndex = lines.findIndex((line) => line.startsWith("ORIGIN"));
  if (originIndex === -1) {
    throw new MoleculeError("PARSE_ERROR", "GenBank file is missing ORIGIN sequence content.");
  }
  const sequenceParts: string[] = [];
  for (let index = originIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("//")) break;
    sequenceParts.push(line.replace(/[0-9\s]/g, ""));
  }
  const sequence = normalizeSequence(sequenceParts.join(""), alphabet);
  if (sequence.length === 0) {
    throw new MoleculeError("PARSE_ERROR", "GenBank file has empty ORIGIN sequence content.");
  }
  return sequence;
}

function parseFeatures(lines: string[]): ParsedGenBankFeature[] {
  const featuresIndex = lines.findIndex((line) => line.startsWith("FEATURES"));
  const originIndex = lines.findIndex((line) => line.startsWith("ORIGIN"));
  if (featuresIndex === -1 || originIndex === -1 || featuresIndex > originIndex) return [];
  const features: MutableFeature[] = [];
  let current: MutableFeature | null = null;

  function addQualifier(feature: MutableFeature, key: string, rawValue: string | undefined): void {
    const value = parseQualifierValue(rawValue);
    const existing = feature.qualifiers[key];
    if (existing === undefined) feature.qualifiers[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else feature.qualifiers[key] = [existing, value];
    feature.activeQualifier = key;
  }

  for (let index = featuresIndex + 1; index < originIndex; index += 1) {
    const line = lines[index];
    const featureMatch = /^ {5}(\S+)\s+(.+)$/.exec(line);
    if (featureMatch) {
      current = { key: featureMatch[1], locationParts: [featureMatch[2].trim()], qualifiers: {} };
      features.push(current);
      continue;
    }
    if (!current) continue;
    const continuation = line.slice(21).trim();
    if (continuation.length === 0) continue;
    if (continuation.startsWith("/")) {
      const qualifierMatch = /^\/([^=\s]+)(?:=(.*))?$/.exec(continuation);
      if (!qualifierMatch) {
        throw new MoleculeError("PARSE_ERROR", "Invalid GenBank qualifier syntax.", { line: index + 1, text: continuation });
      }
      addQualifier(current, qualifierMatch[1], qualifierMatch[2]);
      continue;
    }
    if (current.activeQualifier) {
      appendQualifierContinuation(current, current.activeQualifier, continuation);
    } else {
      current.locationParts.push(continuation);
    }
  }

  return features.map((feature) => {
    const location = feature.locationParts.join("");
    return {
      key: feature.key,
      location,
      segments: parseFeatureLocation(location),
      qualifiers: feature.qualifiers,
    };
  });
}

function parseQualifierValue(rawValue: string | undefined): string {
  if (rawValue === undefined) return "true";
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function appendQualifierContinuation(feature: MutableFeature, key: string, continuation: string): void {
  const value = parseQualifierValue(continuation);
  const existing = feature.qualifiers[key];
  if (Array.isArray(existing)) {
    existing[existing.length - 1] = `${existing[existing.length - 1]} ${value}`.trim();
  } else if (typeof existing === "string") {
    feature.qualifiers[key] = `${existing} ${value}`.trim();
  }
}

export function parseFeatureLocation(location: string): CoordinateSegment[] {
  const normalized = location.replace(/\s+/g, "");
  if (/[<>^?]/.test(normalized)) {
    throw new MoleculeError("PARSE_ERROR", "Unsupported GenBank fuzzy coordinate syntax.", { location });
  }
  if (normalized.startsWith("complement(") && normalized.endsWith(")")) {
    const inner = normalized.slice("complement(".length, -1);
    return parsePositiveLocation(inner).map((segment) => ({ ...segment, strand: "-" }));
  }
  return parsePositiveLocation(normalized);
}

function parsePositiveLocation(location: string): CoordinateSegment[] {
  if (location.startsWith("join(") && location.endsWith(")")) {
    const inner = location.slice("join(".length, -1);
    return splitTopLevelCommas(inner).map(parseRange);
  }
  return [parseRange(location)];
}

function parseRange(part: string): CoordinateSegment {
  const rangeMatch = /^(\d+)\.\.(\d+)$/.exec(part);
  if (rangeMatch) {
    return { start: Number.parseInt(rangeMatch[1], 10), end: Number.parseInt(rangeMatch[2], 10), strand: "+" };
  }
  const singleBaseMatch = /^(\d+)$/.exec(part);
  if (singleBaseMatch) {
    const position = Number.parseInt(singleBaseMatch[1], 10);
    return { start: position, end: position, strand: "+" };
  }
  throw new MoleculeError("PARSE_ERROR", "Unsupported GenBank coordinate syntax.", { location: part });
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  if (parts.some((part) => part.length === 0)) {
    throw new MoleculeError("PARSE_ERROR", "Invalid empty segment in GenBank join location.", { location: value });
  }
  return parts;
}
