import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  blastSequence,
  importSequenceFile,
  sequenceDigest,
  type NcbiBlastRequest,
  WORKSPACE_SCHEMA,
  WORKSPACE_VERSION,
  writeWorkspaceFile,
} from "../src/index.js";
import { stageFixture } from "./support/fixtures.js";

const fixtureRoot = "fixtures/blast/puc19-bla-blastn-nt";
const putResponse = readFileSync(path.join(fixtureRoot, "put-response.txt"), "utf8");
const statusResponse = readFileSync(path.join(fixtureRoot, "status-0060.txt"), "utf8");
const resultJson = readFileSync(path.join(fixtureRoot, "result.json"), "utf8");

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("blastSequence", () => {
  it("runs NCBI BLAST through an injected transport, summarizes hits, and writes the raw JSON artifact", async () => {
    const source = await openBlastQuery();
    const requests: NcbiBlastRequest[] = [];
    const result = await blastSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      database: "nt",
      program: "blastn",
      hitlistSize: 5,
      eValueThreshold: 0.001,
      outputPath: "reports/blast/puc19-bla.fixture.json",
    }, {
      email: "test@example.com",
      tool: "datalox-test",
      submittedAt: "2026-07-22T00:00:00.000Z",
      sleepSeconds: async () => undefined,
      transport: async (request) => {
        requests.push(request);
        if (request.params.CMD === "Put") return putResponse;
        if (request.params.FORMAT_OBJECT === "SearchInfo") return statusResponse;
        return resultJson;
      },
    });

    expect(result).toMatchObject({
      queryId: "mol_puc19_bla",
      querySource: "workspace_molecule",
      queryLength: 300,
      requestedDatabase: "nt",
      effectiveDatabase: "core_nt",
      program: "blastn",
      rid: "606SVMTS014",
      hitsTruncated: true,
      hitlistLimitReached: true,
      parameters: {
        hitlistSize: 5,
        eValueThreshold: 0.001,
      },
      provenance: {
        requestedDatabase: "nt",
        effectiveDatabase: "core_nt",
        resultFormat: "JSON2_S",
        rid: "606SVMTS014",
      },
      artifact: {
        kind: "blast_result",
        relativePath: path.join("reports", "blast", "puc19-bla.fixture.json"),
      },
      revision: 0,
    });
    expect(result.hits).toHaveLength(5);
    expect(result.hits[0]).toMatchObject({
      accession: "PX095324",
      alignments: [
        expect.objectContaining({
          identity: 300,
          alignedLength: 300,
          queryStart: 1,
          queryEnd: 300,
          subjectStart: 7277,
          subjectEnd: 7576,
          eValue: 1.39168e-149,
        }),
      ],
    });
    expect(JSON.stringify(result.hits)).not.toContain("qseq");
    expect(JSON.stringify(result.hits)).not.toContain("midline");
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
    expect(requests[0].params).toMatchObject({
      DATABASE: "nt",
      PROGRAM: "blastn",
      HITLIST_SIZE: "5",
      EXPECT: "0.001",
      tool: "datalox-test",
      email: "test@example.com",
    });

    const artifactText = await fs.readFile(result.artifact?.path ?? "", "utf8");
    expect(JSON.parse(artifactText)).toMatchObject({
      BlastOutput2: expect.any(Array),
    });
    expect(artifactText).toContain("qseq");
  });

  it("accepts raw sequence without writing a workspace artifact", async () => {
    const result = await blastSequence({
      sequence: "ACGT".repeat(75),
      database: "nt",
      program: "blastn",
      hitlistSize: 5,
    }, fixtureDeps());

    expect(result).toMatchObject({
      queryId: "raw_sequence",
      querySource: "raw_sequence",
      queryLength: 300,
      requestedDatabase: "nt",
    });
    expect(result.artifact).toBeUndefined();
  });

  it("rejects incompatible program and database before transport", async () => {
    const calls: NcbiBlastRequest[] = [];
    const error = await caughtAsync(() => blastSequence({
      sequence: "ACGT".repeat(10),
      database: "nr",
      program: "blastn",
    }, fixtureDeps(calls)));

    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: {
        program: "blastn",
        database: "nr",
      },
    });
    expect(calls).toEqual([]);
  });

  it("rejects protein molecules for blastn before transport", async () => {
    const workspaceDir = await tempDir("mol-blast-protein-");
    const sequencePath = path.join(workspaceDir, "data", "sequences", "protein.fa");
    await fs.mkdir(path.dirname(sequencePath), { recursive: true });
    await fs.writeFile(sequencePath, ">protein\nMTEYKLVVVG\n", "utf8");
    const workspacePath = path.join(workspaceDir, "molecule.workspace.json");
    await writeWorkspaceFile(workspacePath, {
      schema: WORKSPACE_SCHEMA,
      version: WORKSPACE_VERSION,
      revision: 0,
      workspaceId: "ws_protein",
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
      molecules: [{
        id: "mol_protein",
        name: "protein",
        path: path.join("data", "sequences", "protein.fa"),
        sourceFormat: "fasta",
        sequenceDigest: sequenceDigest("MTEYKLVVVG"),
        length: 10,
        topology: "linear",
        moleculeType: "protein",
        alphabet: "protein",
      }],
      features: [],
      primers: [],
      guides: [],
      constructs: [],
      experiments: [],
      auditEvents: [],
    });
    const calls: NcbiBlastRequest[] = [];

    const error = await caughtAsync(() => blastSequence({
      workspacePath,
      moleculeId: "mol_protein",
      database: "nt",
      program: "blastn",
    }, fixtureDeps(calls)));

    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: {
        moleculeType: "protein",
        program: "blastn",
        requiredQueryType: "nucleotide",
      },
    });
    expect(calls).toEqual([]);
  });

  it("rejects artifact paths outside the workspace", async () => {
    const source = await openBlastQuery();
    const outsidePath = path.join(os.tmpdir(), "blast-outside.json");

    const error = await caughtAsync(() => blastSequence({
      workspacePath: source.workspacePath,
      moleculeId: source.moleculeId,
      database: "nt",
      program: "blastn",
      outputPath: outsidePath,
    }, fixtureDeps()));

    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "BLAST outputPath must stay inside the workspace.",
    });
  });

  it("rejects outputPath without workspacePath before transport", async () => {
    const calls: NcbiBlastRequest[] = [];
    const error = await caughtAsync(() => blastSequence({
      sequence: "ACGT".repeat(75),
      database: "nt",
      program: "blastn",
      outputPath: "reports/blast/raw.json",
    }, fixtureDeps(calls)));

    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "workspacePath is required when outputPath is provided.",
    });
    expect(calls).toEqual([]);
  });

  it("requires NCBI_BLAST_EMAIL only after local validation passes", async () => {
    const error = await caughtAsync(() => blastSequence({
      sequence: "ACGT".repeat(10),
      database: "nt",
      program: "blastn",
    }, {
      transport: async () => resultJson,
    }));

    expect(error).toMatchObject({
      code: "DEPENDENCY_MISSING",
      details: {
        env: "NCBI_BLAST_EMAIL",
      },
    });
  });
});

async function openBlastQuery(): Promise<{ workspacePath: string; moleculeId: string }> {
  const workspaceDir = await tempDir("mol-blast-");
  const inputPath = await stageFixture(workspaceDir, "blast/puc19-bla-blastn-nt/query.fa");
  const imported = await importSequenceFile({
    inputPath,
    workspaceDir,
    format: "fasta",
    moleculeId: "mol_puc19_bla",
  });
  return {
    workspacePath: imported.workspacePath,
    moleculeId: "mol_puc19_bla",
  };
}

function fixtureDeps(requests: NcbiBlastRequest[] = []): Parameters<typeof blastSequence>[1] {
  return {
    email: "test@example.com",
    submittedAt: "2026-07-22T00:00:00.000Z",
    sleepSeconds: async () => undefined,
    transport: async (request) => {
      requests.push(request);
      if (request.params.CMD === "Put") return putResponse;
      if (request.params.FORMAT_OBJECT === "SearchInfo") return statusResponse;
      return resultJson;
    },
  };
}

async function caughtAsync(run: () => Promise<unknown>): Promise<{ code?: string; message?: string; details?: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    return error as { code?: string; message?: string; details?: Record<string, unknown> };
  }
  throw new Error("expected operation to throw");
}
