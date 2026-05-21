import type { Request, Response, NextFunction } from 'express';

export interface AuditConfig {
  enabled: boolean;
  /** 1=MINIMAL  — mutating ops (POST/PUT/PATCH/DELETE) + errors only
   *  2=STANDARD — all requests + status + duration
   *  3=VERBOSE  — standard + content-type + content-length + request body preview
   */
  level: number;
  service: string;
}

/** Build config from environment variables.
 *
 *  AUDIT_LOG_ENABLED  true|false        (default: true)
 *  AUDIT_LOG_LEVEL    1|2|3             (default: 2)
 *  AUDIT_LOG_SERVICE  arbitrary string  (default: defaultService)
 */
export function loadAuditConfig(defaultService: string): AuditConfig {
  return {
    enabled: process.env['AUDIT_LOG_ENABLED'] !== 'false',
    level: Math.min(3, Math.max(1, parseInt(process.env['AUDIT_LOG_LEVEL'] ?? '2', 10) || 2)),
    service: process.env['AUDIT_LOG_SERVICE'] ?? defaultService,
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Express middleware that emits a structured JSON audit entry to stdout for
 *  every request that matches the configured level.  Entries are written to
 *  stdout so they are captured by the Docker logging driver and forwarded to
 *  Loki with the same service labels as all other container output.
 */
export function auditMiddleware(cfg: AuditConfig) {
  if (!cfg.enabled) {
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now();
    const isMutating = MUTATING.has(req.method);

    res.on('finish', () => {
      const duration = Date.now() - start;
      const status   = res.statusCode;
      const isError  = status >= 400;

      if (cfg.level >= 2 || isMutating || isError) {
        const auditLevel = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
        const ip = (
          req.headers['x-real-ip'] as string | undefined ??
          (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
          req.socket.remoteAddress ??
          'unknown'
        );

        const entry: Record<string, unknown> = {
          timestamp:   new Date().toISOString(),
          level:       'AUDIT',
          audit_level: auditLevel,
          service:     cfg.service,
          event:       'http_request',
          method:      req.method,
          path:        req.path,
          status,
          duration_ms: duration,
          remote_ip:   ip,
        };

        if (cfg.level >= 3) {
          entry['content_type']   = req.headers['content-type'] ?? null;
          entry['content_length'] = req.headers['content-length'] ?? null;
          if (isMutating && req.body != null && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            const bodyStr = JSON.stringify(req.body);
            entry['request_body_preview'] = bodyStr.length > 512
              ? bodyStr.slice(0, 512) + '...[truncated]'
              : bodyStr;
          }
        }

        console.log(JSON.stringify(entry));
      }
    });

    next();
  };
}

/** Log a lifecycle event (startup / shutdown) outside the request cycle. */
export function logAuditEvent(cfg: AuditConfig, event: string, extra: Record<string, unknown> = {}): void {
  if (!cfg.enabled) return;
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level:     'AUDIT',
    service:   cfg.service,
    event,
    ...extra,
  }));
}
