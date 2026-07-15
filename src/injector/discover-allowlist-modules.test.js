import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isAllowlistConfigShape,
  moduleIdMatchesBoAllowlist,
  unwrapAllowlistExports
} from './discover-allowlist-modules.js';

describe('discover-allowlist-modules', () => {
  it('matches path-style module ids to boName for .allowlist.ts', () => {
    assert.equal(
      moduleIdMatchesBoAllowlist(
        './src/controller/outsource/outsource-stockin/state/outsourceStockin.allowlist.ts',
        'OutsourceStockin'
      ),
      true
    );
    assert.equal(
      moduleIdMatchesBoAllowlist('outsourceIssue.allowlist.ts', 'OutsourceIssue'),
      true
    );
    assert.equal(moduleIdMatchesBoAllowlist('12345', 'OutsourceStockin'), false);
    assert.equal(
      moduleIdMatchesBoAllowlist('outsourceIssue.allowlist.ts', 'OutsourceStockin'),
      false
    );
  });

  it('unwraps named export allowlist and default', () => {
    const config = {
      boName: 'OutsourceStockin',
      version: 'v1',
      fields: [{ path: 'main.vendorId' }]
    };
    assert.deepEqual(unwrapAllowlistExports(config), config);
    assert.deepEqual(unwrapAllowlistExports({ allowlist: config }), config);
    assert.deepEqual(unwrapAllowlistExports({ exports: { allowlist: config } }), config);
    assert.deepEqual(unwrapAllowlistExports({ default: { allowlist: config } }), config);
    assert.equal(isAllowlistConfigShape({ allowlist: config }), true);
    assert.equal(isAllowlistConfigShape({ foo: 1 }), false);
  });
});
