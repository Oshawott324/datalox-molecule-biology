import { MoleculeError } from "./errors.js";
import {
  type BlastParsedResult,
  type BlastStatus,
  parseBlastJson2,
  parseBlastPutResponse,
  parseBlastStatus,
} from "./blast-parse.js";

export const NCBI_BLAST_ENDPOINT = "https://blast.ncbi.nlm.nih.gov/Blast.cgi";
export const NCBI_BLAST_RESULT_FORMAT = "JSON2_S";
export const DEFAULT_NCBI_BLAST_TOOL = "DataloxMoleculeBiologyMCP";

export type NcbiBlastProgram = "blastn" | "blastp" | "blastx" | "tblastn" | "tblastx";

export type NcbiBlastRequest = {
  method: "GET" | "POST";
  endpoint: string;
  params: Record<string, string>;
};

export type NcbiBlastTransport = (request: NcbiBlastRequest) => Promise<string>;

export type NcbiBlastStatusObservation = {
  elapsedSeconds: number;
  status: BlastStatus;
  text: string;
};

export type NcbiBlastRunOptions = {
  sequence: string;
  database: string;
  program: NcbiBlastProgram;
  hitlistSize: number;
  expect: string;
  shortQueryAdjust?: boolean;
  wordSize?: number;
  filter?: "F" | "T";
  entrezQuery?: string;
  tool?: string;
  email: string;
  maxWaitSeconds?: number;
  pollIntervalSeconds?: number;
  endpoint?: string;
  submittedAt?: string;
  transport?: NcbiBlastTransport;
  sleepSeconds?: (seconds: number) => Promise<void>;
};

export type NcbiBlastRunResult = {
  endpoint: string;
  rid: string;
  rtoe: number;
  status: "READY";
  submittedAt: string;
  completedAt: string;
  program: NcbiBlastProgram;
  requestedDatabase: string;
  effectiveDatabase?: string;
  hitlistSize: number;
  expect: string;
  shortQueryAdjust: boolean;
  wordSize?: number;
  filter?: "F" | "T";
  entrezQuery?: string;
  queryLength: number;
  result: BlastParsedResult;
  raw: {
    putResponse: string;
    statusResponses: NcbiBlastStatusObservation[];
    resultJson: string;
  };
};

export function blastQueryFasta(sequence: string, id = "query"): string {
  return `>${id}\n${sequence.match(/.{1,60}/g)?.join("\n") ?? ""}\n`;
}

export async function runNcbiBlast(options: NcbiBlastRunOptions): Promise<NcbiBlastRunResult> {
  const endpoint = options.endpoint ?? NCBI_BLAST_ENDPOINT;
  const tool = options.tool ?? DEFAULT_NCBI_BLAST_TOOL;
  const maxWaitSeconds = options.maxWaitSeconds ?? 600;
  const pollIntervalSeconds = Math.max(60, options.pollIntervalSeconds ?? 60);
  const transport = options.transport ?? defaultNcbiBlastTransport;
  const sleepSeconds = options.sleepSeconds ?? sleepRealSeconds;
  const submittedAt = options.submittedAt ?? new Date().toISOString();
  const shortQueryAdjust = options.shortQueryAdjust ?? useShortQueryAdjust(options.sequence, options.program);
  const useShortNucleotideDefaults = shortQueryAdjust && useShortNucleotideQuery(options.sequence, options.program);
  const wordSize = options.wordSize ?? (useShortNucleotideDefaults ? 7 : undefined);
  const filter = options.filter ?? (useShortNucleotideDefaults ? "F" : undefined);

  const query = blastQueryFasta(options.sequence);
  const putResponse = await transport({
    method: "POST",
    endpoint,
    params: {
      CMD: "Put",
      QUERY: query,
      DATABASE: options.database,
      PROGRAM: options.program,
      HITLIST_SIZE: String(options.hitlistSize),
      EXPECT: options.expect,
      FORMAT_TYPE: NCBI_BLAST_RESULT_FORMAT,
      tool,
      email: options.email,
      ...(options.entrezQuery === undefined ? {} : { ENTREZ_QUERY: options.entrezQuery }),
      ...(shortQueryAdjust ? { SHORT_QUERY_ADJUST: "true" } : {}),
      ...(wordSize === undefined ? {} : { WORD_SIZE: String(assertPositiveInteger(wordSize, "wordSize")) }),
      ...(filter === undefined ? {} : { FILTER: assertBlastFilter(filter) }),
    },
  });
  const put = parseBlastPutResponse(putResponse);

  const statusResponses: NcbiBlastStatusObservation[] = [];
  let elapsedSeconds = 0;
  const initialWaitSeconds = Math.max(put.rtoe, pollIntervalSeconds);
  if (initialWaitSeconds > maxWaitSeconds) {
    throw blastTimeoutError(put.rid, put.rtoe, elapsedSeconds, maxWaitSeconds, statusResponses);
  }

  await sleepSeconds(initialWaitSeconds);
  elapsedSeconds += initialWaitSeconds;

  while (elapsedSeconds <= maxWaitSeconds) {
    const statusText = await transport({
      method: "GET",
      endpoint,
      params: {
        CMD: "Get",
        RID: put.rid,
        FORMAT_OBJECT: "SearchInfo",
        tool,
        email: options.email,
      },
    });
    const status = parseBlastStatus(statusText);
    statusResponses.push({ elapsedSeconds, status, text: statusText });

    if (status === "READY") {
      const resultJson = await transport({
        method: "GET",
        endpoint,
        params: {
          CMD: "Get",
          RID: put.rid,
          FORMAT_TYPE: NCBI_BLAST_RESULT_FORMAT,
          HITLIST_SIZE: String(options.hitlistSize),
          tool,
          email: options.email,
        },
      });
      const result = parseBlastJson2(resultJson);
      return {
        endpoint,
        rid: put.rid,
        rtoe: put.rtoe,
        status: "READY",
        submittedAt,
        completedAt: new Date().toISOString(),
        program: options.program,
        requestedDatabase: options.database,
        effectiveDatabase: result.effectiveDatabase,
        hitlistSize: options.hitlistSize,
        expect: options.expect,
        shortQueryAdjust,
        ...(wordSize === undefined ? {} : { wordSize }),
        ...(filter === undefined ? {} : { filter }),
        entrezQuery: options.entrezQuery,
        queryLength: options.sequence.length,
        result,
        raw: { putResponse, statusResponses, resultJson },
      };
    }

    if (status === "FAILED" || status === "UNKNOWN") {
      throw new MoleculeError("BLAST_FAILED", "NCBI BLAST search did not complete successfully.", {
        rid: put.rid,
        rtoe: put.rtoe,
        status,
        elapsedSeconds,
      });
    }

    if (elapsedSeconds + pollIntervalSeconds > maxWaitSeconds) break;
    await sleepSeconds(pollIntervalSeconds);
    elapsedSeconds += pollIntervalSeconds;
  }

  throw blastTimeoutError(put.rid, put.rtoe, elapsedSeconds, maxWaitSeconds, statusResponses);
}

