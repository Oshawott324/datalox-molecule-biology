import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { callMoleculeMcpTool, createMoleculeMcpServer, moleculeToolDescriptors } from "../src/index.js";
import { PACKAGE_VERSION, REQUIRED_V1_TOOLS } from "../src/core/version.js";
import { assertSupportedInputSchema } from "../src/mcp/validate-args.js";
import { toolFailure } from "../src/tools/envelope.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("MCP server", () => {
  const clients: Client[] = [];
  const servers: ReturnType<typeof createMoleculeMcpServer>[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("lists molecule biology tools through MCP", async () => {
    const { client } = await connectedClient();
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_version",
      "open_sequence",
      "get_sequence_context",
      "upsert_feature",
      "upsert_grna",
      "design_grnas",
      "export_grna_report",
      "validate_workspace",
    ]));
  });

  it("returns a real version handshake for hub startup checks", async () => {
    const { client } = await connectedClient();
    const version = envelope(await client.callTool({ name: "get_version", arguments: {} }));

    expect(version).toMatchObject({
      ok: true,
      tool: "get_version",
      data: {
        packageName: "@datalox/molecule-biology",
        packageVersion: "0.1.0",
        protocol: "mcp-stdio",
        agentContractVersion: 1,
        workspaceSchema: "datalox.molecule.workspace",
        workspaceVersion: 1,
        provenanceBundleVersion: "1.0",
      },
    });
    const data = version.data as { requiredTools?: string[]; availableTools?: string[]; toolCount?: number; caveats?: string[] };
    expect(data.requiredTools).toEqual([...REQUIRED_V1_TOOLS]);
    expect(data.availableTools).toEqual(moleculeToolDescriptors.map((descriptor) => descriptor.name));
    expect(data.toolCount).toBe(moleculeToolDescriptors.length);
    expect(data.caveats?.length).toBeGreaterThan(0);
  });

  it("keeps the handshake package version synchronized with package.json", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as { version?: string };
    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });

  it("runs the core open, context, write, validate loop through MCP", async () => {
    const workspaceDir = await tempDir("mol-mcp-");
    const inputPath = path.join(workspaceDir, "input.fa");
    await fs.writeFile(inputPath, ">mcp demo\nACGTRYSWKMBDHVN\n", "utf8");
    const { client } = await connectedClient();

    const open = await client.callTool({
      name: "open_sequence",
      arguments: {
        inputPath,
        workspaceDir,
        format: "fasta",
        moleculeId: "mol_mcp_demo",
      },
    });
    const openEnvelope = envelope(open);
    expect(openEnvelope.ok).toBe(true);

    const context = await client.callTool({
      name: "get_sequence_context",
      arguments: {
        workspacePath: openEnvelope.workspacePath,
        moleculeId: "mol_mcp_demo",
        includeSequence: true,
      },
    });
    const contextEnvelope = envelope(context);
    expect(contextEnvelope).toMatchObject({
      ok: true,
      revision: 0,
      data: {
        sequence: "ACGTRYSWKMBDHVN",
      },
    });

    const upsert = await client.callTool({
      name: "upsert_feature",
      arguments: {
        workspacePath: openEnvelope.workspacePath,
        expectedRevision: 0,
        feature: {
          id: "feat_mcp_demo",
          moleculeId: "mol_mcp_demo",
          name: "MCP demo feature",
          type: "misc_feature",
          segments: [{ start: 1, end: 4, strand: "+" }],
          source: { kind: "agent", tool: "upsert_feature" },
        },
      },
    });
    expect(envelope(upsert)).toMatchObject({
      ok: true,
      revision: 1,
      data: {
        featureId: "feat_mcp_demo",
      },
    });

    const validate = await client.callTool({
      name: "validate_workspace",
      arguments: {
        workspacePath: openEnvelope.workspacePath,
      },
    });
    expect(envelope(validate)).toMatchObject({
      ok: true,
      revision: 1,
      data: {
        valid: true,
        issues: [],
      },
    });
  });

  it("simulates restriction assembly through MCP and returns candidate artifacts", async () => {
    const workspaceDir = await tempDir("mol-mcp-assembly-");
    const vectorPath = path.join(workspaceDir, "vector.gb");
    const insertPath = path.join(workspaceDir, "insert.fa");
    await fs.writeFile(
      vectorPath,
      circularGenBank(
        "AAAA" + "GAATTC" + "CCCCCCCCCCCCCC" + "GGATCC" + "TTTTTTTTTTTTTTTTTTTT",
        "mcp_vector",
      ),
      "utf8",
    );
    await fs.writeFile(
      insertPath,
      ">mcp_insert\n" + "AAAA" + "GAATTC" + "GGGGGGGGGGGGGG" + "GGATCC" + "AAAA\n",
      "utf8",
    );
    const { client } = await connectedClient();

    const vectorOpen = envelope(await client.callTool({
      name: "open_sequence",
      arguments: {
        inputPath: vectorPath,
        workspaceDir,
        format: "genbank",
        moleculeId: "mol_mcp_vector",
      },
    }));
    expect(vectorOpen.ok).toBe(true);
    const insertOpen = envelope(await client.callTool({
      name: "open_sequence",
      arguments: {
        inputPath: insertPath,
        workspaceDir,
        format: "fasta",
        moleculeId: "mol_mcp_insert",
        expectedRevision: vectorOpen.revision,
      },
    }));
    expect(insertOpen.ok).toBe(true);

    const assembly = envelope(await client.callTool({
      name: "simulate_assembly",
      arguments: {
        workspacePath: vectorOpen.workspacePath,
        method: "restriction_ligation",
        vector: { moleculeId: "mol_mcp_vector", leftEnzyme: "EcoRI", rightEnzyme: "BamHI" },
        insert: {
          moleculeId: "mol_mcp_insert",
          leftEnzyme: "EcoRI",
          rightEnzyme: "BamHI",
          orientation: "forward",
        },
        product: { moleculeId: "mol_mcp_product", name: "mcp_product" },
      },
    }));

    expect(assembly).toMatchObject({
      ok: true,
      tool: "simulate_assembly",
      revision: 1,
      data: {
        candidates: [
          {
            candidateId: "candidate_forward",
            length: 50,
            artifacts: [expect.objectContaining({ kind: "genbank" })],
          },
        ],
      },
      artifacts: [expect.objectContaining({ kind: "genbank" })],
      nextAction: {
        tool: "open_sequence",
        arguments: expect.objectContaining({
          format: "genbank",
          expectedRevision: 1,
        }),
      },
    });
    expect(await fileExists(((assembly.artifacts as Array<{ path: string }>)[0]).path)).toBe(true);
  });

  it("rejects non-object tool arguments instead of coercing them", async () => {
    const result = await callMoleculeMcpTool("reverse_complement", "ACGT");

    expect(envelope(result)).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        details: {
          received: "string",
        },
      },
    });
  });

  it("rejects schema-invalid arguments at the MCP boundary before dispatch", async () => {
    const missingRequired = envelope(await callMoleculeMcpTool("reverse_complement", {}));
    expect(missingRequired).toMatchObject({
      ok: false,
      error: { code: "SCHEMA_VALIDATION_ERROR" },
    });
    expect((missingRequired.error as { details?: { violations?: unknown[] } }).details?.violations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: "arguments.sequence" })]));

    const wrongType = envelope(await callMoleculeMcpTool("reverse_complement", { sequence: 42 }));
    expect(wrongType).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION_ERROR" } });

    const unknownProperty = envelope(await callMoleculeMcpTool("reverse_complement", { sequence: "ACGT", oops: true }));
    expect(unknownProperty).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION_ERROR" } });

    const badEnum = envelope(await callMoleculeMcpTool("open_sequence", {
      inputPath: "x.fa",
      workspaceDir: "ws",
      format: "rubbish",
    }));
    expect(badEnum).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION_ERROR" } });
  });

  it("separates schema-invalid from domain-invalid requests", async () => {
    // Schema-valid but the file does not exist -> domain layer, not the schema gate.
    const missingPath = path.join(os.tmpdir(), "definitely-missing-mol-input.fa");
    const result = envelope(await callMoleculeMcpTool("open_sequence", {
      inputPath: missingPath,
      workspaceDir: await tempDir("mol-domain-"),
      format: "fasta",
    }));
    expect(result.ok).toBe(false);
    expect((result.error as { code?: string }).code).not.toBe("SCHEMA_VALIDATION_ERROR");
    expect(JSON.stringify(result)).not.toContain(missingPath);
    expect(JSON.stringify(result)).toContain("<redacted:absolute_path:definitely-missing-mol-input.fa>");
  });

  it("rejects open_sequence imports outside the workspace root through the MCP boundary", async () => {
    const outsidePath = path.resolve("fixtures/fasta/single.fa");
    const workspaceDir = await tempDir("mol-path-boundary-");
    const result = envelope(await callMoleculeMcpTool("open_sequence", {
      inputPath: outsidePath,
      workspaceDir,
      format: "fasta",
    }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "PATH_OUTSIDE_WORKSPACE",
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(outsidePath);
    expect(serialized).not.toContain(workspaceDir);
    expect(serialized).toContain("<redacted:absolute_path:single.fa>");
  });

  it("redacts absolute paths in error details without redacting URLs", () => {
    const envelope = toolFailure("blast_sequence", "BLAST_TIMEOUT", "NCBI BLAST timed out.", {
      ncbiUrl: "https://blast.ncbi.nlm.nih.gov/Blast.cgi?RID=ABC123&CMD=Get",
      localPath: path.join(os.tmpdir(), "blast-result.xml"),
    });

    const serialized = JSON.stringify(envelope);
    expect(serialized).toContain("https://blast.ncbi.nlm.nih.gov/Blast.cgi?RID=ABC123&CMD=Get");
    expect(serialized).not.toContain(path.join(os.tmpdir(), "blast-result.xml"));
    expect(serialized).toContain("<redacted:absolute_path:blast-result.xml>");
  });

  it("advertises only JSON Schema keywords the boundary validator enforces", () => {
    // Locked contract: validate-args.ts implements exactly this subset. A descriptor
    // that introduces another keyword (pattern, maxLength, anyOf, ...) would be
    // advertised but silently unenforced, so this fails loudly until the validator
    // catches up. Keep this set in sync with validate-args.ts.
    const supported = new Set(["type", "properties", "required", "additionalProperties", "enum", "minimum", "items", "description"]);
    const offenders: string[] = [];
    const walk = (schema: Record<string, unknown>, where: string): void => {
      for (const key of Object.keys(schema)) {
        if (!supported.has(key)) offenders.push(`${where}.${key}`);
      }
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      for (const [name, child] of Object.entries(properties ?? {})) walk(child, `${where}.${name}`);
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) walk(items, `${where}[]`);
    };
    for (const descriptor of moleculeToolDescriptors) {
      walk(descriptor.inputSchema as unknown as Record<string, unknown>, descriptor.name);
    }
    expect(offenders).toEqual([]);
  });

  it("fails loudly when a descriptor schema uses an unsupported type or keyword", () => {
    expect(() => assertSupportedInputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        sequence: { type: "string", pattern: "^[ACGT]+$" },
      },
    }, "bad_tool")).toThrow("unsupported JSON Schema keyword 'pattern'");

    expect(() => assertSupportedInputSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        sequence: { type: "text" },
      },
    }, "bad_tool")).toThrow("unsupported JSON Schema type 'text'");
  });

  it("enforces every advertised required field at the schema gate, not the handler", async () => {
    // For each tool that advertises required fields, empty arguments must be rejected
    // by the schema gate (SCHEMA_VALIDATION_ERROR) before any handler runs. This locks
    // the protocol/schema/domain separation: `required` is the schema layer's job.
    for (const descriptor of moleculeToolDescriptors) {
      if ((descriptor.inputSchema.required ?? []).length === 0) continue;
      const result = envelope(await callMoleculeMcpTool(descriptor.name, {}));
      expect(result.ok).toBe(false);
      expect((result.error as { code?: string }).code).toBe("SCHEMA_VALIDATION_ERROR");
    }
  });

  async function connectedClient(): Promise<{ client: Client }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMoleculeMcpServer();
    const client = new Client({ name: "molecule-biology-test", version: "0.1.0" });
    servers.push(server);
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client };
  }
});

function circularGenBank(sequence: string, name: string): string {
  return [
    `LOCUS       ${name.padEnd(12)} ${sequence.length} bp    DNA     circular SYN 03-JUL-2026`,
    `DEFINITION  ${name}.`,
    "FEATURES             Location/Qualifiers",
    "ORIGIN",
    `        1 ${sequence.toLowerCase()}`,
    "//",
    "",
  ].join("\n");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function envelope(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) throw new Error("MCP result was not an object");
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((entry): entry is { type: "text"; text: string } => (
    isRecord(entry) && entry.type === "text" && typeof entry.text === "string"
  ))?.text;
  if (text === undefined) throw new Error("MCP result did not include text content");
  return JSON.parse(text) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
