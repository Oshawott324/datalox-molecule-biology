import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NCBI_BLAST_RESULT_FORMAT,
  type NcbiBlastRequest,
  redactNcbiBlastResponseText,
  runNcbiBlast,
} from "../src/index.js";

const resultJson = readFileSync("fixtures/blast/puc19-bla-blastn-nt/result.json", "utf8");
const putResponse = "RID = TESTRID123\nRTOE = 30\n";
const readyStatus = "Status=READY\n";

function baseOptions(overrides: Partial<Parameters<typeof runNcbiBlast>[0]> = {}): Parameters<typeof runNcbiBlast>[0] {
  return {
    sequence: "ACGT".repeat(75),
    database: "nt",
    program: "blastn",
    hitlistSize: 5,
    expect: "0.001",
    tool: "datalox-test",
    email: "test@example.com",
    submittedAt: "2026-07-22T00:00:00.000Z",
    sleepSeconds: async () => undefined,
    ...overrides,
  };
}

describe("NCBI BLAST client orchestration", () => {
  it("submits, polls once, retrieves JSON2_S, and parses the result", async () => {
    const requests: NcbiBlastRequest[] = [];
    const result = await runNcbiBlast(baseOptions({
      transport: async (request) => {
        requests.push(request);
        if (request.params.CMD === "Put") return putResponse;
        if (request.params.FORMAT_OBJECT === "SearchInfo") return readyStatus;
        return resultJson;
      },
    }));

    expect(result).toMatchObject({
      rid: "TESTRID123",
      rtoe: 30,
      status: "READY",
      requestedDatabase: "nt",
      effectiveDatabase: "core_nt",
      queryLength: 300,
    });
    expect(result.result.hits).toHaveLength(5);
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
    expect(requests[0].params).toMatchObject({
      CMD: "Put",
      DATABASE: "nt",
      PROGRAM: "blastn",
      HITLIST_SIZE: "5",
      EXPECT: "0.001",
      FORMAT_TYPE: NCBI_BLAST_RESULT_FORMAT,
      tool: "datalox-test",
      email: "test@example.com",
    });
    expect(requests[1].params).toMatchObject({
      CMD: "Get",
      RID: "TESTRID123",
      FORMAT_OBJECT: "SearchInfo",
    });
    expect(requests[2].params).toMatchObject({
      CMD: "Get",
      RID: "TESTRID123",
      FORMAT_TYPE: NCBI_BLAST_RESULT_FORMAT,
    });
  });

  it("waits at least 60 seconds before polling and between WAITING statuses", async () => {
    const sleeps: number[] = [];
    const statuses = ["Status=WAITING\n", "Status=READY\n"];
    await runNcbiBlast(baseOptions({
      sleepSeconds: async (seconds) => {
        sleeps.push(seconds);
      },
      transport: async (request) => {
        if (request.params.CMD === "Put") return "RID = WAITRID\nRTOE = 10\n";
        if (request.params.FORMAT_OBJECT === "SearchInfo") return statuses.shift() ?? readyStatus;
        return resultJson;
      },
    }));

    expect(sleeps).toEqual([60, 60]);
  });

  it("throws BLAST_FAILED with RID when NCBI returns FAILED", async () => {
    const error = await caughtAsync(() => runNcbiBlast(baseOptions({
      transport: async (request) => {
        if (request.params.CMD === "Put") return putResponse;
        return "Status=FAILED\n";
      },
    })));

    expect(error).toMatchObject({
      code: "BLAST_FAILED",
      details: {
        rid: "TESTRID123",
        status: "FAILED",
      },
    });
  });

  it("throws BLAST_TIMEOUT with RID when the wait budget is exhausted", async () => {
    const error = await caughtAsync(() => runNcbiBlast(baseOptions({
      maxWaitSeconds: 60,
      transport: async (request) => {
        if (request.params.CMD === "Put") return putResponse;
        return "Status=WAITING\n";
      },
    })));

    expect(error).toMatchObject({
      code: "BLAST_TIMEOUT",
      details: {
        rid: "TESTRID123",
        lastStatus: "WAITING",
        maxWaitSeconds: 60,
      },
    });
  });

  it("adds SHORT_QUERY_ADJUST for short nucleotide queries only", async () => {
    const requests: NcbiBlastRequest[] = [];
    await runNcbiBlast(baseOptions({
      sequence: "ACGTACGTACGT",
      transport: async (request) => {
        requests.push(request);
        if (request.params.CMD === "Put") return putResponse;
        if (request.params.FORMAT_OBJECT === "SearchInfo") return readyStatus;
        return resultJson;
      },
    }));

    expect(requests[0].params.SHORT_QUERY_ADJUST).toBe("true");
  });

  it("redacts NCBI contact fields from captured HTML responses", () => {
    const redacted = redactNcbiBlastResponseText(
      "email=test@example.com&email=test%40example.com&email=test%2540example.com&MYNCBI_USER=123&MYNCBI%5FUSER%3D456",
      "test@example.com",
    );

    expect(redacted).not.toContain("test@example.com");
    expect(redacted).not.toContain("test%40example.com");
    expect(redacted).not.toContain("test%2540example.com");
    expect(redacted).not.toContain("MYNCBI_USER=123");
    expect(redacted).not.toContain("MYNCBI%5FUSER%3D456");
    expect(redacted).toContain("<redacted:ncbi_email>");
    expect(redacted).toContain("<redacted:ncbi_user>");
  });
});

async function caughtAsync(run: () => Promise<unknown>): Promise<{ code?: string; details?: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    return error as { code?: string; details?: Record<string, unknown> };
  }
  throw new Error("expected operation to throw");
}
