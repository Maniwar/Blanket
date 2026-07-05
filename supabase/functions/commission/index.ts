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
// Transactional email (order confirmation / shipping / cancellation) via Resend.
// Optional: if RESEND_API_KEY is unset, emails are simply skipped (never an error).
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "Feierabend <onboarding@resend.dev>";

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

// ── Rate limiting — DB-backed fixed window (shared across all edge instances),
//    with a per-instance in-memory fallback if the DB/RPC is unreachable ───────

const RATE_WINDOW_SEC = 10 * 60; // 10 minutes
const RATE_WINDOW_MS = RATE_WINDOW_SEC * 1000;
const hits = new Map<string, number[]>(); // key -> timestamps (fallback only)

/** Per-instance sliding window — used only when the shared DB limiter is
 *  unreachable, so an outage still leaves some protection. */
function rateLimitedLocal(key: string, limit: number): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
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

/** Shared, DB-backed limiter (one window across every instance); holds get a
 *  roomier budget per IP. Fails over to the per-instance counter on DB error. */
async function rateLimited(key: string, limit: number): Promise<boolean> {
  if (!SUPABASE_URL || !SERVICE_KEY) return rateLimitedLocal(key, limit);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rate_hit`, {
      method: "POST",
      headers: RPC_HEADERS,
      body: JSON.stringify({ p_key: key, p_limit: limit, p_window_seconds: RATE_WINDOW_SEC }),
    });
    if (!res.ok) return rateLimitedLocal(key, limit);
    return (await res.json()) === true;
  } catch {
    return rateLimitedLocal(key, limit);
  }
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

/** The concierge conversation key, when the buyer chatted this visit. */
function readChatSession(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<string, unknown>).chat_session;
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

// ── Transactional email ──────────────────────────────────────────────────────

const COLORWAY_NAME: Record<string, string> = {
  ungefaerbt: "Ungefärbt", loden: "Loden", graphit: "Graphit",
};

/** Best-effort email via Resend's API. Never throws; skips if unconfigured. */
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_API_KEY || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    });
  } catch { /* email never breaks the order path */ }
}

function emailShell(heading: string, lines: string[]): string {
  const body = lines.filter(Boolean).map((l) =>
    `<tr><td style="padding:0 34px 14px;font-family:Helvetica,Arial,sans-serif;color:#c9c3b6;font-size:14px;line-height:1.6;">${l}</td></tr>`
  ).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1c211d;margin:0;padding:32px 0;"><tr><td align="center">` +
    `<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="width:440px;max-width:92%;background:#232a25;border:1px solid #3a4139;border-radius:14px;overflow:hidden;">` +
    `<tr><td style="padding:30px 34px 4px;font-family:Georgia,serif;color:#f1ece2;font-size:26px;letter-spacing:.5px;">Feierabend</td></tr>` +
    `<tr><td style="padding:0 34px 20px;font-family:'Courier New',monospace;color:#c49b5b;font-size:10px;letter-spacing:3px;text-transform:uppercase;">Weberei Brandt · Est. 1897</td></tr>` +
    `<tr><td style="padding:0 34px;border-top:1px solid #3a4139;"></td></tr>` +
    `<tr><td style="padding:24px 34px 8px;font-family:Georgia,serif;color:#f1ece2;font-size:19px;line-height:1.35;">${heading}</td></tr>` +
    body +
    `<tr><td style="padding:12px 34px 24px;border-top:1px solid #3a4139;font-family:Helvetica,Arial,sans-serif;color:#7f7a6e;font-size:11px;line-height:1.6;">An automated note from the mill's register. This is a demo — nothing ships and no payment is taken. hello@feierabend.example</td></tr>` +
    `</table></td></tr></table>`;
}

interface OrderRow {
  serial: number | null; email: string; name?: string | null; colorway?: string | null;
  tracking?: string | null; recipient_name?: string | null; is_gift?: boolean; status?: string | null;
  address?: string | null; address2?: string | null; city?: string | null;
  state?: string | null; zip?: string | null;
}

const PRICE_USD = 589; // the edition's fixed price; duties + U.S. delivery included

/** The shipping-address block (or empty if we don't have one). */
function shipToHtml(o: OrderRow): string {
  const lines = [
    o.name,
    o.address,
    o.address2,
    [o.city, o.state].filter(Boolean).join(", ") + (o.zip ? " " + o.zip : ""),
  ].map((s) => (s ?? "").trim()).filter(Boolean);
  if (lines.length <= 1) return ""; // nothing but a name — skip
  const rows = lines.map((l) =>
    `<span style="display:block;color:#c9c3b6;">${l}</span>`
  ).join("");
  const gift = o.is_gift && o.recipient_name
    ? `<span style="display:block;color:#c49b5b;margin-top:6px;">A gift — the card carries ${o.recipient_name}'s name.</span>`
    : "";
  return `<span style="display:block;font-family:'Courier New',monospace;color:#7f7a6e;font-size:10px;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">Ship to</span>${rows}${gift}`;
}

