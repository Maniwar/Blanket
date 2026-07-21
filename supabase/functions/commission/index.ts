/**
 * Feierabend — Decke 01 · Commission endpoint (Supabase Edge Function, Deno)
 *
 * DEMO checkout — no payment is collected, ever. A "commission" assigns the
 * next serial number from public.allocation_counter and records a minimal
 * order: email, name, city/state, colorway. No street address, no card data,
 * no payment processor — minimal data, CCPA-minded. Deletion requests go to
 * concierge@feier-abend.co.
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
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "Feierabend <concierge@feier-abend.co>";

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

// A companion piece as the CLIENT proposes it. Name + price are NOT taken from the
// client — they are resolved from the catalog server-side (resolveAddonLines), so
// the AOV the dashboard reports can never be inflated by a tampered payload.
interface ClientAddon {
  slug: string; colorway: string | null; qty: number; addedBy: string;
}

interface Commission {
  name: string; email: string; address: string; address2: string;
  city: string; state: string; zip: string; colorway: string;
  recipient: string; isGift: boolean; billing: Billing | null;
  addons: ClientAddon[];
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

  // Optional add-on lines. Validated leniently — a malformed line is dropped, never
  // a reason to reject the whole commission. Only slug / colorway / qty / attribution
  // come from the client; name and price are resolved from the catalog server-side.
  const addons: ClientAddon[] = [];
  if (Array.isArray(raw.addons)) {
    for (const item of raw.addons.slice(0, 12)) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const a = item as Record<string, unknown>;
      const slug = str(a.slug).toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) continue;
      const cw = str(a.colorway).toLowerCase();
      const colorway = COLORWAYS.has(cw) ? cw : null;
      const qtyNum = typeof a.qty === "number" ? a.qty : parseInt(str(a.qty), 10);
      const qty = Number.isFinite(qtyNum) ? Math.min(20, Math.max(1, Math.round(qtyNum))) : 1;
      const by = str(a.added_by);
      const addedBy = (by === "concierge" || by === "customer" || by === "page") ? by : "customer";
      if (!addons.some((x) => x.slug === slug)) addons.push({ slug, colorway, qty, addedBy });
    }
  }
  return { name, email, address, address2, city, state, zip, colorway, recipient, isGift, billing, addons };
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

/** Attribution tier: 'concierge' (checkout opened from the concierge's own
 * commission button — causal) vs 'ambient' (a chat existed this session —
 * co-occurrence). Anything else is dropped. */
function readChatVia(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<string, unknown>).chat_via;
  return v === "concierge" || v === "ambient" ? v : null;
}

/** Commission-click context ({entry, section, turns}) — whitelisted keys only,
 * bounded values, so nothing free-form lands on the order row. */
function readChatMeta(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as Record<string, unknown>).chat_meta;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof m.entry === "string" && m.entry.length <= 40 && /^[a-z0-9:_-]+$/i.test(m.entry)) out.entry = m.entry;
  if (typeof m.section === "string" && m.section.length <= 32 && /^[a-z0-9_-]+$/i.test(m.section)) out.section = m.section;
  if (typeof m.turns === "number" && Number.isFinite(m.turns) && m.turns >= 0) out.turns = Math.min(Math.floor(m.turns), 999);
  return Object.keys(out).length > 0 ? out : null;
}

// ── Standing — the patron's place in the Webbuch ─────────────────────────────

function standingTier(n: number): string {
  if (n >= 5) return "Stifter";
  if (n >= 3) return "Hausfreund";
  if (n === 2) return "Wiederkehr";
  return "Eintrag";
}

// ── Address book — distinct ship-to addresses from the buyer's order history ──
// One entry per unique (address + city + zip + recipient). A gift entry keeps the
// recipient's name so the checkout can re-address "send Oma another" in one tap;
// a personal entry is the buyer's own door. Newest-first, capped for a lean payload.
type AddressEntry = {
  key: string; label: string; is_gift: boolean; recipient_name: string | null;
  name: string; address: string; address2: string; city: string; state: string; zip: string;
};
function deriveAddressBook(rows: Array<Record<string, unknown>>): AddressEntry[] {
  const seen = new Set<string>();
  const out: AddressEntry[] = [];
  for (const r of rows) {
    const address = String(r.address ?? "").trim();
    const city = String(r.city ?? "").trim();
    if (!address || !city) continue;                 // a real ship-to only
    const zip = String(r.zip ?? "").trim();
    const isGift = r.is_gift === true;
    const recip = isGift ? (String(r.recipient_name ?? "").trim() || null) : null;
    const key = [address.toLowerCase(), city.toLowerCase(), zip.toLowerCase(), (recip ?? "").toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: isGift ? (recip ?? "A gift") : "Home",
      is_gift: isGift,
      recipient_name: recip,
      name: String(r.name ?? "").trim(),
      address,
      address2: String(r.address2 ?? "").trim(),
      city,
      state: String(r.state ?? "").trim(),
      zip,
    });
    if (out.length >= 8) break;
  }
  return out;
}

// Distinct BILLING addresses from history (orders.billing jsonb), for the "billing
// differs" picker. Same shape as the ship-to book so the client reuses one renderer.
function deriveBillingBook(rows: Array<Record<string, unknown>>): AddressEntry[] {
  const seen = new Set<string>();
  const out: AddressEntry[] = [];
  for (const r of rows) {
    const b = r.billing;
    if (!b || typeof b !== "object") continue;
    const bb = b as Record<string, unknown>;
    const address = String(bb.address ?? "").trim();
    const city = String(bb.city ?? "").trim();
    if (!address || !city) continue;
    const zip = String(bb.zip ?? "").trim();
    const key = [address.toLowerCase(), city.toLowerCase(), zip.toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key, label: "Billing", is_gift: false, recipient_name: null,
      name: String(r.name ?? "").trim(),
      address, address2: String(bb.address2 ?? "").trim(), city,
      state: String(bb.state ?? "").trim(), zip,
    });
    if (out.length >= 8) break;
  }
  return out;
}

