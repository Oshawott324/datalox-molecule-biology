import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_NCBI_BLAST_TOOL,
  blastQueryFasta,
  defaultNcbiBlastTransport,
  redactNcbiBlastResponseText,
  runNcbiBlast,
} from "../dist/src/core/blast-client.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const responseRedactions = [
  {
    field: "email",
    replacement: "<redacted:ncbi_email>",
    reason: "NCBI contact parameter is required for live calls but is not needed in a public fixture.",
  },
  {
    field: "MYNCBI_USER",
    replacement: "<redacted:ncbi_user>",
    reason: "NCBI page-local account identifier is not needed for parser fixtures.",
  },
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = process.env.NCBI_BLAST_EMAIL;
  if (!email) {
    throw new Error("NCBI_BLAST_EMAIL is required. NCBI asks API users to include an email parameter for contact.");
  }

  const fixtureId = requiredArg(args, "fixture-id");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(fixtureId)) {
    throw new Error("--fixture-id may only contain letters, digits, dots, underscores, and hyphens.");
  }

  const sequence = await querySequence(args);
  const program = blastProgram(args.program ?? "blastn");
  const database = requiredNonEmpty(args.database ?? "nt", "database");
  const hitlistSize = boundedInteger(args["hitlist-size"] ?? "5", "hitlist-size", 1, 100);
  const expect = args.expect ?? "0.001";
  const shortQueryAdjust = optionalBoolean(args["short-query-adjust"], "short-query-adjust");
  const wordSize = args["word-size"] === undefined ? undefined : boundedInteger(args["word-size"], "word-size", 1, 1000);
  const filter = args.filter === undefined ? undefined : blastFilter(args.filter);
  const tool = process.env.NCBI_BLAST_TOOL ?? DEFAULT_NCBI_BLAST_TOOL;
  const outputRoot = path.resolve(repoRoot, args["output-dir"] ?? path.join("fixtures", "blast"));
  const outputDir = path.join(outputRoot, fixtureId);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "query.fa"), blastQueryFasta(sequence), "utf8");

  const result = await runNcbiBlast({
    sequence,
    program,
    database,
    hitlistSize,
    expect,
    ...(shortQueryAdjust === undefined ? {} : { shortQueryAdjust }),
    ...(wordSize === undefined ? {} : { wordSize }),
    ...(filter === undefined ? {} : { filter }),
    entrezQuery: args["entrez-query"],
    tool,
    email,
    maxWaitSeconds: boundedInteger(args["max-wait-seconds"] ?? "600", "max-wait-seconds", 60, 3600),
    pollIntervalSeconds: boundedInteger(args["poll-interval-seconds"] ?? "60", "poll-interval-seconds", 60, 3600),
    transport: async (request) => redactNcbiBlastResponseText(await defaultNcbiBlastTransport(request), email),
  });

  await fs.writeFile(path.join(outputDir, "put-response.txt"), result.raw.putResponse, "utf8");
  for (const statusResponse of result.raw.statusResponses) {
    await fs.writeFile(
      path.join(outputDir, `status-${String(statusResponse.elapsedSeconds).padStart(4, "0")}.txt`),
      statusResponse.text,
      "utf8",
    );
  }
  await fs.writeFile(path.join(outputDir, "result.json"), result.raw.resultJson, "utf8");
  await writeMetadata(outputDir, {
    fixtureId,
    submittedAt: result.submittedAt,
    completedAt: result.completedAt,
    endpoint: result.endpoint,
    rid: result.rid,
    rtoe: result.rtoe,
    status: result.status,
    program,
    database,
    databaseEffective: result.effectiveDatabase ?? null,
    databaseStatistics: {
      db_num: result.result.statistics?.dbNum ?? null,
      db_len: result.result.statistics?.dbLen ?? null,
    },
    hitlistSize,
    expect,
    shortQueryAdjust: result.shortQueryAdjust,
    wordSize: result.wordSize ?? null,
    filter: result.filter ?? null,
    entrezQuery: args["entrez-query"] ?? null,
    queryLength: sequence.length,
    resultFile: "result.json",
    redactions: responseRedactions,
  });

  console.log(JSON.stringify({
    ok: true,
    fixtureId,
    outputDir,
    rid: result.rid,
    status: result.status,
    resultFile: path.join(outputDir, "result.json"),
  }, null, 2));
}

async function writeMetadata(outputDir, value) {
  await fs.writeFile(path.join(outputDir, "metadata.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function querySequence(parsedArgs) {
  const hasSequence = parsedArgs.sequence !== undefined;
  const hasFasta = parsedArgs.fasta !== undefined;
  if (hasSequence === hasFasta) {
    throw new Error("Provide exactly one of --sequence or --fasta.");
  }
  if (hasSequence) return normalizeSequence(parsedArgs.sequence);
  const content = await fs.readFile(path.resolve(parsedArgs.fasta), "utf8");
  return normalizeSequence(content.split(/\r?\n/).filter((line) => !line.startsWith(">")).join(""));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function requiredArg(parsedArgs, name) {
  const value = parsedArgs[name];
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function requiredNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`--${name} must not be empty.`);
  return value;
}

function blastProgram(value) {
  const allowed = new Set(["blastn", "blastp", "blastx", "tblastn", "tblastx"]);
  if (!allowed.has(value)) throw new Error(`--program must be one of ${Array.from(allowed).join(", ")}.`);
  return value;
}

function boundedInteger(value, name, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false.`);
}

function blastFilter(value) {
  if (value === "F" || value === "T") return value;
  throw new Error("--filter must be F or T.");
}

function normalizeSequence(value) {
  const sequence = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z*]+$/.test(sequence)) throw new Error("Query sequence contains unsupported symbols.");
  return sequence;
}
