// The K-line panel's engine side (RealityEngine_Manager#372, RealityEngine_CI#603):
// each instance's two halves, read and switched through the engines' own
// control APIs. Manager holds no copy of a control; every write is read back.
//
//   RE half: klineCapture, klineFeedbackHops, klineStoreMaxBytes on
//            /api/engine/config; the store at /api/klines/*.
//   PE half: isreCapture, isreStoreMaxBytes on PATCH /api/config; the store at
//            /api/isre-composition/*.
//
// A half that does not serve these is `unsupported` (a conformance follower
// that does not capture yet), never `off`.

export const VOTERS = ['cpp', 'lsp', 'scala'] as const;
export const RE_KNOBS = { klineFeedbackHops: { min: 0, max: 16, default: 3 }, klineStoreMaxBytes: { min: 0, max: 9007199254740991, default: 2147483648 } } as const;
export const PE_KNOBS = { isreStoreMaxBytes: { min: 0, max: 9007199254740991, default: 2147483648 } } as const;
export type Knob = keyof typeof RE_KNOBS | keyof typeof PE_KNOBS;

export interface Instance { id: string; runtime: string; re_url: string; pe_url?: string; status?: string; role?: string }
export interface Reply { status: number; data: any }
/** The calls the panel makes; axios in production, a fake in tests. */
export interface Http {
  get(url: string): Promise<Reply>;
  put(url: string, body: unknown): Promise<Reply>;
  patch(url: string, body: unknown): Promise<Reply>;
  delete(url: string): Promise<Reply>;
  postText(url: string, body: unknown): Promise<{ status: number; text: string }>;
}

export interface ReHalf {
  supported: boolean;
  capture?: boolean;
  feedbackHops?: number;
  storeMaxBytes?: number;
  stats?: { segments: number; bytes: number; budget: number; warnings: string[]; byOutcome: Record<string, number> };
  open?: number;
  commit?: number;
  error?: string;
}
export interface PeHalf {
  supported: boolean;
  capture?: boolean;
  storeMaxBytes?: number;
  taxonomy?: string | null;
  stats?: { segments: number; bytes: number; budget: number; warnings: string[]; records: number };
  error?: string;
}
export interface InstanceStatus {
  id: string;
  runtime: string;
  role: 'voter' | 'follower';
  re: ReHalf;
  pe: PeHalf;
}

const trim = (u: string) => u.replace(/\/+$/, '');

export function roleOf(inst: Instance): 'voter' | 'follower' {
  return inst.role === 'follower' || !(VOTERS as readonly string[]).includes(inst.runtime) ? 'follower' : 'voter';
}

function controlValue(controls: any[], name: string): any {
  return controls.find((c: any) => c?.name === name)?.value;
}

export async function reHalf(http: Http, inst: Instance): Promise<ReHalf> {
  const re = trim(inst.re_url);
  try {
    const cfg = await http.get(`${re}/api/engine/config`);
    const controls: any[] = Array.isArray(cfg.data?.controls) ? cfg.data.controls : [];
    if (cfg.status !== 200 || controlValue(controls, 'klineCapture') === undefined) return { supported: false };
    const [stats, open] = await Promise.all([http.get(`${re}/api/klines/stats`), http.get(`${re}/api/klines/open`)]);
    return {
      supported: true,
      capture: controlValue(controls, 'klineCapture') === true,
      feedbackHops: controlValue(controls, 'klineFeedbackHops'),
      storeMaxBytes: controlValue(controls, 'klineStoreMaxBytes'),
      stats: stats.status === 200 ? stats.data : undefined,
      open: open.status === 200 && Array.isArray(open.data?.open) ? open.data.open.length : undefined,
      commit: open.status === 200 ? open.data?.commit : undefined,
    };
  } catch (e: any) {
    return { supported: false, error: `unreachable: ${e?.message ?? e}` };
  }
}

export async function peHalf(http: Http, inst: Instance): Promise<PeHalf> {
  if (!inst.pe_url) return { supported: false };
  try {
    const stats = await http.get(`${trim(inst.pe_url)}/api/isre-composition/stats`);
    if (stats.status !== 200 || typeof stats.data?.isreCapture !== 'boolean') return { supported: false };
    return {
      supported: true,
      capture: stats.data.isreCapture,
      storeMaxBytes: stats.data.budget,
      taxonomy: stats.data.taxonomy ?? null,
      stats: stats.data,
    };
  } catch (e: any) {
    return { supported: false, error: `unreachable: ${e?.message ?? e}` };
  }
}

