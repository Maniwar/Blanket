/**
 * Feierabend — Decke 01 · AI Sales Concierge v3 (Supabase Edge Function, Deno)
 *
 * v1 proxied streaming chat to the Anthropic Messages API (server-side key,
 * validation, rate limiting, SSE re-shaping). v2 added DB-driven config + KB,
 * GET ?config=1, signed-in order awareness, and conversation logging.
 * v3 adds:
 *   - Register tools (Anthropic tool use) for signed-in owners: the model can
 *     read their orders, change a shipping address before shipment, and cancel
 *     an order that hasn't started weaving. Every mutation is written to
 *     concierge_actions for the admin Studio.
 *   - Standard operating procedures from concierge_sops, injected into the
 *     system prompt so the admin can teach the concierge process.
 *   - A semantic answer cache (pgvector + gte-small embeddings) for anonymous
 *     first-turn questions, editable from the Studio's Cache tab.
 *
 * Wire contract:
 *   GET  <fn>?config=1 -> 200 {"enabled","greeting","starters","auth":true}
 *   POST <fn> {"messages":[{role,content}], "context"?:{}, "session_key"?:str}
 *     -> SSE: data: {"t":"…"} per text delta, then once
 *        data: {"m":{"cid":"<uuid>","mid":<int>}}, then data: [DONE].
 *        v3 may also send data: {"s":"…"} (a status caption while the
 *        concierge works the register) and data: {"c":1} (answer served
 *        from the cache). Unknown keys are ignored by older clients.
 *   Errors: non-200 JSON {"error":"..."} with CORS headers; 503 when disabled.
 *
 * Dependencies: ./kb.ts only — BRAND_SYSTEM / KB_MARKDOWN are the fallbacks
 * when the database is unreachable or empty. All DB access is raw PostgREST
 * over fetch with the service-role key; no supabase-js.
 */

import { BRAND_SYSTEM, KB_MARKDOWN } from "./kb.ts";

// Supabase edge runtime global (embeddings); typed loosely on purpose.
// deno-lint-ignore no-explicit-any
declare const Supabase: any;

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

// ── PostgREST helpers — service-role over plain fetch (no supabase-js) ───────

const PG_HEADERS = {
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** GET /rest/v1/<query>. Returns rows, or null when unreachable/error. */
async function pgSelect<T>(query: string): Promise<T[] | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers: PG_HEADERS });
    return res.ok ? await res.json() as T[] : null;
  } catch { return null; }
}

/** POST one row into <table>, returning the inserted row (null on error). */
async function pgInsert<T>(table: string, row: Record<string, unknown>): Promise<T | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...PG_HEADERS, "Prefer": "return=representation" },
      body: JSON.stringify(row),
    });
    if (!res.ok) return null;
    const rows = await res.json() as T[];
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch { return null; }
}

/** PATCH rows matching <query>, returning the updated rows (null on error). */
async function pgPatch<T>(query: string, patch: Record<string, unknown>): Promise<T[] | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      method: "PATCH",
      headers: { ...PG_HEADERS, "Prefer": "return=representation" },
      body: JSON.stringify(patch),
    });
    return res.ok ? await res.json() as T[] : null;
  } catch { return null; }
}

/** POST /rest/v1/rpc/<fn>. Returns the result, or null on error. */
async function pgRpc<T>(fn: string, args: Record<string, unknown>): Promise<T | null> {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: PG_HEADERS,
      body: JSON.stringify(args),
    });
    return res.ok ? await res.json() as T : null;
  } catch { return null; }
}

// ── Config + KB + SOPs — DB reads cached in module memory for 60 seconds ─────

interface FormDef {
  slug: string; title: string; submit_tool: string; fields: unknown;
}

interface GoalDef { slug: string; label: string; description: string }

interface ConciergeData {
  config: Record<string, unknown> | null; // concierge_config {key: jsonb value}
  kbText: string | null; // enabled concierge_kb rows; null -> KB_MARKDOWN fallback
  sopText: string | null; // enabled concierge_sops rows; null -> none
  forms: FormDef[]; // enabled concierge_forms rows
  goals: GoalDef[]; // enabled concierge_goals rows
  at: number; // Date.now() of the read; refreshed after CACHE_TTL_MS
}

const CACHE_TTL_MS = 60_000;
let dataCache: ConciergeData | null = null;

async function loadConciergeData(): Promise<ConciergeData> {
  if (dataCache && Date.now() - dataCache.at < CACHE_TTL_MS) return dataCache;
  const [cfgRows, kbRows, sopRows, formRows, goalRows] = await Promise.all([
    pgSelect<{ key: string; value: unknown }>("concierge_config?select=key,value"),
    pgSelect<{ title: string; content_md: string }>(
      "concierge_kb?select=title,content_md&enabled=is.true&order=sort_order.asc",
    ),
    pgSelect<{ title: string; content_md: string }>(
      "concierge_sops?select=title,content_md&enabled=is.true&order=sort_order.asc",
    ),
    pgSelect<FormDef>(
      "concierge_forms?select=slug,title,submit_tool,fields&enabled=is.true",
    ),
    pgSelect<GoalDef>(
      "concierge_goals?select=slug,label,description&enabled=is.true&order=sort_order.asc",
    ),
  ]);
  dataCache = {
    config: cfgRows && cfgRows.length > 0
      ? Object.fromEntries(cfgRows.map((r) => [r.key, r.value]))
      : null,
    kbText: kbRows && kbRows.length > 0
      ? kbRows.map((r) => `## ${r.title}\n${r.content_md}`).join("\n\n")
      : null,
    sopText: sopRows && sopRows.length > 0
      ? sopRows.map((r) => `### ${r.title}\n${r.content_md}`).join("\n\n")
      : null,
    forms: formRows ?? [],
    goals: goalRows ?? [],
    at: Date.now(),
  };
  return dataCache;
}

// ── Rate limiting — in-memory sliding window per client IP (POST only) ───────

const RATE_LIMIT = 20; // requests
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

// ── Validation — v1 rules plus optional session_key (<= 64 chars) ────────────

interface ChatMessage { role: "user" | "assistant"; content: string }

interface ValidatedBody {
  messages: ChatMessage[]; context: Record<string, unknown>; sessionKey: string | null;
}

function validateBody(body: unknown): ValidatedBody | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  const { messages, context, session_key } = body as Record<string, unknown>;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) {
    return "messages must be an array of 1 to 20 items.";
  }
  for (const m of messages) {
    if (typeof m !== "object" || m === null) return "Each message must be an object.";
    const { role, content } = m as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") return "Each message role must be 'user' or 'assistant'.";
    if (typeof content !== "string" || content.length === 0 || content.length > 2000) {
      return "Each message content must be a non-empty string of at most 2000 characters.";
    }
  }
  if (context !== undefined &&
    (typeof context !== "object" || context === null || Array.isArray(context))) {
    return "context, if provided, must be an object.";
  }
  if (session_key !== undefined &&
    (typeof session_key !== "string" || session_key.length > 64)) {
    return "session_key, if provided, must be a string of at most 64 characters.";
  }
  return {
    messages: messages as ChatMessage[],
    context: (context ?? {}) as Record<string, unknown>,
    sessionKey: typeof session_key === "string" && session_key ? session_key : null,
  };
}

