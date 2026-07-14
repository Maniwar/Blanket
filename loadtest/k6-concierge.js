// k6 load test for the concierge edge function — pins the capacity ladder in
// docs/scaling-scorecard.svg with real numbers instead of estimates.
//
// The DEFAULT scenario ("read") hammers only the public GET endpoints
// (?config / ?site / ?tools / ?defaults / ?starters). Those exercise the exact
// edge-function + Postgres read path the scaling review cares about, WITHOUT
// calling Anthropic (no token spend) and WITHOUT writing rows.
//
// The opt-in "chat" scenario drives the real LLM path. It SPENDS TOKENS and will
// hit the shared 20-requests / 10-min rate limit (blocker #1) — the 429s it
// produces are themselves the finding, not an error. Run it small and on staging.
//
// Usage (see loadtest/README.md):
//   BASE_URL="https://<ref>.functions.supabase.co/concierge" \
//   ANON_KEY="<publishable-anon-key>" \
//   k6 run loadtest/k6-concierge.js
//
// Never point this at production, and never at a project with real customers.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL;   // the /concierge function URL (cfg().endpoint)
const KEY = __ENV.ANON_KEY;    // Supabase publishable / anon key
const SCENARIO = (__ENV.SCENARIO || 'read').toLowerCase();

if (!BASE || !KEY) {
  throw new Error(
    'Set BASE_URL (the /concierge function URL) and ANON_KEY. See loadtest/README.md.',
  );
}

const HEADERS = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

// Order-of-magnitude tiers from the capacity ladder. Override with env vars to
// find the real knee for THIS project's plan — start low, climb until p95/errors
// break the thresholds below, and record the tier where they do.
const STEADY = Number(__ENV.STEADY_VUS || 50);   // ~thousands concurrent users
const HIGH = Number(__ENV.HIGH_VUS || 300);      // ~tens of thousands
const SPIKE = Number(__ENV.SPIKE_VUS || 800);    // push toward the ceiling
const HOLD = __ENV.HOLD || '1m';                 // time held at each tier

const errors = new Rate('errors');
const READ_ENDPOINTS = ['config', 'site', 'tools', 'defaults', 'starters'];

export const options = buildOptions();

function buildOptions() {
  if (SCENARIO === 'chat') {
    return {
      scenarios: {
        chat: {
          executor: 'constant-vus',
          vus: Number(__ENV.CHAT_VUS || 5),
          duration: __ENV.CHAT_DURATION || '1m',
          exec: 'chatPath',
        },
      },
      // The LLM path is slow by design; this only flags gross regressions.
      thresholds: { 'http_req_duration{kind:chat}': ['p(95)<20000'] },
    };
  }
  return {
    scenarios: {
      read: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { target: STEADY, duration: '30s' },
          { target: STEADY, duration: HOLD },
          { target: HIGH, duration: '30s' },
          { target: HIGH, duration: HOLD },
          { target: SPIKE, duration: '30s' },
          { target: SPIKE, duration: HOLD },
          { target: 0, duration: '20s' },
        ],
        gracefulRampDown: '10s',
        exec: 'readPath',
      },
    },
    thresholds: {
      http_req_failed: ['rate<0.01'],
      errors: ['rate<0.01'],
      'http_req_duration{kind:read}': ['p(95)<800', 'p(99)<1500'],
    },
  };
}

// Default, safe path: round-robin the public config/content reads.
export function readPath() {
  const ep = READ_ENDPOINTS[(__VU + __ITER) % READ_ENDPOINTS.length];
  const res = http.get(`${BASE}?${ep}=1`, {
    headers: HEADERS,
    tags: { kind: 'read', endpoint: ep },
  });
  const ok = check(res, { 'status is 200': (r) => r.status === 200 });
  errors.add(!ok);
  sleep(Math.random() * 0.5 + 0.2);
}

// Opt-in path: the real chat/LLM round-trip. Spends tokens; 429s are expected
// under load (that is blocker #1 doing its job) and are NOT counted as errors.
export function chatPath() {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'How much is the blanket?' }],
    session_key: `loadtest-${__VU}-${__ITER}`,
    section: 'product',
    turns: 1,
  });
  const res = http.post(BASE, body, { headers: HEADERS, tags: { kind: 'chat' } });
  check(res, {
    'not a 5xx': (r) => r.status < 500,
    'served or rate-limited (200/429)': (r) => r.status === 200 || r.status === 429,
  });
  sleep(1);
}
