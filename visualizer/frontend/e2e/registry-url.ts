import fs from 'node:fs';
import path from 'node:path';

/**
 * Where is the instance registry? The same order as RealityEngine_CI's
 * scripts/lib/registry-url.sh:
 *
 *   1. RE_REGISTRY_URL, when set.
 *   2. RealityEngine_CI/.universe-registry-url — startUniverse.sh writes the
 *      address the running universe serves there; stopUniverse.sh removes it.
 *   3. http://127.0.0.1:${RE_REGISTRY_PORT:-5999}/re-registry.json.
 *
 * 5999 is the shim's port only with fixed ports. Under --free-ports it is
 * OS-assigned, and these specs, falling back from RE_REGISTRY_URL straight to
 * a literal :5999, looked for the registry where nothing listened.
 */
// RealityEngine_CI, a sibling of RealityEngine_Manager. Playwright runs from
// visualizer/frontend, so the workspace root is three levels up.
const CI_DIR = process.env.RE_CI_DIR
  ?? path.resolve(process.cwd(), '..', '..', '..', 'RealityEngine_CI');

export function registryUrl(): string {
  const env = process.env.RE_REGISTRY_URL?.trim();
  if (env) return env;
  try {
    const recorded = fs.readFileSync(path.join(CI_DIR, '.universe-registry-url'), 'utf8')
      .split('\n')[0].trim();
    if (recorded) return recorded;
  } catch {
    // No universe has recorded an address: fall through to the default.
  }
  return `http://127.0.0.1:${process.env.RE_REGISTRY_PORT ?? '5999'}/re-registry.json`;
}
