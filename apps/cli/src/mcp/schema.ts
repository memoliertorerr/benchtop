/**
 * The JSON Schema subset the MCP tools describe their arguments with (BT68), and its validator.
 * Clients read the schemas as JSON Schema; the server checks arguments against them itself
 * before a tool runs. Keywords: `type` (one of object, string, number, integer, boolean, array),
 * `description`, `properties`, `required`, `additionalProperties` (false, or a schema every
 * other property must match), `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `items`,
 * `maxItems`. A schema without `type` accepts any value. `SCHEMA_KEYWORDS` lists them so a test
 * can prove no tool uses anything else.
 */

export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
  maxItems?: number;
}

export const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'items',
  'maxItems',
]);

/** Errors shown per call, at most. */
const MAX_ERRORS = 10;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return;
  const where = path === '' ? 'arguments' : path;
  switch (schema.type) {
    case undefined:
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${where} must be an object, got ${describe(value)}`);
        return;
      }
      break;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${where} must be an array, got ${describe(value)}`);
        return;
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${where} must be an integer, got ${describe(value)}`);
        return;
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${where} must be a finite number, got ${describe(value)}`);
        return;
      }
      break;
    default:
      if (typeof value !== schema.type) {
        errors.push(`${where} must be a ${schema.type}, got ${describe(value)}`);
        return;
      }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number)) {
    errors.push(`${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    return;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where} must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where} must be ≤ ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where} must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where} must be at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${where} must have at most ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((item, i) => check(schema.items as JsonSchema, item, `${path}[${i}]`, errors));
  }
  if (schema.type === 'object') {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (object[name] === undefined) errors.push(`${path === '' ? '' : `${path}.`}${name} is required`);
    }
    for (const [name, item] of Object.entries(object)) {
      const sub = schema.properties?.[name];
      const at = path === '' ? name : `${path}.${name}`;
      if (sub !== undefined) check(sub, item, at, errors);
      else if (schema.additionalProperties === false) errors.push(`${at} is not an argument this tool takes`);
      else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, item, at, errors);
    }
  }
}

/** Every way `value` breaks `schema` (empty: it conforms), at most ten. */
export function validate(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, value, '', errors);
  return errors;
}

/** Every keyword a schema (and its nested schemas) uses that `SCHEMA_KEYWORDS` doesn't list. */
export function unknownKeywords(schema: JsonSchema, path = '#'): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) found.push(`${path}/${key}`);
    else if (key === 'properties') for (const [name, sub] of Object.entries(value as Record<string, JsonSchema>)) found.push(...unknownKeywords(sub, `${path}/properties/${name}`));
    else if ((key === 'items' || key === 'additionalProperties') && typeof value === 'object') found.push(...unknownKeywords(value as JsonSchema, `${path}/${key}`));
  }
  return found;
}
