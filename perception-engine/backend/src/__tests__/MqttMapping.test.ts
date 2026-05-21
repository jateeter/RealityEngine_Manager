/**
 * MqttMappingRegistry + MqttBridge tests — verifies AI-side parity with
 * the CPP + LSP implementations.  Schema parsing, topic-filter matching
 * (MQTT + and # wildcards), sensorId template substitution, payload
 * extraction (csv / json pointer / raw), normalization (passthrough,
 * minmax with clamp, linear), length validation, overlap detection, and
 * the in-process bridge dispatcher (no broker — same hatch the CPP/LSP
 * tests use).
 */

import { describe, it, expect } from '@jest/globals';
import { MappingRegistry } from '../MqttMapping.js';
import { MqttBridge, fromEnvironment } from '../MqttBridge.js';
import type { IngestPayload } from '../MqttBridge.js';

function reg(json: string): MappingRegistry {
  return MappingRegistry.fromJson(JSON.parse(json));
}

describe('MappingRegistry — topic-filter matching', () => {
  it('matches exact topics with no captures', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"sensors/temp","region":{"offset":0,"length":1},"extract":{"type":"csv-float"}}]}`);
    const m = r.match('sensors/temp');
    expect(m).not.toBeNull();
    expect(m!.captures).toEqual([]);
    expect(r.match('sensors/humidity')).toBeNull();
  });

  it('captures + wildcards one level at a time', () => {
    const r = reg(`{"mappings":[{"id":"zone","topicFilter":"sensors/zone/+/temp","region":{"offset":0,"length":1},"extract":{"type":"csv-float"}}]}`);
    const m = r.match('sensors/zone/3/temp');
    expect(m).not.toBeNull();
    expect(m!.captures).toEqual(['3']);
    expect(r.match('sensors/zone/3/foo')).toBeNull();
    expect(r.match('sensors/zone/3')).toBeNull();
  });

  it('captures # as the remaining tail', () => {
    const r = reg(`{"mappings":[{"id":"slow","topicFilter":"telemetry/slow/#","region":{"offset":0,"length":1},"extract":{"type":"raw"}}]}`);
    const m = r.match('telemetry/slow/dev-42/pressure');
    expect(m).not.toBeNull();
    expect(m!.captures).toEqual(['dev-42/pressure']);
  });

  it('first matching rule wins', () => {
    const r = reg(`{"mappings":[
      {"id":"specific","topicFilter":"sensors/+/temp","region":{"offset":0,"length":1},"extract":{"type":"csv-float"}},
      {"id":"generic","topicFilter":"sensors/#","region":{"offset":4,"length":1},"extract":{"type":"csv-float"}}
    ]}`);
    expect(r.match('sensors/abc/temp')!.ruleIndex).toBe(0);
  });
});

describe('MappingRegistry — sensorIdTemplate', () => {
  it('interpolates capture indices into the template', () => {
    const r = reg(`{"mappings":[{"id":"z","topicFilter":"sensors/zone/+/temp","sensorIdTemplate":"zone.{1}.temp","region":{"offset":0,"length":1},"extract":{"type":"csv-float"}}]}`);
    const m = r.match('sensors/zone/A1/temp')!;
    expect(r.resolveSensorId(r.rules[m.ruleIndex], 'sensors/zone/A1/temp', m.captures))
      .toBe('zone.A1.temp');
  });

  it('falls back to the topic when template is empty', () => {
    const r = reg(`{"mappings":[{"id":"flat","topicFilter":"sensors/temp","region":{"offset":0,"length":1},"extract":{"type":"csv-float"}}]}`);
    const m = r.match('sensors/temp')!;
    expect(r.resolveSensorId(r.rules[m.ruleIndex], 'sensors/temp', m.captures))
      .toBe('sensors/temp');
  });
});

describe('MappingRegistry — payload extraction', () => {
  it('decodes a single CSV float', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"csv-float"},"normalize":{"mode":"passthrough","clamp":false}}]}`);
    const d = r.decode(r.rules[0], '0.42');
    expect(d.valid).toBe(true);
    expect(d.values).toEqual([0.42]);
  });

  it('decodes a multi-element CSV with whitespace', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":3},"extract":{"type":"csv-float"},"normalize":{"mode":"passthrough","clamp":false}}]}`);
    const d = r.decode(r.rules[0], '0.1, 0.2, 0.3');
    expect(d.valid).toBe(true);
    expect(d.values).toEqual([0.1, 0.2, 0.3]);
  });

  it('picks a single CSV index when extract.index is set', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"csv-float","index":1},"normalize":{"mode":"passthrough","clamp":false}}]}`);
    const d = r.decode(r.rules[0], '10,20,30');
    expect(d.valid).toBe(true);
    expect(d.values).toEqual([20]);
  });

  it('extracts via JSON pointer', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"json","pointer":"/value"},"normalize":{"mode":"passthrough","clamp":false}}]}`);
    const d = r.decode(r.rules[0], '{"value":7.5,"unit":"C"}');
    expect(d.valid).toBe(true);
    expect(d.values).toEqual([7.5]);
  });

  it('extracts via nested JSON pointer', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"json","pointer":"/sensor/reading"},"normalize":{"mode":"passthrough","clamp":false}}]}`);
    const d = r.decode(r.rules[0], '{"sensor":{"reading":42}}');
    expect(d.valid).toBe(true);
    expect(d.values).toEqual([42]);
  });

  it('rejects missing JSON pointer', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"json","pointer":"/missing"},"normalize":{"mode":"passthrough","clamp":false}}]}`);
    const d = r.decode(r.rules[0], '{"value":1}');
    expect(d.valid).toBe(false);
    expect(d.error).toMatch(/not found/);
  });
});

