export function schemaFindings(value, schema, path = '$') {
  if (!schema) return []; const findings = [];
  if (schema.const !== undefined && !deepEqual(value, schema.const)) findings.push(`${path} must equal const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) findings.push(`${path} is not in enum`);
  if (Array.isArray(schema.allOf)) for (const child of schema.allOf) findings.push(...schemaFindings(value, child, path));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => schemaFindings(value, child, path).length === 0)) findings.push(`${path} does not match anyOf`);
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((child) => schemaFindings(value, child, path).length === 0).length !== 1) findings.push(`${path} does not match exactly one oneOf branch`);
  if (schema.not && schemaFindings(value, schema.not, path).length === 0) findings.push(`${path} matches forbidden schema`);
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object`];
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) findings.push(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) findings.push(...schemaFindings(value[key], child, `${path}.${key}`));
    for (const [pattern, child] of Object.entries(schema.patternProperties || {})) for (const [key, item] of Object.entries(value)) if (new RegExp(pattern).test(key)) findings.push(...schemaFindings(item, child, `${path}.${key}`));
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key) && !Object.keys(schema.patternProperties || {}).some((pattern) => new RegExp(pattern).test(key))) findings.push(`${path}.${key} is not allowed`);
    if (Number.isFinite(schema.minProperties) && Object.keys(value).length < schema.minProperties) findings.push(`${path} has fewer than ${schema.minProperties} properties`);
    if (Number.isFinite(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) findings.push(`${path} has more than ${schema.maxProperties} properties`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) findings.push(`${path} has fewer than ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) findings.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) findings.push(`${path} items must be unique`);
    for (const [index, item] of value.entries()) findings.push(...schemaFindings(item, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') findings.push(`${path} must be a string`);
    else { if (Number.isFinite(schema.minLength) && value.length < schema.minLength) findings.push(`${path} is shorter than ${schema.minLength}`); if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) findings.push(`${path} is longer than ${schema.maxLength}`); if (schema.pattern && !new RegExp(schema.pattern).test(value)) findings.push(`${path} does not match pattern`); }
  } else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) findings.push(`${path} must be a number`);
  else if (schema.type === 'integer' && !Number.isInteger(value)) findings.push(`${path} must be an integer`);
  else if (schema.type === 'boolean' && typeof value !== 'boolean') findings.push(`${path} must be a boolean`);
  else if (schema.type === 'null' && value !== null) findings.push(`${path} must be null`);
  if (['number', 'integer'].includes(schema.type) && typeof value === 'number') { if (Number.isFinite(schema.minimum) && value < schema.minimum) findings.push(`${path} is below minimum`); if (Number.isFinite(schema.maximum) && value > schema.maximum) findings.push(`${path} is above maximum`); if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) findings.push(`${path} is not above exclusiveMinimum`); if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) findings.push(`${path} is not below exclusiveMaximum`); if (Number.isFinite(schema.multipleOf) && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) findings.push(`${path} is not a multipleOf ${schema.multipleOf}`); }
  return findings;
}
function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