// ── Signed-in awareness — verify Supabase Auth JWT, pull the user's orders ───

interface Customer { id: string; email: string | null }
interface OrderRow {
  serial: number | null; status: string | null; tracking: string | null;
  colorway: string | null; address: string | null; address2: string | null;
  city: string | null; state: string | null; zip: string | null;
  placed_at: string | null; recipient_name?: string | null; is_gift?: boolean;
  cancelled_serial?: number | null; name?: string | null;
}

/** Verified user, or null (absent / anon key / invalid token — never errors). */
async function verifyUser(req: Request): Promise<Customer | null> {
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

/** PostgREST ownership filter: orders tied to this user's id OR email. */
function ownershipFilter(customer: Customer): string {
  const safeEmail = customer.email?.replace(/["\\,()]/g, "");
  return safeEmail
    ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
    : `user_id=eq.${encodeURIComponent(customer.id)}`;
}

async function myOrders(
  customer: Customer, includeCancelled = false,
): Promise<OrderRow[] | null> {
  return await pgSelect<OrderRow>(
    "orders?select=serial,status,tracking,colorway,address,address2,city,state,zip,placed_at,recipient_name,is_gift,cancelled_serial,name" +
      (includeCancelled ? "" : "&status=neq.cancelled") +
      `&${ownershipFilter(customer)}&order=placed_at.desc&limit=25`,
  );
}

/** Builds the CUSTOMER line for LIVE STATE (orders via service-role call). */
async function customerBlock(customer: Customer): Promise<string> {
  const safeEmail = customer.email?.replace(/["\\,()]/g, "");
  const noteFilter = safeEmail
    ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
    : `user_id=eq.${encodeURIComponent(customer.id)}`;
  const notesP = pgSelect<{ note: string; created_at: string }>(
    `customer_notes?select=note,created_at&${noteFilter}&order=created_at.desc&limit=8`,
  );
  // Re-engagement: the last conversation we wrapped (snoozed or closed). If one
  // exists, THIS is a fresh visit picking the thread back up, not a first hello.
  const lastConvoP = pgSelect<{ ended_at: string; status: string; section: string | null }>(
    `concierge_conversations?select=ended_at,status,section&user_id=eq.${
      encodeURIComponent(customer.id)}&ended_at=not.is.null&order=ended_at.desc&limit=1`,
  );
  const all = await myOrders(customer, true);
  const notes = await notesP;
  const lastConvo = await lastConvoP;
  const orders = all ? all.filter((o) => o.status !== "cancelled") : null;
  const struck = all ? all.length - (orders?.length ?? 0) : 0;
  const fmt = (o: OrderRow) =>
    [
      `Nº ${o.serial ?? o.cancelled_serial ?? "—"} — ${o.status ?? "status unknown"}`,
      o.is_gift && o.recipient_name && `a gift for ${o.recipient_name}`,
      o.tracking && `tracking ${o.tracking}`,
      o.city && `to ${o.city}`,
      o.placed_at && `placed ${String(o.placed_at).slice(0, 10)}`,
    ].filter(Boolean).join(", ");
  let summary = "no orders on file";
  let standing = "";
  if (orders && orders.length > 0) {
    const delivered = orders.filter((o) => o.status === "delivered").length;
    const open = orders.length - delivered;
    summary = `${orders.length} on the register` +
      (orders.length > 1 || open > 0
        ? ` (${open} not yet delivered, ${delivered} delivered)`
        : "") +
      ` — ${orders.map(fmt).join("; ")}`;
    const active = orders.filter((o) => o.status !== "cancelled").length;
    const tier = active >= 5
      ? "Stifter"
      : active >= 3
      ? "Hausfreund"
      : active === 2
      ? "Wiederkehr"
      : "Eintrag";
    standing = ` STANDING: ${tier} (${active} on the register).`;
  }
  const archive = struck > 0 ? ` ARCHIVE: ${struck} struck (cancelled) — mention only if asked.` : "";
  const book = notes && notes.length > 0
    ? ` CLIENT BOOK (weave in naturally, never recite): ${
      notes.map((n) => `${String(n.created_at).slice(0, 10)}: ${n.note}`).join(" | ")}`
    : "";

  // First name (from their most recent order) — for warm, natural address.
  let firstName = "";
  if (orders && orders.length > 0) {
    const named = orders.find((o) => typeof o.name === "string" && o.name.trim());
    if (named?.name) firstName = named.name.trim().split(/\s+/)[0];
  }
  const nameLine = firstName
    ? `NAME: ${firstName} (use their first name naturally when it fits — never in every line).`
    : "";

  // Recency — how the register should read the passage of time since they bought.
  let recency = "";
  const dated = (orders ?? []).filter((o) => o.placed_at).map((o) => o.placed_at as string).sort();
  if (dated.length > 0) {
    const last = new Date(dated[dated.length - 1]).getTime();
    const days = Math.floor((Date.now() - last) / 86400000);
    recency = ` LAST PURCHASE: ${
      days <= 0 ? "today (this visit or earlier today)" : days === 1 ? "yesterday" : `${days} days ago`
    }.`;
  }

  // Re-engagement recency — how long since the last conversation was wrapped.
  let reengage = "";
  if (lastConvo && lastConvo.length > 0 && lastConvo[0].ended_at) {
    const mins = Math.floor((Date.now() - new Date(lastConvo[0].ended_at).getTime()) / 60000);
    const when = mins < 1 ? "moments ago"
      : mins < 60 ? `${mins} min ago`
      : mins < 1440 ? `${Math.floor(mins / 60)}h ago`
      : `${Math.floor(mins / 1440)} days ago`;
    const how = lastConvo[0].status === "snoozed"
      ? "they asked for room (quiet mode)" : "the chat was wrapped up";
    reengage = ` RE-ENGAGEMENT: this is a new visit — you last spoke ${when} and ${how}. ` +
      `Greet like someone returning, not a stranger; pick up naturally, don't restart from scratch.`;
  }

  return `CUSTOMER: ${customer.email ?? customer.id} (signed in, email verified). ${nameLine} ORDERS: ${summary}.${standing}${recency}${reengage}${archive}${book}`;
}

// ── Register tools — definitions + execution (signed-in only) ────────────────

const MUTABLE_STATUSES = ["placed", "weaving", "finishing"];

// deno-lint-ignore no-explicit-any
const REGISTER_TOOLS: any[] = [
  {
    name: "get_my_orders",
    description:
      "Read the orders on the register for the signed-in owner: serial number, " +
      "status, tracking (when shipped), colorway, shipping address, and the date placed. " +
      "Always call this before answering questions about the owner's orders. " +
      "Struck (cancelled) entries are omitted unless include_cancelled is true — " +
      "pass it only when the owner asks about cancelled or past entries.",
    input_schema: {
      type: "object",
      properties: {
        include_cancelled: {
          type: "boolean",
          description: "Also return struck (cancelled) entries. Default false.",
        },
      },
      required: [],
    },
  },
  {
    name: "update_shipping_address",
    description:
      "Change the shipping address on one of the owner's orders. Allowed only while " +
      "the order has not shipped (status placed, weaving, or finishing). Confirm the " +
      "complete new address with the owner before calling.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        address: { type: "string", description: "Street address." },
        address2: { type: "string", description: "Apartment, suite, unit (optional)." },
        city: { type: "string" },
        state: { type: "string", description: "Two-letter US state code." },
        zip: { type: "string", description: "ZIP code, 12345 or 12345-6789." },
      },
      required: ["serial", "address", "city", "state", "zip"],
    },
  },
  {
    name: "remember_customer",
    description:
      "Write one short, durable, factual line to this patron's client book — a room they " +
      "mentioned, a favored cloth, a gift occasion, a hesitation, a thread to pick up later. " +
      "Only what a good clerk would note; never health, beliefs, finances, or anything " +
      "sensitive. The book is shown to the patron's own conversations and to the admin.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "One factual line, at most 240 characters." },
      },
      required: ["note"],
    },
  },
  {
    name: "update_colorway",
    description:
      "Change the cloth (colorway) on one of the owner's orders. Allowed only while the " +
      "order is still 'placed' — once weaving begins the cloth is on the loom. " +
      "Confirm the exact change with the owner before calling.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        colorway: {
          type: "string", enum: ["ungefaerbt", "loden", "graphit"],
          description: "The new cloth.",
        },
      },
      required: ["serial", "colorway"],
    },
  },
  {
    name: "cancel_order",
    description:
      "Cancel one of the owner's orders. Allowed only while the order is still 'placed' " +
      "(weaving has not begun). Ask the owner to explicitly confirm before calling. " +
      "The number returns to the year's edition and cannot be held again.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
      },
      required: ["serial"],
    },
  },
];

