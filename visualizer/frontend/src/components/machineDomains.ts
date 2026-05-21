/**
 * machineDomains - Classify machines into domains-of-effect.
 *
 * Powers domain-aware layout, coloring, and filtering across visualizer
 * components (interconnection graph, input strip, legend).
 *
 * Classification signals (first match wins):
 *   1. metadata.category         (enum match; explicit author override)
 *   2. id prefix / name prefix  (e.g. "localai/", "DC", "AI")
 *   3. metadata.domain free-text (substring match against a keyword table)
 *   4. metadata.tags             (any match against a keyword table)
 */

export type DomainId =
  | 'healthservices'
  | 'healthpersonal'
  | 'lifebalance'
  | 'builtspace'
  | 'transportation'
  | 'legalservices'
  | 'communityservices'
  | 'agriculture'
  | 'datacenter'
  | 'digitallogic'
  | 'ai'
  | 'general';

export interface DomainDef {
  id: DomainId;
  label: string;
  short: string;
  // Ring color on node borders + legend swatch
  color: string;
  // Soft fill (hex with alpha suffix) used for cluster hull backgrounds
  fill: string;
  // Where this domain's cluster gravitates (unit coords; 0..1 × width/height)
  anchor: { x: number; y: number };
  description: string;
}

// 4×3 grid layout (4 cols × 3 rows):
//   x = 0.125 | 0.375 | 0.625 | 0.875
//   y = 0.20  | 0.50  | 0.80
// Each domain occupies one cell; the MachineInterconnectionGraph clamps
// node positions to per-cell bounding boxes so domain hulls are disjoint.
export const DOMAINS: Record<DomainId, DomainDef> = {
  healthservices: {
    id: 'healthservices',
    label: 'Health Services',
    short: 'HS',
    color: '#22c55e',
    fill: 'rgba(34, 197, 94, 0.05)',
    anchor: { x: 0.125, y: 0.20 },
    description: 'Public health systems, community care delivery, health program evaluation',
  },
  lifebalance: {
    id: 'lifebalance',
    label: 'Life Balance',
    short: 'LB',
    color: '#ec4899',
    fill: 'rgba(236, 72, 153, 0.05)',
    anchor: { x: 0.375, y: 0.20 },
    description: 'Lifestyle medicine, psychiatric care, nutrition, sleep, CGM, metabolic health',
  },
  healthpersonal: {
    id: 'healthpersonal',
    label: 'Personal Health',
    short: 'PH',
    color: '#14b8a6',
    fill: 'rgba(20, 184, 166, 0.05)',
    anchor: { x: 0.625, y: 0.20 },
    description: 'Home health, assisted living, elder care, care transitions',
  },
  builtspace: {
    id: 'builtspace',
    label: 'Built Space / WELL',
    short: 'BS',
    color: '#6366f1',
    fill: 'rgba(99, 102, 241, 0.05)',
    anchor: { x: 0.875, y: 0.20 },
    description: 'WELL Building Standard operations — air, water, light, thermal, acoustics, occupant health',
  },
  transportation: {
    id: 'transportation',
    label: 'Transportation',
    short: 'TR',
    color: '#f97316',
    fill: 'rgba(249, 115, 22, 0.05)',
    anchor: { x: 0.125, y: 0.50 },
    description: 'Transit fleet operations — dispatch, charging, depot, rider experience, workforce',
  },
  legalservices: {
    id: 'legalservices',
    label: 'Legal Services',
    short: 'LS',
    color: '#eab308',
    fill: 'rgba(234, 179, 8, 0.05)',
    anchor: { x: 0.375, y: 0.50 },
    description: 'IP portfolio, patent filing, trademark, copyright, legal operations',
  },
  communityservices: {
    id: 'communityservices',
    label: 'Community Services',
    short: 'CS',
    color: '#0ea5e9',
    fill: 'rgba(14, 165, 233, 0.05)',
    anchor: { x: 0.625, y: 0.50 },
    description: 'Benefits eligibility, case management, service delivery, community outreach',
  },
  agriculture: {
    id: 'agriculture',
    label: 'Agriculture',
    short: 'Ag',
    color: '#84cc16',
    fill: 'rgba(132, 204, 22, 0.05)',
    anchor: { x: 0.875, y: 0.50 },
    description: 'Indoor growing, aquaculture, irrigation, crop steering, IPM, harvest',
  },
  datacenter: {
    id: 'datacenter',
    label: 'Data Center',
    short: 'DC',
    color: '#f59e0b',
    fill: 'rgba(245, 158, 11, 0.05)',
    anchor: { x: 0.125, y: 0.80 },
    description: 'DC monitoring, cooling, power, network, storage, SRE, change management',
  },
  digitallogic: {
    id: 'digitallogic',
    label: 'Digital Logic',
    short: 'DL',
    color: '#06b6d4',
    fill: 'rgba(6, 182, 212, 0.05)',
    anchor: { x: 0.375, y: 0.80 },
    description: 'Digital logic primitives — flip-flops, Kleene patterns, regular expressions, ASIC patterns',
  },
  ai: {
    id: 'ai',
    label: 'AI Infrastructure',
    short: 'AI',
    color: '#a855f7',
    fill: 'rgba(168, 85, 247, 0.06)',
    anchor: { x: 0.625, y: 0.80 },
    description: 'AI model serving, capacity throttling, cooling, power, RAG routing, inference infra',
  },
  general: {
    id: 'general',
    label: 'General',
    short: 'Gen',
    color: '#94a3b8',
    fill: 'rgba(148, 163, 184, 0.05)',
    anchor: { x: 0.875, y: 0.80 },
    description: 'Unclassified or multi-domain machines',
  },
};

