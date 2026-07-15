import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAllowlistTsSource } from '../shared/parse-allowlist-ts.js';

describe('parseAllowlistTsSource', () => {
  it('parses export const allowlist = { JSON }', () => {
    const src = `export const  allowlist = {
  "boName": "OutsourceStockin",
  "version": "v1",
  "fields": [{ "path": "main.vendorId" }]
}
`;
    const result = parseAllowlistTsSource(src);
    assert.equal(result.ok, true);
    assert.equal(result.config.boName, 'OutsourceStockin');
    assert.equal(result.config.fields.length, 1);
  });

  it('rejects typed or non-json shapes', () => {
    const bad = 'export const allowlist = { boName: "X", fields: [] }';
    const result = parseAllowlistTsSource(bad);
    assert.equal(result.ok, false);
  });
});