// ── Managed address book (customer_addresses) ────────────────────────────────
// Real, editable/removable addresses (distinct from the derived view). Patron
// access is brokered here with the service role + verified-JWT ownership checks.
type SavedAddress = {
  id: string; label: string; is_gift: boolean; recipient_name: string | null;
  address: string; address2: string; city: string; state: string; zip: string;
};
function ownFilter(userId: string, email: string | null): string {
  const safeEmail = email?.replace(/["\\,()]/g, "");
  return safeEmail
    ? `or=${encodeURIComponent(`(user_id.eq.${userId},email.eq."${safeEmail}")`)}`
    : `user_id=eq.${encodeURIComponent(userId)}`;
}
function savedKey(a: { address: string; city: string; zip: string; recipient_name?: string | null; is_gift?: boolean }): string {
  return [a.address.toLowerCase(), a.city.toLowerCase(), a.zip.toLowerCase(),
    (a.is_gift ? (a.recipient_name ?? "") : "").toLowerCase()].join("|");
}
async function fetchSaved(userId: string, email: string | null): Promise<SavedAddress[]> {
  if (!SUPABASE_URL || !SERVICE_KEY) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/customer_addresses?select=id,label,is_gift,recipient_name,address,address2,city,state,zip&${ownFilter(userId, email)}&order=created_at.desc&limit=60`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (!res.ok) return [];
    const rows = await res.json() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id), label: String(r.label ?? ""), is_gift: r.is_gift === true,
      recipient_name: r.recipient_name ? String(r.recipient_name) : null,
      address: String(r.address ?? ""), address2: String(r.address2 ?? ""),
      city: String(r.city ?? ""), state: String(r.state ?? ""), zip: String(r.zip ?? ""),
    }));
  } catch { return []; }
}
/** Insert one address unless the patron already has that (address+city+zip+recipient). */
async function insertSaved(userId: string | null, email: string | null, a: {
  label?: string; is_gift?: boolean; recipient_name?: string | null;
  address: string; address2?: string; city: string; state: string; zip: string;
}, existing: SavedAddress[]): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY || !a.address || !a.city) return;
  const key = savedKey({ address: a.address, city: a.city, zip: a.zip, recipient_name: a.recipient_name ?? null, is_gift: !!a.is_gift });
  if (existing.some((e) => savedKey(e) === key)) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/customer_addresses`, {
      method: "POST",
      headers: { ...RPC_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId, email,
        label: (a.label && a.label.trim()) || (a.is_gift ? (a.recipient_name ?? "Gift") : "Home"),
        is_gift: !!a.is_gift, recipient_name: a.is_gift ? (a.recipient_name ?? null) : null,
        address: a.address, address2: a.address2 ?? null, city: a.city, state: a.state, zip: a.zip,
      }),
    });
    existing.push({ id: "", label: a.label ?? "", is_gift: !!a.is_gift, recipient_name: a.recipient_name ?? null, address: a.address, address2: a.address2 ?? "", city: a.city, state: a.state, zip: a.zip });
  } catch { /* best-effort */ }
}
/** The patron's book, backfilled from order history the first time it's empty. */
async function savedBook(userId: string, email: string | null): Promise<SavedAddress[]> {
  let list = await fetchSaved(userId, email);
  if (list.length > 0) return list;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?select=name,recipient_name,is_gift,address,address2,city,state,zip,billing,placed_at&${ownFilter(userId, email)}&status=neq.cancelled&order=placed_at.desc&limit=30`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    const rows = res.ok ? await res.json() as Array<Record<string, unknown>> : [];
    const acc: SavedAddress[] = [];
    for (const a of deriveAddressBook(rows)) {
      await insertSaved(userId, email, {
        label: a.label, is_gift: a.is_gift, recipient_name: a.recipient_name,
        address: a.address, address2: a.address2, city: a.city, state: a.state, zip: a.zip,
      }, acc);
    }
    for (const a of deriveBillingBook(rows)) {
      await insertSaved(userId, email, {
        label: "Billing", is_gift: false, recipient_name: null,
        address: a.address, address2: a.address2, city: a.city, state: a.state, zip: a.zip,
      }, acc);
    }
  } catch { /* leave empty on failure */ }
  list = await fetchSaved(userId, email);
  return list;
}
/** Validate address fields for a save; a clean object or an error string. */
function cleanAddr(raw: Record<string, unknown>): string | {
  label: string; is_gift: boolean; recipient_name: string | null;
  address: string; address2: string; city: string; state: string; zip: string;
} {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const address = str(raw.address), city = str(raw.city), state = str(raw.state).toUpperCase(), zip = str(raw.zip);
  const address2 = str(raw.address2), label = str(raw.label).slice(0, 60);
  const isGift = raw.is_gift === true;
  const recipient = isGift ? str(raw.recipient_name).slice(0, 80) : "";
  if (address.length < 4 || address.length > 120) return "Street address must be 4 to 120 characters.";
  if (address2.length > 120) return "Apt/suite must be at most 120 characters.";
  if (city.length < 1 || city.length > 80) return "City must be 1 to 80 characters.";
  if (!/^[A-Z]{2}$/.test(state) || !US_STATES.has(state)) return "State must be a two-letter US state code.";
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return "ZIP must be a 5-digit US ZIP code.";
  return { label, is_gift: isGift, recipient_name: recipient || null, address, address2, city, state, zip };
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

/** A companion piece as the RPC persists it — name + price snapshotted from the
 *  authoritative catalog, colorway resolved, qty clamped, attribution carried. */
interface AddonRpcLine {
  slug: string; name: string; price_cents: number;
  colorway: string | null; qty: number; added_by: string;
}

/** Enrich the client's add-on lines with the AUTHORITATIVE catalog (?catalog=1 on
 *  the concierge function), so name + price come from the shelf, never the payload —
 *  the AOV the dashboard reports is trustworthy. Unknown slugs are dropped; on a
 *  catalog-fetch failure the lines are dropped too (the cloth still enters the
 *  register). Variant pieces inherit the order's colorway when none was chosen. */
async function resolveAddonLines(
  addons: ClientAddon[], orderColorway: string,
): Promise<AddonRpcLine[]> {
  if (!addons.length || !SUPABASE_URL) return [];
  let catalog: Array<Record<string, unknown>> = [];
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/concierge?catalog=1`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    if (res.ok) {
      const j = await res.json() as { addons?: Array<Record<string, unknown>> };
      if (Array.isArray(j.addons)) catalog = j.addons;
    }
  } catch { /* no catalog reachable — drop the add-ons, keep the order */ }
  if (!catalog.length) return [];
  const bySlug = new Map<string, Record<string, unknown>>();
  for (const c of catalog) {
    const s = String(c.slug ?? "").toLowerCase();
    if (s) bySlug.set(s, c);
  }
  const out: AddonRpcLine[] = [];
  for (const a of addons) {
    const c = bySlug.get(a.slug);
    if (!c) continue;
    const variants = c.variants === true;
    const cw = variants ? (a.colorway ?? (COLORWAYS.has(orderColorway) ? orderColorway : null)) : null;
    out.push({
      slug: a.slug,
      name: String(c.name ?? a.slug).slice(0, 120),
      price_cents: Math.max(0, Math.round(Number(c.price_cents) || 0)),
      colorway: cw,
      qty: a.qty,
      added_by: a.addedBy,
    });
  }
  return out;
}

