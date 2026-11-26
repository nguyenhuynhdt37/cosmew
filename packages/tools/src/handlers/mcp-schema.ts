import Ajv, {type ValidateFunction} from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

const MAX_INPUT_BYTES = 8192;
const MAX_INLINED_BYTES = 16384;
const MAX_NODES = 512;
const MAX_DEPTH = 16;
const MAX_REF_DEPTH = 8;
const MAX_FORMAT_LENGTH = 64;
const MAX_PATTERN_LENGTH = 256;

const FORBIDDEN_KEYWORDS = new Set(['$dynamicRef', '$recursiveRef', '$async', 'patternProperties', 'contains']);
const LOCAL_REF_RE = /^#\/(\$defs|definitions)\/((?:[A-Za-z0-9_.-]|~[01])+)$/;
const REF_SIBLING_ANNOTATIONS = new Set([
  'title',
  'description',
  'default',
  'examples',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const SCHEMA_MAP_KEYS = new Set(['properties', 'definitions', '$defs', 'dependentSchemas']);
const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_CHILD_KEYS = new Set([
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'propertyNames',
  'contentSchema',
  'not',
  'if',
  'then',
  'else',
]);

type SchemaMap = Record<string, unknown>;

function isPlainObject(value: unknown): value is SchemaMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwnProp(target: SchemaMap, key: string, value: unknown): void {
  Object.defineProperty(target, key, {value, enumerable: true, writable: true, configurable: true});
}

function assertBounds(root: unknown, maxNodes: number, maxDepth: number): void {
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth) throw new Error('schema bound');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(root, 0);
}

/** Reject backreferences, lookarounds, and nested/alternating quantifiers that can cause ReDoS. */
export function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return false;
  try {
    new RegExp(pattern, 'u');
  } catch {
    return false;
  }

  let inCharClass = false;
  const groupStack: {hasQuantifier: boolean; hasAlternation: boolean}[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) return false;
      if (!inCharClass) {
        if (next >= '1' && next <= '9') return false;
        if (next === 'k' && pattern[i + 2] === '<') return false;
      }
      if ((next === 'p' || next === 'P' || next === 'u') && pattern[i + 2] === '{') {
        const close = pattern.indexOf('}', i + 3);
        if (close === -1) return false;
        i = close;
        continue;
      }
      i++;
      continue;
    }

    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }

    if (ch === '[') {
      inCharClass = true;
      continue;
    }

    if (ch === '(') {
      if (pattern[i + 1] === '?') {
        const p2 = pattern[i + 2];
        if (p2 === '=' || p2 === '!') return false;
        if (p2 === '<' && (pattern[i + 3] === '=' || pattern[i + 3] === '!')) return false;
        if (p2 === ':') {
          groupStack.push({hasQuantifier: false, hasAlternation: false});
          i += 2;
          continue;
        }
        if (p2 === '<') {
          const close = pattern.indexOf('>', i + 3);
          if (close === -1) return false;
          groupStack.push({hasQuantifier: false, hasAlternation: false});
          i = close;
          continue;
        }
        return false;
      }
      groupStack.push({hasQuantifier: false, hasAlternation: false});
      continue;
    }

    if (ch === ')') {
      const frame = groupStack.pop();
      if (!frame) return false;
      const next = pattern[i + 1];
      const hasPostfixQuantifier = next === '*' || next === '+' || next === '?' || next === '{';
      if (hasPostfixQuantifier && (frame.hasQuantifier || frame.hasAlternation)) return false;
      const parent = groupStack[groupStack.length - 1];
      if (parent) {
        if (hasPostfixQuantifier || frame.hasQuantifier) parent.hasQuantifier = true;
        if (frame.hasAlternation) parent.hasAlternation = true;
      }
      continue;
    }

    if (ch === '|') {
      const current = groupStack[groupStack.length - 1];
      if (current) current.hasAlternation = true;
      continue;
    }

    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      const current = groupStack[groupStack.length - 1];
      if (current) current.hasQuantifier = true;
    }
  }

  return !inCharClass && groupStack.length === 0;
}