describe('MappingRegistry — normalization', () => {
  it('minmax 50/[0,100] -> 0.5', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"csv-float"},"normalize":{"mode":"minmax","min":0,"max":100,"clamp":true}}]}`);
    const d = r.decode(r.rules[0], '50');
    expect(d.values).toEqual([0.5]);
  });

  it('clamps minmax overflow to 1.0', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"csv-float"},"normalize":{"mode":"minmax","min":0,"max":100,"clamp":true}}]}`);
    const d = r.decode(r.rules[0], '150');
    expect(d.values).toEqual([1.0]);
  });

  it('linear scale + offset', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"csv-float"},"normalize":{"mode":"linear","scale":2,"offset":-1,"clamp":false}}]}`);
    const d = r.decode(r.rules[0], '0.5');
    expect(d.values).toEqual([0]);
  });
});

describe('MappingRegistry — validation', () => {
  it('rejects length mismatch', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":3},"extract":{"type":"csv-float"},"normalize":{"mode":"passthrough","clamp":false}}]}`);
    const d = r.decode(r.rules[0], '1,2');
    expect(d.valid).toBe(false);
    expect(d.error).toMatch(/region\.length/);
  });

  it('rejects non-finite values', () => {
    const r = reg(`{"mappings":[{"id":"a","topicFilter":"t","region":{"offset":0,"length":1},"extract":{"type":"csv-float"},"normalize":{"mode":"passthrough","clamp":false}}]}`);
    const d = r.decode(r.rules[0], 'not-a-number');
    expect(d.valid).toBe(false);
  });

  it('reports overlapping regions', () => {
    const r = reg(`{"mappings":[
      {"id":"a","topicFilter":"x","region":{"offset":0,"length":3},"extract":{"type":"csv-float"}},
      {"id":"b","topicFilter":"y","region":{"offset":2,"length":2},"extract":{"type":"csv-float"}}
    ]}`);
    const warnings = r.validateOverlaps(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"a"');
    expect(warnings[0]).toContain('"b"');
    expect(r.validateOverlaps(true)).toEqual([]);
  });

  it('no warning on adjacent regions', () => {
    const r = reg(`{"mappings":[
      {"id":"a","topicFilter":"x","region":{"offset":0,"length":3},"extract":{"type":"csv-float"}},
      {"id":"b","topicFilter":"y","region":{"offset":3,"length":2},"extract":{"type":"csv-float"}}
    ]}`);
    expect(r.validateOverlaps(false)).toEqual([]);
  });
});

describe('MappingRegistry — fan-out (matchAll)', () => {
  it('returns every rule that matches a shared topic filter, in declaration order', () => {
    const r = reg(`{"mappings":[
      {"id":"temp","topicFilter":"s/x/v1","region":{"offset":0,"length":1},
       "extract":{"type":"json","pointer":"/t"},"normalize":{"mode":"passthrough","clamp":false}},
      {"id":"humid","topicFilter":"s/x/v1","region":{"offset":1,"length":1},
       "extract":{"type":"json","pointer":"/h"},"normalize":{"mode":"passthrough","clamp":false}},
      {"id":"other","topicFilter":"s/y/v1","region":{"offset":2,"length":1},"extract":{"type":"csv-float"}}
    ]}`);
    const all = r.matchAll('s/x/v1');
    expect(all.map(m => m.ruleIndex)).toEqual([0, 1]);
    expect(r.matchAll('s/y/v1')).toHaveLength(1);
    expect(r.matchAll('nothing')).toHaveLength(0);
  });
});

