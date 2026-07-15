/**
 * Minimal, dependency-free validator for the JSON Schema subset used by
 * moleculeToolDescriptors. It exists to make the MCP boundary the gate for
 * schema-invalid requests: arguments are checked against the tool's advertised
 * inputSchema before dispatch, so handlers only ever see structurally valid
 * input and can focus on domain validation.
 *
 * Supported keywords (the only ones the descriptors may advertise): type
 * (object/array/string/integer/number/boolean), properties, required,
 * additionalProperties:false, enum, minimum, array items, and description.
 * Descriptor schemas are audited before the MCP server starts so unsupported
 * keywords or unknown types fail loudly instead of being silently unenforced.
 */

export type SchemaViolation = {
  path: string;
  message: string;
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  minimum?: number;
  items?: JsonSchema;
  description?: string;
};

const supportedSchemaKeywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "minimum",
  "items",
  "description",
]);

const supportedSchemaTypes = new Set(["object", "array", "string", "integer", "number", "boolean"]);

export function validateAgainstSchema(value: unknown, schema: unknown, basePath = "arguments"): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  validateNode(value, schema as JsonSchema, basePath, violations);
  return violations;
}

export function assertSupportedInputSchema(schema: unknown, where = "inputSchema"): void {
  assertSupportedSchemaNode(schema, where);
}

export function assertSupportedInputSchemas(descriptors: Array<{ name: string; inputSchema: unknown }>): void {
  for (const descriptor of descriptors) {
    assertSupportedInputSchema(descriptor.inputSchema, descriptor.name);
  }
}

function assertSupportedSchemaNode(schema: unknown, where: string): void {
  if (!isRecord(schema)) {
    throw new Error(`${where}: input schema must be a JSON object`);
  }
  for (const key of Object.keys(schema)) {
    if (!supportedSchemaKeywords.has(key)) {
      throw new Error(`${where}: unsupported JSON Schema keyword '${key}'`);
    }
  }
  if (schema.type !== undefined && (typeof schema.type !== "string" || !supportedSchemaTypes.has(schema.type))) {
    throw new Error(`${where}: unsupported JSON Schema type '${String(schema.type)}'`);
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`${where}: properties must be an object`);
    for (const [property, childSchema] of Object.entries(schema.properties)) {
      assertSupportedSchemaNode(childSchema, `${where}.${property}`);
    }
  }
  if (schema.items !== undefined) {
    assertSupportedSchemaNode(schema.items, `${where}[]`);
  }
}

function validateNode(value: unknown, schema: JsonSchema, path: string, violations: SchemaViolation[]): void {
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    violations.push({ path, message: `expected ${schema.type}` });
    return; // Type is the precondition for every other check at this node.
  }

  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) {
    violations.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }

  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
      violations.push({ path, message: `must be >= ${schema.minimum}` });
    }
  }

  if (schema.type === "object" && isRecord(value)) {
    validateObject(value, schema, path, violations);
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => validateNode(entry, schema.items as JsonSchema, `${path}[${index}]`, violations));
  }
}

function validateObject(value: Record<string, unknown>, schema: JsonSchema, path: string, violations: SchemaViolation[]): void {
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) {
      violations.push({ path: `${path}.${key}`, message: "is required" });
    }
  }

  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        violations.push({ path: `${path}.${key}`, message: "is not an allowed property" });
      }
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    if (value[key] !== undefined) {
      validateNode(value[key], childSchema, `${path}.${key}`, violations);
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