function parseLocalRef(
  ref: unknown,
  defs: SchemaMap | undefined,
  definitions: SchemaMap | undefined,
): {key: string; target: SchemaMap | boolean} | undefined {
  if (typeof ref !== 'string') return;
  const match = LOCAL_REF_RE.exec(ref);
  if (!match) return;
  const section = match[1] as '$defs' | 'definitions';
  const name = match[2]!.replace(/~1/g, '/').replace(/~0/g, '~');
  const container = section === '$defs' ? defs : definitions;
  if (!container || !Object.hasOwn(container, name)) return;
  const target = container[name];
  if (!isPlainObject(target) && typeof target !== 'boolean') return;
  return {key: `${section}:${name}`, target};
}

/** Visit every child schema position (never argument names or annotation/enum data). */
function forEachChildSchema(schema: SchemaMap, visit: (child: unknown) => void): void {
  for (const [key, item] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      if (isPlainObject(item)) for (const child of Object.values(item)) visit(child);
    } else if (key === 'dependencies') {
      if (isPlainObject(item)) {
        for (const child of Object.values(item)) {
          if (!Array.isArray(child)) visit(child);
        }
      }
    } else if (key === 'items') {
      if (Array.isArray(item)) for (const child of item) visit(child);
      else visit(item);
    } else if (SCHEMA_ARRAY_KEYS.has(key)) {
      if (Array.isArray(item)) for (const child of item) visit(child);
    } else if (SCHEMA_CHILD_KEYS.has(key)) {
      visit(item);
    }
  }
}

function checkSchema(
  value: unknown,
  context: {allowLocalRef: boolean; defs?: SchemaMap; definitions?: SchemaMap},
): void {
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    // Only schema positions contain keywords. Argument names and annotation/enum data do not.
    if (FORBIDDEN_KEYWORDS.has(key)) throw new Error('unsupported schema feature');
    if (key === '$ref') {
      if (!context.allowLocalRef || !parseLocalRef(item, context.defs, context.definitions)) {
        throw new Error('unsupported schema feature');
      }
    } else if (key === 'format') {
      if (typeof item !== 'string' || item.length > MAX_FORMAT_LENGTH) throw new Error('unsupported schema feature');
    } else if (key === 'uniqueItems') {
      if (typeof item !== 'boolean') throw new Error('unsupported schema feature');
    } else if (key === 'pattern') {
      if (typeof item !== 'string' || !isSafeRegexPattern(item)) throw new Error('unsupported schema feature');
    }
  }
  forEachChildSchema(value, child => checkSchema(child, context));
}

function verifyDefinitionRefs(defs: SchemaMap | undefined, definitions: SchemaMap | undefined): void {
  const visiting = new Set<string>();
  const memo = new Map<string, number>();

  const maxNodeRefDepth = (value: unknown): number => {
    if (!isPlainObject(value)) return 0;
    let max = 0;
    if (Object.hasOwn(value, '$ref')) {
      const resolved = parseLocalRef(value.$ref, defs, definitions);
      if (!resolved) throw new Error('unsupported $ref');
      max = Math.max(max, 1 + defDepth(resolved.key, resolved.target));
    }
    forEachChildSchema(value, child => {
      max = Math.max(max, maxNodeRefDepth(child));
    });
    return max;
  };

  const defDepth = (key: string, target: SchemaMap | boolean): number => {
    if (visiting.has(key)) throw new Error('cyclic $ref');
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    visiting.add(key);
    const depth = maxNodeRefDepth(target);
    visiting.delete(key);
    if (depth > MAX_REF_DEPTH) throw new Error('max $ref depth exceeded');
    memo.set(key, depth);
    return depth;
  };

  if (defs) {
    for (const [name, target] of Object.entries(defs)) {
      if (isPlainObject(target) || typeof target === 'boolean') defDepth(`$defs:${name}`, target);
    }
  }
  if (definitions) {
    for (const [name, target] of Object.entries(definitions)) {
      if (isPlainObject(target) || typeof target === 'boolean') defDepth(`definitions:${name}`, target);
    }
  }
}

