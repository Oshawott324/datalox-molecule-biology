import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const DEMO_TIMEOUT_MS = 120_000;
const MAX_CHILD_OUTPUT_BYTES = 512_000;

const demo = await runDiagnosticDigestDemo();
const reviewDir = path.join(demo.workspaceDir, "reports", "review");
await fs.mkdir(reviewDir, { recursive: true });

const reviewPath = path.join(reviewDir, "v1-diagnostic-review.html");
const summaryPath = path.join(reviewDir, "v1-diagnostic-review.summary.json");
await fs.writeFile(summaryPath, `${JSON.stringify(demo, null, 2)}\n`, "utf8");
await fs.writeFile(reviewPath, await renderReviewHtml(demo), "utf8");

console.log(JSON.stringify({
  ok: true,
  reviewPath,
  summaryPath,
  workspaceDir: demo.workspaceDir,
  workspacePath: demo.workspacePath,
  gelArtifact: demo.gelArtifact,
  mapArtifacts: demo.mapArtifacts,
  bundlePath: demo.bundlePath,
  recordCount: demo.recordCount,
}, null, 2));

async function runDiagnosticDigestDemo() {
  const child = spawn("node", [path.join(repoRoot, "scripts", "demo-diagnostic-digest-mcp.mjs")], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let outputLimitError;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const timeout = setTimeout(() => {
    if (!settled) child.kill("SIGTERM");
  }, DEMO_TIMEOUT_MS);
  const appendBounded = (label, current, chunk) => {
    const next = current + chunk;
    if (Buffer.byteLength(next, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
      outputLimitError = new Error(`Diagnostic digest demo exceeded ${MAX_CHILD_OUTPUT_BYTES} byte ${label} limit.`);
      child.kill("SIGTERM");
      return current;
    }
    return next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = appendBounded("stdout", stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded("stderr", stderr, chunk);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    settled = true;
    clearTimeout(timeout);
  });
  if (exitCode === null) {
    if (outputLimitError) throw outputLimitError;
    throw new Error(`Diagnostic digest demo was terminated after exceeding lifecycle limits: timeoutMs=${DEMO_TIMEOUT_MS}, maxOutputBytes=${MAX_CHILD_OUTPUT_BYTES}`);
  }
  if (outputLimitError) throw outputLimitError;
  if (exitCode !== 0) {
    throw new Error(`Diagnostic digest demo failed with exit code ${exitCode}: ${stderr || stdout}`);
  }
  const jsonStart = stdout.lastIndexOf("\n{");
  const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart + 1) : stdout;
  return JSON.parse(jsonText);
}

async function renderReviewHtml(summary) {
  const gelSvg = await readGeneratedSvg(summary.gelArtifact?.path, "gel artifact");
  const forwardMap = await readGeneratedSvg(summary.mapArtifacts?.mol_forward?.path, "forward map artifact");
  const reverseMap = await readGeneratedSvg(summary.mapArtifacts?.mol_reverse?.path, "reverse map artifact");
  const candidateRows = summary.candidateResults.map((candidate) => `
      <tr class="${candidate.verdict === "selected" ? "selected" : ""}">
        <td>${escapeHtml(candidate.pair.replace("+", " + "))}</td>
        <td>${escapeHtml(candidate.fragmentsByMolecule.mol_empty.join(", "))}</td>
        <td>${escapeHtml(candidate.fragmentsByMolecule.mol_forward.join(", "))}</td>
        <td>${escapeHtml(candidate.fragmentsByMolecule.mol_reverse.join(", "))}</td>
        <td>${candidate.score.minOrientationSmallBand}</td>
        <td>${candidate.score.smallBandDifference}</td>
        <td>${escapeHtml(candidate.verdict)}</td>
      </tr>`).join("");
  const toolList = summary.tools.map((tool, index) => `<li><span>${String(index + 1).padStart(2, "0")}</span>${escapeHtml(tool)}</li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Datalox V1 Diagnostic Digest Review</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #16211f;
      --muted: #5f706c;
      --line: #d4dfdc;
      --panel: #f4f8f7;
      --accent: #176b5b;
      --warn: #b87508;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 Arial, Helvetica, sans-serif;
      color: var(--ink);
      background: #ffffff;
    }
    header {
      padding: 24px 28px 16px;
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 16px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr);
      min-height: calc(100vh - 82px);
    }
    section {
      padding: 20px 24px;
      border-bottom: 1px solid var(--line);
    }
    .left { border-right: 1px solid var(--line); }
    .artifact svg {
      width: 100%;
      height: auto;
      display: block;
      border: 1px solid var(--line);
      background: #fff;
    }
    .maps {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .maps svg { max-height: 360px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 8px 9px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; }
    tr.selected td {
      background: #e8f3f0;
      font-weight: 700;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 14px;
    }
    .metric {
      padding: 10px;
      background: var(--panel);
      border: 1px solid var(--line);
    }
    .metric span { display: block; color: var(--muted); font-size: 11px; }
    .metric strong { display: block; margin-top: 4px; font-size: 18px; }
    ol {
      margin: 0;
      padding: 0;
      list-style: none;
      columns: 2;
      column-gap: 22px;
    }
    li {
      break-inside: avoid;
      padding: 3px 0;
      color: var(--muted);
    }
    li span {
      display: inline-block;
      width: 28px;
      color: var(--accent);
      font-weight: 700;
    }
    .review {
      background: #fbfcfc;
    }
    .approval {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .approval div {
      padding: 14px;
      border: 1px solid var(--line);
      background: #fff;
    }
    .approval strong { display: block; margin-bottom: 6px; }
    code {
      display: block;
      margin-top: 8px;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--muted);
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header>
    <h1>Datalox V1 Diagnostic Digest Review</h1>
    <p>${escapeHtml(summary.scenario)}. Deterministic MCP tools selected ${escapeHtml(summary.selectedPair.join(" + "))} and verified the replay bundle.</p>
  </header>
  <main>
    <div class="left">
      <section class="artifact">
        <h2>Diagnostic Gel</h2>
        ${gelSvg}
      </section>
      <section>
        <h2>Candidate Enzyme Pairs</h2>
        <table>
          <thead>
            <tr><th>Pair</th><th>Empty</th><th>Forward</th><th>Reverse</th><th>Min small band</th><th>Diff</th><th>Verdict</th></tr>
          </thead>
          <tbody>${candidateRows}</tbody>
        </table>
      </section>
      <section class="artifact">
        <h2>Construct Maps</h2>
        <div class="maps">
          ${forwardMap}
          ${reverseMap}
        </div>
      </section>
    </div>
    <div>
      <section>
        <h2>Replay Provenance</h2>
        <div class="metrics">
          <div class="metric"><span>Bundle</span><strong>verified</strong></div>
          <div class="metric"><span>Tool records</span><strong>${summary.recordCount}</strong></div>
          <div class="metric"><span>Insert</span><strong>${summary.insert.length} bp</strong></div>
        </div>
        <code>${escapeHtml(summary.bundlePath)}</code>
      </section>
      <section>
        <h2>Tool Chain</h2>
        <ol>${toolList}</ol>
      </section>
      <section class="review">
        <h2>Human Review</h2>
        <div class="approval">
          <div>
            <strong>Scientific conclusion</strong>
            Forward and reverse constructs are distinguishable by HindIII + XhoI: ${summary.expectedFragments.mol_forward.join(" + ")} bp vs ${summary.expectedFragments.mol_reverse.join(" + ")} bp.
          </div>
          <div>
            <strong>Approval state</strong>
            Ready for human approval after visual inspection of gel, maps, and replay provenance.
          </div>
        </div>
      </section>
    </div>
  </main>
</body>
</html>
`;
}

async function readGeneratedSvg(filePath, label) {
  if (typeof filePath !== "string" || filePath.length === 0) throw new Error(`Missing ${label} path`);
  const svg = await fs.readFile(filePath, "utf8");
  if (!svg.includes("<svg")) throw new Error(`${label} is not an SVG`);
  return svg;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
