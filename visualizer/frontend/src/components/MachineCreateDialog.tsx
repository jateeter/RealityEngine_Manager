import React, { useState } from 'react';
import { useVisualizerStore } from '../store';
import { Machine } from '../types';

interface MachineCreateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (machine: Machine) => void;
}

const MachineCreateDialog: React.FC<MachineCreateDialogProps> = ({ isOpen, onClose, onCreate }) => {
  const { createMachine } = useVisualizerStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Machine name is required');
      return;
    }

    setIsSubmitting(true);

    try {
      const machine = await createMachine({
        name: name.trim(),
        description: description.trim()
      });

      onCreate(machine);
      setName('');
      setDescription('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create machine');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    setName('');
    setDescription('');
    setError(null);
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleCancel}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          backdropFilter: 'blur(4px)'
        }}
      >
        {/* Dialog */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            background: '#1a1a1a',
            border: '2px solid #333',
            borderRadius: '12px',
            width: '500px',
            maxHeight: '600px',
            overflow: 'auto',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)'
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '24px',
              borderBottom: '1px solid #333',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 'bold', color: '#e2e8f0' }}>
              Create New Machine
            </h2>
            <button
              onClick={handleCancel}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                fontSize: '24px',
                cursor: 'pointer',
                padding: '0',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              ×
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={{ padding: '24px' }}>
            {/* Error Message */}
            {error && (
              <div
                style={{
                  background: '#7f1d1d',
                  border: '1px solid #991b1b',
                  borderRadius: '8px',
                  color: '#fecaca',
                  padding: '12px',
                  marginBottom: '20px',
                  fontSize: '14px'
                }}
              >
                {error}
              </div>
            )}

            {/* Name Field */}
            <div style={{ marginBottom: '20px' }}>
              <label
                htmlFor="machine-name"
                style={{
                  display: 'block',
                  fontSize: '14px',
                  fontWeight: '600',
                  color: '#e2e8f0',
                  marginBottom: '8px'
                }}
              >
                Machine Name *
              </label>
              <input
                id="machine-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter machine name"
                autoFocus
                style={{
                  width: '100%',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  color: '#e2e8f0',
                  padding: '12px',
                  fontSize: '14px',
                  outline: 'none'
                }}
              />
            </div>

            {/* Description Field */}
            <div style={{ marginBottom: '24px' }}>
              <label
                htmlFor="machine-description"
                style={{
                  display: 'block',
                  fontSize: '14px',
                  fontWeight: '600',
                  color: '#e2e8f0',
                  marginBottom: '8px'
                }}
              >
                Description
              </label>
              <textarea
                id="machine-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Enter machine description (optional)"
                rows={4}
                style={{
                  width: '100%',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  color: '#e2e8f0',
                  padding: '12px',
                  fontSize: '14px',
                  outline: 'none',
                  resize: 'vertical',
                  fontFamily: 'inherit'
                }}
              />
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={handleCancel}
                disabled={isSubmitting}
                style={{
                  background: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  color: '#94a3b8',
                  padding: '10px 20px',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  opacity: isSubmitting ? 0.5 : 1
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                style={{
                  background: '#3b82f6',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#fff',
                  padding: '10px 20px',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  opacity: isSubmitting ? 0.5 : 1
                }}
              >
                {isSubmitting ? 'Creating...' : 'Create Machine'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
};

export default MachineCreateDialog;
