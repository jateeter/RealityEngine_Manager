import React, { useState, useEffect } from 'react';
import './PerceptualLogViewer.css';
import { perceptualLogger, PerceptualLogEntry, PerceptualLogLevel, PerceptualLogType } from '../utils/perceptualSequenceLogger';

interface PerceptualLogViewerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PerceptualLogViewer: React.FC<PerceptualLogViewerProps> = ({ isOpen, onClose }) => {
  const [logs, setLogs] = useState<PerceptualLogEntry[]>([]);
  const [filteredLogs, setFilteredLogs] = useState<PerceptualLogEntry[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<PerceptualLogLevel | 'all'>('all');
  const [selectedType, setSelectedType] = useState<PerceptualLogType | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Load logs and subscribe to updates
  useEffect(() => {
    // Initial load
    setLogs(perceptualLogger.getLogs());

    // Subscribe to new logs
    const unsubscribe = perceptualLogger.subscribe((entry) => {
      setLogs(prev => [...prev, entry]);
    });

    return () => unsubscribe();
  }, []);

  // Apply filters
  useEffect(() => {
    let filtered = [...logs];

    // Filter by level
    if (selectedLevel !== 'all') {
      filtered = filtered.filter(log => log.level === selectedLevel);
    }

    // Filter by type
    if (selectedType !== 'all') {
      filtered = filtered.filter(log => log.type === selectedType);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(log =>
        log.message.toLowerCase().includes(query) ||
        log.type.toLowerCase().includes(query) ||
        JSON.stringify(log.data).toLowerCase().includes(query)
      );
    }

    setFilteredLogs(filtered);
  }, [logs, selectedLevel, selectedType, searchQuery]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && isOpen) {
      const logList = document.querySelector('.log-list');
      if (logList) {
        logList.scrollTop = logList.scrollHeight;
      }
    }
  }, [filteredLogs, autoScroll, isOpen]);

  if (!isOpen) return null;

  const stats = perceptualLogger.getStatistics();

  const uniqueTypes = Array.from(new Set(logs.map(log => log.type)));

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString() + '.' + date.getMilliseconds().toString().padStart(3, '0');
  };

  const getLevelColor = (level: PerceptualLogLevel) => {
    switch (level) {
      case 'debug': return '#64748b';
      case 'info': return '#3b82f6';
      case 'warn': return '#f59e0b';
      case 'error': return '#ef4444';
      default: return '#94a3b8';
    }
  };

  const getLevelIcon = (level: PerceptualLogLevel) => {
    switch (level) {
      case 'debug': return '🔍';
      case 'info': return 'ℹ️';
      case 'warn': return '⚠️';
      case 'error': return '❌';
      default: return '📝';
    }
  };

  const getTypeIcon = (type: PerceptualLogType) => {
    if (type.startsWith('input-queue')) return '📥';
    if (type.startsWith('output-queue')) return '📤';
    if (type.startsWith('vector-generate')) return '⚙️';
    if (type.startsWith('vector-process')) return '🔄';
    if (type.startsWith('vector-extract')) return '🔪';
    if (type.startsWith('vector-merge')) return '🔗';
    if (type.includes('simulation')) return '▶️';
    if (type.includes('perceptual')) return '🌐';
    return '📊';
  };

  const handleExportJSON = () => {
    const json = perceptualLogger.exportToJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `perceptual-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    const csv = perceptualLogger.exportToCSV();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `perceptual-logs-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearLogs = () => {
    if (confirm('Are you sure you want to clear all logs?')) {
      perceptualLogger.clearLogs();
      setLogs([]);
      setFilteredLogs([]);
    }
  };

  return (
    <div className="perceptual-log-viewer-overlay" onClick={onClose}>
      <div className="perceptual-log-viewer" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="log-viewer-header">
          <div className="header-title-section">
            <span className="header-icon">📋</span>
            <div className="header-title-text">
              <h2>Perceptual Sequence Logs</h2>
              <p>Detailed logging of input/output sequence operations</p>
            </div>
          </div>
          <button className="log-viewer-close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* Statistics Bar */}
        <div className="log-statistics">
          <div className="stat-item">
            <span className="stat-label">Total Logs:</span>
            <span className="stat-value">{stats.total}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Debug:</span>
            <span className="stat-value" style={{ color: getLevelColor('debug') }}>{stats.byLevel.debug}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Info:</span>
            <span className="stat-value" style={{ color: getLevelColor('info') }}>{stats.byLevel.info}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Warn:</span>
            <span className="stat-value" style={{ color: getLevelColor('warn') }}>{stats.byLevel.warn}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Error:</span>
            <span className="stat-value" style={{ color: getLevelColor('error') }}>{stats.byLevel.error}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Showing:</span>
            <span className="stat-value">{filteredLogs.length}</span>
          </div>
        </div>

        {/* Controls */}
        <div className="log-controls">
          <div className="control-group">
            <label>Level:</label>
            <select value={selectedLevel} onChange={(e) => setSelectedLevel(e.target.value as any)}>
              <option value="all">All Levels</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
          </div>

          <div className="control-group">
            <label>Type:</label>
            <select value={selectedType} onChange={(e) => setSelectedType(e.target.value as any)}>
              <option value="all">All Types</option>
              {uniqueTypes.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>

          <div className="control-group search-group">
            <label>Search:</label>
            <input
              type="text"
              placeholder="Search logs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
          </div>

          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              Auto-scroll
            </label>
          </div>
        </div>

        {/* Actions */}
        <div className="log-actions">
          <button onClick={handleExportJSON} className="action-btn export-btn">
            📄 Export JSON
          </button>
          <button onClick={handleExportCSV} className="action-btn export-btn">
            📊 Export CSV
          </button>
          <button onClick={handleClearLogs} className="action-btn danger-btn">
            🗑️ Clear Logs
          </button>
        </div>

        {/* Log List */}
        <div className="log-list">
          {filteredLogs.length === 0 ? (
            <div className="empty-logs">
              <span className="empty-icon">📭</span>
              <p>No logs to display</p>
              <p className="empty-hint">
                {searchQuery || selectedLevel !== 'all' || selectedType !== 'all'
                  ? 'Try adjusting your filters'
                  : 'Logs will appear here as operations occur'}
              </p>
            </div>
          ) : (
            filteredLogs.map(log => (
              <div
                key={log.id}
                className={`log-entry log-level-${log.level} ${expandedLogId === log.id ? 'expanded' : ''}`}
                onClick={() => setExpandedLogId(expandedLogId === log.id ? null : log.id)}
              >
                <div className="log-entry-header">
                  <span className="log-timestamp">{formatTimestamp(log.timestamp)}</span>
                  <span className="log-level" style={{ color: getLevelColor(log.level) }}>
                    {getLevelIcon(log.level)} {log.level.toUpperCase()}
                  </span>
                  <span className="log-type">
                    {getTypeIcon(log.type)} {log.type}
                  </span>
                  <span className="log-message">{log.message}</span>
                  <span className="expand-icon">{expandedLogId === log.id ? '▼' : '▶'}</span>
                </div>

                {expandedLogId === log.id && log.data && (
                  <div className="log-entry-details">
                    <div className="log-data-label">Data:</div>
                    <pre className="log-data">{JSON.stringify(log.data, null, 2)}</pre>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
