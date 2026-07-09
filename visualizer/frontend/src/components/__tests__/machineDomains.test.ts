import { describe, it, expect } from 'vitest';
import {
  portalNodeId, isPortalNode, getNodeRole, OPENCLAW_NODE_ID,
  classifyMachine,
} from '../machineDomains';

describe('portalNodeId', () => {
  it('generates a stable id for a domain', () => {
    expect(portalNodeId('healthservices')).toBe('__openclaw_portal_healthservices__');
    expect(portalNodeId('agriculture')).toBe('__openclaw_portal_agriculture__');
  });

  it('ids are different per domain', () => {
    expect(portalNodeId('healthservices')).not.toBe(portalNodeId('transportation'));
  });
});

describe('isPortalNode', () => {
  it('returns true for portal node ids', () => {
    expect(isPortalNode(portalNodeId('healthservices'))).toBe(true);
    expect(isPortalNode(portalNodeId('datacenter'))).toBe(true);
  });

  it('returns false for the old global openclaw node', () => {
    expect(isPortalNode(OPENCLAW_NODE_ID)).toBe(false);
  });

  it('returns false for regular machine ids', () => {
    expect(isPortalNode('some-machine-id')).toBe(false);
    expect(isPortalNode('dc-thermal')).toBe(false);
  });
});

describe('getNodeRole', () => {
  it('returns agent-dispatcher for machines with agent-dispatcher tag', () => {
    const m = {
      name: 'Health Services Test Agent Dispatcher',
      metadata: { tags: ['agent-dispatcher', 'health-services'], function: 'Agent Dispatcher' },
    };
    expect(getNodeRole(m)).toBe('agent-dispatcher');
  });

  it('returns interconnect for machines with Interconnect in name', () => {
    const m = { name: 'Health Services Interconnect', metadata: {} };
    expect(getNodeRole(m)).toBe('interconnect');
  });

  it('returns standard for plain machines', () => {
    const m = { name: 'Thermal Monitor', metadata: {} };
    expect(getNodeRole(m)).toBe('standard');
  });
});

describe('classifyMachine', () => {
  it('classifies Health Services machines correctly', () => {
    const m = {
      name: 'Health Services Care Coordination Agent Dispatcher',
      metadata: { domain: 'Health Services - Care Coordination', tags: ['health-services'] },
    };
    expect(classifyMachine(m).domain).toBe('healthservices');
  });

  it('falls back to general for unknown machines', () => {
    const m = { name: 'Unknown Machine', metadata: {} };
    expect(classifyMachine(m).domain).toBe('general');
  });

  it('classifies energy machines by metadata.category', () => {
    const m = {
      name: 'Community Microgrid Cluster Rooftop Solar Fleet Availability Monitor',
      metadata: { category: 'energy', domain: 'New Energy - Community Microgrid Cluster' },
    };
    expect(classifyMachine(m).domain).toBe('energy');
  });

  it('classifies energy machines by ENX id prefix', () => {
    const m = { id: 'machine-enx001-rooftop-solar-fleet-availability-monitor', name: 'Rooftop Solar Fleet', metadata: {} };
    expect(classifyMachine(m).domain).toBe('energy');
  });

  it('classifies energy interconnects by microgrid keywords', () => {
    const m = {
      name: 'Energy ENX-001-010 Interconnect',
      metadata: { domain: 'New Energy - Community Microgrid Cluster' },
    };
    expect(classifyMachine(m).domain).toBe('energy');
  });
});
