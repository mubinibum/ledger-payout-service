import { afterEach, describe, expect, it } from 'vitest';
import { metrics } from '../../src/infra/metrics.js';

describe('unit: in-process metrics registry', () => {
  afterEach(() => metrics.reset());

  it('renders Prometheus text exposition with HELP and TYPE lines', () => {
    metrics.transfersTotal.inc();
    const text = metrics.render();
    expect(text).toContain('# HELP transfers_total');
    expect(text).toContain('# TYPE transfers_total counter');
    expect(text).toMatch(/transfers_total 1$/m);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders labelled counter samples with quoted label values', () => {
    metrics.httpRequestsTotal.inc({
      method: 'GET',
      route: '/v1/accounts/:id',
      status_class: '2xx',
    });
    const text = metrics.render();
    expect(text).toContain(
      'http_requests_total{method="GET",route="/v1/accounts/:id",status_class="2xx"} 1',
    );
  });

  it('histogram emits _bucket / _sum / _count with a +Inf bucket', () => {
    metrics.httpRequestDurationSeconds.observe(0.02, { method: 'GET', route: '/healthz' });
    metrics.httpRequestDurationSeconds.observe(0.2, { method: 'GET', route: '/healthz' });
    const text = metrics.render();
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toMatch(/http_request_duration_seconds_bucket\{le="\+Inf"[^}]*\} 2/);
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*\} 2/);
    expect(text).toMatch(/http_request_duration_seconds_sum\{[^}]*\} 0\.22/);
    // 0.02 falls in le="0.025"; 0.2 does not.
    expect(text).toMatch(/http_request_duration_seconds_bucket\{le="0.025"[^}]*\} 1/);
  });

  it('gauge renders the last set value', () => {
    metrics.payoutManualReviewGauge.set(3);
    metrics.payoutManualReviewGauge.set(5);
    expect(metrics.render()).toMatch(/^payout_manual_review 5$/m);
  });

  it('exposition contains no obviously sensitive label values', () => {
    // Simulate a full request path exercising many label sites.
    metrics.httpRequestsTotal.inc({ method: 'POST', route: '/v1/payouts', status_class: '2xx' });
    metrics.payoutTransitionsTotal.inc({ from: 'requested', to: 'queued' });
    metrics.webhookRejectedTotal.inc({ reason: 'signature' });
    const text = metrics.render();
    // no uuid-shaped values, no long digit runs (ids), no bearer/secret words
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toMatch(/="\d{7,}"/);
    expect(text).not.toMatch(/secret|bearer|authorization/i);
  });
});
