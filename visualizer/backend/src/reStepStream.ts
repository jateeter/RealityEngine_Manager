/**
 * Reading one frame of an RE's `GET /api/engine/stream` (#250).
 *
 * SURFACE_SPEC ("Streaming events") defines the frame as
 * `{ "type": "step-result", "step": { ... } }`. The runtimes do not agree:
 *
 * - LSP sends exactly that envelope;
 * - C++ and Scala send the bare step object (`stepNumber`, `machineResults`,
 *   ...), with no envelope.
 *
 * This read only the bare form, so every LSP step reached the browser as an
 * object with no `machineResults` and no `stepNumber`, and the CES graphs showed
 * no activity on LSP at all, without an error anywhere. Both forms are accepted
 * here; which form the runtimes should send is an engine-contract question, not
 * one the Manager can settle by preferring one runtime's shape.
 */

/** A step as the RE reports it. Only the fields the Manager reads are typed. */
export interface REStep {
  stepNumber?: number;
  machineResults?: Record<string, unknown>;
  [key: string]: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The step carried by one SSE `data:` payload, or null when the payload is not
 * a step: malformed JSON, another event type, or an object with no step fields.
 */
export function parseStepFrame(payload: string): REStep | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  // The specified envelope.
  if (parsed.type === 'step-result') {
    return isObject(parsed.step) ? (parsed.step as REStep) : null;
  }
  // Some other event type on the same stream: not a step.
  if (typeof parsed.type === 'string') return null;

  // The bare step (C++, Scala).
  if ('stepNumber' in parsed || 'machineResults' in parsed) return parsed as REStep;
  return null;
}