function dereferenceSchemaNode(
  value: unknown,
  context: {
    defs?: SchemaMap;
    definitions?: SchemaMap;
    is2020: boolean;
    state: {ops: number};
  },
  refStack: Set<string>,
  depth: number,
  isRoot: boolean,
): unknown {
  if (++context.state.ops > MAX_NODES * 2 || depth > MAX_DEPTH) throw new Error('schema bound');
  if (typeof value === 'boolean' || !isPlainObject(value)) return structuredClone(value);

  if (Object.hasOwn(value, '$ref')) {
    const resolved = parseLocalRef(value.$ref, context.defs, context.definitions);
    if (!resolved) throw new Error('unsupported $ref');
    if (refStack.has(resolved.key)) throw new Error('cyclic $ref');
    if (refStack.size + 1 > MAX_REF_DEPTH) throw new Error('max $ref depth exceeded');

    const nextStack = new Set(refStack);
    nextStack.add(resolved.key);
    const derefTarget = dereferenceSchemaNode(resolved.target, context, nextStack, depth, false);

    const annotations: SchemaMap = {};
    const otherKeywords: SchemaMap = {};
    let hasAnnotations = false;
    let hasOtherKeywords = false;

    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' || (isRoot && (key === '$defs' || key === 'definitions'))) continue;
      if (REF_SIBLING_ANNOTATIONS.has(key)) {
        setOwnProp(annotations, key, structuredClone(item));
        hasAnnotations = true;
      } else {
        setOwnProp(otherKeywords, key, item);
        hasOtherKeywords = true;
      }
    }

    if (hasOtherKeywords) {
      if (!context.is2020) throw new Error('unsupported $ref sibling keywords');
      const derefOthers = dereferenceSchemaNode(otherKeywords, context, refStack, depth + 2, false);
      const out: SchemaMap = {};
      if (hasAnnotations) {
        for (const [key, item] of Object.entries(annotations)) setOwnProp(out, key, item);
      }
      if (derefTarget === true) {
        if (isPlainObject(derefOthers)) {
          for (const [key, item] of Object.entries(derefOthers)) {
            if (!Object.hasOwn(out, key)) setOwnProp(out, key, item);
          }
        }
        return out;
      }
      if (
        isPlainObject(derefTarget) &&
        isPlainObject(derefOthers) &&
        Object.hasOwn(derefTarget, 'type') &&
        !Object.hasOwn(derefOthers, 'type')
      ) {
        setOwnProp(derefOthers, 'type', structuredClone(derefTarget.type));
      }
      setOwnProp(out, 'allOf', [derefTarget, derefOthers]);
      return out;
    }

    if (typeof derefTarget === 'boolean') {
      if (!hasAnnotations) return derefTarget;
      const out: SchemaMap = derefTarget ? {} : {not: {}};
      for (const [key, item] of Object.entries(annotations)) setOwnProp(out, key, item);
      return out;
    }

    if (!isPlainObject(derefTarget)) return derefTarget;
    const out: SchemaMap = {};
    for (const [key, item] of Object.entries(derefTarget)) setOwnProp(out, key, item);
    if (hasAnnotations) {
      for (const [key, item] of Object.entries(annotations)) setOwnProp(out, key, item);
    }
    return out;
  }

  const out: SchemaMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (isRoot && (key === '$defs' || key === 'definitions')) continue;
    if (SCHEMA_MAP_KEYS.has(key)) {
      if (isPlainObject(item)) {
        if (depth + 1 > MAX_DEPTH) throw new Error('schema bound');
        const mapOut: SchemaMap = {};
        for (const [propKey, child] of Object.entries(item)) {
          setOwnProp(mapOut, propKey, dereferenceSchemaNode(child, context, refStack, depth + 2, false));
        }
        setOwnProp(out, key, mapOut);
      } else {
        setOwnProp(out, key, structuredClone(item));
      }
    } else if (key === 'dependencies') {
      if (isPlainObject(item)) {
        if (depth + 1 > MAX_DEPTH) throw new Error('schema bound');
        const mapOut: SchemaMap = {};
        for (const [propKey, child] of Object.entries(item)) {
          setOwnProp(
            mapOut,
            propKey,
            Array.isArray(child)
              ? structuredClone(child)
              : dereferenceSchemaNode(child, context, refStack, depth + 2, false),
          );
        }
        setOwnProp(out, key, mapOut);
      } else {
        setOwnProp(out, key, structuredClone(item));
      }
    } else if (key === 'items') {
      if (Array.isArray(item)) {
        if (depth + 1 > MAX_DEPTH) throw new Error('schema bound');
        setOwnProp(
          out,
          key,
          item.map(child => dereferenceSchemaNode(child, context, refStack, depth + 2, false)),
        );
      } else {
        setOwnProp(out, key, dereferenceSchemaNode(item, context, refStack, depth + 1, false));
      }
    } else if (SCHEMA_ARRAY_KEYS.has(key)) {
      if (Array.isArray(item)) {
        if (depth + 1 > MAX_DEPTH) throw new Error('schema bound');
        setOwnProp(
          out,
          key,
          item.map(child => dereferenceSchemaNode(child, context, refStack, depth + 2, false)),
        );
      } else {
        setOwnProp(out, key, structuredClone(item));
      }
    } else if (SCHEMA_CHILD_KEYS.has(key)) {
      setOwnProp(out, key, dereferenceSchemaNode(item, context, refStack, depth + 1, false));
    } else {
      setOwnProp(out, key, structuredClone(item));
    }
  }
  return out;
}

