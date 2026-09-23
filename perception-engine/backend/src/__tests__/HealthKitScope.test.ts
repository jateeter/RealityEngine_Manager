import { HealthKitScope } from '../integrations/HealthKitScope.js';

// localHealthkitBridge INGEST_CONTRACT.md, "Scope and resync".
const B = 'healthkit-ios-bridge';
const BP = 'HKCorrelationTypeIdentifierBloodPressure';
const SL = 'HKCategoryTypeIdentifierSleepAnalysis';

describe('HealthKitScope', () => {
  it('is open until the first scope declaration', () => {
    const s = new HealthKitScope();
    expect(s.refusal(B, BP)).toBeNull();
    s.change(B, 'add', [SL], 'pim', 1);
    expect(s.refusal(B, SL)).toBeNull();
    expect(s.refusal(B, BP)).toBe('not-in-scope');
  });

  it('refuses locked types as locked and removed ones as not in scope', () => {
    const s = new HealthKitScope();
    s.change(B, 'lock', [SL], null, 1);
    expect(s.refusal(B, SL)).toBe('locked');
    s.change(B, 'remove', [SL], null, 2);
    expect(s.refusal(B, SL)).toBe('not-in-scope');
  });

  it('reports the sensors a removed type wrote', () => {
    const s = new HealthKitScope();
    s.noteSensor(B, BP, 'healthkit.bp');
    const r = s.change(B, 'remove', [BP], null, 1);
    expect(r.ok && r.removedSensors).toEqual(['healthkit.bp']);
    expect(r.ok && r.body['generation']).toBe(1);
  });

  it('rejects an unknown action and an empty type list', () => {
    const s = new HealthKitScope();
    expect(s.change(B, 'resync', [BP], null, 1).ok).toBe(false);
    expect(s.change(B, 'add', [], null, 1).ok).toBe(false);
  });

  it('refuses a resync of a locked type (409) and accepts an active one (202)', () => {
    const s = new HealthKitScope();
    s.change(B, 'add', [BP], null, 1);
    s.change(B, 'lock', [SL], null, 2);
    expect(s.resync(B, [SL], 'localAIStack', 3, () => 'r0').status).toBe(409);
    const out = s.resync(B, [], 'localAIStack', 3, () => 'r1');
    expect(out.status).toBe(202);
    expect((out.body['request'] as { types: string[] }).types).toEqual([BP]);
  });

  it('marks a resync fulfilled by id', () => {
    const s = new HealthKitScope();
    s.change(B, 'add', [BP], null, 1);
    s.resync(B, [BP], 'localAIStack', 2, () => 'r1');
    s.fulfil(B, 'r1', 3);
    const reqs = s.json(B)['resyncRequests'] as Array<{ state: string; fulfilledAt: number }>;
    expect(reqs[0]).toMatchObject({ state: 'fulfilled', fulfilledAt: 3 });
  });

  it('requires requestedBy', () => {
    expect(new HealthKitScope().resync(B, [], undefined, 1, () => 'x').status).toBe(400);
  });
});
