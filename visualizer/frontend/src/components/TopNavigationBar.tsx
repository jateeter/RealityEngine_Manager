import React from 'react';
import { Machine } from '../types';

interface TopNavigationBarProps {
  currentMachine: Machine | null;
  onNavigateBack: () => void;
}

const TopNavigationBar: React.FC<TopNavigationBarProps> = ({ currentMachine, onNavigateBack }) => {
  return (
    <div
      style={{
        height: '60px',
        background: '#0f172a',
        borderBottom: '2px solid #1e293b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        position: 'relative',
        zIndex: 100
      }}
    >
      {/* Left: Breadcrumb Navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {/* Back Button */}
        <button
          onClick={onNavigateBack}
          style={{
            background: '#1e293b',
            border: '1px solid #334155',
            borderRadius: '6px',
            color: '#94a3b8',
            padding: '8px 12px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '14px',
            fontWeight: '500',
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#334155';
            e.currentTarget.style.color = '#e2e8f0';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#1e293b';
            e.currentTarget.style.color = '#94a3b8';
          }}
        >
          <span style={{ fontSize: '16px' }}>←</span>
          Back
        </button>

        {/* Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
          <span
            onClick={onNavigateBack}
            style={{
              color: '#64748b',
              cursor: 'pointer',
              transition: 'color 0.2s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#94a3b8';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#64748b';
            }}
          >
            Machines
          </span>
          {currentMachine && (
            <>
              <span style={{ color: '#475569' }}>/</span>
              <span style={{ color: '#e2e8f0', fontWeight: '600' }}>
                {currentMachine.name}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Right: Machine Info */}
      {currentMachine && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            fontSize: '12px',
            color: '#64748b'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: '#94a3b8' }}>Sequences:</span>
            <span style={{ color: '#e2e8f0', fontWeight: '600' }}>
              {currentMachine.sequenceCount}
            </span>
          </div>
          <div
            style={{
              width: '1px',
              height: '16px',
              background: '#334155'
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: '#94a3b8' }}>Vectors:</span>
            <span style={{ color: '#e2e8f0', fontWeight: '600' }}>
              {currentMachine.totalVectors}
            </span>
          </div>
          {currentMachine.isExample && (
            <>
              <div
                style={{
                  width: '1px',
                  height: '16px',
                  background: '#334155'
                }}
              />
              <div
                style={{
                  background: '#3b82f6',
                  color: '#fff',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: '600'
                }}
              >
                Example
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default TopNavigationBar;
