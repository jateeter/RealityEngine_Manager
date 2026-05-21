/**
 * machineDomains - Classify machines into domains-of-effect.
 *
 * Mirrors the Reality Engine visualizer's classifier so the Perception Engine
 * UI shows consistent domain labels and colors when filtering machines.
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
  color: string;
}

export const DOMAINS: Record<DomainId, DomainDef> = {
  healthservices: { id: 'healthservices', label: 'Health Services', short: 'HS', color: '#22c55e' },
  lifebalance: { id: 'lifebalance', label: 'Life Balance', short: 'LB', color: '#ec4899' },
  healthpersonal: { id: 'healthpersonal', label: 'Personal Health', short: 'PH', color: '#14b8a6' },
  builtspace: { id: 'builtspace', label: 'Built Space / WELL', short: 'BS', color: '#6366f1' },
  transportation: { id: 'transportation', label: 'Transportation', short: 'TR', color: '#f97316' },
  legalservices: { id: 'legalservices', label: 'Legal Services', short: 'LS', color: '#eab308' },
  communityservices: { id: 'communityservices', label: 'Community Services', short: 'CS', color: '#0ea5e9' },
  agriculture: { id: 'agriculture', label: 'Agriculture', short: 'Ag', color: '#84cc16' },
  datacenter: { id: 'datacenter', label: 'Data Center', short: 'DC', color: '#f59e0b' },
  digitallogic: { id: 'digitallogic', label: 'Digital Logic', short: 'DL', color: '#06b6d4' },
  ai: { id: 'ai', label: 'AI Infrastructure', short: 'AI', color: '#a855f7' },
  general: { id: 'general', label: 'General', short: 'Gen', color: '#94a3b8' },
};

export const DOMAIN_ORDER: DomainId[] = [
  'healthservices', 'lifebalance', 'healthpersonal', 'builtspace',
  'transportation', 'legalservices', 'communityservices', 'agriculture',
  'datacenter', 'digitallogic', 'ai', 'general',
];

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

interface MinimalMachine {
  id?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, any>;
}

const anyKeyword = (haystack: string, keywords: string[]): boolean => {
  const h = haystack.toLowerCase();
  for (const k of keywords) if (h.includes(k)) return true;
  return false;
};

export function classifyMachine(m: MinimalMachine): DomainId {
  const id = (m.id ?? '').toLowerCase();
  const name = (m.name ?? '').toLowerCase();
  const meta = m.metadata ?? {};
  const category = (meta.category ?? '').toString().toLowerCase();
  const metaDomain = (meta.domain ?? '').toString().toLowerCase();
  const tags: string[] = Array.isArray(meta.tags)
    ? meta.tags.map(t => String(t).toLowerCase())
    : [];

  if (category === 'health-services') return 'healthservices';
  if (category === 'life-balance') return 'lifebalance';
  if (category === 'health-personal' || category === 'elder-care' || category === 'eldercare' || category === 'healthcare') return 'healthpersonal';
  if (category === 'built-space') return 'builtspace';
  if (category === 'transportation') return 'transportation';
  if (category === 'legal-services') return 'legalservices';
  if (category === 'community-services' || category === 'social-services' || category === 'community-care') return 'communityservices';
  if (category === 'agriculture' || category === 'indoor-growing' || category === 'crop-management' || category === 'hydroponics') return 'agriculture';
  if (category === 'data-center' || category === 'datacenter' || category === 'monitoring' || category === 'ai-infrastructure') return 'datacenter';
  if (category === 'digital-logic' || category === 'state-machine' || category === 'pattern-matching') return 'digitallogic';
  if (category === 'ai-services' || category === 'ai-pipeline' || category === 'ai') return 'ai';

  if (name.startsWith('dc') || id.startsWith('dc')) return 'datacenter';
  if (name.startsWith('ai') || id.startsWith('ai') || id.startsWith('localai/')) return 'ai';
  if (name.startsWith('ag') || id.startsWith('ag')) return 'agriculture';

  const tables: Array<[string[], DomainId]> = [
    [HEALTH_KEYWORDS, 'healthservices'],
    [LIFE_BALANCE_KEYWORDS, 'lifebalance'],
    [HEALTH_PERSONAL_KEYWORDS, 'healthpersonal'],
    [BUILT_SPACE_KEYWORDS, 'builtspace'],
    [TRANSPORTATION_KEYWORDS, 'transportation'],
    [LEGAL_KEYWORDS, 'legalservices'],
    [CS_KEYWORDS, 'communityservices'],
    [AG_KEYWORDS, 'agriculture'],
    [DC_KEYWORDS, 'datacenter'],
    [DL_KEYWORDS, 'digitallogic'],
    [AI_KEYWORDS, 'ai'],
  ];

  if (metaDomain) {
    for (const [kws, d] of tables) if (anyKeyword(metaDomain, kws)) return d;
  }
  for (const t of tags) {
    for (const [kws, d] of tables) if (anyKeyword(t, kws)) return d;
  }
  const desc = (m.description ?? '').toLowerCase();
  if (desc) {
    for (const [kws, d] of tables) if (anyKeyword(desc, kws)) return d;
  }
  return 'general';
}