describe('MqttBridge — in-process dispatcher', () => {
  it('drives every rule that shares a topic on a single PUBLISH', () => {
    const r = reg(`{"mappings":[
      {"id":"temp","topicFilter":"s/x/v1","region":{"offset":0,"length":1},
       "extract":{"type":"json","pointer":"/t"},"normalize":{"mode":"passthrough","clamp":false}},
      {"id":"humid","topicFilter":"s/x/v1","region":{"offset":1,"length":1},
       "extract":{"type":"json","pointer":"/h"},"normalize":{"mode":"passthrough","clamp":false}}
    ]}`);
    const ingests: IngestPayload[] = [];
    const bridge = new MqttBridge(
      { brokerUrl: 'mqtt://unreachable:1' }, r,
      p => { ingests.push(p); },
      () => { /* no push */ },
    );
    bridge.injectMessage('s/x/v1', '{"t":0.25,"h":0.75}');
    expect(ingests).toHaveLength(2);
    expect(ingests.map(i => i.mappingId)).toEqual(['temp', 'humid']);
    expect(ingests[0].values).toEqual([0.25]);
    expect(ingests[1].values).toEqual([0.75]);
    expect(bridge.getStats().messagesMapped).toBe(2);
  });
});

describe('MqttBridge — in-process dispatcher (single rule)', () => {
  it('runs the full extract → normalize → ingest pipeline', () => {
    const r = reg(`{"mappings":[{
      "id":"zone-temp","topicFilter":"sensors/zone/+/temp","sensorIdTemplate":"zone.{1}.temp",
      "region":{"offset":0,"length":1},
      "extract":{"type":"json","pointer":"/value"},
      "normalize":{"mode":"minmax","min":0,"max":100,"clamp":true},
      "ttlMs":15000,"pushMode":"immediate"
    }]}`);
    const ingested: IngestPayload[] = [];
    let pushCount = 0;
    const bridge = new MqttBridge(
      { brokerUrl: 'mqtt://unreachable:1' },  // never start()ed
      r,
      p => { ingested.push(p); },
      () => { pushCount += 1; },
    );

    bridge.injectMessage('sensors/zone/3/temp', '{"value":50}');
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      sensorId: 'zone.3.temp', offset: 0, length: 1, values: [0.5], ttlMs: 15000,
    });
    expect(pushCount).toBe(1);

    // Bad payload — length mismatch + bridge counter bumps.
    bridge.injectMessage('sensors/zone/3/temp', '{"missing":1}');
    expect(ingested).toHaveLength(1);
    expect(bridge.getStats().messagesRejected).toBe(1);

    // Unmatched topic — separate counter, no ingest.
    bridge.injectMessage('unknown/topic', '');
    expect(bridge.getStats().messagesUnmatched).toBe(1);
  });

  it('respects acceptRetained=false on retained messages', () => {
    const r = reg(`{"mappings":[{
      "id":"alerts","topicFilter":"alerts/+","region":{"offset":0,"length":1},
      "extract":{"type":"csv-float"},"acceptRetained":false
    }]}`);
    const ingested: IngestPayload[] = [];
    const bridge = new MqttBridge(
      { brokerUrl: 'mqtt://unreachable:1' }, r,
      p => { ingested.push(p); }, () => { /* push noop */ },
    );
    bridge.injectMessage('alerts/oncall', '1', /* retain */ true);
    expect(ingested).toHaveLength(0);
    expect(bridge.getStats().messagesRetainedDropped).toBe(1);
  });
});

describe('MqttBridge.fromEnvironment', () => {
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'MQTT_BROKER_URL', 'MQTT_CLIENT_ID', 'MQTT_USERNAME', 'MQTT_PASSWORD',
    'MQTT_KEEPALIVE', 'MQTT_MAPPINGS_FILE', 'MQTT_MAPPINGS_JSON',
    'MQTT_ALLOW_REGION_OVERLAP',
  ];
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns null when MQTT_BROKER_URL is unset', () => {
    expect(fromEnvironment()).toBeNull();
  });

  it('returns config + registry when broker + inline mappings are set', () => {
    process.env['MQTT_BROKER_URL'] = 'mqtt://localhost:1883';
    process.env['MQTT_MAPPINGS_JSON'] = JSON.stringify({
      mappings: [{
        id: 'a', topicFilter: 'sensors/a',
        region: { offset: 0, length: 1 }, extract: { type: 'csv-float' },
      }],
    });
    const out = fromEnvironment();
    expect(out).not.toBeNull();
    expect(out!.config.brokerUrl).toBe('mqtt://localhost:1883');
    expect(out!.registry.size).toBe(1);
  });

  it('returns null when broker is set but no mappings resolve', () => {
    process.env['MQTT_BROKER_URL'] = 'mqtt://localhost:1883';
    expect(fromEnvironment()).toBeNull();
  });
});
