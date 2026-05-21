import React, { useEffect, useRef, useState } from 'react';
import { OutputVector } from '../types';

interface OutputStreamVisualizationProps {
  outputVectors: OutputVector[];
  maxVisible?: number;
  highlightedOutputId?: string | null;
}

const OutputStreamVisualization: React.FC<OutputStreamVisualizationProps> = ({
  outputVectors,
  highlightedOutputId
}) => {
  const [expanded, setExpanded] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const outputRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const currentOutput = outputVectors.length > 0 ? outputVectors[outputVectors.length - 1] : null;
  // Keep chronological order (oldest to newest) - will use reverse flex direction
  const history = outputVectors.length > 1 ? outputVectors.slice(0, -1) : [];

  // Auto-scroll history to top when new output arrives (newest items appear at top in reverse flex)
  useEffect(() => {
    if (historyRef.current && outputVectors.length > 0) {
      historyRef.current.scrollTop = 0;
    }
  }, [outputVectors.length]);

  // Auto-scroll to highlighted output when it changes
  useEffect(() => {
    if (highlightedOutputId && historyRef.current) {
      const outputElement = outputRefs.current.get(highlightedOutputId);
      if (outputElement) {
        // Scroll the history container to show the highlighted output
        outputElement.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });
      }
    }
  }, [highlightedOutputId]);

  const now = Date.now();
  const renderOutputCard = (output: OutputVector, isCurrent: boolean, index?: number) => {
    const age = now - (output.timestamp || 0);
    const isNew = age < 3000;
    const isHighlighted = highlightedOutputId === output.id;

    return (
      <div
        key={output.id || index}
        ref={(el) => {
          if (output.id) {
            if (el) outputRefs.current.set(output.id, el);
            else outputRefs.current.delete(output.id);
          }
        }}
        style={{
          padding: '12px',
          background: isHighlighted
            ? 'linear-gradient(135deg, #a855f7 0%, #8b5cf6 100%)'
            : isCurrent
            ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
            : '#334155',
          border: isHighlighted
            ? '3px solid #c084fc'
            : isCurrent
            ? '2px solid #fbbf24'
            : '1px solid #475569',
          borderRadius: '8px',
          transition: 'all 0.3s ease',
          position: 'relative',
          boxShadow: isHighlighted
            ? '0 0 30px rgba(168, 85, 247, 0.6)'
            : isCurrent
            ? '0 0 20px rgba(245, 158, 11, 0.4)'
            : 'none',
          animation: isCurrent && isNew ? 'slideIn 0.3s ease-out' : 'none',
          transform: isHighlighted ? 'scale(1.05)' : 'scale(1)'
        }}
      >
        {/* Output ID */}
        <div style={{
          fontSize: '10px',
          color: isCurrent ? '#fef3c7' : '#94a3b8',
          marginBottom: '6px',
          fontWeight: '600',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{
            maxWidth: '140px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}>
            {output.id || `Output ${index !== undefined ? outputVectors.length - index : outputVectors.length}`}
          </span>
          {isCurrent && isNew && (
            <span style={{
              fontSize: '12px',
              animation: 'sparkle 1s ease-in-out infinite'
            }}>✨</span>
          )}
        </div>

        {/* Vector Values */}
        <div style={{
          fontFamily: 'monospace',
          fontSize: '11px',
          color: isCurrent ? '#fff' : '#cbd5e1',
          wordBreak: 'break-all',
          lineHeight: '1.4',
          marginBottom: output.metadata ? '8px' : '0'
        }}>
          [{output.vector.map(v => v.toFixed(2)).join(', ')}]
        </div>

        {/* Metadata */}
        {output.metadata && (
          <div style={{
            fontSize: '10px',
            color: isCurrent ? '#fde68a' : '#64748b',
            fontStyle: 'italic',
            borderTop: `1px solid ${isCurrent ? '#fbbf24' : '#475569'}`,
            paddingTop: '6px',
            maxHeight: '40px',
            overflow: 'hidden'
          }}>
            {typeof output.metadata === 'string'
              ? output.metadata
              : output.metadata.description || JSON.stringify(output.metadata).slice(0, 50) + '...'}
          </div>
        )}

        {/* Current Indicator */}
        {isCurrent && (
          <div style={{
            position: 'absolute',
            left: '-12px',
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '20px',
            color: '#f59e0b',
            animation: 'bounce 1s ease-in-out infinite'
          }}>
            →
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{
      width: expanded ? '220px' : '44px',
      height: '100%',
      background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
      borderLeft: '2px solid #f59e0b',
      display: 'flex',
      flexDirection: 'column',
      padding: expanded ? '20px' : '12px 6px',
      boxShadow: 'inset 5px 0 15px rgba(245, 158, 11, 0.1)',
      transition: 'width 0.2s ease, padding 0.2s ease',
      overflow: 'hidden'
    }}>
      {/* Header (clickable to expand/collapse) */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse output stream' : 'Expand output stream'}
        style={{
          marginBottom: expanded ? '16px' : '0',
          paddingBottom: expanded ? '12px' : '0',
          borderBottom: expanded ? '2px solid #f59e0b' : 'none',
          background: 'transparent',
          border: 'none',
          color: '#f59e0b',
          cursor: 'pointer',
          textAlign: 'left',
          padding: 0,
          width: '100%',
          display: 'flex',
          flexDirection: expanded ? 'column' : 'column',
          alignItems: expanded ? 'stretch' : 'center',
          gap: '6px'
        }}
      >
        <div style={{
          fontSize: expanded ? '14px' : '10px',
          fontWeight: 700,
          color: '#f59e0b',
          textTransform: 'uppercase',
          letterSpacing: '1px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          writingMode: expanded ? 'horizontal-tb' : 'vertical-rl',
          transform: expanded ? 'none' : 'rotate(180deg)'
        }}>
          <span>OUTPUT</span>
          <span style={{ fontSize: expanded ? '18px' : '12px' }}>→</span>
          <span style={{
            fontSize: '11px',
            color: '#94a3b8',
            fontFamily: 'monospace',
            fontWeight: 400
          }}>
            {outputVectors.length}
          </span>
        </div>
        {expanded && (
          <div style={{
            fontSize: '12px',
            color: '#64748b',
            fontFamily: 'monospace',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <span>
              {outputVectors.length > 0
                ? `${outputVectors.length} output${outputVectors.length !== 1 ? 's' : ''}`
                : 'No outputs yet'}
            </span>
            <span style={{ color: '#f59e0b' }}>▲</span>
          </div>
        )}
        {!expanded && (
          <span style={{ fontSize: '10px', color: '#f59e0b', marginTop: '4px' }}>▼</span>
        )}
      </button>

      {!expanded ? null : outputVectors.length === 0 ? (
        <div style={{
          padding: '20px',
          textAlign: 'center',
          color: '#475569',
          fontSize: '13px',
          border: '2px dashed #334155',
          borderRadius: '8px',
          background: '#1e293b'
        }}>
          Waiting for outputs...
        </div>
      ) : (
        <>
          {/* Current Output Section */}
          <div style={{
            marginBottom: '16px'
          }}>
            <div style={{
              fontSize: '11px',
              fontWeight: '700',
              color: '#f59e0b',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}>
              <span>CURRENT</span>
              <div style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: '#f59e0b',
                animation: 'pulse 2s ease-in-out infinite'
              }}></div>
            </div>
            {currentOutput && renderOutputCard(currentOutput, true)}
          </div>

          {/* History Section */}
          {history.length > 0 && (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0
            }}>
              <div style={{
                fontSize: '11px',
                fontWeight: '700',
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                marginBottom: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <span>HISTORY</span>
                <span style={{
                  fontSize: '9px',
                  color: '#475569',
                  fontWeight: '400',
                  fontFamily: 'monospace'
                }}>
                  {history.length} previous
                </span>
              </div>
              <div
                ref={historyRef}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column-reverse',
                  gap: '10px',
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  paddingRight: '4px',
                  scrollbarWidth: 'thin',
                  scrollbarColor: '#475569 #1e293b'
                }}
              >
                {history.map((output, index) => renderOutputCard(output, false, index))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Animations */}
      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        @keyframes sparkle {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.2); }
        }

        @keyframes bounce {
          0%, 100% { transform: translateY(-50%) translateX(0); }
          50% { transform: translateY(-50%) translateX(-3px); }
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
};

export default OutputStreamVisualization;