export async function defaultNcbiBlastTransport(request: NcbiBlastRequest): Promise<string> {
  if (request.method === "POST") {
    const response = await fetch(request.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(request.params),
    });
    if (!response.ok) throw new MoleculeError("DEPENDENCY_MISSING", "NCBI BLAST endpoint request failed.", { status: response.status });
    return response.text();
  }

  const url = `${request.endpoint}?${new URLSearchParams(request.params).toString()}`;
  const response = await fetch(url);
  if (!response.ok) throw new MoleculeError("DEPENDENCY_MISSING", "NCBI BLAST endpoint request failed.", { status: response.status });
  return response.text();
}

export function redactNcbiBlastResponseText(text: string, email: string): string {
  return text
    .replaceAll(email, "<redacted:ncbi_email>")
    .replaceAll(encodeURIComponent(email), "%3Credacted%3Ancbi_email%3E")
    .replaceAll(encodeURIComponent(encodeURIComponent(email)), "%3Credacted%3Ancbi_email%3E")
    .replace(/MYNCBI_USER=\d+/g, "MYNCBI_USER=<redacted:ncbi_user>")
    .replace(/MYNCBI%5FUSER%3D\d+/g, "MYNCBI%5FUSER%3D<redacted:ncbi_user>");
}

function blastTimeoutError(
  rid: string,
  rtoe: number,
  elapsedSeconds: number,
  maxWaitSeconds: number,
  statusResponses: NcbiBlastStatusObservation[],
): MoleculeError {
  return new MoleculeError("BLAST_TIMEOUT", "NCBI BLAST timed out before results were ready.", {
    rid,
    rtoe,
    elapsedSeconds,
    maxWaitSeconds,
    lastStatus: statusResponses.at(-1)?.status ?? null,
  });
}

function useShortQueryAdjust(sequence: string, program: NcbiBlastProgram): boolean {
  return sequence.length < 30 && (program === "blastn" || program === "blastp");
}

function useShortNucleotideQuery(sequence: string, program: NcbiBlastProgram): boolean {
  return sequence.length < 30 && program === "blastn";
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new MoleculeError("INVALID_ARGUMENT", `${label} must be a positive integer.`, { [label]: value });
  }
  return value;
}

function assertBlastFilter(value: string): "F" | "T" {
  if (value !== "F" && value !== "T") {
    throw new MoleculeError("INVALID_ARGUMENT", "filter must be F or T.", { filter: value });
  }
  return value;
}

function sleepRealSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