/** Calls public.commission_order; the serial, -1 (run fully spoken for),
 *  or null on failure. Falls back to the pre-holds 9-parameter signature so
 *  a freshly deployed function still works against a not-yet-migrated DB. */
async function commissionOrder(
  c: Commission, userId: string | null, session: string | null,
): Promise<number | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const addonLines = await resolveAddonLines(c.addons, c.colorway);
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
    // Preferred: the add-on-aware signature. If the DB isn't migrated yet the RPC
    // 404s on this arg set and we fall through to the order-only signature below —
    // the cloth still enters the register (add-ons resume once the DB catches up).
    { ...legacyArgs, p_session: session, p_recipient: c.recipient || null,
      p_is_gift: c.isGift, p_billing: c.billing, p_addons: addonLines.length ? addonLines : null },
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
      if (res.ok) {
        const serial = await res.json() as unknown;
        return typeof serial === "number" && Number.isInteger(serial) ? serial : null;
      }
      // 404 = no function matches THESE args (a pre-migration signature) → try the
      // next signature. Anything else is a REAL error from the RPC itself (a
      // constraint, a raised exception); don't mask it behind legacy attempts —
      // log it so the edge logs show the true cause, and stop.
      if (res.status === 404) continue;
      const body = await res.text().catch(() => "");
      console.error("commission_order failed:", res.status, body.slice(0, 500));
      return null;
    } catch (e) {
      console.error("commission_order fetch error:", e instanceof Error ? e.message : String(e));
    }
  }
  return null;
}

/** Add ONE companion piece to an existing order (the post-order path). Returns the
 *  new line id, -1 when no matching open order is on the owner's register, or null
 *  on failure. The caller has already re-priced `line` from the catalog. */
async function addOrderAddon(
  serial: number, userId: string | null, email: string | null, line: AddonRpcLine,
): Promise<number | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/add_order_addon`, {
      method: "POST",
      headers: RPC_HEADERS,
      body: JSON.stringify({
        p_serial: serial, p_user_id: userId, p_email: email,
        p_slug: line.slug, p_name: line.name, p_price_cents: line.price_cents,
        p_colorway: line.colorway, p_added_by: line.added_by,
      }),
    });
    if (res.ok) {
      const v = await res.json() as unknown;
      return typeof v === "number" && Number.isInteger(v) ? v : null;
    }
    if (res.status === 404) return null; // RPC not migrated yet
    const body = await res.text().catch(() => "");
    console.error("add_order_addon failed:", res.status, body.slice(0, 300));
    return null;
  } catch (e) {
    console.error("add_order_addon fetch error:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

// ── Transactional email ──────────────────────────────────────────────────────

const COLORWAY_NAME: Record<string, string> = {
  ungefaerbt: "Ungefärbt", loden: "Loden", graphit: "Graphit",
};

/** Best-effort email via Resend's API. Never throws. When `meta` is given, the
 *  attempt (success or failure) is recorded in email_log so the admin can see
 *  what was sent and re-send it. */
async function sendEmail(
  to: string, subject: string, html: string,
  meta?: { kind: string; serial?: number | null },
): Promise<void> {
  if (!to) return;
  let ok = false;
  let providerId: string | null = null;
  let error: string | null = null;
  if (!RESEND_API_KEY) {
    error = "email not configured (no RESEND_API_KEY)";
  } else {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
      });
      ok = res.ok;
      const body = await res.json().catch(() => null) as { id?: string; message?: string } | null;
      if (ok) providerId = body?.id ?? null;
      else error = (body?.message ?? `HTTP ${res.status}`).slice(0, 300);
    } catch (e) {
      error = String(e).slice(0, 300);
    }
  }
  if (meta) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/email_log`, {
        method: "POST",
        headers: { ...RPC_HEADERS, "Prefer": "return=minimal" },
        body: JSON.stringify({
          to_email: to, kind: meta.kind, serial: meta.serial ?? null,
          subject, ok, provider_id: providerId, error,
        }),
      });
    } catch { /* logging never breaks the send */ }
  }
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
    `<tr><td style="padding:12px 34px 24px;border-top:1px solid #3a4139;font-family:Helvetica,Arial,sans-serif;color:#7f7a6e;font-size:11px;line-height:1.6;">An automated note from the mill's register. This is a demo — nothing ships and no payment is taken. concierge@feier-abend.co</td></tr>` +
    `</table></td></tr></table>`;
}

