/**
 * Feierabend — Decke 01 · Commission endpoint (Supabase Edge Function, Deno)
 *
 * DEMO checkout — no payment is collected, ever. A "commission" assigns the
 * next serial number from public.allocation_counter and records a minimal
 * order: email, name, city/state, colorway. No street address, no card data,
 * no payment processor — minimal data, CCPA-minded. Deletion requests go to
 * hello@feierabend.example.
 *
 * Wire contract:
 *   POST <fn> {"name","email","city","state","colorway"}
 *     -> 200 {"serial":14215,"name":"…","colorway":"…","email":"…"}
 *   Errors: JSON {"error":"..."} with CORS headers (400 validation,
 *   405 non-POST, 429 rate limit, 502 register unavailable).
 *
 * Optional Authorization: Bearer <Supabase user JWT> links the order to the
 * signed-in account (invalid/absent tokens simply mean anonymous — never an
 * error). Dependency-free: raw fetch to Auth + PostgREST RPC; no supabase-js.
 */

// ── Environment ──────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// ── CORS ─────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  let allowOrigin = "";
  if (ALLOWED_ORIGINS.includes("*")) allowOrigin = origin || "*";
  else if (origin && ALLOWED_ORIGINS.includes(origin)) allowOrigin = origin;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return headers;
}

function jsonResponse(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function jsonError(req: Request, status: number, message: string): Response {
  return jsonResponse(req, status, { error: message });
}

// ── Rate limiting — in-memory sliding window per client IP ───────────────────

const RATE_LIMIT = 10; // requests
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const hits = new Map<string, number[]>(); // ip -> request timestamps

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  // Prune stale entries across the whole map so it can't grow unbounded.
  for (const [key, times] of hits) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
  }
  const recent = hits.get(ip) ?? [];
  if (recent.length >= RATE_LIMIT) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// ── Validation ───────────────────────────────────────────────────────────────

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
]);

const COLORWAYS = new Set(["ungefaerbt", "loden", "graphit"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface Commission {
  name: string; email: string; address: string; address2: string;
  city: string; state: string; zip: string; colorway: string;
}

function validateBody(body: unknown): Commission | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  const raw = body as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = str(raw.name);
  const email = str(raw.email);
  const address = str(raw.address);
  const address2 = str(raw.address2);
  const city = str(raw.city);
  const state = str(raw.state);
  const zip = str(raw.zip);
  const colorway = str(raw.colorway);

  if (name.length < 1 || name.length > 80) {
    return "name must be 1 to 80 characters.";
  }
  if (email.length > 120 || !EMAIL_RE.test(email)) {
    return "email must be a valid address of at most 120 characters.";
  }
  if (address.length < 4 || address.length > 120) {
    return "address must be 4 to 120 characters.";
  }
  if (address2.length > 120) {
    return "address2 must be at most 120 characters.";
  }
  if (city.length < 1 || city.length > 80) {
    return "city must be 1 to 80 characters.";
  }
  if (!/^[A-Z]{2}$/.test(state) || !US_STATES.has(state)) {
    return "state must be a two-letter US state code (or DC), uppercase.";
  }
  if (!/^\d{5}(-\d{4})?$/.test(zip)) {
    return "zip must be a 5-digit US ZIP code (ZIP+4 accepted).";
  }
  if (!COLORWAYS.has(colorway)) {
    return "colorway must be one of: ungefaerbt, loden, graphit.";
  }
  return { name, email, address, address2, city, state, zip, colorway };
}

// ── Optional signed-in linkage — verify Supabase Auth JWT ────────────────────

/** Verified user id, or null (absent / anon key / invalid — never errors). */
async function verifyUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7).trim();
  // The anon (or service) key arriving as the bearer means "not signed in".
  if (!token || token === ANON_KEY || token === SERVICE_KEY) return null;
  if (!SUPABASE_URL || !ANON_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "apikey": ANON_KEY, "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json() as Record<string, unknown>;
    return typeof user?.id === "string" ? user.id : null;
  } catch { return null; }
}

// ── RPC — commission_order via PostgREST with the service role ───────────────

/** Calls public.commission_order; returns the serial, or null on any failure. */
async function commissionOrder(c: Commission, userId: string | null): Promise<number | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/commission_order`, {
      method: "POST",
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_email: c.email,
        p_name: c.name,
        p_address: c.address,
        p_address2: c.address2,
        p_city: c.city,
        p_state: c.state,
        p_zip: c.zip,
        p_colorway: c.colorway,
        p_user_id: userId,
      }),
    });
    if (!res.ok) return null;
    const serial = await res.json() as unknown;
    return typeof serial === "number" && Number.isInteger(serial) ? serial : null;
  } catch { return null; }
}

// ── Entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("next")) {
    // Public: the next serial to be assigned — keeps the page's number honest.
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/allocation_counter?select=next_serial&id=eq.1`,
        { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
      );
      const rows = res.ok ? await res.json() as Array<{ next_serial: number }> : [];
      const next = rows.length > 0 ? rows[0].next_serial : null;
      if (typeof next === "number") {
        return jsonResponse(req, 200, { next_serial: next });
      }
    } catch { /* fall through */ }
    return jsonError(req, 502, "Counter unavailable.");
  }
  if (req.method !== "POST") {
    return jsonError(req, 405, "Method not allowed. Use POST, or GET ?next=1.");
  }

  // Rate limit: 10 requests / 10 minutes per x-forwarded-for IP.
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    return jsonError(req, 429,
      "Too many requests. The register takes a short pause — try again in a few minutes.");
  }

  // Body validation.
  let parsed: unknown;
  try { parsed = await req.json(); } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const validated = validateBody(parsed);
  if (typeof validated === "string") return jsonError(req, 400, validated);

  // Optional signed-in linkage (anonymous on absent/invalid token).
  const userId = await verifyUserId(req);

  // Assign the serial and record the order.
  const serial = await commissionOrder(validated, userId);
  if (serial === null) {
    return jsonError(req, 502,
      "The register is briefly unavailable. Nothing was recorded — try again.");
  }

  return jsonResponse(req, 200, {
    serial,
    name: validated.name,
    colorway: validated.colorway,
    email: validated.email,
  });
});