// Per-cell half-extents (as fractions of canvas) — sized so each domain's
// bounding box fits inside its grid cell with a small inter-cell gap.
// 4×3 grid: x-spacing = 0.25, y-spacing = 0.30.
// Half-extents leave ~0.04 horiz and ~0.04 vert as gap between adjacent cells.
export const DOMAIN_BOX_HALF = { x: 0.105, y: 0.130 };

export const DOMAIN_ORDER: DomainId[] = [
  'healthservices', 'lifebalance', 'healthpersonal', 'builtspace',
  'transportation', 'legalservices', 'communityservices', 'agriculture',
  'datacenter', 'digitallogic', 'ai', 'general',
];

// ── Keyword tables (all lowercase; matched against lowercased input) ──────────

const HEALTH_KEYWORDS = [
  'health-services', 'health services', 'public-health', 'public health',
  'community-health', 'community health', 'evaluability', 'maternal',
];

const HEALTH_PERSONAL_KEYWORDS = [
  'elder-care', 'eldercare', 'health-personal', 'assisted living',
  'home health', 'care transition', 'residential', 'clinical',
  'patient', 'healthcare', 'facilitiesmaintenance', 'facilities-maintenance',
];

const LIFE_BALANCE_KEYWORDS = [
  'life-balance', 'life balance', 'lifestyle-psychiatry', 'lifestyle psychiatry',
  'metabolic-health', 'metabolic health', 'cgm', 'nutrition', 'sleep-circadian',
  'adolescent-psychiatry', 'temperament',
];

const BUILT_SPACE_KEYWORDS = [
  'built-space', 'built space', 'well-building', 'well building', 'occupant',
  'biophilia', 'thermal-comfort', 'air-quality', 'acoustics',
];

const TRANSPORTATION_KEYWORDS = [
  'transportation', 'transit', 'fleet', 'bus', 'rider', 'depot',
  'public-transit', 'public transit',
];

const LEGAL_KEYWORDS = [
  'legal-services', 'legal services', 'intellectual-property', 'intellectual property',
  'patent', 'trademark', 'copyright', 'ip-portfolio', 'ip portfolio',
];

const AG_KEYWORDS = [
  'agriculture', 'agricultural', 'indoor growing', 'indoor farm', 'greenhouse',
  'hydroponics', 'irrigation', 'nutrient solution', 'photosynthesis', 'photoperiod',
  'harvest', 'crop', 'plant growth', 'zone temperature', 'atmospheric co2',
  'pest', 'ipm', 'yield optimization', 'grow cycle', 'growing system', 'aquaculture',
];

const CS_KEYWORDS = [
  'community services', 'community-services', 'social services', 'social-services',
  'benefits eligibility', 'case management', 'caseworker', 'service delivery',
  'community outreach', 'referral network', 'qualification workflow', 'document signing',
  'enrollment coordination', 'snap', 'liheap', 'community access', 'intake assessment',
];

const DC_KEYWORDS = [
  'data center', 'data-center', 'datacenter', 'cooling', 'power efficiency',
  'network burst', 'network throttle', 'memory pressure',
  'memory alert', 'critical alert', 'dccriticalsynthesizer',
];

const DL_KEYWORDS = [
  'digital-logic', 'digital logic', 'state-machine', 'state machine',
  'pattern-matching', 'pattern matching', 'flipflop', 'flip-flop',
  'kleene', 'multistep', 'rs flipflop', 'rs2', 'asic', 'regular-expression',
  'logical-infrastructure', 'logical infrastructure',
];