interface OrderRow {
  serial: number | null; email: string; name?: string | null; colorway?: string | null;
  tracking?: string | null; recipient_name?: string | null; is_gift?: boolean; status?: string | null;
  address?: string | null; address2?: string | null; city?: string | null;
  state?: string | null; zip?: string | null; placed_at?: string | null; cancelled_at?: string | null;
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

const MS_DAY = 86_400_000;
function fmtEmailDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
// The placement date and the 3–5 week delivery window shown in the confirmation.
// Computed from placed_at when we have it (so a re-sent confirmation shows the
// ORIGINAL date, not today's); falls back to now for the freshly-placed email,
// which is being sent the same instant the row was written.
function orderDates(placedAt?: string | null): { placed: string; deliver: string } {
  let p = placedAt ? new Date(placedAt) : new Date();
  if (isNaN(p.getTime())) p = new Date();
  const lo = new Date(p.getTime() + 21 * MS_DAY); // 3 weeks
  const hi = new Date(p.getTime() + 35 * MS_DAY); // 5 weeks
  const sameMY = lo.getUTCFullYear() === hi.getUTCFullYear() && lo.getUTCMonth() === hi.getUTCMonth();
  // Same month/year → "August 10–24, 2026"; otherwise the two dates in full.
  const deliver = sameMY
    ? lo.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) +
      "–" + hi.getUTCDate() + ", " + hi.getUTCFullYear()
    : fmtEmailDate(lo) + " – " + fmtEmailDate(hi);
  return { placed: fmtEmailDate(p), deliver };
}

