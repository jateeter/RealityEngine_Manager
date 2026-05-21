/**
 * Perceptual Sequence Logger
 *
 * Captures detailed logs of input/output sequences flowing through the perceptual system.
 * Provides structured logging for debugging, analysis, and system monitoring.
 */

import { VectorSequenceItem } from '../types';

export type PerceptualLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type PerceptualLogType =
  | 'input-queue-add'
  | 'input-queue-add-bulk'
  | 'input-queue-pop'
  | 'input-queue-remove'
  | 'input-queue-clear'
  | 'output-queue-add'
  | 'output-queue-remove'
  | 'output-queue-clear'
  | 'vector-generate-algorithmic'
  | 'vector-generate-random'
  | 'vector-process-start'
  | 'vector-process-complete'
  | 'vector-extract-machine-input'
  | 'vector-merge-machine-output'
  | 'perceptual-space-update'
  | 'simulation-step'
  | 'queue-state-snapshot';

export interface PerceptualLogEntry {
  id: string;
  timestamp: number;
  level: PerceptualLogLevel;
  type: PerceptualLogType;
  message: string;
  data?: {
    // Queue operations
    queueLength?: number;
    queueType?: 'input' | 'output';
    itemId?: string;
    itemsAdded?: number;
    itemsRemoved?: number;

    // Vector operations
    vectorId?: string;
    vectorDimension?: number;
    vectorSource?: 'algorithmic' | 'random' | 'manual' | 'override';
    vectorPattern?: string;
    vectorRegion?: { offset: number; length: number };
    vectorNonZeroCount?: number;
    vectorMean?: number;
    vectorStdDev?: number;

    // Machine operations
    machineId?: string;
    machineName?: string;
    machineInputRegion?: { offset: number; length: number };
    machineOutputRegion?: { offset: number; length: number };
    extractedInputLength?: number;
    mergedOutputLength?: number;

    // Simulation operations
    simulationStep?: number;
    simulationTotalSteps?: number;
    currentUniversalVector?: number[];
    perceptualSpaceDimension?: number;
    activeSequences?: string[];

    // Queue snapshots
    inputQueueSnapshot?: VectorSequenceItem[];
    outputQueueSnapshot?: VectorSequenceItem[];

    // Additional metadata
    [key: string]: any;
  };
}

export class PerceptualSequenceLogger {
  private logs: PerceptualLogEntry[] = [];
  private maxLogs: number = 1000; // Keep last 1000 logs
  private listeners: Array<(entry: PerceptualLogEntry) => void> = [];
  private enabled: boolean = true;
  private lokiBuffer: PerceptualLogEntry[] = [];
  private lokiFlushInterval: number | null = null;
  private lokiFlushSize: number = 10; // Send to Loki every 10 logs
  private lokiFlushDelay: number = 5000; // Or every 5 seconds
  private lokiEnabled: boolean = true; // Enable Loki forwarding

  constructor(maxLogs: number = 1000) {
    this.maxLogs = maxLogs;
    this.startLokiFlushTimer();
    // Flush remaining logs and stop the timer when the page closes.
    window.addEventListener('beforeunload', () => this.destroy());
  }

  /**
   * Start periodic Loki flush timer
   */
  private startLokiFlushTimer(): void {
    if (this.lokiFlushInterval) return;

    this.lokiFlushInterval = window.setInterval(() => {
      this.flushToLoki();
    }, this.lokiFlushDelay);
  }

