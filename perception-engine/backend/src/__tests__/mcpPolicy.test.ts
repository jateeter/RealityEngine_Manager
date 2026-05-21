/**
 * mcpPolicy — env parsing + gating decisions.
 *
 * Covers Phase 5 acceptance: a mutating call without the right
 * capability returns a typed 403-style error; read-only tools never
 * block; the `mutate` wildcard permits everything.
 */

import { describe, expect, it } from '@jest/globals';

import {
  checkPolicy, loadPolicyFromEnv, policyErrorResult,
} from '../mcpPolicy.js';

describe('loadPolicyFromEnv', () => {
  it('defaults to enforce:false with an empty allow-list', () => {
    const p = loadPolicyFromEnv({});
    expect(p.enforce).toBe(false);
    expect(p.allow.size).toBe(0);
  });

  it('honours MCP_POLICY_ENFORCE = true|1|yes (case-insensitive)', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'YeS']) {
      expect(loadPolicyFromEnv({ MCP_POLICY_ENFORCE: v }).enforce).toBe(true);
    }
    for (const v of ['', 'false', '0', 'no', 'on']) {
      expect(loadPolicyFromEnv({ MCP_POLICY_ENFORCE: v }).enforce).toBe(false);
    }
  });

  it('parses MCP_POLICY_ALLOW as comma-separated tokens', () => {
    const p = loadPolicyFromEnv({ MCP_POLICY_ALLOW: 'sources.write, engine.control ,trigger.dispatch' });
    expect(p.allow.has('sources.write')).toBe(true);
    expect(p.allow.has('engine.control')).toBe(true);
    expect(p.allow.has('trigger.dispatch')).toBe(true);
    expect(p.allow.has('mutate')).toBe(false);
  });
});

describe('checkPolicy', () => {
  it('always allows read-only tools', () => {
    const p = loadPolicyFromEnv({ MCP_POLICY_ENFORCE: 'true' });
    expect(checkPolicy(p, { mutates: false }).ok).toBe(true);
  });

  it('allows mutating tools when enforcement is off (legacy default)', () => {
    const p = loadPolicyFromEnv({});
    expect(checkPolicy(p, { mutates: true, capability: 'sources.write' }).ok).toBe(true);
  });

  it('blocks mutating tools when enforced and no matching capability', () => {
    const p = loadPolicyFromEnv({ MCP_POLICY_ENFORCE: 'true', MCP_POLICY_ALLOW: 'dispatch.write' });
    const r = checkPolicy(p, { mutates: true, capability: 'sources.write' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.capability).toBe('sources.write');
      expect(r.error).toMatch(/MCP_POLICY_ALLOW/);
    }
  });

  it('permits the exact capability when listed', () => {
    const p = loadPolicyFromEnv({ MCP_POLICY_ENFORCE: 'true', MCP_POLICY_ALLOW: 'sources.write' });
    expect(checkPolicy(p, { mutates: true, capability: 'sources.write' }).ok).toBe(true);
  });

  it('treats "mutate" as a wildcard for any mutating tool', () => {
    const p = loadPolicyFromEnv({ MCP_POLICY_ENFORCE: 'true', MCP_POLICY_ALLOW: 'mutate' });
    expect(checkPolicy(p, { mutates: true, capability: 'sources.write' }).ok).toBe(true);
    expect(checkPolicy(p, { mutates: true, capability: 'trigger.dispatch' }).ok).toBe(true);
  });

  it('falls back to capability="mutate" when none is provided', () => {
    const p = loadPolicyFromEnv({ MCP_POLICY_ENFORCE: 'true', MCP_POLICY_ALLOW: 'mutate' });
    expect(checkPolicy(p, { mutates: true }).ok).toBe(true);

    const strict = loadPolicyFromEnv({ MCP_POLICY_ENFORCE: 'true', MCP_POLICY_ALLOW: 'sources.write' });
    const r = checkPolicy(strict, { mutates: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.capability).toBe('mutate');
  });
});

describe('policyErrorResult', () => {
  it('returns an MCP-shaped tool error result', () => {
    const p = loadPolicyFromEnv({ MCP_POLICY_ENFORCE: 'true' });
    const decision = checkPolicy(p, { mutates: true, capability: 'sources.write' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      const r = policyErrorResult(decision);
      expect(r.isError).toBe(true);
      expect(r.content[0]?.type).toBe('text');
      const body = JSON.parse(r.content[0]!.text);
      expect(body.capability).toBe('sources.write');
      expect(typeof body.error).toBe('string');
    }
  });
});