/** The itemized order summary (item · price · duties · total). */
function orderSummaryHtml(o: OrderRow): string {
  const no = "Nº " + Number(o.serial).toLocaleString("en-US");
  const cw = o.colorway && COLORWAY_NAME[o.colorway] ? COLORWAY_NAME[o.colorway] : "—";
  const price = "$" + PRICE_USD.toLocaleString("en-US");
  const cell = "font-family:Helvetica,Arial,sans-serif;font-size:13px;";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #3a4139;border-radius:8px;">` +
    `<tr><td style="padding:12px 14px 4px;${cell}color:#e7e1d4;">Decke 01 — ${cw}<br><span style="color:#9a9484;font-size:11px;">${no} · woven to order</span></td>` +
    `<td align="right" style="padding:12px 14px 4px;${cell}color:#e7e1d4;white-space:nowrap;">${price}</td></tr>` +
    `<tr><td style="padding:0 14px 12px;${cell}color:#9a9484;font-size:12px;">Duties &amp; U.S. delivery</td>` +
    `<td align="right" style="padding:0 14px 12px;${cell}color:#9a9484;font-size:12px;white-space:nowrap;">Included</td></tr>` +
    `<tr><td style="padding:10px 14px;border-top:1px solid #3a4139;${cell}color:#f1ece2;font-weight:bold;">Total</td>` +
    `<td align="right" style="padding:10px 14px;border-top:1px solid #3a4139;${cell}color:#f1ece2;font-weight:bold;white-space:nowrap;">${price}</td></tr>` +
    `</table>`;
}

function orderEmail(
  kind: "placed" | "shipped" | "cancelled", o: OrderRow,
): { subject: string; html: string } {
  const no = "Nº " + Number(o.serial).toLocaleString("en-US");
  const first = (o.name ?? "").trim().split(/\s+/)[0] || "";
  const greet = first ? `${first},` : "Guten Tag,";
  const cloth = o.colorway && COLORWAY_NAME[o.colorway] ? ` in ${COLORWAY_NAME[o.colorway]}` : "";
  if (kind === "placed") {
    return {
      subject: `${no} is entered in the Webbuch`,
      html: emailShell("Your number is entered", [
        `${greet} thank you — <strong>${no}</strong>${cloth} is entered in the Webbuch under your name.`,
        orderSummaryHtml(o),
        shipToHtml(o),
        "It is woven to order — <strong>3–5 weeks</strong> to your door. When it ships, the tracking will appear in your register and in a note from us.",
        "This is a concept demonstration: <strong>nothing was charged and nothing ships</strong>. The total above is shown only to make the confirmation feel real.",
      ]),
    };
  }
  if (kind === "shipped") {
    return {
      subject: `${no} is on its way`,
      html: emailShell("On its way", [
        `${greet} <strong>${no}</strong> has left the mill.`,
        o.tracking ? `Tracking: <strong>${o.tracking}</strong>` : "Your tracking number is now in your register.",
        "Woven to order, sealed by hand. We hope it lands well.",
      ]),
    };
  }
  return {
    subject: `${no} — cancelled`,
    html: emailShell("Struck from the register", [
      `${greet} <strong>${no}</strong> has been cancelled, and the number returns to the edition.`,
      "Nothing was charged — this is a demo. If it was in error, write to us and we'll set it right.",
    ]),
  };
}

// ── Admin helpers (for fulfillment) ──────────────────────────────────────────

