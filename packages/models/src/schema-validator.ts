import Ajv, {type ValidateFunction} from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import {FutrynError} from '@cosmew/contracts';

const MAX_OUTPUT_SCHEMA_BYTES = 256 * 1024;

function hasExternalRef(node: unknown, depth = 0): boolean {
  if (depth > 64 || !node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(item => hasExternalRef(item, depth + 1));
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === 'string' && !record.$ref.startsWith('#')) return true;
  return Object.values(record).some(value => hasExternalRef(value, depth + 1));
}

export interface CompiledOutputSchema {
  schema: Record<string, unknown>;
  validate(value: unknown): {ok: true} | {ok: false; summary: string};
}

/**
 * Parses and compiles a user-supplied JSON Schema (`--json-schema`, ADR 0124) using Ajv (draft-07 or 2020-12).
 * Rejects oversized schemas, non-object schemas, external `$ref` URLs, and uncompilable schemas before any model call.
 */
export function compileOutputJsonSchema(raw: string | Record<string, unknown>): CompiledOutputSchema {
  let schema: unknown;
  if (typeof raw === 'string') {
    if (!raw.trim() || Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_SCHEMA_BYTES) throw new FutrynError('INVALID_INPUT');
    try {
      schema = JSON.parse(raw);
    } catch {
      throw new FutrynError('INVALID_INPUT');
    }
  } else {
    const serialized = JSON.stringify(raw);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_OUTPUT_SCHEMA_BYTES)
      throw new FutrynError('INVALID_INPUT');
    schema = raw;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new FutrynError('INVALID_INPUT');
  const record = schema as Record<string, unknown>;
  if (hasExternalRef(record)) throw new FutrynError('INVALID_INPUT');
  const dialect = typeof record.$schema === 'string' ? record.$schema : '';
  const ajv = dialect.includes('2020-12')
    ? new Ajv2020({strict: false, allErrors: true, validateFormats: false})
    : new Ajv({strict: false, allErrors: true, validateFormats: false});
  let fn: ValidateFunction;
  try {
    fn = ajv.compile(record);
  } catch {
    throw new FutrynError('INVALID_INPUT');
  }
  return {
    schema: record,
    validate(value: unknown) {
      if (fn(value)) return {ok: true};
      const errors = (fn.errors ?? [])
        .slice(0, 5)
        .map(err => `${err.instancePath || '/'} ${err.message ?? 'invalid'}`)
        .join('; ');
      return {ok: false, summary: errors || 'does not match required JSON Schema'};
    },
  };
}

/** Extracts a single JSON value from raw model output (bare JSON or fenced ```json block). */
export function extractStructuredJson(
  text: string,
): {ok: true; value: unknown; canonicalText: string} | {ok: false; reason: string} {
  const trimmed = text.trim();
  if (!trimmed) return {ok: false, reason: 'empty response'};
  const tryParse = (candidate: string) => {
    try {
      const value: unknown = JSON.parse(candidate);
      return {ok: true as const, value, canonicalText: JSON.stringify(value)};
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const fromFence = tryParse(fenced[1].trim());
    if (fromFence) return fromFence;
  }
  return {ok: false, reason: 'response is not valid JSON'};
}
