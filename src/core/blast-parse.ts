import { MoleculeError } from "./errors.js";

export type BlastStrand = "plus" | "minus" | null;

export type BlastAlignment = {
  identityPercent: number;
  coveragePercent: number;
  eValue: number;
  bitScore: number;
  alignedLength: number;
  identity: number;
  gaps: number;
  queryStart: number;
  queryEnd: number;
  subjectStart: number;
  subjectEnd: number;
  strand: BlastStrand;
};

export type BlastHit = {
  accession: string;
  title: string;
  taxId?: number;
  organism?: string;
  subjectLength: number;
  alignments: BlastAlignment[];
};

export type BlastSearchStatistics = {
  dbNum?: number;
  dbLen?: number;
  hspLen?: number;
  effectiveSearchSpace?: number;
  kappa?: number;
  lambda?: number;
  entropy?: number;
};

export type BlastParsedResult = {
  program: string;
  version?: string;
  queryId?: string;
  queryTitle?: string;
  queryLength: number;
  effectiveDatabase?: string;
  parameters: Record<string, unknown>;
  statistics?: BlastSearchStatistics;
  hits: BlastHit[];
};

export type BlastPutResponse = {
  rid: string;
  rtoe: number;
};

export type BlastStatus = "READY" | "WAITING" | "FAILED" | "UNKNOWN";

export function parseBlastJson2(raw: string | unknown): BlastParsedResult {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const reports = readArray((parsed as Record<string, unknown>)?.BlastOutput2, "BlastOutput2");
  if (reports.length !== 1) {
    throw new MoleculeError("PARSE_ERROR", "Expected exactly one BLAST report.", {
      path: "BlastOutput2",
      actualCount: reports.length,
    });
  }

  const report = readObject(readObject(reports[0], "BlastOutput2[0]").report, "BlastOutput2[0].report");
  const results = readObject(report.results, "report.results");
  const search = readObject(results.search, "report.results.search");
  const queryLength = readNumber(search.query_len, "report.results.search.query_len");
  const rawHits = search.hits === undefined ? [] : readArray(search.hits, "report.results.search.hits");

  return {
    program: readString(report.program, "report.program"),
    version: optionalString(report.version, "report.version"),
    queryId: optionalString(search.query_id, "report.results.search.query_id"),
    queryTitle: optionalString(search.query_title, "report.results.search.query_title"),
    queryLength,
    effectiveDatabase: optionalString(readOptionalObject(report.search_target, "report.search_target")?.db, "report.search_target.db"),
    parameters: readOptionalObject(report.params, "report.params") ?? {},
    statistics: parseStatistics(readOptionalObject(search.stat, "report.results.search.stat")),
    hits: rawHits.map((hit, index) => parseHit(hit, index, queryLength)),
  };
}

export function parseBlastPutResponse(text: string): BlastPutResponse {
  const rid = parseLineValue(text, "RID");
  const rtoeRaw = parseLineValue(text, "RTOE");
  const rtoe = rtoeRaw === undefined ? Number.NaN : Number.parseInt(rtoeRaw, 10);
  if (!rid || !Number.isInteger(rtoe)) {
    throw new MoleculeError("PARSE_ERROR", "Could not parse BLAST RID/RTOE from Put response.", {
      hasRid: Boolean(rid),
      rtoe: rtoeRaw ?? null,
    });
  }
  return { rid, rtoe };
}

export function parseBlastStatus(text: string): BlastStatus {
  const status = parseLineValue(text, "Status") ?? parseLineValue(text, "STATUS");
  if (status === "READY" || status === "WAITING" || status === "FAILED" || status === "UNKNOWN") return status;
  return "UNKNOWN";
}

function parseHit(rawHit: unknown, index: number, queryLength: number): BlastHit {
  const path = `report.results.search.hits[${index}]`;
  const hit = readObject(rawHit, path);
  const descriptions = readArray(hit.description, `${path}.description`);
  const description = readObject(descriptions[0], `${path}.description[0]`);
  const hsps = readArray(hit.hsps, `${path}.hsps`);

  return {
    accession: readString(description.accession, `${path}.description[0].accession`),
    title: readString(description.title, `${path}.description[0].title`),
    taxId: optionalNumber(description.taxid, `${path}.description[0].taxid`),
    organism: optionalString(description.sciname, `${path}.description[0].sciname`),
    subjectLength: readNumber(hit.len, `${path}.len`),
    alignments: hsps.map((hsp, hspIndex) => parseHsp(hsp, `${path}.hsps[${hspIndex}]`, queryLength)),
  };
}

function parseHsp(rawHsp: unknown, path: string, queryLength: number): BlastAlignment {
  const hsp = readObject(rawHsp, path);
  const alignedLength = readNumber(hsp.align_len, `${path}.align_len`);
  const identity = readNumber(hsp.identity, `${path}.identity`);
  const gaps = optionalNumber(hsp.gaps, `${path}.gaps`) ?? 0;

  return {
    identityPercent: roundPercent(identity, alignedLength),
    coveragePercent: roundPercent(alignedLength, queryLength),
    eValue: readNumber(hsp.evalue, `${path}.evalue`),
    bitScore: readNumber(hsp.bit_score, `${path}.bit_score`),
    alignedLength,
    identity,
    gaps,
    queryStart: readNumber(hsp.query_from, `${path}.query_from`),
    queryEnd: readNumber(hsp.query_to, `${path}.query_to`),
    subjectStart: readNumber(hsp.hit_from, `${path}.hit_from`),
    subjectEnd: readNumber(hsp.hit_to, `${path}.hit_to`),
    strand: parseStrand(optionalString(hsp.hit_strand, `${path}.hit_strand`)),
  };
}

function parseStatistics(stat: Record<string, unknown> | undefined): BlastSearchStatistics | undefined {
  if (!stat) return undefined;
  return {
    dbNum: optionalNumber(stat.db_num, "stat.db_num"),
    dbLen: optionalNumber(stat.db_len, "stat.db_len"),
    hspLen: optionalNumber(stat.hsp_len, "stat.hsp_len"),
    effectiveSearchSpace: optionalNumber(stat.eff_space, "stat.eff_space"),
    kappa: optionalNumber(stat.kappa, "stat.kappa"),
    lambda: optionalNumber(stat.lambda, "stat.lambda"),
    entropy: optionalNumber(stat.entropy, "stat.entropy"),
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new MoleculeError("PARSE_ERROR", "BLAST JSON2_S response is not valid JSON.", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseLineValue(text: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, "m").exec(text);
  return match?.[1];
}

function parseStrand(value: string | undefined): BlastStrand {
  if (value === undefined) return null;
  const normalized = value.toLowerCase();
  if (normalized === "plus") return "plus";
  if (normalized === "minus") return "minus";
  return null;
}

function roundPercent(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MoleculeError("PARSE_ERROR", "Expected object in BLAST response.", { path });
  }
  return value as Record<string, unknown>;
}

function readOptionalObject(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return readObject(value, path);
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new MoleculeError("PARSE_ERROR", "Expected array in BLAST response.", { path });
  }
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new MoleculeError("PARSE_ERROR", "Expected string in BLAST response.", { path });
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, path);
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoleculeError("PARSE_ERROR", "Expected finite number in BLAST response.", { path });
  }
  return value;
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return readNumber(value, path);
}