/** Writes one row to the concierge_actions audit log. Never throws. */
async function logAction(
  cid: string | null, customer: Customer, action: string,
  serial: number | null, payload: unknown, result: string,
): Promise<void> {
  try {
    await pgInsert("concierge_actions", {
      conversation_id: cid, user_id: customer.id, email: customer.email,
      action, serial, payload: payload ?? null, result: result.slice(0, 500),
    });
  } catch { /* audit failures never break the chat */ }
}

/** Executes one register tool; returns the tool_result content string. */
async function runRegisterTool(
  name: string, input: Record<string, unknown>,
  customer: Customer, cid: string | null,
): Promise<string> {
  if (name === "get_my_orders") {
    const orders = await myOrders(customer, input.include_cancelled === true);
    if (orders === null) return "ERROR: the register is unreachable right now.";
    await logAction(cid, customer, "get_my_orders", null, null, `${orders.length} orders read`);
    if (orders.length === 0) return "No orders on the register for this owner.";
    return JSON.stringify(orders.map((o) => ({ ...o, serial: o.serial ?? o.cancelled_serial })));
  }

  if (name === "remember_customer") {
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 240) : "";
    if (note.length < 3) return "ERROR: a note needs a few words.";
    const row = await pgInsert("customer_notes", {
      user_id: customer.id, email: customer.email, note,
    });
    if (!row) return "ERROR: the client book is unreachable right now.";
    await logAction(cid, customer, "remember_customer", null, { note }, "noted");
    return "Noted in the client book.";
  }

  const serial = typeof input.serial === "number" ? Math.floor(input.serial) : NaN;
  if (!Number.isFinite(serial)) return "ERROR: serial must be a number.";

  // Ownership check first: the order must exist AND belong to this owner.
  const rows = await pgSelect<OrderRow>(
    `orders?select=serial,status,tracking,colorway,address,address2,city,state,zip,placed_at` +
      `&serial=eq.${serial}&${ownershipFilter(customer)}&limit=1`,
  );
  if (rows === null) return "ERROR: the register is unreachable right now.";
  if (rows.length === 0) return `ERROR: no order Nº ${serial} on this owner's register.`;
  const order = rows[0];

  if (name === "update_shipping_address") {
    if (!MUTABLE_STATUSES.includes(order.status ?? "")) {
      return `ERROR: Nº ${serial} is '${order.status}' — the register is closed on it. ` +
        "Address changes are possible only before shipment.";
    }
    const address = String(input.address ?? "").trim();
    const address2 = String(input.address2 ?? "").trim();
    const city = String(input.city ?? "").trim();
    const state = String(input.state ?? "").trim().toUpperCase();
    const zip = String(input.zip ?? "").trim();
    if (address.length < 4 || address.length > 120) return "ERROR: street address must be 4-120 characters.";
    if (address2.length > 120) return "ERROR: address line 2 is too long.";
    if (city.length < 1 || city.length > 80) return "ERROR: city must be 1-80 characters.";
    if (!/^[A-Z]{2}$/.test(state)) return "ERROR: state must be a two-letter US code.";
    if (!/^\d{5}(-\d{4})?$/.test(zip)) return "ERROR: zip must be 12345 or 12345-6789.";
    const patch = { address, address2: address2 || null, city, state, zip };
    const updated = await pgPatch<OrderRow>(
      `orders?serial=eq.${serial}&${ownershipFilter(customer)}`, patch,
    );
    if (!updated || updated.length === 0) return "ERROR: the register did not accept the change.";
    await logAction(cid, customer, "update_shipping_address", serial, patch, "address updated");
    const u = updated[0];
    return `Recorded. Nº ${serial} now ships to: ${u.address}` +
      `${u.address2 ? ", " + u.address2 : ""}, ${u.city}, ${u.state} ${u.zip}.`;
  }

  if (name === "update_colorway") {
    if (order.status !== "placed") {
      return `ERROR: Nº ${serial} is '${order.status}' — the cloth is on the loom. ` +
        "Colorway changes are possible only while an order is still 'placed'; " +
        "the 30-night trial covers a color that turns out wrong.";
    }
    const cw = String(input.colorway ?? "").toLowerCase();
    if (!["ungefaerbt", "loden", "graphit"].includes(cw)) {
      return "ERROR: colorway must be ungefaerbt, loden, or graphit.";
    }
    const updated = await pgPatch<OrderRow>(
      `orders?serial=eq.${serial}&status=eq.placed&${ownershipFilter(customer)}`,
      { colorway: cw },
    );
    if (!updated || updated.length === 0) return "ERROR: the register did not accept the change.";
    await logAction(cid, customer, "update_colorway", serial, { colorway: cw }, "colorway updated");
    const pretty = cw === "ungefaerbt" ? "Ungefärbt" : cw === "loden" ? "Loden" : "Graphit";
    return `Recorded. Nº ${serial} now weaves in ${pretty}.`;
  }

  if (name === "cancel_order") {
    if (order.status !== "placed") {
      return `ERROR: Nº ${serial} is '${order.status}' — only 'placed' orders can be cancelled. ` +
        "Once weaving begins the cloth carries the owner's number; the 30-night trial applies on arrival.";
    }
    // Atomic strike-and-release: the entry is struck, the number rejoins the
    // edition's pool and goes to the next visitor, lowest first.
    const result = await pgRpc<string>("cancel_order_return", {
      p_serial: serial,
      p_user_id: customer.id,
      p_email: customer.email,
    });
    if (result === "ok") {
      await logAction(cid, customer, "cancel_order", serial, null, "order cancelled; serial released");
      return `Done. Nº ${serial} is struck from the register and the number returns to the year's edition.`;
    }
    if (result === null) {
      // Pre-migration register: fall back to the plain status change.
      const updated = await pgPatch<OrderRow>(
        `orders?serial=eq.${serial}&status=eq.placed&${ownershipFilter(customer)}`,
        { status: "cancelled" },
      );
      if (!updated || updated.length === 0) return "ERROR: the register did not accept the cancellation.";
      await logAction(cid, customer, "cancel_order", serial, null, "order cancelled");
      return `Done. Nº ${serial} is cancelled.`;
    }
    return `ERROR: the register declined — ${result}.`;
  }

  return `ERROR: unknown tool '${name}'.`;
}

