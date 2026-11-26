/**
 * An instance's clocks, as the Visualizer shows them (RealityEngine_CI#600, Manager#293).
 *
 * Each engine instance is two Lamport clock participants, its RE and its PE.
 * `GET /api/engine/:id/clock` on the Manager backend returns each one's clock
 * at its newest committed step: `lamport` (the full Lamport clock), `commit`
 * (committed steps) and `step` (resets on reset; -1 before the first step).
 */

export interface ParticipantClock {
  instance: string;
  lamport: number;
  commit: number;
  step: number;
}

export interface InstanceClocks {
  id: string;
  re: ParticipantClock | null;
  pe: ParticipantClock | null;
}

function isClock(c: unknown): c is ParticipantClock {
  const o = c as Record<string, unknown> | null;
  return !!o && typeof o.instance === 'string' && ['lamport', 'commit', 'step'].every(k => Number.isInteger(o[k]));
}

/** `L 7232531 · c 412 · s 38`, `s —` before the first step; `—` for no clock. */
export function formatClock(c: unknown): string {
  if (!isClock(c)) return '—';
  return `L ${c.lamport} · c ${c.commit} · s ${c.step < 0 ? '—' : c.step}`;
}

/** The clock line under an instance: `RE <clock>  PE <clock>`. */
export function formatInstanceClocks(c: Partial<InstanceClocks> | null | undefined): string {
  return `RE ${formatClock(c?.re)}   PE ${formatClock(c?.pe)}`;
}

/** The participant UUIDs, for a tooltip. */
export function clockTitle(c: Partial<InstanceClocks> | null | undefined): string {
  const re = isClock(c?.re) ? c!.re!.instance : 'no clock';
  const pe = isClock(c?.pe) ? c!.pe!.instance : 'no clock';
  return `RE ${re}\nPE ${pe}\nLamport clocks at each participant's newest committed step (RealityEngine_CI#600)`;
}
