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
 *   POST <fn> {"name","email","city","state","colorway","session_key"?}
 *     -> 200 {"serial":14215,"name":"…","colorway":"…","email":"…"}
 *   POST <fn>?hold=1 {"session_key"} -> 200 {"serial":14216,"expires_at":"…"}
 *     or 200 {"sold_out":true} when every number is held/claimed right now.
 *     The hold reserves the shown number for the visit (10-min TTL, refresh
 *     by calling again); the commission consumes it, so shown == recorded.
 *   Errors: JSON {"error":"..."} with CORS headers (400 validation,
 *   405 non-POST, 409 run fully spoken for, 429 rate limit,
 *   502 register unavailable).
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

const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const hits = new Map<string, number[]>(); // key -> request timestamps

/** Sliding-window limiter; holds get their own, roomier budget per IP. */
function rateLimited(key: string, limit: number): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  // Prune stale entries across the whole map so it can't grow unbounded.
  for (const [k, times] of hits) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length === 0) hits.delete(k);
    else hits.set(k, fresh);
  }
  const recent = hits.get(key) ?? [];
  if (recent.length >= limit) return true;
  recent.push(now);
  hits.set(key, recent);
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

interface Billing {
  address: string; address2: string; city: string; state: string; zip: string;
}

interface Commission {
  name: string; email: string; address: string; address2: string;
  city: string; state: string; zip: string; colorway: string;
  recipient: string; isGift: boolean; billing: Billing | null;
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
  const recipient = str(raw.recipient);
  const isGift = raw.is_gift === true;
  if (recipient.length > 80) {
    return "recipient must be at most 80 characters.";
  }
  if (isGift && recipient.length < 2) {
    return "recipient is required when is_gift is true.";
  }

  // Billing: optional, all-or-nothing; stored only when it differs.
  let billing: Billing | null = null;
  if (raw.billing !== undefined && raw.billing !== null) {
    if (typeof raw.billing !== "object" || Array.isArray(raw.billing)) {
      return "billing, if provided, must be an object.";
    }
    const b = raw.billing as Record<string, unknown>;
    const bAddress = str(b.address);
    const bAddress2 = str(b.address2);
    const bCity = str(b.city);
    const bState = str(b.state);
    const bZip = str(b.zip);
    if (bAddress.length < 4 || bAddress.length > 120) {
      return "billing.address must be 4 to 120 characters.";
    }
    if (bAddress2.length > 120) {
      return "billing.address2 must be at most 120 characters.";
    }
    if (bCity.length < 1 || bCity.length > 80) {
      return "billing.city must be 1 to 80 characters.";
    }
    if (!/^[A-Z]{2}$/.test(bState) || !US_STATES.has(bState)) {
      return "billing.state must be a two-letter US state code (or DC), uppercase.";
    }
    if (!/^\d{5}(-\d{4})?$/.test(bZip)) {
      return "billing.zip must be a 5-digit US ZIP code (ZIP+4 accepted).";
    }
    billing = { address: bAddress, address2: bAddress2, city: bCity, state: bState, zip: bZip };
  }
  return { name, email, address, address2, city, state, zip, colorway, recipient, isGift, billing };
}

// ── Optional signed-in linkage — verify Supabase Auth JWT ────────────────────

interface VerifiedUser { id: string; email: string | null }

/** Verified user, or null (absent / anon key / invalid — never errors). */
async function verifyUser(req: Request): Promise<VerifiedUser | null> {
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
    if (typeof user?.id !== "string") return null;
    return { id: user.id, email: typeof user.email === "string" ? user.email : null };
  } catch { return null; }
}

// ── Session keys — a visit's identity for holds (opaque, client-generated) ───

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

function readSessionKey(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<string, unknown>).session_key;
  return typeof v === "string" && SESSION_RE.test(v) ? v : null;
}

// ── Standing — the patron's place in the Webbuch ─────────────────────────────

function standingTier(n: number): string {
  if (n >= 5) return "Stifter";
  if (n >= 3) return "Hausfreund";
  if (n === 2) return "Wiederkehr";
  return "Eintrag";
}

/** Orders on the register for this buyer (id OR verified email), sans cancelled. */
async function orderCount(userId: string, email: string | null): Promise<number | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const safeEmail = email?.replace(/["\\,()]/g, "");
  const filter = safeEmail
    ? `or=${encodeURIComponent(`(user_id.eq.${userId},email.eq."${safeEmail}")`)}`
    : `user_id=eq.${encodeURIComponent(userId)}`;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?select=serial&${filter}&status=neq.cancelled`,
      {
        headers: {
          "apikey": SERVICE_KEY,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Prefer": "count=exact",
          "Range": "0-0",
        },
      },
    );
    if (!res.ok) return null;
    const range = res.headers.get("content-range") ?? "";
    const total = parseInt(range.split("/")[1] ?? "", 10);
    return Number.isFinite(total) ? total : null;
  } catch { return null; }
}

// ── RPCs via PostgREST with the service role ─────────────────────────────────

const RPC_HEADERS = {
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** Calls public.hold_serial; {serial, expires_at}, "sold out" (empty), or null on failure. */
async function holdSerial(session: string): Promise<{ serial: number; expires_at: string } | "sold_out" | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hold_serial`, {
      method: "POST",
      headers: RPC_HEADERS,
      body: JSON.stringify({ p_session: session }),
    });
    if (!res.ok) return null;
    const rows = await res.json() as Array<{ o_serial: number; o_expires_at: string }>;
    if (!Array.isArray(rows) || rows.length === 0) return "sold_out";
    const row = rows[0];
    return typeof row?.o_serial === "number"
      ? { serial: row.o_serial, expires_at: String(row.o_expires_at ?? "") }
      : null;
  } catch { return null; }
}