async function isAdmin(email: string | null): Promise<boolean> {
  if (!email) return false;
  try {
    const safe = email.replace(/["\\,()]/g, "");
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/concierge_admins?select=email&email=eq.${encodeURIComponent(email)}`,
      { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
    );
    if (!res.ok) return false;
    const rows = await res.json() as unknown[];
    void safe;
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

async function fetchOrder(serial: number): Promise<OrderRow | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?select=serial,email,name,colorway,tracking,recipient_name,is_gift,status&serial=eq.${serial}&limit=1`,
      { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json() as OrderRow[];
    return rows.length > 0 ? rows[0] : null;
  } catch { return null; }
}

async function patchOrder(serial: number, patch: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?serial=eq.${serial}`, {
      method: "PATCH", headers: RPC_HEADERS, body: JSON.stringify(patch),
    });
    return res.ok;
  } catch { return false; }
}

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
        `${SUPABASE_URL}/rest/v1/allocation_counter?select=next_serial,run_size&id=eq.1`,
        { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
      );
      const rows = res.ok ? await res.json() as Array<{ next_serial: number; run_size: number }> : [];
      const next = rows.length > 0 ? rows[0].next_serial : null;
      const run = rows.length > 0 ? rows[0].run_size : null;
      if (typeof next === "number") {
        return jsonResponse(req, 200, {
          next_serial: next,
          run_size: typeof run === "number" ? run : null,
          remaining: typeof run === "number" ? Math.max(run - (next - 1), 0) : null,
        });
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
    if (await rateLimited("h:" + ip, 30)) {
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

  // ── POST ?waitlist=1 — join the waitlist (sold-out form, or the concierge) ──
  if (new URL(req.url).searchParams.get("waitlist")) {
    if (await rateLimited("w:" + ip, 10)) {
      return jsonError(req, 429, "A short pause, please — try again in a moment.");
    }
    let wb: Record<string, unknown>;
    try { wb = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const email = s(wb.email).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) {
      return jsonError(req, 400, "A valid email is required.");
    }
    const cw = s(wb.colorway).toLowerCase();
    const source = ["sold_out", "concierge", "form"].includes(s(wb.source)) ? s(wb.source) : "form";
    const user = await verifyUser(req);
    const row = {
      email,
      name: s(wb.name).slice(0, 80) || null,
      colorway: COLORWAYS.has(cw) ? cw : null,
      note: s(wb.note).slice(0, 400) || null,
      source,
      user_id: user?.id ?? null,
    };
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
        method: "POST",
        headers: { ...RPC_HEADERS, "Prefer": "return=minimal" },
        body: JSON.stringify(row),
      });
      if (!res.ok) return jsonError(req, 502, "Could not record that just now — try again.");
    } catch {
      return jsonError(req, 502, "Could not record that just now — try again.");
    }
    return jsonResponse(req, 200, { ok: true });
  }

  // ── POST ?fulfill=1 — admin advances an order and (on ship) notifies ──────
  if (new URL(req.url).searchParams.get("fulfill")) {
    const admin = await verifyUser(req);
    if (!admin || !(await isAdmin(admin.email))) {
      return jsonError(req, 403, "Administrators only.");
    }
    let fb: Record<string, unknown>;
    try { fb = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const serial = typeof fb.serial === "number" ? Math.floor(fb.serial) : NaN;
    const status = typeof fb.status === "string" ? fb.status : "";
    const trackingRaw = typeof fb.tracking === "string" ? fb.tracking.trim().slice(0, 120) : null;
    const ALLOWED = ["placed", "weaving", "finishing", "shipped", "delivered", "returned"];
    if (!Number.isFinite(serial) || !ALLOWED.includes(status)) {
      return jsonError(req, 400, "serial (number) and a valid status are required.");
    }
    const before = await fetchOrder(serial);
    if (!before) return jsonError(req, 404, `No order Nº ${serial} on the register.`);
    const patch: Record<string, unknown> = { status };
    if (trackingRaw !== null) patch.tracking = trackingRaw || null;
    if (!(await patchOrder(serial, patch))) {
      return jsonError(req, 502, "The register could not be updated. Nothing was changed.");
    }
    // Notify the buyer when it ships or is struck (best-effort).
    if (status === "shipped" || status === "returned") {
      const kind = status === "shipped" ? "shipped" : "cancelled";
      const mail = orderEmail(kind, { ...before, tracking: trackingRaw ?? before.tracking });
      const p = sendEmail(before.email, mail.subject, mail.html);
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (x: Promise<unknown>) => void } }).EdgeRuntime;
      if (typeof er?.waitUntil === "function") er.waitUntil(p); else p.catch(() => {});
    }
    return jsonResponse(req, 200, { ok: true, serial, status, tracking: patch.tracking ?? before.tracking });
  }

  // Rate limit: 10 commissions / 10 minutes per x-forwarded-for IP.
  if (await rateLimited(ip, 10)) {
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
  const chatSession = readChatSession(parsed);

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

  // Attribution: the concierge's commissions are counted (best-effort).
  if (chatSession) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/orders?serial=eq.${serial}`, {
        method: "PATCH",
        headers: RPC_HEADERS,
        body: JSON.stringify({ chat_session: chatSession }),
      });
    } catch { /* the order stands either way */ }
  }

  // Order-confirmation email (best-effort; never blocks the response).
  {
    const mail = orderEmail("placed", {
      serial, email: validated.email, name: validated.name, colorway: validated.colorway,
      recipient_name: validated.recipient || null, is_gift: !!validated.isGift,
      address: validated.address, address2: validated.address2, city: validated.city,
      state: validated.state, zip: validated.zip,
    });
    const p = sendEmail(validated.email, mail.subject, mail.html);
    if (typeof (globalThis as { EdgeRuntime?: { waitUntil?: (x: Promise<unknown>) => void } }).EdgeRuntime
      ?.waitUntil === "function") {
      (globalThis as { EdgeRuntime: { waitUntil: (x: Promise<unknown>) => void } }).EdgeRuntime
        .waitUntil(p);
    } else { p.catch(() => {}); }
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