const AI_KEYWORDS = [
  'localai', 'ai-pipeline', 'ai infrastructure', 'ai model', 'rag',
  'langgraph', 'llm', 'inference', 'corrective-rag', 'agent context',
  'session rag', 'session agent', 'ai capacity', 'ai cooling', 'ai hardware',
  'ai power', 'ai security', 'ai-services',
];

// ── Shape ────────────────────────────────────────────────────────────────────

export interface ClassifiedMachine {
  domain: DomainId;
  isExternal: boolean;
  reason: string;
}

interface MinimalMachine {
  id?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, any>;
}

// ── Classification ───────────────────────────────────────────────────────────

const anyKeyword = (haystack: string, keywords: string[]): string | null => {
  const h = haystack.toLowerCase();
  for (const k of keywords) if (h.includes(k)) return k;
  return null;
};

export function classifyMachine(m: MinimalMachine): ClassifiedMachine {
  const id = (m.id ?? '').toLowerCase();
  const name = (m.name ?? '').toLowerCase();
  const meta = m.metadata ?? {};
  const category = (meta.category ?? '').toString().toLowerCase();
  const metaDomain = (meta.domain ?? '').toString().toLowerCase();
  const author = (meta.author ?? '').toString().toLowerCase();
  const tags: string[] = Array.isArray(meta.tags)
    ? meta.tags.map(t => String(t).toLowerCase())
    : [];

  const isExternal =
    id.startsWith('localai/') ||
    name.startsWith('localai/') ||
    author.includes('localaistack');

  // 1) metadata.category — explicit author override (most reliable signal)
  if (category === 'health-services')
    return { domain: 'healthservices', isExternal, reason: `category=${category}` };
  if (category === 'life-balance')
    return { domain: 'lifebalance', isExternal, reason: `category=${category}` };
  if (category === 'health-personal' || category === 'elder-care' || category === 'eldercare' || category === 'healthcare')
    return { domain: 'healthpersonal', isExternal, reason: `category=${category}` };
  if (category === 'built-space')
    return { domain: 'builtspace', isExternal, reason: `category=${category}` };
  if (category === 'transportation')
    return { domain: 'transportation', isExternal, reason: `category=${category}` };
  if (category === 'legal-services')
    return { domain: 'legalservices', isExternal, reason: `category=${category}` };
  if (category === 'community-services' || category === 'social-services' || category === 'community-care')
    return { domain: 'communityservices', isExternal, reason: `category=${category}` };
  if (category === 'agriculture' || category === 'indoor-growing' || category === 'crop-management' || category === 'hydroponics')
    return { domain: 'agriculture', isExternal, reason: `category=${category}` };
  if (category === 'data-center' || category === 'datacenter' || category === 'monitoring' || category === 'ai-infrastructure')
    return { domain: 'datacenter', isExternal, reason: `category=${category}` };
  if (category === 'digital-logic' || category === 'state-machine' || category === 'pattern-matching')
    return { domain: 'digitallogic', isExternal, reason: `category=${category}` };
  if (category === 'ai-services' || category === 'ai-pipeline' || category === 'ai')
    return { domain: 'ai', isExternal, reason: `category=${category}` };

  // 2) Strong id/name prefixes
  if (name.startsWith('dc') || id.startsWith('dc'))
    return { domain: 'datacenter', isExternal, reason: 'id/name prefix "DC"' };
  if (name.startsWith('ai') || id.startsWith('ai') || id.startsWith('localai/'))
    return { domain: 'ai', isExternal, reason: 'id/name prefix "AI"/"localai"' };
  if (name.startsWith('ag') || id.startsWith('ag'))
    return { domain: 'agriculture', isExternal, reason: 'id/name prefix "Ag"' };

  // 3) metadata.domain free-text match
  if (metaDomain) {
    if (anyKeyword(metaDomain, HEALTH_KEYWORDS))
      return { domain: 'healthservices', isExternal, reason: `metadata.domain ~ healthservices` };
    if (anyKeyword(metaDomain, LIFE_BALANCE_KEYWORDS))
      return { domain: 'lifebalance', isExternal, reason: `metadata.domain ~ lifebalance` };
    if (anyKeyword(metaDomain, HEALTH_PERSONAL_KEYWORDS))
      return { domain: 'healthpersonal', isExternal, reason: `metadata.domain ~ healthpersonal` };
    if (anyKeyword(metaDomain, BUILT_SPACE_KEYWORDS))
      return { domain: 'builtspace', isExternal, reason: `metadata.domain ~ builtspace` };
    if (anyKeyword(metaDomain, TRANSPORTATION_KEYWORDS))
      return { domain: 'transportation', isExternal, reason: `metadata.domain ~ transportation` };
    if (anyKeyword(metaDomain, LEGAL_KEYWORDS))
      return { domain: 'legalservices', isExternal, reason: `metadata.domain ~ legalservices` };
    if (anyKeyword(metaDomain, CS_KEYWORDS))
      return { domain: 'communityservices', isExternal, reason: `metadata.domain ~ communityservices` };
    if (anyKeyword(metaDomain, AG_KEYWORDS))
      return { domain: 'agriculture', isExternal, reason: `metadata.domain ~ agriculture` };
    if (anyKeyword(metaDomain, DC_KEYWORDS))
      return { domain: 'datacenter', isExternal, reason: `metadata.domain ~ datacenter` };
    if (anyKeyword(metaDomain, DL_KEYWORDS))
      return { domain: 'digitallogic', isExternal, reason: `metadata.domain ~ digitallogic` };
    if (anyKeyword(metaDomain, AI_KEYWORDS))
      return { domain: 'ai', isExternal, reason: `metadata.domain ~ ai` };
  }

  // 4) tags
  for (const t of tags) {
    if (anyKeyword(t, HEALTH_KEYWORDS))
      return { domain: 'healthservices', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, LIFE_BALANCE_KEYWORDS))
      return { domain: 'lifebalance', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, HEALTH_PERSONAL_KEYWORDS))
      return { domain: 'healthpersonal', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, BUILT_SPACE_KEYWORDS))
      return { domain: 'builtspace', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, TRANSPORTATION_KEYWORDS))
      return { domain: 'transportation', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, LEGAL_KEYWORDS))
      return { domain: 'legalservices', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, CS_KEYWORDS))
      return { domain: 'communityservices', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, AG_KEYWORDS))
      return { domain: 'agriculture', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, DC_KEYWORDS))
      return { domain: 'datacenter', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, DL_KEYWORDS))
      return { domain: 'digitallogic', isExternal, reason: `tag=${t}` };
    if (anyKeyword(t, AI_KEYWORDS))
      return { domain: 'ai', isExternal, reason: `tag=${t}` };
  }

  // 5) description fallback
  const desc = (m.description ?? '').toLowerCase();
  if (anyKeyword(desc, HEALTH_KEYWORDS))
    return { domain: 'healthservices', isExternal, reason: 'description ~ healthservices' };
  if (anyKeyword(desc, LIFE_BALANCE_KEYWORDS))
    return { domain: 'lifebalance', isExternal, reason: 'description ~ lifebalance' };
  if (anyKeyword(desc, HEALTH_PERSONAL_KEYWORDS))
    return { domain: 'healthpersonal', isExternal, reason: 'description ~ healthpersonal' };
  if (anyKeyword(desc, BUILT_SPACE_KEYWORDS))
    return { domain: 'builtspace', isExternal, reason: 'description ~ builtspace' };
  if (anyKeyword(desc, TRANSPORTATION_KEYWORDS))
    return { domain: 'transportation', isExternal, reason: 'description ~ transportation' };
  if (anyKeyword(desc, LEGAL_KEYWORDS))
    return { domain: 'legalservices', isExternal, reason: 'description ~ legalservices' };
  if (anyKeyword(desc, CS_KEYWORDS))
    return { domain: 'communityservices', isExternal, reason: 'description ~ communityservices' };
  if (anyKeyword(desc, AG_KEYWORDS))
    return { domain: 'agriculture', isExternal, reason: 'description ~ agriculture' };
  if (anyKeyword(desc, DC_KEYWORDS))
    return { domain: 'datacenter', isExternal, reason: 'description ~ datacenter' };
  if (anyKeyword(desc, DL_KEYWORDS))
    return { domain: 'digitallogic', isExternal, reason: 'description ~ digitallogic' };
  if (anyKeyword(desc, AI_KEYWORDS))
    return { domain: 'ai', isExternal, reason: 'description ~ ai' };

  return { domain: 'general', isExternal, reason: 'unclassified fallback' };
}

export function domainColor(domain: DomainId): string {
  return DOMAINS[domain].color;
}

export function domainFill(domain: DomainId): string {
  return DOMAINS[domain].fill;
}

export function domainLabel(domain: DomainId): string {
  return DOMAINS[domain].label;
}