function orderEmail(
  kind: "placed" | "shipped" | "cancelled", o: OrderRow,
): { subject: string; html: string } {
  const no = "Nº " + Number(o.serial).toLocaleString("en-US");
  const first = (o.name ?? "").trim().split(/\s+/)[0] || "";
  const greet = first ? `${first},` : "Guten Tag,";
  const cloth = o.colorway && COLORWAY_NAME[o.colorway] ? ` in ${COLORWAY_NAME[o.colorway]}` : "";
  if (kind === "placed") {
    const d = orderDates(o.placed_at);
    return {
      subject: `${no} is entered in the Webbuch`,
      html: emailShell("Your number is entered", [
        `${greet} thank you — <strong>${no}</strong>${cloth} is entered in the Webbuch under your name.`,
        orderSummaryHtml(o),
        shipToHtml(o),
        `Placed <strong>${d.placed}</strong>. It is woven to order — <strong>3–5 weeks</strong> to your door, so look for it around <strong>${d.deliver}</strong>. When it ships, the tracking will appear in your register and in a note from us.`,
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
  const safeDate = (v?: string | null): string => {
    if (!v) return "";
    const dt = new Date(v);
    return isNaN(dt.getTime()) ? "" : fmtEmailDate(dt);
  };
  const placedStr = safeDate(o.placed_at);
  const cancelledStr = safeDate(o.cancelled_at);
  let dateLine = "";
  if (placedStr && cancelledStr) dateLine = `Placed <strong>${placedStr}</strong> · cancelled <strong>${cancelledStr}</strong>.`;
  else if (cancelledStr) dateLine = `Cancelled <strong>${cancelledStr}</strong>.`;
  else if (placedStr) dateLine = `Placed <strong>${placedStr}</strong>.`;
  return {
    subject: `${no} — cancelled`,
    html: emailShell("Struck from the register", [
      `${greet} <strong>${no}</strong> has been cancelled, and the number returns to the edition.`,
      dateLine,
      "Nothing was charged — this is a demo. If it was in error, write to us and we'll set it right.",
    ]),
  };
}

// ── Admin helpers (for fulfillment) ──────────────────────────────────────────

async function isAdmin(email: string | null): Promise<boolean> {
  if (!email) return false;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/concierge_admins?select=email&email=eq.${encodeURIComponent(email)}`,
      { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
    );
    if (!res.ok) return false;
    const rows = await res.json() as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

async function fetchOrder(serial: number): Promise<OrderRow | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?select=serial,email,name,colorway,tracking,recipient_name,is_gift,status,address,address2,city,state,zip,placed_at,cancelled_at&serial=eq.${serial}&limit=1`,
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
    // KEPT entries only: a cancelled order carries a NULL serial (the Nº went
    // back to the pool) and a returned one is struck — neither belongs in the
    // homepage's "recent claims", and a null serial crashed the nav ticker.
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?select=serial,city,state,placed_at&serial=not.is.null&status=not.in.(cancelled,returned)&order=placed_at.desc&limit=3`,
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
    let addresses: AddressEntry[] = [];
    let billingAddresses: AddressEntry[] = [];
    try {
      const safeEmail = me.email?.replace(/["\\,()]/g, "");
      const filter = safeEmail
        ? `or=${encodeURIComponent(`(user_id.eq.${me.id},email.eq."${safeEmail}")`)}`
        : `user_id=eq.${encodeURIComponent(me.id)}`;
      // Pull recent history so the checkout can offer a real address book, not
      // just the single latest ship-to (which bleeds a gift recipient's address
      // into a returning buyer's personal order).
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/orders?select=serial,status,colorway,name,recipient_name,is_gift,email,address,address2,city,state,zip,billing,placed_at&${filter}&status=neq.cancelled&order=placed_at.desc&limit=30`,
        { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
      );
      const rows = res.ok ? await res.json() as Array<Record<string, unknown>> : [];
      latest = rows.length > 0 ? rows[0] : null;
      addresses = deriveAddressBook(rows);
      billingAddresses = deriveBillingBook(rows);
    } catch { /* latest stays null, books empty */ }
    // The managed address book (real, removable). Backfilled from history on first
    // read; the derived `addresses`/`billing_addresses` stay as a fallback.
    const saved = await savedBook(me.id, me.email);
    const res = jsonResponse(req, 200, {
      count, tier: standingTier(count), latest, addresses, billing_addresses: billingAddresses,
      saved_addresses: saved,
    });
    // Personal payload: nothing between the browser and this function caches it.
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  // ── GET ?addresses=1 — the patron's managed address book (for a refresh after
  // an add/remove). Backfills from history the first time it's empty. ──────────
  if (req.method === "GET" && new URL(req.url).searchParams.get("addresses")) {
    const me = await verifyUser(req);
    if (!me) return jsonError(req, 401, "The register takes signed entries.");
    const res = jsonResponse(req, 200, { addresses: await savedBook(me.id, me.email) });
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

  // ── POST ?addon=1 — add one companion piece to an existing order (post-order) ──
  if (new URL(req.url).searchParams.get("addon")) {
    if (await rateLimited("a:" + ip, 20)) {
      return jsonError(req, 429, "A short pause, please — try again in a moment.");
    }
    let ab: Record<string, unknown>;
    try { ab = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const serial = typeof ab.serial === "number" ? ab.serial : parseInt(s(ab.serial), 10);
    if (!Number.isInteger(serial) || serial < 1) return jsonError(req, 400, "A valid serial is required.");
    const slug = s(ab.slug).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) return jsonError(req, 400, "A valid add-on slug is required.");
    const cw = s(ab.colorway).toLowerCase();
    const by = s(ab.added_by);
    const addedBy = (by === "concierge" || by === "customer" || by === "page") ? by : "customer";
    // Re-price from the authoritative catalog — never trust a client price.
    const lines = await resolveAddonLines(
      [{ slug, colorway: COLORWAYS.has(cw) ? cw : null, qty: 1, addedBy }],
      COLORWAYS.has(cw) ? cw : "",
    );
    if (!lines.length) return jsonError(req, 400, "That companion piece is not in the catalog.");
    // Owner: a signed-in session wins; else the email that placed the order.
    const user = await verifyUser(req);
    const email = user?.email ?? (s(ab.email).toLowerCase() || null);
    if (!user && !email) return jsonError(req, 400, "An email or a signed-in session is required.");
    const id = await addOrderAddon(serial, user?.id ?? null, email, lines[0]);
    if (id === null) return jsonError(req, 502, "The register is briefly unavailable.");
    if (id === -1) return jsonError(req, 404, "No open order with that number on your register.");
    return jsonResponse(req, 200, { ok: true, id });
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
    const ALLOWED = ["placed", "weaving", "finishing", "shipped", "delivered", "returned", "cancelled"];
    if (!Number.isFinite(serial) || !ALLOWED.includes(status)) {
      return jsonError(req, 400, "serial (number) and a valid status are required.");
    }
    const before = await fetchOrder(serial);
    if (!before) return jsonError(req, 404, `No order Nº ${serial} on the register.`);
    // TRUE cancellation — only before the loom starts. The number is released
    // back to the edition's pool (atomic strike-and-release RPC: serial →
    // cancelled_serial, a lapsed hold frees the number for the next visitor),
    // and the buyer is emailed. Once weaving has begun the number is woven
    // into cloth and cannot return to the pool — strike those as 'returned'.
    if (status === "cancelled") {
      if (before.status !== "placed") {
        return jsonError(req, 409,
          `Nº ${serial} is '${before.status}' — once the loom starts, the number is woven into the cloth ` +
          `and can't return to the pool. Mark it 'returned' instead (refund; the number stays on the record).`);
      }
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cancel_order_return`, {
        method: "POST",
        headers: {
          "apikey": SERVICE_KEY,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_serial: serial, p_user_id: null, p_email: before.email }),
      });
      const verdict = rpcRes.ok ? (await rpcRes.json().catch(() => null)) : null;
      if (verdict !== "ok") {
        return jsonError(req, 502, `The register declined the cancellation${
          typeof verdict === "string" ? ` — ${verdict}` : ""}. Nothing was changed.`);
      }
      const struck = new Date().toISOString();
      const mail = orderEmail("cancelled", { ...before, cancelled_at: struck });
      const p = sendEmail(before.email, mail.subject, mail.html, { kind: "cancelled", serial });
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (x: Promise<unknown>) => void } }).EdgeRuntime;
      if (typeof er?.waitUntil === "function") er.waitUntil(p); else p.catch(() => {});
      return jsonResponse(req, 200, { ok: true, serial, status: "cancelled" });
    }
    const patch: Record<string, unknown> = { status };
    if (trackingRaw !== null) patch.tracking = trackingRaw || null;
    // Stamp the strike time on a return (if not already struck) so the note shows it.
    const struckAt = status === "returned" ? (before.cancelled_at || new Date().toISOString()) : null;
    if (struckAt && !before.cancelled_at) patch.cancelled_at = struckAt;
    if (!(await patchOrder(serial, patch))) {
      return jsonError(req, 502, "The register could not be updated. Nothing was changed.");
    }
    // Notify the buyer when it ships or is struck (best-effort).
    if (status === "shipped" || status === "returned") {
      const kind = status === "shipped" ? "shipped" : "returned";
      const mail = orderEmail(status === "shipped" ? "shipped" : "cancelled", { ...before, cancelled_at: struckAt ?? before.cancelled_at, tracking: trackingRaw ?? before.tracking });
      const p = sendEmail(before.email, mail.subject, mail.html, { kind, serial });
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (x: Promise<unknown>) => void } }).EdgeRuntime;
      if (typeof er?.waitUntil === "function") er.waitUntil(p); else p.catch(() => {});
    }
    return jsonResponse(req, 200, { ok: true, serial, status, tracking: patch.tracking ?? before.tracking });
  }

  // ── POST ?editaddr=1 — admin corrects an order's shipping address ──────────
  // The reliable, labeled correction path: each field is entered separately in
  // the admin, validated here, and written only for unshipped orders.
  if (new URL(req.url).searchParams.get("editaddr")) {
    const admin = await verifyUser(req);
    if (!admin || !(await isAdmin(admin.email))) {
      return jsonError(req, 403, "Administrators only.");
    }
    let fb: Record<string, unknown>;
    try { fb = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const serial = typeof fb.serial === "number" ? Math.floor(fb.serial) : NaN;
    if (!Number.isFinite(serial)) return jsonError(req, 400, "serial (number) is required.");
    const address = String(fb.address ?? "").trim();
    const address2 = String(fb.address2 ?? "").trim();
    const city = String(fb.city ?? "").trim();
    const state = String(fb.state ?? "").trim().toUpperCase();
    const zip = String(fb.zip ?? "").trim();
    if (address.length < 4 || address.length > 120) return jsonError(req, 400, "Street address must be 4–120 characters.");
    if (address2.length > 120) return jsonError(req, 400, "Address line 2 is too long.");
    if (city.length < 1 || city.length > 80) return jsonError(req, 400, "City must be 1–80 characters.");
    if (!/^[A-Z]{2}$/.test(state)) return jsonError(req, 400, "State must be a two-letter US code.");
    if (!/^\d{5}(-\d{4})?$/.test(zip)) return jsonError(req, 400, "ZIP must be 12345 or 12345-6789.");
    const before = await fetchOrder(serial);
    if (!before) return jsonError(req, 404, `No order Nº ${serial} on the register.`);
    if (!["placed", "weaving", "finishing"].includes(before.status ?? "")) {
      return jsonError(req, 409, `Nº ${serial} is '${before.status}' — the register is closed on it (address changes are only possible before shipment).`);
    }
    const patch = { address, address2: address2 || null, city, state, zip };
    if (!(await patchOrder(serial, patch))) {
      return jsonError(req, 502, "The register could not be updated. Nothing was changed.");
    }
    return jsonResponse(req, 200, { ok: true, serial, ...patch });
  }

  // ── POST ?editbilling=1 — admin sets/clears an order's BILLING address ───────
  // Billing is a record (the orders.billing jsonb), not a shipping instruction, so
  // it's editable at any status. Passing {same_as_shipping:true} clears it.
  if (new URL(req.url).searchParams.get("editbilling")) {
    const admin = await verifyUser(req);
    if (!admin || !(await isAdmin(admin.email))) {
      return jsonError(req, 403, "Administrators only.");
    }
    let fb: Record<string, unknown>;
    try { fb = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const serial = typeof fb.serial === "number" ? Math.floor(fb.serial) : NaN;
    if (!Number.isFinite(serial)) return jsonError(req, 400, "serial (number) is required.");
    const before = await fetchOrder(serial);
    if (!before) return jsonError(req, 404, `No order Nº ${serial} on the register.`);
    if (fb.same_as_shipping === true) {
      if (!(await patchOrder(serial, { billing: null }))) {
        return jsonError(req, 502, "The register could not be updated. Nothing was changed.");
      }
      return jsonResponse(req, 200, { ok: true, serial, billing: null });
    }
    const address = String(fb.address ?? "").trim();
    const address2 = String(fb.address2 ?? "").trim();
    const city = String(fb.city ?? "").trim();
    const state = String(fb.state ?? "").trim().toUpperCase();
    const zip = String(fb.zip ?? "").trim();
    if (address.length < 4 || address.length > 120) return jsonError(req, 400, "Billing street address must be 4–120 characters.");
    if (address2.length > 120) return jsonError(req, 400, "Billing address line 2 is too long.");
    if (city.length < 1 || city.length > 80) return jsonError(req, 400, "Billing city must be 1–80 characters.");
    if (!/^[A-Z]{2}$/.test(state)) return jsonError(req, 400, "Billing state must be a two-letter US code.");
    if (!/^\d{5}(-\d{4})?$/.test(zip)) return jsonError(req, 400, "Billing ZIP must be 12345 or 12345-6789.");
    const billing = { address, address2: address2 || null, city, state, zip };
    if (!(await patchOrder(serial, { billing }))) {
      return jsonError(req, 502, "The register could not be updated. Nothing was changed.");
    }
    return jsonResponse(req, 200, { ok: true, serial, billing });
  }

  // ── POST ?address_save=1 — signed-in patron adds/edits one saved address ─────
  if (new URL(req.url).searchParams.get("address_save")) {
    const me = await verifyUser(req);
    if (!me) return jsonError(req, 401, "The register takes signed entries.");
    let ab: Record<string, unknown>;
    try { ab = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const clean = cleanAddr(ab);
    if (typeof clean === "string") return jsonError(req, 400, clean);
    const id = typeof ab.id === "string" && /^[0-9a-f-]{36}$/i.test(ab.id) ? ab.id : null;
    const body = {
      label: clean.label || (clean.is_gift ? (clean.recipient_name ?? "Gift") : "Home"),
      is_gift: clean.is_gift, recipient_name: clean.recipient_name,
      address: clean.address, address2: clean.address2 || null,
      city: clean.city, state: clean.state, zip: clean.zip, updated_at: new Date().toISOString(),
    };
    if (id) {
      // Update, scoped to the owner so a patron can only edit their own row.
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/customer_addresses?id=eq.${id}&${ownFilter(me.id, me.email)}`,
        { method: "PATCH", headers: { ...RPC_HEADERS, Prefer: "return=representation" }, body: JSON.stringify(body) },
      );
      const rows = res.ok ? await res.json() as unknown[] : [];
      if (!res.ok || rows.length === 0) return jsonError(req, 404, "That saved address isn't yours to edit.");
      return jsonResponse(req, 200, { ok: true, addresses: await fetchSaved(me.id, me.email) });
    }
    await insertSaved(me.id, me.email, clean, await fetchSaved(me.id, me.email));
    return jsonResponse(req, 200, { ok: true, addresses: await fetchSaved(me.id, me.email) });
  }

  // ── POST ?address_delete=1 — signed-in patron removes one saved address ──────
  if (new URL(req.url).searchParams.get("address_delete")) {
    const me = await verifyUser(req);
    if (!me) return jsonError(req, 401, "The register takes signed entries.");
    let db: Record<string, unknown>;
    try { db = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const id = typeof db.id === "string" && /^[0-9a-f-]{36}$/i.test(db.id) ? db.id : null;
    if (!id) return jsonError(req, 400, "A valid address id is required.");
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/customer_addresses?id=eq.${id}&${ownFilter(me.id, me.email)}`,
      { method: "DELETE", headers: RPC_HEADERS },
    );
    if (!res.ok) return jsonError(req, 502, "Could not remove that address.");
    return jsonResponse(req, 200, { ok: true, addresses: await fetchSaved(me.id, me.email) });
  }

  // ── POST ?custresend=1 — SERVICE-ONLY re-send, called by the concierge ──────
  // The concierge's resend_confirmation tool calls this AFTER it has verified the
  // signed-in owner actually owns the order. Auth here is the service key (bearer),
  // so a browser can never reach it — only server-to-server. It reuses the same
  // orderEmail templates, and guards the kind against the order's real status so a
  // "shipped" note can't go out for something that hasn't shipped.
  if (new URL(req.url).searchParams.get("custresend")) {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!SERVICE_KEY || token !== SERVICE_KEY) {
      return jsonError(req, 403, "Not permitted.");
    }
    let rb: Record<string, unknown>;
    try { rb = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const serial = typeof rb.serial === "number" ? Math.floor(rb.serial) : NaN;
    const kind = typeof rb.kind === "string" ? rb.kind : "";
    if (!Number.isFinite(serial) || !["placed", "shipped", "cancelled"].includes(kind)) {
      return jsonError(req, 400, "serial (number) and kind (placed|shipped|cancelled) are required.");
    }
    const order = await fetchOrder(serial);
    if (!order) return jsonError(req, 404, `No order Nº ${serial}.`);
    const st = order.status ?? "";
    // Guard: the note has to match reality.
    if (kind === "shipped" && !["shipped", "delivered"].includes(st)) {
      return jsonError(req, 409, `Nº ${serial} has not shipped yet (${st}); a shipping note would be wrong.`);
    }
    if (kind === "cancelled" && !["cancelled", "returned"].includes(st)) {
      return jsonError(req, 409, `Nº ${serial} is '${st}', not cancelled; that note doesn't apply.`);
    }
    const mail = orderEmail(kind as "placed" | "shipped" | "cancelled", order);
    const logKind = (kind === "cancelled" && st === "returned") ? "returned" : kind;
    await sendEmail(order.email, mail.subject, mail.html, { kind: logKind, serial });
    return jsonResponse(req, 200, { ok: true, to: order.email });
  }

  // ── POST ?resend=1 — admin re-sends a transactional email for an order ──────
  if (new URL(req.url).searchParams.get("resend")) {
    const admin = await verifyUser(req);
    if (!admin || !(await isAdmin(admin.email))) {
      return jsonError(req, 403, "Administrators only.");
    }
    let rb: Record<string, unknown>;
    try { rb = await req.json() as Record<string, unknown>; } catch {
      return jsonError(req, 400, "Request body must be valid JSON.");
    }
    const serial = typeof rb.serial === "number" ? Math.floor(rb.serial) : NaN;
    const kind = typeof rb.kind === "string" ? rb.kind : "";
    if (!Number.isFinite(serial) || !["placed", "shipped", "cancelled"].includes(kind)) {
      return jsonError(req, 400, "serial (number) and kind (placed|shipped|cancelled) are required.");
    }
    const order = await fetchOrder(serial);
    if (!order) return jsonError(req, 404, `No order Nº ${serial}.`);
    const mail = orderEmail(kind as "placed" | "shipped" | "cancelled", order);
    // record it under the true state name (a returned order's note is 'returned')
    const logKind = (kind === "cancelled" && order.status === "returned") ? "returned" : kind;
    await sendEmail(order.email, mail.subject, mail.html, { kind: logKind, serial });
    return jsonResponse(req, 200, { ok: true });
  }

  // Rate limit. The wall exists because this is a public endpoint where every
  // accepted order consumes a scarce serial from the edition, sends real
  // email, and writes rows — unthrottled, a script could drain serials and
  // the mail quota in minutes. But an email-verified signed-in buyer is not
  // anonymous traffic: they get their own, far roomier window keyed to their
  // user id (seen live: a heavy demo day tripped the shared IP wall and
  // blocked a real signed-in purchase — the worst failure a register can have).
  const buyer = await verifyUser(req);
  if (buyer) {
    if (await rateLimited("u:" + buyer.id, 30)) {
      return jsonError(req, 429,
        "Too many requests. The register takes a short pause — try again in a few minutes.");
    }
  } else if (await rateLimited(ip, 10)) {
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
  const chatVia = readChatVia(parsed);
  const chatMeta = readChatMeta(parsed);

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

  // Attribution: the concierge's commissions are counted (best-effort — the
  // order stands either way, but a failure is LOGGED so lost attribution is
  // visible in the function logs instead of silently undercounting).
  // Session-level first (checkout sent a chat key); else IDENTITY-level: a
  // signed-in buyer whose account had a conversation in the 30 days before
  // placement gets chat_via='identity' with that conversation's session key —
  // this catches cross-device and chat-today-buy-tomorrow journeys the
  // same-tab-session capture misses. See ATTRIBUTION.md.
  {
    let attribution: Record<string, unknown> | null = null;
    if (chatSession) {
      attribution = { chat_session: chatSession };
      if (chatVia) attribution.chat_via = chatVia;
      if (chatMeta) attribution.chat_meta = chatMeta;
    } else {
      try {
        const lookback = new Date(Date.now() - 30 * 86400000).toISOString();
        const safeEmail = (validated.email ?? "").replace(/["\\,()]/g, "");
        const filter = safeEmail
          ? `or=(user_id.eq.${customer.id},user_email.eq."${encodeURIComponent(safeEmail)}")`
          : `user_id=eq.${customer.id}`;
        const cr = await fetch(
          `${SUPABASE_URL}/rest/v1/concierge_conversations?select=session_key,created_at&${filter}` +
            `&created_at=gte.${encodeURIComponent(lookback)}&order=created_at.desc&limit=1`,
          { headers: RPC_HEADERS },
        );
        if (cr.ok) {
          const rows = await cr.json() as { session_key: string | null; created_at: string }[];
          if (rows.length > 0 && rows[0].session_key) {
            const days = Math.max(0, Math.floor((Date.now() - new Date(rows[0].created_at).getTime()) / 86400000));
            attribution = {
              chat_session: rows[0].session_key,
              chat_via: "identity",
              chat_meta: { lookback_days: days },
            };
          }
        }
      } catch { /* identity lookback is purely additive */ }
    }
    if (attribution) {
      try {
        const pr = await fetch(`${SUPABASE_URL}/rest/v1/orders?serial=eq.${serial}`, {
          method: "PATCH",
          headers: RPC_HEADERS,
          body: JSON.stringify(attribution),
        });
        if (!pr.ok) {
          console.error(`attribution PATCH failed for serial ${serial}: HTTP ${pr.status} ${await pr.text().catch(() => "")}`.slice(0, 300));
        }
      } catch (e) {
        console.error(`attribution PATCH threw for serial ${serial}:`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  // Save the used ship-to (and any distinct billing) into the patron's managed
  // address book, so it's there to reuse or remove next time (best-effort, off
  // the response path).
  if (customer.id) {
    const saveP = (async () => {
      try {
        const acc = await fetchSaved(customer.id, customer.email);
        await insertSaved(customer.id, customer.email, {
          is_gift: !!validated.isGift, recipient_name: validated.recipient || null,
          address: validated.address, address2: validated.address2,
          city: validated.city, state: validated.state, zip: validated.zip,
        }, acc);
        if (validated.billing) {
          await insertSaved(customer.id, customer.email, {
            label: "Billing", is_gift: false, recipient_name: null,
            address: validated.billing.address, address2: validated.billing.address2,
            city: validated.billing.city, state: validated.billing.state, zip: validated.billing.zip,
          }, acc);
        }
      } catch { /* best-effort */ }
    })();
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (x: Promise<unknown>) => void } }).EdgeRuntime;
    if (typeof er?.waitUntil === "function") er.waitUntil(saveP); else saveP.catch(() => {});
  }

  // Order-confirmation email (best-effort; never blocks the response).
  {
    const mail = orderEmail("placed", {
      serial, email: validated.email, name: validated.name, colorway: validated.colorway,
      recipient_name: validated.recipient || null, is_gift: !!validated.isGift,
      address: validated.address, address2: validated.address2, city: validated.city,
      state: validated.state, zip: validated.zip,
    });
    const p = sendEmail(validated.email, mail.subject, mail.html, { kind: "placed", serial });
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (x: Promise<unknown>) => void } }).EdgeRuntime;
    if (typeof er?.waitUntil === "function") er.waitUntil(p);
    else p.catch(() => {});
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