// ── Semantic cache — gte-small embeddings + match_cached_answer RPC ──────────

// Questions about live or personal state must never be answered from cache.
const CACHE_SKIP = /remain(s|ing)?|left|available|stock|hold|my (order|blanket|deliver|number)|status|track|sign in|signed in/i;

// deno-lint-ignore no-explicit-any
let embedSession: { run: (t: string, o: Record<string, unknown>) => Promise<any> } | null = null;
let embedFailureFiled = false;

/** Files one Studio-visible flag per isolate when embeddings are unavailable. */
async function fileEmbedFailure(detail: string): Promise<void> {
  if (embedFailureFiled) return;
  embedFailureFiled = true;
  try {
    await pgInsert("concierge_flags", {
      question: "(system) semantic cache self-check",
      answer: "Embedding runtime unavailable — cached answers cannot be written or matched. " + detail.slice(0, 300),
      reason: "cache_embed_unavailable",
    });
  } catch { /* the log line still exists */ }
  console.error("concierge cache: embedding unavailable:", detail);
}

async function embed(text: string): Promise<number[] | null> {
  try {
    if (!embedSession) embedSession = new Supabase.ai.Session("gte-small");
    const out = await embedSession!.run(text, { mean_pool: true, normalize: true });
    // gte-small may return number[] or a Float32Array-like — accept both.
    const arr: number[] | null = Array.isArray(out)
      ? out as number[]
      : (out && typeof out.length === "number" ? Array.from(out as ArrayLike<number>) : null);
    if (arr && arr.length === 384) return arr;
    await fileEmbedFailure(`unexpected output shape (length ${arr ? arr.length : "n/a"})`);
    return null;
  } catch (e) {
    await fileEmbedFailure(e instanceof Error ? e.message : String(e));
    return null;
  }
}

const vecLiteral = (e: number[]) => `[${e.join(",")}]`;

interface CacheHit { id: string; question: string; answer_md: string; similarity: number }

async function cacheLookup(embedding: number[]): Promise<CacheHit | null> {
  const rows = await pgRpc<CacheHit[]>("match_cached_answer", {
    query_embedding: vecLiteral(embedding), match_threshold: 0.90,
  });
  return rows && rows.length > 0 ? rows[0] : null;
}

/** An answer is cacheable when it carries no live numbers or register state.
 *  "15,000" (the edition) and "$589" are static product truth and stay
 *  cacheable; serial-style figures (Nº 14,215 / other comma-thousands) do not. */
function cacheableAnswer(text: string): boolean {
  if (/Nº\s*\d/.test(text)) return false; // a specific serial
  const liveFigure = /\b\d{1,2},\d{3}\b/g;
  let m: RegExpExecArray | null;
  while ((m = liveFigure.exec(text)) !== null) {
    if (m[0] !== "15,000") return false; // any other thousands figure is live state
  }
  if (text.includes("{{action:signin}}")) return false;
  // Visit-specific state that isn't a serial: hold countdowns (09:52),
  // loom clocks (5d 16h), or talk of "this visit" never crosses visitors.
  if (/\b\d{1,2}:\d{2}\b/.test(text)) return false;
  if (/\b\d+\s*d\s+\d+\s*h\b/i.test(text)) return false;
  if (/\b(this|your) visit\b/i.test(text)) return false;
  return text.length > 0 && text.length <= 4000;
}

// ── Knowledge gaps — flag "I don't know" answers for the admin ───────────────

const GAP_RE = new RegExp(
  [
    "don'?t have that",
    "do not have that",
    "isn'?t something i know",
    "not something i know",
    "i don'?t know",
    "i do not know",
    "don'?t have (a|the|that) (detail|figure|answer)",
    "beyond (my|the) (register|knowledge)",
    "cannot (say|tell you|answer)",
    "no figure for",
    "that'?s a question for hello@",
  ].join("|"),
  "i",
);

/** Files an unanswered question for the Studio's Knowledge tab. Never throws. */
async function maybeFlagGap(
  cid: string | null, question: string | undefined, answer: string,
): Promise<void> {
  try {
    if (!question || !answer || !GAP_RE.test(answer)) return;
    await pgInsert("concierge_flags", {
      conversation_id: cid,
      question: question.slice(0, 2000),
      answer: answer.slice(0, 4000),
      reason: "knowledge_gap",
    });
  } catch { /* flagging never breaks the chat */ }
}

// ── Goal evaluation — a light judge scores the conversation vs. the goals ────

// Supabase edge background-task hook; run the judge after the response closes.
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

function scheduleGoalEval(
  cid: string | null, data: ConciergeData, transcript: ChatMessage[],
  apiKey: string, model: string,
): void {
  if (!cid || data.goals.length === 0) return;
  const p = evaluateGoals(cid, data, transcript, apiKey, model);
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(p);
    } else {
      p.catch(() => {});
    }
  } catch { p.catch(() => {}); }
}


