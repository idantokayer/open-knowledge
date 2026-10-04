import {
  applyConfigOverlay,
  ConfigSchema,
  resolveEnvConfigLayer,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { Config } from '../config/schema.ts';
import { canWrite, principalFromConfig } from './write-policy.ts';

/**
 * Wiring test for the OK_READ_ONLY read-only gate.
 *
 * The blind spot this closes: write-policy.test.ts feeds principalFromConfig a
 * config that ALREADY has server.readOnly:true, so it never exercised the real
 * path the server runs at boot:
 *
 *   process.env (OK_READ_ONLY=1)
 *     -> resolveEnvConfigLayer(env).layer           (core/env-layer.ts)
 *     -> applyConfigOverlay(fileConfig, layer)       (-> envConfig)
 *     -> that envConfig is forwarded to the MCP gate (start.ts line ~702)
 *     -> principalFromConfig(envConfig)              (write-policy.ts)
 *
 * The dead-gate defect was that OK_READ_ONLY never reached the gate; a suite
 * that only hand-sets readOnly:true could stay green while the env var did
 * nothing. These tests reproduce the actual env->overlay->gate seam, so they
 * go red if the env layer stops mapping OK_READ_ONLY onto server.readOnly or
 * stops reaching the resolved config.
 *
 * A realistic "file/default config" baseline — ConfigSchema.parse({}) — which
 * ships server.readOnly:false (stock read-write). The overlay must flip it.
 */

/** The config the server would hold with no env overrides: stock read-write. */
function defaultConfig(): Config {
  return ConfigSchema.parse({}) as unknown as Config;
}

/** Reproduce start.ts: file/default config overlaid with the env layer. */
function envConfigFor(env: Record<string, string | undefined>): Config {
  const { layer } = resolveEnvConfigLayer(env);
  return applyConfigOverlay(defaultConfig(), layer) as unknown as Config;
}

describe('OK_READ_ONLY env → resolved-config overlay (the real wiring)', () => {
  test('baseline: a default config is read-write (nothing locks it by accident)', () => {
    const config = defaultConfig();
    expect(config.server?.readOnly).toBe(false);
    expect(principalFromConfig(config)).toEqual({ role: 'writer' });
  });

  test("OK_READ_ONLY='1' overlays server.readOnly:true onto the resolved config", () => {
    const { layer } = resolveEnvConfigLayer({ OK_READ_ONLY: '1' });
    // The env layer carries the right path with real boolean coercion…
    expect(layer).toEqual({ server: { readOnly: true } });
    // …and overlaying it onto a default (readOnly:false) config flips the leaf.
    const config = envConfigFor({ OK_READ_ONLY: '1' });
    expect(config.server?.readOnly).toBe(true);
  });

  test("OK_READ_ONLY='1' end-to-end: the gate resolves a READER and refuses writes", () => {
    const config = envConfigFor({ OK_READ_ONLY: '1' });
    const principal = principalFromConfig(config);
    expect(principal).toEqual({ role: 'reader' });
    expect(canWrite(principal)).toEqual({
      allow: false,
      reason: 'server is in read-only mode',
    });
  });

  test("OK_READ_ONLY='true' is coerced the same way (reader, writes refused)", () => {
    const config = envConfigFor({ OK_READ_ONLY: 'true' });
    expect(config.server?.readOnly).toBe(true);
    expect(canWrite(principalFromConfig(config)).allow).toBe(false);
  });

  test("OK_READ_ONLY='0' leaves the server read-write (gate resolves a WRITER)", () => {
    const config = envConfigFor({ OK_READ_ONLY: '0' });
    expect(config.server?.readOnly).toBe(false);
    expect(principalFromConfig(config)).toEqual({ role: 'writer' });
    expect(canWrite(principalFromConfig(config))).toEqual({ allow: true });
  });

  test('no OK_READ_ONLY in the environment ⇒ stock read-write (gate resolves a WRITER)', () => {
    const config = envConfigFor({});
    expect(config.server?.readOnly).toBe(false);
    expect(principalFromConfig(config)).toEqual({ role: 'writer' });
  });

  test('the env overlay does not clobber the rest of the resolved config', () => {
    // Guards the overlay seam itself: flipping readOnly must leave sibling
    // server defaults (bind, allowExternal) intact, so this stays a wiring
    // test and not an accidental assertion about a stubbed object.
    const config = envConfigFor({ OK_READ_ONLY: '1' });
    expect(config.server?.readOnly).toBe(true);
    expect(config.server?.allowExternal).toBe(false);
    expect(Array.isArray(config.server?.bind)).toBe(true);
  });
});
