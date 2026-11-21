import Ajv, {type ValidateFunction} from 'ajv';

/** Remote schemas are untrusted. Bound compilation and refuse expensive/recursive features. */
export function mcpValidator(schema: Record<string, unknown>): ValidateFunction | undefined {
  try {
    if (schema.type !== 'object' || Buffer.byteLength(JSON.stringify(schema)) > 8192) return;
    let nodes = 0;
    const walk = (value: unknown, depth: number): void => {
      if (++nodes > 512 || depth > 16) throw new Error('schema bound');
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, depth + 1);
        return;
      }
      for (const item of Object.values(value)) walk(item, depth + 1);
    };
    walk(schema, 0);
    const checkSchema = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [key, item] of Object.entries(value)) {
        // Only schema positions contain keywords. Argument names and annotation/enum data do not.
        if (
          [
            '$ref',
            '$dynamicRef',
            '$recursiveRef',
            '$async',
            'pattern',
            'patternProperties',
            'format',
            'uniqueItems',
            'contains',
          ].includes(key)
        )
          throw new Error('unsupported schema feature');
        if (['properties', 'definitions', '$defs', 'dependentSchemas', 'dependencies'].includes(key)) {
          if (item && typeof item === 'object' && !Array.isArray(item))
            for (const child of Object.values(item)) checkSchema(child);
        } else if (['allOf', 'anyOf', 'oneOf', 'items'].includes(key) && Array.isArray(item)) {
          for (const child of item) checkSchema(child);
        } else if (
          ['items', 'additionalItems', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else'].includes(
            key,
          )
        ) {
          checkSchema(item);
        }
      }
    };
    checkSchema(schema);
    const ajv = new Ajv({
      strict: true,
      allErrors: false,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      validateFormats: false,
      loopRequired: 32,
      loopEnum: 32,
    });
    const validate = ajv.compile(schema);
    return validate;
  } catch {
    return;
  }
}
