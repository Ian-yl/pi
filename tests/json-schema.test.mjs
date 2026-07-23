import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaFindings } from '../scripts/lib/json-schema.mjs';

test('shared schema validator enforces advanced constraints used by operation receipts', () => {
  const schema = {
    type: 'object',
    minProperties: 2,
    maxProperties: 3,
    required: ['values', 'count'],
    properties: {
      values: { type: 'array', uniqueItems: true, items: { not: { type: 'null' } } },
      count: { type: 'number', multipleOf: 2, exclusiveMinimum: 0, exclusiveMaximum: 10 }
    },
    patternProperties: { '^x-': { type: 'string', minLength: 2 } },
    additionalProperties: false
  };

  assert.deepEqual(schemaFindings({ values: [1, 2], count: 4, 'x-note': 'ok' }, schema), []);
  const findings = schemaFindings({ values: [null, null], count: 3, 'x-note': 'x', extra: true }, schema);
  for (const fragment of ['more than 3 properties', 'items must be unique', 'matches forbidden schema', 'not a multipleOf 2', 'shorter than 2', 'is not allowed']) {
    assert.ok(findings.some((finding) => finding.includes(fragment)), `missing finding: ${fragment}`);
  }
});