/** Remote schemas are untrusted. Bound compilation and refuse expensive/recursive features. */
export function mcpValidator(schema: Record<string, unknown>): ValidateFunction | undefined {
  try {
    if (!isPlainObject(schema) || schema.type !== 'object') return;
    const encoded = JSON.stringify(schema);
    if (Buffer.byteLength(encoded) > MAX_INPUT_BYTES) return;

    const cloned = JSON.parse(encoded) as SchemaMap;
    assertBounds(cloned, MAX_NODES, MAX_DEPTH);

    const defs = isPlainObject(cloned.$defs) ? cloned.$defs : undefined;
    const definitions = isPlainObject(cloned.definitions) ? cloned.definitions : undefined;
    const is2020 =
      cloned.$schema === 'https://json-schema.org/draft/2020-12/schema' ||
      cloned.$schema === 'https://json-schema.org/draft/2020-12/schema#';

    checkSchema(cloned, {allowLocalRef: true, defs, definitions});
    verifyDefinitionRefs(defs, definitions);

    const inlined = dereferenceSchemaNode(cloned, {defs, definitions, is2020, state: {ops: 0}}, new Set(), 0, true);
    if (!isPlainObject(inlined)) return;
    if (Buffer.byteLength(JSON.stringify(inlined)) > MAX_INLINED_BYTES) return;
    assertBounds(inlined, MAX_NODES, MAX_DEPTH);
    checkSchema(inlined, {allowLocalRef: false});

    // Preserve dialect semantics: never strip $schema to compile newer schemas as draft-07.
    const Validator = is2020 ? Ajv2020 : Ajv;
    const ajv = new Validator({
      strict: true,
      allErrors: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      validateFormats: false,
      loopRequired: 32,
      loopEnum: 32,
    });
    return ajv.compile(inlined);
  } catch {
    return;
  }
}