/** Calls public.commission_order; the serial, -1 (run fully spoken for),
 *  or null on failure. Falls back to the pre-holds 9-parameter signature so
 *  a freshly deployed function still works against a not-yet-migrated DB. */
async function commissionOrder(
  c: Commission, userId: string | null, session: string | null,
): Promise<number | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const legacyArgs: Record<string, unknown> = {
    p_email: c.email,
    p_name: c.name,
    p_address: c.address,
    p_address2: c.address2,
    p_city: c.city,
    p_state: c.state,
    p_zip: c.zip,
    p_colorway: c.colorway,
    p_user_id: userId,
  };
  const attempts: Record<string, unknown>[] = [
    { ...legacyArgs, p_session: session, p_recipient: c.recipient || null,
      p_is_gift: c.isGift, p_billing: c.billing },
    { ...legacyArgs, p_session: session, p_recipient: c.recipient || null, p_is_gift: c.isGift },
    { ...legacyArgs, p_session: session },
    legacyArgs,
  ];
  for (const args of attempts) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/commission_order`, {
        method: "POST",
        headers: RPC_HEADERS,
        body: JSON.stringify(args),
      });
      if (!res.ok) continue; // signature mismatch pre-migration → try legacy
      const serial = await res.json() as unknown;
      return typeof serial === "number" && Number.isInteger(serial) ? serial : null;
    } catch { /* fall through to the next signature */ }
  }
  return null;
}

// ── Entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("recent")) {
    // Public: the latest register entries — serial, city/state, time only.
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?select=serial,city,state,placed_at&order=placed_at.desc&limit=3`,
        { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
      );
      const rows = res.ok ? await res.json() as unknown[] : [];
      return jsonResponse(req, 200, { orders: rows });
    } catch {
      return jsonError(req, 502, "Register unavailable.");
    }
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
  if (req.method === "GET" && new URL(req.url).searchParams.get("me")) {
    // Signed-in only: the buyer's standing and latest entry, for the welcome.
    const me = await verifyUser(req);
    if (!me) return jsonError(req, 401, "The register takes signed entries.");
    const count = await orderCount(me.id, me.email);
    if (count === null) return jsonError(req, 502, "Register unavailable.");
    let latest: unknown = null;
    try {
      const safeEmail = me.email?.replace(/["\\,()]/g, "");
      const filter = safeEmail
        ? `or=${encodeURIComponent(`(user_id.eq.${me.id},email.eq."${safeEmail}")`)}`
        : `user_id=eq.${encodeURIComponent(me.id)}`;
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?select=serial,status,colorway,name,recipient_name,is_gift,email,address,address2,city,state,zip&${filter}&status=neq.cancelled&order=placed_at.desc&limit=1`,
        { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
      );
      const rows = res.ok ? await res.json() as unknown[] : [];
      latest = rows.length > 0 ? rows[0] : null;
    } catch { /* latest stays null */ }
    const res = jsonResponse(req, 200, {
      count, tier: standingTier(count), latest,
    });
    // Personal payload: nothing between the browser and this function caches it.
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  if (req.method !== "POST") {
    return jsonError(req, 405, "Method not allowed. Use POST, or GET ?next=1.");
  }

  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();

  // ── POST ?hold=1 — reserve (or re-confirm) the visit's number ─────────────
  if (new URL(req.url).searchParams.get("hold")) {
    if (rateLimited("h:" + ip, 30)) {
      return jsonError(req, 429, "Too many hold requests — a short pause, please.");
    }
    let holdBody: unknown;
    try { holdBody = await req.json(); } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const session = readSessionKey(holdBody);
    if (!session) {
      return jsonError(req, 400, "session_key must be 8-64 characters of [A-Za-z0-9_-].");
    }
    const hold = await holdSerial(session);
    if (hold === null) return jsonError(req, 502, "The register is briefly unavailable.");
    if (hold === "sold_out") return jsonResponse(req, 200, { sold_out: true });
    return jsonResponse(req, 200, hold);
  }

  // Rate limit: 10 commissions / 10 minutes per x-forwarded-for IP.
  if (rateLimited(ip, 10)) {
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
  const session = readSessionKey(parsed);

  // The register takes signed entries only: a verified magic-link session is
  // required, and the verified email is the one recorded — not the typed one.
  const customer = await verifyUser(req);
  if (!customer) {
    return jsonError(req, 401,
      "The register takes signed entries. Verify your email first — the key arrives by mail.");
  }
  if (customer.email) validated.email = customer.email;

  // Assign the serial and record the order (consuming the visit's hold).
  const serial = await commissionOrder(validated, customer.id, session);
  if (serial === null) {
    return jsonError(req, 502,
      "The register is briefly unavailable. Nothing was recorded — try again.");
  }
  if (serial === -1) {
    return jsonError(req, 409,
      "The year's run is fully spoken for at this moment. The 2027 waitlist stands open.");
  }

  const count = await orderCount(customer.id, customer.email);
  return jsonResponse(req, 200, {
    serial,
    name: validated.name,
    colorway: validated.colorway,
    email: validated.email,
    standing: count !== null ? { count, tier: standingTier(count) } : null,
  });
});