async function evaluateGoals(
  cid: string, data: ConciergeData, transcript: ChatMessage[],
  apiKey: string, model: string,
): Promise<void> {
  try {
    if (!cid || data.goals.length === 0) return;
    const convo = transcript
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-16)
      .map((m) => `${m.role === "user" ? "Shopper" : "Concierge"}: ${m.content}`)
      .join("\n");
    const goalList = data.goals.map((g) => `${g.slug}: ${g.label} — ${g.description}`).join("\n");
    const judgeSystem =
      "You evaluate a sales conversation against goals. For EACH goal, judge whether it is " +
      "'met', 'partial', or 'unmet' so far, with a very short reason. Respond ONLY with a JSON " +
      "object mapping each goal slug to {\"status\":\"met|partial|unmet\",\"note\":\"...\"}. No prose.";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model, max_tokens: 500,
        system: judgeSystem,
        messages: [{
          role: "user",
          content: `GOALS:\n${goalList}\n\nCONVERSATION:\n${convo}\n\nReturn the JSON now.`,
        }],
      }),
    });
    if (!res.ok) return;
    // deno-lint-ignore no-explicit-any
    const msg = await res.json() as any;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    // deno-lint-ignore no-explicit-any
    let text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const a = text.indexOf("{"), z = text.lastIndexOf("}");
    if (a < 0 || z < 0) return;
    text = text.slice(a, z + 1);
    const parsed = JSON.parse(text) as Record<string, { status?: string; note?: string }>;
    const clean: Record<string, { status: string; note: string }> = {};
    for (const g of data.goals) {
      const v = parsed[g.slug];
      const st = v && ["met", "partial", "unmet"].includes(String(v.status)) ? String(v.status) : "unmet";
      clean[g.slug] = { status: st, note: (v && typeof v.note === "string") ? v.note.slice(0, 160) : "" };
    }
    await pgPatch(
      `concierge_conversations?id=eq.${cid}`,
      { goal_status: clean, goal_status_at: new Date().toISOString() },
    );
  } catch { /* evaluation is best-effort */ }
}

// ── System prompt assembly ───────────────────────────────────────────────────

function renderLiveState(ctx: Record<string, unknown>, customerLine: string | null): string {
  const val = (k: string) =>
    ctx[k] === undefined || ctx[k] === null || ctx[k] === "" ? "unknown" : String(ctx[k]);
  const line = [
    `section: ${val("section")}`, `claimed: ${val("claimed")}`,
    `remaining: ${val("remaining")}`, `slot: ${val("slot")}`,
    `holdClock: ${val("holdClock")}`, `loomClock: ${val("loomClock")}`,
  ].join(" | ");
  const browsing = [
    `device: ${val("device")}`, `scrolled: ${val("depth")}`,
    `minutes on page: ${val("minutes")}`, `checkout: ${val("checkout")}`,
    `this message arrived by: ${val("entry")}`, `seconds since their last: ${val("sinceLast")}`,
  ].join(" | ");
  const base = `${line}\nBROWSING: ${browsing}`;
  return customerLine ? `${base}\n${customerLine}` : base;
}

function formCatalog(data: ConciergeData): string {
  return data.forms.map((f) => `${f.slug} — ${f.title}`).join("; ");
}

function buildSystemPrompt(
  data: ConciergeData, liveState: string, signedIn: boolean,
): string {
  const kb = data.kbText ?? KB_MARKDOWN; // DB rows, else compiled-in fallback
  // Function replacements so "$" sequences in content are never interpreted.
  let system = BRAND_SYSTEM
    .replace("{{LIVE_STATE}}", () => liveState)
    .replace("{{KB}}", () => kb);
  if (signedIn) {
    system += "\nREGISTER TOOLS\n" +
      "- This shopper is signed in and email-verified. You hold the register desk's tools: " +
      "get_my_orders (read their orders), update_shipping_address (before shipment), " +
      "update_colorway (only while 'placed'), cancel_order (only while 'placed'), " +
      "remember_customer (one durable line to the client book).\n" +
      "- Call get_my_orders before answering any question about their orders — never rely on memory. " +
      "Struck (cancelled) entries are archive: leave them out of lists and counts unless the owner " +
      "asks about cancellations or history (then call get_my_orders with include_cancelled).\n" +
      "- For any change (address, cancellation): state exactly what you are about to do and get the " +
      "owner's explicit confirmation in this conversation before calling the tool. Report the tool's " +
      "result verbatim in substance — never claim a change happened unless the tool confirmed it.\n" +
      "- This pattern governs EVERY register action (status detail, cancellation, address change, " +
      "anything that modifies an order): when more than one order could be meant, FIRST list the " +
      "eligible orders, then offer one {{reply:...}} pill per order, each on its own line, at most 6. " +
      "For any change, after they pick, restate the consequence in one line and " +
      "offer exactly two pills — {{reply:Yes, cancel Nº X}} / {{reply:Keep Nº X}} (or the matching " +
      "pair for the action). Call the tool only after the explicit Yes. Never make the owner type " +
      "what a tap can say.\n" +
      "- Identify orders the way a person remembers them, not by number alone. In lists, lead with " +
      "the cloth and what distinguishes it — placed date, gift recipient, destination when they " +
      "differ ('Graphit, placed July 4 — a gift for Anna Weber'); the Nº is the receipt, not the " +
      "identity. Pills carry the cloth with the number: {{reply:Cancel the Graphit — Nº 14,228}}; " +
      "when several orders share a cloth, add the placed date or recipient to the pill so no two " +
      "read alike.\n" +
      (data.forms.length > 0
        ? "- FORMS: for structured input, emit {{form:<slug>:<serial>}} on its own line once the " +
          "order is chosen — it renders a proper form and the register records the submission " +
          "directly (the chat will show the confirmation). Available forms: " + formCatalog(data) +
          ". Never dictate form fields through chat, and never invent form slugs.\n"
        : "") +
      "- LIVE STATE may carry the owner's STANDING in the Webbuch (Eintrag — first entry; " +
      "Wiederkehr — one who returns; Hausfreund — friend of the house; Stifter — patron of the mill). " +
      "Acknowledge it once, lightly, when greeting or thanking — never as a gimmick or a sales lever. " +
      "Orders marked as gifts carry the recipient's name on the card; the buyer remains the owner of record.\n";
  }
  if (data.goals.length > 0) {
    system += "\nCONVERSATION GOALS (pursue these naturally across the conversation; do not announce them)\n" +
      data.goals.map((g) => `- ${g.label}: ${g.description}`).join("\n") + "\n";
  }
  if (data.sopText) {
    system += "\nSTANDARD OPERATING PROCEDURES (follow these exactly)\n" + data.sopText + "\n";
  }
  const notes = data.config?.voice_notes;
  if (typeof notes === "string" && notes.trim().length > 0) {
    system += "\nADMIN TUNING NOTES (follow these):\n" + notes;
  }
  return system;
}

// ── Logging — concierge_conversations / concierge_messages ───────────────────

