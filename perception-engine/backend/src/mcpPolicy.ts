/**
 * MCP policy gating.
 *
 * Mutating MCP tools (anything that creates/modifies sources, drives the
 * engine, or fires a dispatch) check a capability token against an
 * operator-supplied allow-list.  The intent is to make a misconfigured
 * shared MCP server safe-by-default in production while keeping local
 * dev frictionless.
 *
 *   MCP_POLICY_ENFORCE   `true`  → enforce; mutating tools require a
 *                                  capability listed in MCP_POLICY_ALLOW.
 *                        unset/`false` → legacy behaviour (no gating).
 *   MCP_POLICY_ALLOW     comma-separated capability tokens.  The wildcard
 *                        token `mutate` permits every mutating tool.
 *                        Finer-grained tokens: `sources.write`,
 *                        `engine.control`, `trigger.dispatch`,
 *                        `dispatch.write`.
 *
 * The helper returns a structured `{ ok: true } | { ok: false, error }`
 * so tool wrappers can short-circuit with a typed error response that
 * matches the MCP error contract.
 */

const WILDCARD = 'mutate';

export interface PolicyConfig {
  enforce: boolean;
  allow: Set<string>;
}

export type PolicyCheck =
  | { ok: true }
  | { ok: false; status: 403; error: string; capability: string };

export function loadPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const raw = (env['MCP_POLICY_ENFORCE'] ?? '').toLowerCase();
  const enforce = raw === 'true' || raw === '1' || raw === 'yes';
  const allow = new Set<string>();
  for (const tok of (env['MCP_POLICY_ALLOW'] ?? '').split(',')) {
    const trimmed = tok.trim();
    if (trimmed !== '') allow.add(trimmed);
  }
  return { enforce, allow };
}

/**
 * Returns `{ok:true}` for read-only tools always, and for mutating tools
 * only when enforcement is off OR the requested capability is in the
 * allow-list (or `mutate` is present as a wildcard).
 */
export function checkPolicy(
  policy: PolicyConfig,
  meta: { mutates: boolean; capability?: string },
): PolicyCheck {
  if (!meta.mutates) return { ok: true };
  if (!policy.enforce) return { ok: true };
  if (policy.allow.has(WILDCARD)) return { ok: true };
  const cap = meta.capability ?? 'mutate';
  if (policy.allow.has(cap)) return { ok: true };
  return {
    ok: false,
    status: 403,
    capability: cap,
    error:
      `MCP policy: capability "${cap}" not in MCP_POLICY_ALLOW.  ` +
      `Set MCP_POLICY_ALLOW="${cap}" (or "${WILDCARD}" for any mutating tool) ` +
      `to enable this call.`,
  };
}

/** Convenience: error response shaped for MCP tool returns. */
export function policyErrorResult(check: Extract<PolicyCheck, { ok: false }>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: check.error, capability: check.capability }) }],
    isError: true as const,
  };
}
