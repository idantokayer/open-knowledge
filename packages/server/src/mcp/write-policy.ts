import { OPEN_KNOWLEDGE_MCP_WRITE_TOOLS } from '@inkeep/open-knowledge-core';
import type { Config } from '../config/schema.ts';
import type { ConfigOrResolver } from './tools/shared.ts';

/**
 * Read-only mode write policy.
 *
 * This is the degenerate Phase-3 form of a per-principal authorization check.
 * The server has no authentication of its own, so the only input today is the
 * `server.readOnly` config flag (reload:'boot'); the principal is resolved once
 * at tool-registration time. Phase 4 (RBAC) replaces {@link principalFromConfig}
 * with a request-claims reader WITHOUT touching {@link canWrite} or the choke
 * point in tool-logging.ts — that separation is the whole point of the
 * Principal shape.
 */

export type Role = 'reader' | 'writer';

export interface Principal {
  role: Role;
  // Phase 4 adds verified request claims here, e.g.:
  //   subject?: string;
  //   groups?: readonly string[];
  //   claims?: Record<string, unknown>;
}

export interface WriteDecision {
  /** true = the principal may invoke mutating tools. */
  allow: boolean;
  /** Populated only on deny; feeds the refusal message. */
  reason?: string;
}

/** Canonical set of content-mutating MCP tool names (from core). */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(OPEN_KNOWLEDGE_MCP_WRITE_TOOLS);

/**
 * The single write authority. Degenerate today: `role` is the only input.
 * Phase 4 extends the Principal, not this function.
 */
export function canWrite(principal: Principal): WriteDecision {
  return principal.role === 'writer'
    ? { allow: true }
    : { allow: false, reason: 'server is in read-only mode' };
}

/**
 * Resolve the principal from config. `server.readOnly === true` ⇒ reader.
 *
 * `reload:'boot'` means the posture is fixed for the server's lifetime, so
 * resolving once at registration is correct. The real call site
 * (createSessionServer) passes a plain Config. The {@link ConfigOrResolver}
 * union also permits a lazy resolver; a resolver cannot be inspected
 * synchronously here, so we conservatively treat that shape as a writer
 * (stock read-write) rather than silently locking the server. No production
 * path hits that branch today.
 */
export function principalFromConfig(config: ConfigOrResolver): Principal {
  if (typeof config === 'function') return { role: 'writer' };
  return { role: (config as Config).server?.readOnly === true ? 'reader' : 'writer' };
}

/**
 * Is this tool invocation a content mutation?
 *
 * Membership in the canonical write set, PLUS the one argument-conditional
 * case: `lint` is a read tool whose `fix:true` variant mutates the live
 * document. `lint` is deliberately NOT in OPEN_KNOWLEDGE_MCP_WRITE_TOOLS
 * (plain lint is a read), so gating on the set alone would let
 * `lint({ fix:true })` slip through. This predicate closes that gap without
 * blocking plain `lint`.
 */
export function isMutating(name: string, args: unknown): boolean {
  if (WRITE_TOOL_NAMES.has(name)) return true;
  if (name === 'lint' && isPlainObject(args) && args.fix === true) return true;
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Human-facing refusal for a mutating call denied by read-only mode. */
export function readOnlyRefusalMessage(name: string): string {
  return `Error: write refused — the OpenKnowledge server is in read-only mode. The \`${name}\` tool mutates content and is disabled. Read and search tools remain available.`;
}