/** Resolves the conversation, logs the last user message. Never throws. */
async function logUserTurn(body: ValidatedBody, customer: Customer | null, skipUser = false): Promise<string | null> {
  try {
    // Reuse the latest conversation for this session_key, else insert one.
    let cid: string | null = null;
    if (body.sessionKey) {
      const q = `concierge_conversations?select=id,user_id,user_email&session_key=eq.${
        encodeURIComponent(body.sessionKey)}&order=created_at.desc&limit=1`;
      const rows = await pgSelect<{ id: string; user_id: string | null; user_email: string | null }>(q);
      if (rows && rows.length > 0) {
        cid = rows[0].id;
        // Backfill identity if they signed in after the conversation began —
        // otherwise a signed-in chat keeps showing as anonymous in the Studio.
        if (customer && (!rows[0].user_id || !rows[0].user_email)) {
          await pgPatch(`concierge_conversations?id=eq.${cid}`, {
            user_id: customer.id, user_email: customer.email,
          });
        }
      }
    }
    if (!cid) {
      const row = await pgInsert<{ id: string }>("concierge_conversations", {
        session_key: body.sessionKey,
        user_id: customer?.id ?? null,
        user_email: customer?.email ?? null,
        section: typeof body.context.section === "string"
          ? body.context.section.slice(0, 64)
          : null,
      });
      cid = row?.id ?? null;
    }
    if (!cid) return null;
    if (!skipUser) {
      const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
      if (lastUser) {
        await pgInsert("concierge_messages", {
          conversation_id: cid, role: "user", content: lastUser.content,
        });
      }
    }
    return cid;
  } catch { return null; }
}

async function logAssistantTurn(
  cid: string | null, text: string, model: string, latencyMs: number,
): Promise<string | null> {
  if (!cid || text.length === 0) return null;
  const row = await pgInsert<{ id: number }>("concierge_messages", {
    conversation_id: cid, role: "assistant", content: text,
    model, latency_ms: latencyMs,
  });
  return row && typeof row.id === "number"
    ? JSON.stringify({ m: { cid, mid: row.id } })
    : null;
}

// ── SSE plumbing ─────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function sseFrame(obj: unknown): Uint8Array {
  return encoder.encode("data: " + JSON.stringify(obj) + "\n\n");
}

