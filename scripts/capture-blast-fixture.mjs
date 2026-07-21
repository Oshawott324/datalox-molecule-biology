import { promises as fs } from "node:fs";
import path from "node:path";

const endpoint = "https://blast.ncbi.nlm.nih.gov/Blast.cgi";
const repoRoot = path.resolve(import.meta.dirname, "..");

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
  const program = blastProgram(args.program ?? "blastn");
  const database = requiredNonEmpty(args.database ?? "nt", "database");
  const hitlistSize = boundedInteger(args["hitlist-size"] ?? "5", "hitlist-size", 1, 100);
  const expect = args.expect ?? "0.001";
  const sequence = await querySequence(args);
  const tool = process.env.NCBI_BLAST_TOOL ?? "DataloxMoleculeBiologyMCP";
  const outputRoot = path.resolve(repoRoot, args["output-dir"] ?? path.join("fixtures", "blast"));
  const outputDir = path.join(outputRoot, fixtureId);
  const submittedAt = new Date().toISOString();

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "query.fa"), fasta("query", sequence), "utf8");

  const putParams = {
    CMD: "Put",
    QUERY: fasta("query", sequence),
    DATABASE: database,
    PROGRAM: program,
    HITLIST_SIZE: String(hitlistSize),
    EXPECT: expect,
    FORMAT_TYPE: "JSON2",
    tool,
    email,
  };
  if (args["entrez-query"]) putParams.ENTREZ_QUERY = args["entrez-query"];
  if (sequence.length < 30 && (program === "blastn" || program === "blastp")) {
    putParams.SHORT_QUERY_ADJUST = "true";
  }

  const putText = await postForm(putParams);
  await fs.writeFile(path.join(outputDir, "put-response.txt"), putText, "utf8");
  const rid = parseLineValue(putText, "RID");
  const rtoe = Number.parseInt(parseLineValue(putText, "RTOE"), 10);
  if (!rid || !Number.isInteger(rtoe)) {
    throw new Error(`Could not parse RID/RTOE from NCBI response. Saved response at ${path.join(outputDir, "put-response.txt")}`);
  }

  const maxWaitSeconds = boundedInteger(args["max-wait-seconds"] ?? "600", "max-wait-seconds", 60, 3600);
  const pollIntervalSeconds = Math.max(60, boundedInteger(args["poll-interval-seconds"] ?? "60", "poll-interval-seconds", 60, 3600));
  let elapsedSeconds = 0;
  await sleepSeconds(Math.max(rtoe, 60));
  elapsedSeconds += Math.max(rtoe, 60);

  let finalStatus = "UNKNOWN";
  let statusText = "";
  while (elapsedSeconds <= maxWaitSeconds) {
    statusText = await getText({
      CMD: "Get",
      RID: rid,
      FORMAT_OBJECT: "SearchInfo",
      tool,
      email,
    });
    await fs.writeFile(path.join(outputDir, `status-${String(elapsedSeconds).padStart(4, "0")}.txt`), statusText, "utf8");
    finalStatus = parseStatus(statusText);
    if (finalStatus === "READY") break;
    if (finalStatus === "FAILED" || finalStatus === "UNKNOWN") break;
    await sleepSeconds(pollIntervalSeconds);
    elapsedSeconds += pollIntervalSeconds;
  }

  if (finalStatus !== "READY") {
    await writeMetadata(outputDir, {
      fixtureId,
      submittedAt,
      completedAt: new Date().toISOString(),
      endpoint,
      rid,
      rtoe,
      status: finalStatus,
      program,
      database,
      hitlistSize,
      expect,
      entrezQuery: args["entrez-query"] ?? null,
      queryLength: sequence.length,
      resultFile: null,
    });
    throw new Error(`BLAST search did not complete. RID=${rid} STATUS=${finalStatus}. Raw status files are in ${outputDir}`);
  }

  const resultText = await getText({
    CMD: "Get",
    RID: rid,
    FORMAT_TYPE: "JSON2",
    HITLIST_SIZE: String(hitlistSize),
    tool,
    email,
  });
  JSON.parse(resultText);
  await fs.writeFile(path.join(outputDir, "result.json"), resultText, "utf8");
  await writeMetadata(outputDir, {
    fixtureId,
    submittedAt,
    completedAt: new Date().toISOString(),
    endpoint,
    rid,
    rtoe,
    status: finalStatus,
    program,
    database,
    hitlistSize,
    expect,
    entrezQuery: args["entrez-query"] ?? null,
    queryLength: sequence.length,
    resultFile: "result.json",
  });

  console.log(JSON.stringify({
    ok: true,
    fixtureId,
    outputDir,
    rid,
    status: finalStatus,
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

async function postForm(params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) throw new Error(`NCBI BLAST PUT failed: HTTP ${response.status}`);
  return response.text();
}

async function getText(params) {
  const url = `${endpoint}?${new URLSearchParams(params).toString()}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`NCBI BLAST GET failed: HTTP ${response.status}`);
  return response.text();
}

function parseLineValue(text, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, "m").exec(text);
  return match?.[1];
}

function parseStatus(text) {
  return parseLineValue(text, "Status") ?? parseLineValue(text, "STATUS") ?? "UNKNOWN";
}

function sleepSeconds(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
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

function normalizeSequence(value) {
  const sequence = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z*]+$/.test(sequence)) throw new Error("Query sequence contains unsupported symbols.");
  return sequence;
}

function fasta(id, sequence) {
  return `>${id}\n${sequence.match(/.{1,60}/g).join("\n")}\n`;
}
