#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(repoRoot, "fixtures", "crispr", "azimuth-readme-reference.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

const python = process.env.AZIMUTH_PYTHON ?? "python";
const pythonProgram = String.raw`
import json
import sys

try:
    import numpy as np
    from azimuth import model_comparison
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "error": "AZIMUTH_DEPENDENCY_MISSING",
        "message": str(exc),
        "install": "Create a reviewed Python environment with azimuth installed, then rerun with AZIMUTH_PYTHON=/path/to/python."
    }))
    sys.exit(2)

payload = json.load(sys.stdin)
records = payload["records"]
sequences = [record["sequence30"] for record in records]
amino_acid_cut_positions = np.array([record["aminoAcidCutPosition"] for record in records])
percent_peptides = np.array([record["percentPeptide"] for record in records])

scores = model_comparison.predict(sequences, amino_acid_cut_positions, percent_peptides)
print(json.dumps({
    "ok": True,
    "scores": [float(score) for score in scores]
}))
`;

const child = spawnSync(python, ["-c", pythonProgram], {
  input: JSON.stringify({ records: fixture.records }),
  encoding: "utf8",
});

const rawOutput = `${child.stdout ?? ""}`.trim();
const stderr = `${child.stderr ?? ""}`.trim();

if (child.error) {
  console.error(JSON.stringify({
    ok: false,
    error: "PYTHON_NOT_FOUND",
    message: child.error.message,
    python,
  }, null, 2));
  process.exit(2);
}

let result;
try {
  result = JSON.parse(rawOutput);
} catch {
  console.error(JSON.stringify({
    ok: false,
    error: "AZIMUTH_VALIDATION_OUTPUT_PARSE_ERROR",
    stdout: rawOutput,
    stderr,
    exitCode: child.status,
  }, null, 2));
  process.exit(2);
}

if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(child.status ?? 2);
}

const tolerance = fixture.tolerance;
const checks = fixture.records.map((record, index) => {
  const actual = result.scores[index];
  const delta = Math.abs(actual - record.expectedScore);
  return {
    id: record.id,
    expectedScore: record.expectedScore,
    actualScore: actual,
    delta,
    passed: delta <= tolerance,
  };
});

const ok = checks.every((check) => check.passed);
console.log(JSON.stringify({
  ok,
  fixture: path.relative(repoRoot, fixturePath),
  source: fixture.source,
  model: fixture.model,
  tolerance,
  checks,
}, null, 2));

process.exit(ok ? 0 : 1);
