import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { PACKAGE_NAME, PACKAGE_VERSION } from "../core/version.js";
import { moleculeToolDescriptors } from "../tools/descriptors.js";
import { runToolHandler, toolFailure, type ToolName, type ToolResultEnvelope } from "../tools/index.js";
import { assertSupportedInputSchemas, validateAgainstSchema } from "./validate-args.js";

const toolNames = new Set<string>(moleculeToolDescriptors.map((tool) => tool.name));
const toolSchemas = new Map(moleculeToolDescriptors.map((tool) => [tool.name, tool.inputSchema]));

export function createMoleculeMcpServer(): Server {
  assertSupportedInputSchemas(moleculeToolDescriptors);
  const server = new Server(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: [
        "Use molecule biology tools as the source of truth for sequence facts.",
        "Do not infer biological facts from screenshots.",
        "Use expectedRevision for every structured workspace write.",
      ].join(" "),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => listMoleculeMcpTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) => callMoleculeMcpTool(
    request.params.name,
    request.params.arguments ?? {},
  ));

  return server;
}

export function listMoleculeMcpTools(): ListToolsResult {
  return {
    tools: moleculeToolDescriptors.map((tool): Tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool["inputSchema"],
    })),
  };
}

export async function callMoleculeMcpTool(name: string, args: unknown): Promise<CallToolResult> {
  if (!isToolName(name)) {
    return toolEnvelopeToMcpResult(toolFailure(name, "INVALID_ARGUMENT", "Unknown molecule biology tool.", { tool: name }));
  }

  if (!isRecord(args)) {
    return toolEnvelopeToMcpResult(toolFailure(name, "INVALID_ARGUMENT", "Tool arguments must be a JSON object.", {
      received: Array.isArray(args) ? "array" : typeof args,
    }));
  }

  const violations = validateAgainstSchema(args, toolSchemas.get(name));
  if (violations.length > 0) {
    return toolEnvelopeToMcpResult(toolFailure(
      name,
      "SCHEMA_VALIDATION_ERROR",
      "Tool arguments do not match the advertised input schema.",
      { violations },
    ));
  }

  const envelope = await runToolHandler(name, args as never);

  return toolEnvelopeToMcpResult(envelope);
}

export function toolEnvelopeToMcpResult(envelope: ToolResultEnvelope): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${JSON.stringify(envelope, null, 2)}\n`,
      },
    ],
    isError: !envelope.ok,
  };
}

export async function runMoleculeMcpServer(): Promise<void> {
  const server = createMoleculeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isToolName(name: string): name is ToolName {
  return toolNames.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