function sseResponse(req: Request, stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

/** Splits text into small chunks so cached / tool-loop replies still weave. */
function* chunked(text: string): Generator<string> {
  const words = text.split(/(?<=\s)/); // keep whitespace attached
  let buf = "";
  for (const w of words) {
    buf += w;
    if (buf.length >= 24) { yield buf; buf = ""; }
  }
  if (buf) yield buf;
}

// ── GET ?config=1 — public widget bootstrap ──────────────────────────────────

async function handleConfigGet(req: Request): Promise<Response> {
  const { config } = await loadConciergeData();
  const starters = config?.starters;
  const { forms } = await loadConciergeData();
  return jsonResponse(req, 200, {
    enabled: config?.enabled === false ? false : true,
    greeting: typeof config?.greeting === "string" ? config.greeting : null,
    starters: starters && typeof starters === "object" && !Array.isArray(starters) ? starters : null,
    auth: true,
    forms: forms.map((f) => ({ slug: f.slug, title: f.title, fields: f.fields })),
  });
}

// ── POST — streaming chat ────────────────────────────────────────────────────

async function handleChatPost(req: Request): Promise<Response> {
  // Rate limit (v1 behavior: 20 req / 10 min per x-forwarded-for IP).
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    return jsonError(req, 429,
      "Too many requests. The concierge takes a short pause — try again in a few minutes.");
  }

  // Body validation (v1 rules + optional session_key).
  let parsed: unknown;
  try { parsed = await req.json(); } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const validated = validateBody(parsed);
  if (typeof validated === "string") return jsonError(req, 400, validated);

  // Proactive follow-up: the client reports the shopper fell quiet with a
  // nudge context. Append a synthetic instruction (never shown, never logged
  // as the shopper's words) so the model picks the thread back up itself.
  const nudge = (validated.context && typeof validated.context === "object")
    ? (validated.context as Record<string, unknown>).nudge as
      { seconds?: number; count?: number } | undefined
    : undefined;
  const isNudge = !!nudge &&
    validated.messages.length > 0 &&
    validated.messages[validated.messages.length - 1].role === "assistant";
  if (isNudge) {
    const secs = typeof nudge!.seconds === "number" ? Math.round(nudge!.seconds) : 40;
    const cnt = typeof nudge!.count === "number" ? nudge!.count : 1;
    const decision = cnt >= 2
      ? "This is your second follow-up — the conversation is winding down. Follow your WRAP-UP " +
        "procedure: if the shopper is signed in and you learned something durable this visit, " +
        "call remember_customer with one client-book line first. Then either give space (reply " +
        "exactly [HOLD] and nothing else if they seem to be reading, deciding, or done) or offer " +
        "a warm, unhurried close per the SNOOZE procedure — one concrete thread to pull later."
      : "A good clerk circles back once — so SPEAK now (do not hold). Send one warm, specific line.";
    validated.messages.push({
      role: "user",
      content:
        `[Context note, not the shopper's words: they have been quiet about ${secs} seconds ` +
        `(follow-up #${cnt}). Follow your ENGAGEMENT & PACING procedure. ${decision} ` +
        `Draw the line from THIS conversation and what you know of them — their client book, the ` +
        `room or person they mentioned, the cloth they lingered on. Never a generic or scripted ` +
        `line; say something only this shopper would hear. Do not greet them again; do not repeat ` +
        `yourself. One or two sentences.]`,
    });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");

  // Config-driven behavior: kill switch, model, max_tokens.
  const data = await loadConciergeData();
  if (data.config?.enabled === false) {
    return jsonError(req, 503, "The concierge is resting. Write hello@feierabend.example.");
  }
  const model = (typeof data.config?.model === "string" && data.config.model) ||
    Deno.env.get("MODEL") || "claude-sonnet-4-5";
  const maxTokens = typeof data.config?.max_tokens === "number" &&
      data.config.max_tokens > 0
    ? Math.floor(data.config.max_tokens)
    : 1024;

  // Signed-in awareness (anonymous on absent/invalid token; never errors).
  const customer = await verifyUser(req);
  const customerLine = customer ? await customerBlock(customer) : null;
  const system = buildSystemPrompt(
    data, renderLiveState(validated.context, customerLine), customer !== null,
  );

  // Logging: resolve conversation + store the user turn, concurrently with
  // the model work; awaited again before the stream finishes.
  const conversationPromise = logUserTurn(validated, customer, isNudge);
  const startedAt = Date.now();

  // ── Semantic cache — anonymous, single-turn questions only ────────────────
  // Multi-turn answers depend on conversation context; signed-in answers on
  // the register. Neither may be cached or served from cache.
  let queryEmbedding: number[] | null = null;
  const lastUser = [...validated.messages].reverse().find((m) => m.role === "user");
  const userTurns = validated.messages.filter((m) => m.role === "user").length;
  const cacheEligible = !customer && !isNudge &&
    userTurns === 1 &&
    !!lastUser && lastUser.content.length <= 300 &&
    !CACHE_SKIP.test(lastUser.content);

  if (cacheEligible && lastUser) {
    queryEmbedding = await embed(lastUser.content);
    if (queryEmbedding) {
      const hit = await cacheLookup(queryEmbedding);
      if (hit) {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              controller.enqueue(sseFrame({ c: 1 }));
              for (const piece of chunked(hit.answer_md)) {
                controller.enqueue(sseFrame({ t: piece }));
              }
              const cid = await conversationPromise;
              const meta = await logAssistantTurn(
                cid, hit.answer_md, "cache", Date.now() - startedAt,
              );
              if (meta) controller.enqueue(encoder.encode(`data: ${meta}\n\n`));
            } catch { /* still close cleanly */ }
            try {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch { /* consumer gone */ }
          },
        });
        return sseResponse(req, stream);
      }
    }
  }

  // ── Nudge path: the model decides to speak or to give space (hold) ──
  if (isNudge) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => {
          try { controller.enqueue(sseFrame(obj)); } catch { /* gone */ }
        };
        let text = "";
        try {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model, max_tokens: Math.min(maxTokens, 400), system,
              messages: validated.messages,
            }),
          });
          if (res.ok) {
            // deno-lint-ignore no-explicit-any
            const msg = await res.json() as any;
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            text = blocks.filter((b: { type: string }) => b.type === "text")
              // deno-lint-ignore no-explicit-any
              .map((b: any) => b.text).join("").trim();
          }
        } catch { /* fall through to hold */ }

        const held = text.length === 0 || /^\[?hold\]?\.?$/i.test(text) ||
          /^\[hold\]/i.test(text);
        if (held) {
          send({ hold: 1 });
        } else {
          for (const piece of chunked(text)) send({ t: piece });
          try {
            const cid = await conversationPromise;
            const meta = await logAssistantTurn(cid, text, model, Date.now() - startedAt);
            if (meta) { try { controller.enqueue(encoder.encode(`data: ${meta}\n\n`)); } catch { /* gone */ } }
          } catch { /* skip meta */ }
        }
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch { /* gone */ }
      },
    });
    return sseResponse(req, stream);
  }

  // ── Signed-in path: agentic tool loop (non-streaming turns, chunked out) ──
  if (customer) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => {
          try { controller.enqueue(sseFrame(obj)); } catch { /* consumer gone */ }
        };
        let finalText = "";
        try {
          const cid = await conversationPromise;
          // deno-lint-ignore no-explicit-any
          const convo: any[] = validated.messages.map((m) => ({ role: m.role, content: m.content }));
          for (let round = 0; round < 4; round++) {
            if (round === 0) send({ s: "Consulting the register…" });
            const res = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model, max_tokens: maxTokens, system,
                messages: convo, tools: REGISTER_TOOLS,
              }),
            });
            if (!res.ok) {
              finalText = finalText ||
                "The register is briefly unreachable. Ask me again in a moment.";
              break;
            }
            // deno-lint-ignore no-explicit-any
            const msg = await res.json() as any;
            const blocks = Array.isArray(msg.content) ? msg.content : [];
            const textOut = blocks
              .filter((b: { type: string }) => b.type === "text")
              // deno-lint-ignore no-explicit-any
              .map((b: any) => b.text).join("");

            if (msg.stop_reason !== "tool_use") { finalText = textOut; break; }

            // Execute every requested tool, then continue the loop.
            convo.push({ role: "assistant", content: blocks });
            // deno-lint-ignore no-explicit-any
            const results: any[] = [];
            for (const block of blocks) {
              if (block.type !== "tool_use") continue;
              const label = block.name === "get_my_orders"
                ? "Reading the register…"
                : block.name === "update_shipping_address"
                ? "Amending the register…"
                : "Striking the entry…";
              send({ s: label });
              const out = await runRegisterTool(
                block.name, block.input ?? {}, customer, cid,
              );
              results.push({ type: "tool_result", tool_use_id: block.id, content: out });
            }
            convo.push({ role: "user", content: results });
            if (round === 3) {
              finalText = textOut ||
                "The register kept me longer than it should. Ask me once more.";
            }
          }

          for (const piece of chunked(finalText)) send({ t: piece });
          const lastUserMsg = [...validated.messages].reverse().find((m) => m.role === "user");
          await maybeFlagGap(cid, lastUserMsg?.content, finalText);
          if (!isNudge) {
            scheduleGoalEval(cid, data, [...validated.messages, { role: "assistant", content: finalText }], apiKey, model);
          }
          const meta = await logAssistantTurn(cid, finalText, model, Date.now() - startedAt);
          if (meta) { try { controller.enqueue(encoder.encode(`data: ${meta}\n\n`)); } catch { /* gone */ } }
        } catch { /* fall through to [DONE] */ }
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch { /* consumer gone */ }
      },
    });
    return sseResponse(req, stream);
  }

  // ── Anonymous path: plain streaming, then a cache write on the way out ────
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(
      { model, max_tokens: maxTokens, system, messages: validated.messages, stream: true },
    ),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return jsonError(req, 502, detail || `Upstream error (${upstream.status}).`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let assistantText = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of rawEvent.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const evt = JSON.parse(payload);
                if (evt.type === "content_block_delta" &&
                  evt.delta?.type === "text_delta" && typeof evt.delta.text === "string") {
                  assistantText += evt.delta.text;
                  controller.enqueue(sseFrame({ t: evt.delta.text }));
                }
                // Other event types (message_start/stop, ping, ...) ignored.
              } catch { /* ignore unparseable event payloads */ }
            }
          }
        }
      } catch {
        // Mid-stream failure: fall through so the front end still gets a
        // clean [DONE] and the partial reply is logged.
      } finally {
        // Log the assistant turn BEFORE [DONE], then emit the meta event.
        // Logging failures never break the stream — [DONE] is always sent.
        let meta: string | null = null;
        try {
          const cid = await conversationPromise;
          meta = await logAssistantTurn(cid, assistantText, model, Date.now() - startedAt);
        } catch { /* skip the meta event; still finish the stream */ }
        try {
          await maybeFlagGap(await conversationPromise, lastUser?.content, assistantText);
        } catch { /* ignore */ }
        try {
          const cidE = await conversationPromise;
          scheduleGoalEval(cidE, data, [...validated.messages, { role: "assistant", content: assistantText }], apiKey, model);
        } catch { /* eval is best-effort */ }
        // Cache write: single-turn anonymous miss with a state-free answer.
        try {
          if (cacheEligible && queryEmbedding && lastUser && cacheableAnswer(assistantText)) {
            await pgInsert("concierge_cache", {
              question: lastUser.content,
              answer_md: assistantText,
              embedding: vecLiteral(queryEmbedding),
              model,
            });
          }
        } catch { /* cache is best-effort */ }
        try {
          if (meta) controller.enqueue(encoder.encode(`data: ${meta}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch { /* consumer already disconnected */ }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return sseResponse(req, stream);
}

// ── POST ?wrapup=1 — record that a conversation closed or snoozed ─────────────
// The client posts this on two kinds of signal, so the lifecycle is a MIX:
//   • customer-explicit — they pressed "That's all for now" (close) or
//     "Don't message me until I write back" (snoozed / quiet mode);
//   • bot-automatic — the panel was dismissed after a real exchange, or the
//     bot itself wound the conversation down.
// Either way we stamp the conversation's status + ended_at ONCE (already-ended
// conversations are left alone, which dedupes repeat closes). From then on the
// next message opens a fresh conversation the bot treats as a re-engagement.
async function handleWrapup(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const sessionKey = typeof body.session_key === "string" ? body.session_key.slice(0, 64) : "";
  if (!sessionKey) return jsonResponse(req, 200, { ok: true, noted: false });
  const reason = body.reason === "quiet" ? "quiet"
    : body.reason === "close" ? "close"
    : "auto";
  // quiet mode → snoozed ("come back when they write"); close/auto → closed.
  const status = reason === "quiet" ? "snoozed" : "closed";
  try {
    const rows = await pgSelect<{ id: string; ended_at: string | null; user_id: string | null }>(
      `concierge_conversations?select=id,ended_at,user_id&session_key=eq.${
        encodeURIComponent(sessionKey)}&order=created_at.desc&limit=1`,
    );
    if (!rows || rows.length === 0 || rows[0].ended_at) {
      return jsonResponse(req, 200, { ok: true, noted: false });
    }
    const cid = rows[0].id;
    await pgPatch(`concierge_conversations?id=eq.${cid}`, {
      status, ended_at: new Date().toISOString(),
    });
    // For a signed-in patron, leave one terse client-book line so the next
    // visit reads as continuity, not a cold open.
    const customer = await verifyUser(req);
    if (customer) {
      const line = reason === "quiet"
        ? "Asked for room — quiet mode; wants to reach out first next time."
        : reason === "close"
        ? "Wrapped up the chat themselves — needs were met for now."
        : "Chat wound down after our exchange.";
      await pgInsert("customer_notes", { user_id: customer.id, email: customer.email, note: line });
    }
    return jsonResponse(req, 200, { ok: true, noted: true, status });
  } catch {
    return jsonResponse(req, 200, { ok: true, noted: false });
  }
}

// ── POST ?form=1 — structured submissions from in-chat forms ─────────────────
// Same trust boundary as the model's own tool calls: verified JWT, the tool's
// ownership filters and validation, the concierge_actions audit log.

async function handleFormPost(req: Request): Promise<Response> {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (rateLimited("f:" + ip)) {
    return jsonError(req, 429, "A short pause, please — the register is writing.");
  }
  const customer = await verifyUser(req);
  if (!customer) {
    return jsonError(req, 401, "The register takes signed entries — sign in first.");
  }
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const slug = typeof body.form === "string" ? body.form : "";
  const serial = typeof body.serial === "number" ? Math.floor(body.serial) : NaN;
  const values = (body.values && typeof body.values === "object" && !Array.isArray(body.values))
    ? body.values as Record<string, unknown>
    : null;
  if (!slug || !Number.isFinite(serial) || !values) {
    return jsonError(req, 400, "form, serial, and values are required.");
  }
  const data = await loadConciergeData();
  const def = data.forms.find((f) => f.slug === slug);
  if (!def) return jsonError(req, 404, "No such form.");

  // Build the tool input strictly from the form's own field definitions.
  const input: Record<string, unknown> = { serial };
  const fields = Array.isArray(def.fields) ? def.fields as Array<Record<string, unknown>> : [];
  for (const f of fields) {
    const name = typeof f.name === "string" ? f.name : "";
    if (!name) continue;
    const raw = values[name];
    const v = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
    if (f.required === true && !v) {
      return jsonError(req, 400, `${name} is required.`);
    }
    input[name] = v;
  }

  const result = await runRegisterTool(def.submit_tool, input, customer, null);
  if (result.startsWith("ERROR:")) {
    return jsonError(req, 400, result.slice(6).trim());
  }
  return jsonResponse(req, 200, { ok: true, message: result });
}

// ── Entry point ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method === "GET" && new URL(req.url).searchParams.get("config")) {
    return await handleConfigGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("cachecheck")) {
    // Self-diagnosis: run the semantic cache's WHOLE round trip — embed a
    // probe, write it, semantically match it back, delete it — and report
    // which step fails, with the raw error. Exposes no data beyond counts.
    const report: Record<string, unknown> = {};
    const v = await embed("a quiet diagnostic sentence for the register");
    report.embed = v ? `ok (${v.length} dims)` : "FAILED — see concierge_flags for detail";
    if (v) {
      // write
      let probeId: string | null = null;
      try {
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/concierge_cache`, {
          method: "POST",
          headers: { ...PG_HEADERS, "Prefer": "return=representation" },
          body: JSON.stringify({
            question: "(diagnostic probe)", answer_md: "(probe)",
            embedding: vecLiteral(v), model: "probe",
          }),
        });
        if (ins.ok) {
          const rows = await ins.json() as Array<{ id: string }>;
          probeId = rows[0]?.id ?? null;
          report.write = probeId ? "ok" : "FAILED — insert returned no row";
        } else {
          report.write = `FAILED — ${ins.status}: ${(await ins.text()).slice(0, 200)}`;
        }
      } catch (e) {
        report.write = `FAILED — ${e instanceof Error ? e.message : String(e)}`;
      }
      // match
      if (probeId) {
        try {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_cached_answer`, {
            method: "POST",
            headers: PG_HEADERS,
            body: JSON.stringify({ query_embedding: vecLiteral(v), match_threshold: 0.9 }),
          });
          if (res.ok) {
            const hits = await res.json() as Array<{ id: string }>;
            report.match = hits.some((h) => h.id === probeId)
              ? "ok — probe matched itself"
              : `unexpected — ${hits.length} row(s), probe not among them`;
          } else {
            report.match = `FAILED — ${res.status}: ${(await res.text()).slice(0, 200)}`;
          }
        } catch (e) {
          report.match = `FAILED — ${e instanceof Error ? e.message : String(e)}`;
        }
        // clean up the probe
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/concierge_cache?id=eq.${probeId}`, {
            method: "DELETE", headers: PG_HEADERS,
          });
        } catch { /* a stray probe row is visible in the Studio and deletable */ }
      }
    }
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/concierge_cache?select=id`,
        { headers: { ...PG_HEADERS, "Prefer": "count=exact", "Range": "0-0" } },
      );
      const range = res.headers.get("content-range") ?? "";
      const total = parseInt(range.split("/")[1] ?? "", 10);
      report.cache_rows = Number.isFinite(total) ? total : "unknown";
    } catch { report.cache_rows = "unknown"; }
    report.note =
      "cache engages only for anonymous (signed-out) visitors' first question of a conversation";
    return jsonResponse(req, 200, report);
  }
  if (req.method !== "POST") return jsonError(req, 405, "Method not allowed. Use POST, or GET ?config=1.");
  if (new URL(req.url).searchParams.get("wrapup")) return await handleWrapup(req);
  if (new URL(req.url).searchParams.get("form")) return await handleFormPost(req);
  return await handleChatPost(req);
});
