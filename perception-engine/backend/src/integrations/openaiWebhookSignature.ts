import { createHmac, timingSafeEqual } from 'crypto';

export interface OpenAIWebhookLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
}

export interface OpenAIWebhookVerifyOptions {
  secret?: string;
  nowMs?: number;
  toleranceMs?: number;
}

export function verifyOpenAIWebhookSignature(
  req: OpenAIWebhookLikeRequest,
  opts: OpenAIWebhookVerifyOptions = {},
): string | null {
  const secret = opts.secret ?? process.env['OPENAI_WEBHOOK_SECRET'] ?? '';
  if (secret === '') return 'OPENAI_WEBHOOK_SECRET is required';

  const rawBody = req.rawBody;
  if (typeof rawBody !== 'string' || rawBody === '') return 'raw webhook body is required';

  const webhookId = headerString(req.headers, 'webhook-id');
  const webhookTimestamp = headerString(req.headers, 'webhook-timestamp');
  const webhookSignature = headerString(req.headers, 'webhook-signature');
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return 'missing OpenAI webhook signature headers';
  }

  const timestampSeconds = Number(webhookTimestamp);
  if (!Number.isFinite(timestampSeconds)) return 'invalid OpenAI webhook timestamp';
  const toleranceMs = opts.toleranceMs ?? Number(process.env['OPENAI_WEBHOOK_TOLERANCE_MS'] ?? 300_000);
  if (Number.isFinite(toleranceMs) && toleranceMs > 0) {
    const ageMs = Math.abs((opts.nowMs ?? Date.now()) - timestampSeconds * 1000);
    if (ageMs > toleranceMs) return 'OpenAI webhook timestamp outside tolerance';
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expected = createHmac('sha256', webhookSecretBytes(secret))
    .update(signedContent, 'utf8')
    .digest();

  for (const candidate of webhookSignature.split(' ')) {
    const [, value] = candidate.trim().split(',', 2);
    if (!value) continue;
    const actual = Buffer.from(value, 'base64');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return null;
  }
  return 'invalid OpenAI webhook signature';
}

export function signOpenAIWebhookTestPayload(
  rawBody: string,
  secret: string,
  webhookId: string,
  webhookTimestamp: string,
): string {
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  return 'v1,' + createHmac('sha256', webhookSecretBytes(secret))
    .update(signedContent, 'utf8')
    .digest('base64');
}

function webhookSecretBytes(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
      return decoded;
    }
  } catch {
    // Fall through to utf8 for local test secrets.
  }
  return Buffer.from(secret, 'utf8');
}

function headerString(headers: OpenAIWebhookLikeRequest['headers'], name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}