export async function instanceStatus(http: Http, inst: Instance): Promise<InstanceStatus> {
  const [re, pe] = await Promise.all([reHalf(http, inst), peHalf(http, inst)]);
  return { id: inst.id, runtime: inst.runtime, role: roleOf(inst), re, pe };
}

export interface WriteResult { id: string; ok: boolean; errors: string[]; status: InstanceStatus }

/** Both halves on or off together, then read back. A half that does not
 * capture is left alone and named; a refusal is reported, never retried. */
export async function setCapture(http: Http, inst: Instance, on: boolean): Promise<WriteResult> {
  const before = await instanceStatus(http, inst);
  const errors: string[] = [];
  if (before.re.supported) {
    const r = await http.put(`${trim(inst.re_url)}/api/engine/config/klineCapture`, { value: on });
    if (r.status !== 200) errors.push(`RE klineCapture ${r.status}: ${r.data?.error ?? ''}`.trim());
  }
  if (before.pe.supported && inst.pe_url) {
    const r = await http.patch(`${trim(inst.pe_url)}/api/config`, { isreCapture: on });
    if (r.status !== 200) errors.push(`PE isreCapture ${r.status}: ${r.data?.error ?? ''}`.trim());
  }
  const status = await instanceStatus(http, inst);
  if (before.re.supported && status.re.capture !== on) errors.push(`RE reads klineCapture ${status.re.capture}`);
  if (before.pe.supported && status.pe.capture !== on) errors.push(`PE reads isreCapture ${status.pe.capture}`);
  return { id: inst.id, ok: errors.length === 0, errors, status };
}

export function validKnob(knob: string, value: unknown): string | null {
  const spec = (RE_KNOBS as any)[knob] ?? (PE_KNOBS as any)[knob];
  if (!spec) return `unknown knob ${knob}`;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max) {
    return `${knob} requires a whole number in [${spec.min}, ${spec.max}]`;
  }
  return null;
}

/** Set a knob (VALUE) or restore its declared default (VALUE null), then read back. */
export async function setKnob(http: Http, inst: Instance, knob: Knob, value: number | null): Promise<WriteResult> {
  const errors: string[] = [];
  if (knob in RE_KNOBS) {
    const url = `${trim(inst.re_url)}/api/engine/config/${knob}`;
    const r = value === null ? await http.delete(url) : await http.put(url, { value });
    if (r.status !== 200) errors.push(`RE ${knob} ${r.status}: ${r.data?.error ?? ''}`.trim());
  } else if (inst.pe_url) {
    const v = value === null ? PE_KNOBS.isreStoreMaxBytes.default : value;
    const r = await http.patch(`${trim(inst.pe_url)}/api/config`, { [knob]: v });
    if (r.status !== 200) errors.push(`PE ${knob} ${r.status}: ${r.data?.error ?? ''}`.trim());
  } else {
    errors.push(`${inst.id} has no PE`);
  }
  const status = await instanceStatus(http, inst);
  const expected = value ?? ((RE_KNOBS as any)[knob] ?? (PE_KNOBS as any)[knob]).default;
  const read = knob === 'klineFeedbackHops' ? status.re.feedbackHops
    : knob === 'klineStoreMaxBytes' ? status.re.storeMaxBytes : status.pe.storeMaxBytes;
  if (errors.length === 0 && read !== expected) errors.push(`${knob} reads ${read}, not ${expected}`);
  return { id: inst.id, ok: errors.length === 0, errors, status };
}

/** Every page of a commit-paged list. */
export async function paged(http: Http, url: string, cursorKey: 'since' | 'from', listKey: 'klines' | 'records',
                            start: number, end?: number): Promise<any[]> {
  const out: any[] = [];
  let at: number | null = start;
  while (at !== null) {
    const extra = end !== undefined && cursorKey === 'from' ? `&to=${end}` : '';
    const r = await http.get(`${url}?${cursorKey}=${at}&limit=1000${extra}`);
    if (r.status !== 200) throw new Error(`GET ${url}: ${r.status}`);
    out.push(...(r.data?.[listKey] ?? []));
    at = r.data?.next ?? null;
    if (end !== undefined && at !== null && at > end) break;
  }
  return out;
}
