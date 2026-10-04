import { OPEN_KNOWLEDGE_MCP_WRITE_TOOLS } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { Config } from '../config/schema.ts';
import {
  canWrite,
  isMutating,
  principalFromConfig,
  readOnlyRefusalMessage,
} from './write-policy.ts';

// A config whose only relevant leaf is server.readOnly. Cast through unknown:
// the policy only reads config.server?.readOnly, so a partial is sufficient
// and keeps the test from re-stating the entire ConfigSchema default tree.
function configWithReadOnly(readOnly: boolean | undefined): Config {
  return { server: readOnly === undefined ? {} : { readOnly } } as unknown as Config;
}

describe('canWrite', () => {
  test('writer is allowed', () => {
    expect(canWrite({ role: 'writer' })).toEqual({ allow: true });
  });

  test('reader is denied with a reason', () => {
    expect(canWrite({ role: 'reader' })).toEqual({
      allow: false,
      reason: 'server is in read-only mode',
    });
  });
});

describe('principalFromConfig', () => {
  test('readOnly:true ⇒ reader', () => {
    expect(principalFromConfig(configWithReadOnly(true))).toEqual({ role: 'reader' });
  });

  test('readOnly:false ⇒ writer', () => {
    expect(principalFromConfig(configWithReadOnly(false))).toEqual({ role: 'writer' });
  });

  test('readOnly absent ⇒ writer (stock)', () => {
    expect(principalFromConfig(configWithReadOnly(undefined))).toEqual({ role: 'writer' });
  });

  test('server block entirely absent ⇒ writer (stock)', () => {
    expect(principalFromConfig({} as unknown as Config)).toEqual({ role: 'writer' });
  });

  test('a resolver-shaped config conservatively resolves to writer (never silently locks)', () => {
    const resolver = async () => configWithReadOnly(true);
    expect(principalFromConfig(resolver)).toEqual({ role: 'writer' });
  });

  test('only strict boolean true locks — a truthy non-true value stays writer', () => {
    const sneaky = { server: { readOnly: 1 } } as unknown as Config;
    expect(principalFromConfig(sneaky)).toEqual({ role: 'writer' });
  });
});

describe('isMutating', () => {
  test('every canonical write tool is mutating', () => {
    for (const name of OPEN_KNOWLEDGE_MCP_WRITE_TOOLS) {
      expect(isMutating(name, {})).toBe(true);
    }
  });

  test('exactly the 8 ratified write tools are gated by name', () => {
    expect([...OPEN_KNOWLEDGE_MCP_WRITE_TOOLS].sort()).toEqual([
      'checkpoint',
      'delete',
      'edit',
      'import',
      'install',
      'move',
      'restore_version',
      'write',
    ]);
  });

  test('lint with fix:true is mutating', () => {
    expect(isMutating('lint', { fix: true })).toBe(true);
  });

  test('plain lint (no fix) is NOT mutating', () => {
    expect(isMutating('lint', {})).toBe(false);
    expect(isMutating('lint', { document: 'x' })).toBe(false);
  });

  test('lint with fix:false / non-true fix is NOT mutating', () => {
    expect(isMutating('lint', { fix: false })).toBe(false);
    expect(isMutating('lint', { fix: 'true' })).toBe(false);
    expect(isMutating('lint', { fix: 1 })).toBe(false);
  });

  test('read tools are never mutating, even with a stray fix:true arg', () => {
    for (const name of [
      'exec',
      'search',
      'links',
      'audit',
      'history',
      'skills',
      'palette',
      'config',
      'preview_url',
      'share_link',
    ]) {
      expect(isMutating(name, { fix: true })).toBe(false);
    }
  });

  test('missing / non-object args never crash the lint predicate', () => {
    expect(isMutating('lint', undefined)).toBe(false);
    expect(isMutating('lint', null)).toBe(false);
    expect(isMutating('lint', 'fix')).toBe(false);
    expect(isMutating('lint', [{ fix: true }])).toBe(false);
  });
});

describe('readOnlyRefusalMessage', () => {
  test('names the tool and is an Error-prefixed message', () => {
    const msg = readOnlyRefusalMessage('write');
    expect(msg.startsWith('Error:')).toBe(true);
    expect(msg).toContain('`write`');
    expect(msg).toContain('read-only mode');
  });
});
