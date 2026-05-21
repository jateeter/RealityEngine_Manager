import React, { useState, useEffect } from 'react';
import { useVisualizerStore } from '../store';
import { X, FolderOpen, Upload, Download, FileJson, AlertCircle, CheckCircle, Loader } from 'lucide-react';

interface MachineJSONFile {
  filename: string;
  name: string;
  description: string;
  version: string;
  metadata: any;
  sequenceCount: number;
}

interface MachineManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabType = 'browse' | 'import' | 'export';

const MachineManagementModal: React.FC<MachineManagementModalProps> = ({ isOpen, onClose }) => {
  const { machines, listMachineJSONFiles, loadMachineFromJSON, importMachineJSON, exportMachineToJSON } = useVisualizerStore();

  const [activeTab, setActiveTab] = useState<TabType>('browse');
  const [jsonFiles, setJsonFiles] = useState<MachineJSONFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);

  // Import state
  const [importJson, setImportJson] = useState('');

  // Export state
  const [selectedMachineId, setSelectedMachineId] = useState('');

  useEffect(() => {
    if (isOpen && activeTab === 'browse') loadJsonFiles();
  }, [isOpen, activeTab]);

  const clearStatus = () => setStatus(null);

  const loadJsonFiles = async () => {
    setLoading(true);
    clearStatus();
    try {
      setJsonFiles(await listMachineJSONFiles());
    } catch (err: any) {
      setStatus({ type: 'error', message: `Failed to load files: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleLoad = async (file: MachineJSONFile) => {
    setLoading(true);
    clearStatus();
    try {
      await loadMachineFromJSON(file.filename.replace('.json', ''));
      setStatus({ type: 'success', message: `"${file.name}" loaded.` });
    } catch (err: any) {
      setStatus({ type: 'error', message: `Failed to load: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    setLoading(true);
    clearStatus();
    try {
      JSON.parse(importJson);
      await importMachineJSON(importJson);
      setImportJson('');
      setStatus({ type: 'success', message: 'Machine imported.' });
    } catch (err: any) {
      setStatus({ type: 'error', message: err instanceof SyntaxError ? 'Invalid JSON.' : `Import failed: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!selectedMachineId) return;
    setLoading(true);
    clearStatus();
    try {
      const json = await exportMachineToJSON(selectedMachineId, true);
      const machine = machines.find(m => m.id === selectedMachineId);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = machine ? `${machine.name}.json` : 'machine.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus({ type: 'success', message: 'Download started.' });
    } catch (err: any) {
      setStatus({ type: 'error', message: `Export failed: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const tabBtn = (tab: TabType, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => { setActiveTab(tab); clearStatus(); }}
      style={{
        background: 'none',
        border: 'none',
        padding: '14px 20px',
        color: activeTab === tab ? '#3b82f6' : '#94a3b8',
        cursor: 'pointer',
        borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
        fontWeight: activeTab === tab ? '600' : '400',
        fontSize: '14px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      {icon} {label}
    </button>
  );

  return (
    <div
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}
      onClick={onClose}
    >
      <div
        style={{ backgroundColor: '#1a1a1a', borderRadius: '12px', width: '100%', maxWidth: '560px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '20px', color: '#e2e8f0' }}>Machine Management</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px' }}>
            <X size={22} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #333', padding: '0 16px' }}>
          {tabBtn('browse', <FolderOpen size={16} />, 'Browse')}
          {tabBtn('import', <Upload size={16} />, 'Import')}
          {tabBtn('export', <Download size={16} />, 'Export')}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

          {/* Browse */}
          {activeTab === 'browse' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8' }}>Load from examples/machines</p>
                <button
                  onClick={loadJsonFiles}
                  disabled={loading}
                  style={{ background: 'none', border: '1px solid #3b82f6', borderRadius: '6px', padding: '4px 10px', color: '#3b82f6', cursor: loading ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: loading ? 0.5 : 1 }}
                >
                  {loading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>

              {loading && jsonFiles.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8' }}>
                  <Loader size={28} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 12px', display: 'block' }} />
                  <p style={{ margin: 0 }}>Loading...</p>
                </div>
              )}

              {!loading && jsonFiles.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#64748b' }}>
                  <FileJson size={40} style={{ margin: '0 auto 12px', display: 'block', opacity: 0.5 }} />
                  <p style={{ margin: 0 }}>No machine files found</p>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {jsonFiles.map(file => (
                  <div key={file.filename} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', backgroundColor: '#0a0a0a', borderRadius: '8px', border: '1px solid #2a2a2a' }}>
                    <FileJson size={18} style={{ color: '#3b82f6', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: '#e2e8f0' }}>{file.name}</div>
                      <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>{file.sequenceCount} sequences · v{file.version}</div>
                    </div>
                    <button
                      onClick={() => handleLoad(file)}
                      disabled={loading}
                      style={{ padding: '6px 14px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '6px', cursor: loading ? 'not-allowed' : 'pointer', fontSize: '13px', fontWeight: '600', flexShrink: 0, opacity: loading ? 0.6 : 1 }}
                    >
                      Load
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Import */}
          {activeTab === 'import' && (
            <div>
              <input
                type="file"
                accept=".json"
                id="json-file-upload"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = ev => setImportJson(ev.target?.result as string);
                    reader.readAsText(file);
                  }
                }}
              />
              <label
                htmlFor="json-file-upload"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 14px', backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', color: '#e2e8f0', cursor: 'pointer', fontSize: '13px', marginBottom: '12px' }}
              >
                <Upload size={14} /> Choose File
              </label>
              <textarea
                value={importJson}
                onChange={e => setImportJson(e.target.value)}
                placeholder='{"version": "1.0.0", "machine": {...}}'
                style={{ width: '100%', height: '320px', padding: '12px', backgroundColor: '#0a0a0a', border: '1px solid #333', borderRadius: '8px', color: '#e2e8f0', fontFamily: 'monospace', fontSize: '12px', resize: 'vertical', boxSizing: 'border-box' }}
              />
              <button
                onClick={handleImport}
                disabled={!importJson || loading}
                style={{ width: '100%', marginTop: '12px', padding: '10px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', cursor: !importJson || loading ? 'not-allowed' : 'pointer', fontWeight: '600', opacity: !importJson || loading ? 0.6 : 1 }}
              >
                {loading ? 'Importing...' : 'Import Machine'}
              </button>
            </div>
          )}

          {/* Export */}
          {activeTab === 'export' && (
            <div>
              <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#94a3b8' }}>Download a loaded machine as JSON.</p>
              <select
                value={selectedMachineId}
                onChange={e => setSelectedMachineId(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', backgroundColor: '#0a0a0a', border: '1px solid #333', borderRadius: '8px', color: '#e2e8f0', fontSize: '14px', marginBottom: '12px' }}
              >
                <option value="">Choose a machine...</option>
                {machines.map(m => (
                  <option key={m.id} value={m.id}>{m.name} ({m.sequenceCount} sequences)</option>
                ))}
              </select>
              <button
                onClick={handleExport}
                disabled={!selectedMachineId || loading}
                style={{ width: '100%', padding: '10px', backgroundColor: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', cursor: !selectedMachineId || loading ? 'not-allowed' : 'pointer', fontWeight: '600', opacity: !selectedMachineId || loading ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
              >
                <Download size={16} />
                {loading ? 'Exporting...' : 'Download JSON'}
              </button>
            </div>
          )}
        </div>

        {/* Status bar */}
        {status && (
          <div style={{ padding: '12px 24px', borderTop: '1px solid #333', backgroundColor: status.type === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            {status.type === 'error'
              ? <AlertCircle size={16} style={{ color: '#fca5a5', flexShrink: 0 }} />
              : <CheckCircle size={16} style={{ color: '#6ee7b7', flexShrink: 0 }} />}
            <span style={{ fontSize: '13px', color: status.type === 'error' ? '#fca5a5' : '#6ee7b7' }}>{status.message}</span>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

export default MachineManagementModal;