  /**
   * Flush buffered logs to Loki
   */
  private async flushToLoki(): Promise<void> {
    if (!this.lokiEnabled || this.lokiBuffer.length === 0) return;

    const logsToSend = [...this.lokiBuffer];
    this.lokiBuffer = [];

    try {
      // Use window.location to determine backend URL
      const backendUrl = window.location.hostname === 'localhost'
        ? 'http://localhost:3001'
        : `${window.location.protocol}//${window.location.hostname}:3001`;

      const response = await fetch(`${backendUrl}/api/logs/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ logs: logsToSend }),
      });

      if (!response.ok) {
        console.error('Failed to send logs to Loki:', response.statusText);
        // Re-add failed logs to buffer (up to buffer limit)
        this.lokiBuffer.unshift(...logsToSend.slice(-50));
      }
    } catch (error) {
      console.error('Error sending logs to Loki:', error);
      // Re-add failed logs to buffer (up to buffer limit)
      this.lokiBuffer.unshift(...logsToSend.slice(-50));
    }
  }

  /**
   * Enable or disable Loki forwarding
   */
  setLokiEnabled(enabled: boolean): void {
    this.lokiEnabled = enabled;
    if (!enabled) {
      this.lokiBuffer = [];
    }
  }

  /**
   * Enable or disable logging
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Add a log entry
   */
  log(
    level: PerceptualLogLevel,
    type: PerceptualLogType,
    message: string,
    data?: PerceptualLogEntry['data']
  ): PerceptualLogEntry {
    if (!this.enabled) {
      return {
        id: '',
        timestamp: Date.now(),
        level,
        type,
        message,
        data
      };
    }

    const entry: PerceptualLogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      level,
      type,
      message,
      data
    };

    this.logs.push(entry);

    // Trim logs if exceeding max
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Notify listeners
    this.listeners.forEach(listener => {
      try {
        listener(entry);
      } catch (error) {
        console.error('Error in log listener:', error);
      }
    });

    // Add to Loki buffer
    if (this.lokiEnabled) {
      this.lokiBuffer.push(entry);
      // Cap buffer to prevent unbounded growth during Loki downtime.
      if (this.lokiBuffer.length > 200) {
        this.lokiBuffer = this.lokiBuffer.slice(-200);
      }
      // Flush if buffer reaches threshold
      if (this.lokiBuffer.length >= this.lokiFlushSize) {
        this.flushToLoki();
      }
    }

    // Console output based on level
    if (level === 'error') {
      console.error(`[Perceptual] ${message}`, data);
    } else if (level === 'warn') {
      console.warn(`[Perceptual] ${message}`, data);
    } else if (level === 'debug') {
      console.debug(`[Perceptual] ${message}`, data);
    } else {
      console.log(`[Perceptual] ${message}`, data);
    }

    return entry;
  }

  /**
   * Convenience methods for different log levels
   */
  debug(type: PerceptualLogType, message: string, data?: PerceptualLogEntry['data']): PerceptualLogEntry {
    return this.log('debug', type, message, data);
  }

  info(type: PerceptualLogType, message: string, data?: PerceptualLogEntry['data']): PerceptualLogEntry {
    return this.log('info', type, message, data);
  }

  warn(type: PerceptualLogType, message: string, data?: PerceptualLogEntry['data']): PerceptualLogEntry {
    return this.log('warn', type, message, data);
  }

  error(type: PerceptualLogType, message: string, data?: PerceptualLogEntry['data']): PerceptualLogEntry {
    return this.log('error', type, message, data);
  }

  /**
   * Get all logs
   */
  getLogs(): PerceptualLogEntry[] {
    return [...this.logs];
  }

  /**
   * Get logs filtered by type
   */
  getLogsByType(type: PerceptualLogType): PerceptualLogEntry[] {
    return this.logs.filter(log => log.type === type);
  }

  /**
   * Get logs filtered by level
   */
  getLogsByLevel(level: PerceptualLogLevel): PerceptualLogEntry[] {
    return this.logs.filter(log => log.level === level);
  }

  /**
   * Get logs within time range
   */
  getLogsByTimeRange(startTime: number, endTime: number): PerceptualLogEntry[] {
    return this.logs.filter(log => log.timestamp >= startTime && log.timestamp <= endTime);
  }

  /**
   * Clear all logs
   */
  clearLogs(): void {
    this.logs = [];
    this.info('queue-state-snapshot', 'All perceptual sequence logs cleared');
  }

  /**
   * Subscribe to log events
   */
  subscribe(listener: (entry: PerceptualLogEntry) => void): () => void {
    this.listeners.push(listener);

    // Return unsubscribe function
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * Get statistics about logs
   */
  getStatistics(): {
    total: number;
    byLevel: Record<PerceptualLogLevel, number>;
    byType: Record<string, number>;
    timeRange: { earliest: number | null; latest: number | null };
  } {
    const byLevel: Record<PerceptualLogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0
    };

    const byType: Record<string, number> = {};

    let earliest: number | null = null;
    let latest: number | null = null;

    this.logs.forEach(log => {
      byLevel[log.level]++;
      byType[log.type] = (byType[log.type] || 0) + 1;

      if (earliest === null || log.timestamp < earliest) {
        earliest = log.timestamp;
      }
      if (latest === null || log.timestamp > latest) {
        latest = log.timestamp;
      }
    });

    return {
      total: this.logs.length,
      byLevel,
      byType,
      timeRange: { earliest, latest }
    };
  }

  /**
   * Export logs to JSON
   */
  exportToJSON(): string {
    return JSON.stringify({
      exportTime: Date.now(),
      logs: this.logs,
      statistics: this.getStatistics()
    }, null, 2);
  }

  /**
   * Export logs to CSV
   */
  exportToCSV(): string {
    const headers = ['Timestamp', 'Level', 'Type', 'Message', 'Data'];
    const rows = this.logs.map(log => [
      new Date(log.timestamp).toISOString(),
      log.level,
      log.type,
      log.message,
      JSON.stringify(log.data || {})
    ]);

    return [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');
  }

  /**
   * Clean up resources (stop timers, flush remaining logs)
   */
  destroy(): void {
    // Stop Loki flush timer
    if (this.lokiFlushInterval !== null) {
      clearInterval(this.lokiFlushInterval);
      this.lokiFlushInterval = null;
    }

    // Flush any remaining logs
    this.flushToLoki();

    // Clear listeners
    this.listeners = [];

    console.log('[Perceptual Logger] Destroyed and cleaned up');
  }
}

/**
 * Singleton instance for global use
 */
export const perceptualLogger = new PerceptualSequenceLogger();

/**
 * Helper function to calculate vector statistics
 */
export function calculateVectorStats(vector: number[]): {
  nonZeroCount: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
} {
  const nonZeroCount = vector.filter(v => v !== 0).length;
  const sum = vector.reduce((acc, v) => acc + v, 0);
  const mean = sum / vector.length;

  const variance = vector.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / vector.length;
  const stdDev = Math.sqrt(variance);

  const min = Math.min(...vector);
  const max = Math.max(...vector);

  return { nonZeroCount, mean, stdDev, min, max };
}
