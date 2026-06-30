import { describe, expect, it } from '@jest/globals';

import {
  signOpenAIWebhookTestPayload,
  verifyOpenAIWebhookSignature,
} from '../integrations/openaiWebhookSignature.js';

describe('verifyOpenAIWebhookSignature', () => {
  const rawBody = JSON.stringify({ object: 'event', type: 'response.completed', data: { id: 'resp_1' } });
  const secret = 'whsec_' + Buffer.from('test-secret').toString('base64');
  const webhookId = 'wh_test';
  const webhookTimestamp = '1750287078';

  it('accepts a valid Standard Webhooks signature', () => {
    const signature = signOpenAIWebhookTestPayload(rawBody, secret, webhookId, webhookTimestamp);
    const result = verifyOpenAIWebhookSignature({
      rawBody,
      headers: {
        'webhook-id': webhookId,
        'webhook-timestamp': webhookTimestamp,
        'webhook-signature': signature,
      },
    }, { secret, nowMs: Number(webhookTimestamp) * 1000 });

    expect(result).toBeNull();
  });

  it('rejects missing signatures', () => {
    const result = verifyOpenAIWebhookSignature({
      rawBody,
      headers: {},
    }, { secret, nowMs: Number(webhookTimestamp) * 1000 });

    expect(result).toMatch(/missing OpenAI webhook signature headers/);
  });

  it('rejects invalid signatures', () => {
    const result = verifyOpenAIWebhookSignature({
      rawBody,
      headers: {
        'webhook-id': webhookId,
        'webhook-timestamp': webhookTimestamp,
        'webhook-signature': 'v1,' + Buffer.from('not-valid').toString('base64'),
      },
    }, { secret, nowMs: Number(webhookTimestamp) * 1000 });

    expect(result).toMatch(/invalid OpenAI webhook signature/);
  });
});
