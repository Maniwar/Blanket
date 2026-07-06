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
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "Feierabend <concierge@feier-abend.co>";

// Bump when deploying so ?selftest=1 confirms which build is actually live.
const BUILD_TAG = "2026-07-06-ip-and-regrade";

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

/** Probe a table/column for existence + row count (for the self-test). A 400
 *  usually means a missing column/table; 200 with count 0 means it's empty. */
async function pgProbe(
  query: string,
): Promise<{ ok: boolean; status: number; count: number | null; error?: string }> {
  if (!SUPABASE_URL || !SERVICE_KEY) return { ok: false, status: 0, count: null, error: "no service key" };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      headers: { ...PG_HEADERS, "Prefer": "count=exact", "Range": "0-0" },
    });
    const total = parseInt((res.headers.get("content-range") ?? "").split("/")[1] ?? "", 10);
    return {
      ok: res.ok,
      status: res.status,
      count: Number.isFinite(total) ? total : null,
      error: res.ok ? undefined : (await res.text()).slice(0, 160),
    };
  } catch (e) {
    return { ok: false, status: 0, count: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Config + KB + SOPs — DB reads cached in module memory for 60 seconds ─────

interface FormDef {
  slug: string; title: string; submit_tool: string; fields: unknown;
}

interface GoalDef {
  slug: string; label: string; description: string;
  section?: string | null;      // legacy single section (kept for back-compat)
  sections?: string[] | null;   // journey stages this goal fits; empty/null = anywhere
}

/** The journey sections a goal fits, lowercased. Prefers the multi-value
 *  `sections` array; falls back to the legacy single `section` column. */
function goalSections(g: GoalDef): string[] {
  if (Array.isArray(g.sections) && g.sections.length > 0) {
    return g.sections.filter((s) => typeof s === "string").map((s) => s.toLowerCase());
  }
  return typeof g.section === "string" && g.section ? [g.section.toLowerCase()] : [];
}

// Admin overrides for the model-callable tools (concierge_tools table). A tool
// absent from this table runs with its built-in default (enabled, code default
// description); a row can disable it or override the model-facing description.
interface ToolReg { name: string; enabled: boolean; description: string | null }

interface ConciergeData {
  config: Record<string, unknown> | null; // concierge_config {key: jsonb value}
  kbText: string | null; // enabled concierge_kb rows; null -> KB_MARKDOWN fallback
  sopText: string | null; // enabled concierge_sops rows; null -> none
  forms: FormDef[]; // enabled concierge_forms rows
  goals: GoalDef[]; // enabled concierge_goals rows
  tools: ToolReg[]; // concierge_tools overrides (may be empty -> all defaults)
  at: number; // Date.now() of the read; refreshed after CACHE_TTL_MS
}

const CACHE_TTL_MS = 60_000;
let dataCache: ConciergeData | null = null;

// Which model answers. Precedence, most to least specific:
//   1. config.model          — the admin's explicit choice (Tuning → Model)
//   2. config.model_fallback  — the admin's configured fallback (Tuning)
//   3. MODEL env var          — an ops-set default (survives a DB-config read failure)
//   4. DEFAULT_MODEL          — the built-in last resort
// Nothing here is a magic string scattered across call sites: every model
// decision goes through resolveModel() so the fallback is configurable, not
// hard-coded. Kept cheap by default so a config blip degrades DOWN, not up.
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
function resolveModel(data: ConciergeData): string {
  const c = data.config || {};
  if (typeof c.model === "string" && c.model.trim()) return c.model.trim();
  if (typeof c.model_fallback === "string" && c.model_fallback.trim()) return c.model_fallback.trim();
  return Deno.env.get("MODEL") || DEFAULT_MODEL;
}

async function loadConciergeData(): Promise<ConciergeData> {
  if (dataCache && Date.now() - dataCache.at < CACHE_TTL_MS) return dataCache;
  const [cfgRows, kbRows, sopRows, formRows, goalRows, toolRows] = await Promise.all([
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
      "concierge_goals?select=slug,label,description,section,sections&enabled=is.true&order=sort_order.asc",
    ),
    pgSelect<ToolReg>("concierge_tools?select=name,enabled,description"),
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
    tools: toolRows ?? [],
    at: Date.now(),
  };
  return dataCache;
}

// ── Rate limiting — DB-backed fixed window (shared across all edge instances),
//    with a per-instance in-memory fallback if the DB/RPC is unreachable ───────

const RATE_LIMIT = 20; // requests per window
const RATE_WINDOW_SEC = 10 * 60; // 10 minutes
const RATE_WINDOW_MS = RATE_WINDOW_SEC * 1000;
const hits = new Map<string, number[]>(); // ip -> request timestamps (fallback only)

/** Per-instance sliding window — only used when the shared DB limiter can't be
 *  reached, so a database hiccup still leaves *some* protection in place. */
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

/** Shared, DB-backed limiter (one window across every instance). Returns true
 *  when the caller is over the limit. Fails over to the per-instance counter on
 *  any DB error, so it never blocks legitimate traffic on an outage. */
async function rateLimited(key: string, limit = RATE_LIMIT): Promise<boolean> {
  const over = await pgRpc<boolean>("rate_hit", {
    p_key: key, p_limit: limit, p_window_seconds: RATE_WINDOW_SEC,
  });
  if (over === null) return rateLimitedLocal(key, limit); // DB unreachable
  return over === true;
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
  if (context !== undefined &&
    (typeof context !== "object" || context === null || Array.isArray(context))) {
    return "context, if provided, must be an object.";
  }
  const ctxObj = (context ?? {}) as Record<string, unknown>;
  // A proactive opener (the bot greeting a returning visitor) may carry no prior
  // messages — the handler injects its own instruction.
  const isOpener = ctxObj.opener === "reengage" || ctxObj.opener === "greet";
  if (!Array.isArray(messages) || messages.length > 20 || (messages.length < 1 && !isOpener)) {
    return "messages must be an array of up to 20 items.";
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

// ── Transactional email (cancellation) ───────────────────────────────────────
// The concierge places nothing, but it *can* cancel — so it owns the
// cancellation note. Placement/shipment emails live in the commission function.

const EMAIL_COLORWAY: Record<string, string> = {
  ungefaerbt: "Ungefärbt", loden: "Loden", graphit: "Graphit",
};

/** Fire-and-forget async work that must not block or fail the response. */
function bg(p: Promise<unknown>): void {
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else (p as Promise<unknown>).catch(() => {});
  } catch { (p as Promise<unknown>).catch(() => {}); }
}

/** Best-effort email via Resend's API. Never throws. When `meta` is given the
 *  attempt is recorded in email_log (so the admin sees it and can re-send). */
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
    await pgInsert("email_log", {
      to_email: to, kind: meta.kind, serial: meta.serial ?? null,
      subject, ok, provider_id: providerId, error,
    });
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

/** The cancellation note, mirroring the commission function's 'cancelled' email. */
function cancelEmail(serial: number, name?: string | null, colorway?: string | null): {
  subject: string; html: string;
} {
  const no = "Nº " + Number(serial).toLocaleString("en-US");
  const first = (name ?? "").trim().split(/\s+/)[0] || "";
  const greet = first ? `${first},` : "Guten Tag,";
  const cloth = colorway && EMAIL_COLORWAY[colorway] ? ` in ${EMAIL_COLORWAY[colorway]}` : "";
  return {
    subject: `${no} — cancelled`,
    html: emailShell("Struck from the register", [
      `${greet} as you asked, <strong>${no}</strong>${cloth} has been cancelled, and the number returns to the edition.`,
      "Nothing was charged — this is a demo. If it was in error, just say the word and we'll set it right.",
    ]),
  };
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
  customer: Customer, includeCancelled = false, colorway?: string,
): Promise<OrderRow[] | null> {
  const cw = colorway && ["ungefaerbt", "loden", "graphit"].includes(colorway)
    ? `&colorway=eq.${colorway}` : "";
  return await pgSelect<OrderRow>(
    "orders?select=serial,status,tracking,colorway,address,address2,city,state,zip,placed_at,recipient_name,is_gift,cancelled_serial,name" +
      (includeCancelled ? "" : "&status=neq.cancelled") + cw +
      `&${ownershipFilter(customer)}&order=placed_at.desc&limit=500`,
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
    const head = `${orders.length} on the register` +
      (orders.length > 1 || open > 0
        ? ` (${open} not yet delivered, ${delivered} delivered)`
        : "");
    if (orders.length <= 3) {
      // Few orders: list them inline — cheap, and lets the bot greet naturally.
      summary = `${head} — ${orders.map(fmt).join("; ")}`;
    } else {
      // Many orders: a compact cloth tally + the two most recent, NOT the whole
      // list. Detail comes from get_my_orders (the authoritative source the bot is
      // told to use), so re-sending all of them here every turn is dead weight —
      // and having two order sources is what caused miscounts. `orders` is
      // placed_at desc, so [0..1] are the latest.
      const byCloth: Record<string, number> = {};
      for (const o of orders) {
        const c = o.colorway ?? "—";
        byCloth[c] = (byCloth[c] ?? 0) + 1;
      }
      const tally = Object.entries(byCloth)
        .map(([c, n]) => `${n} ${EMAIL_COLORWAY[c] ?? c}`).join(", ");
      summary = `${head} — by cloth: ${tally}. Most recent: ${orders.slice(0, 2).map(fmt).join("; ")}. ` +
        `(Do NOT enumerate or count their orders from this summary — call get_my_orders for the full, current list.)`;
    }
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
      "Returns an authoritative { count, colorway, orders } — ALWAYS call this before " +
      "answering ANY question about the owner's orders, including every count and every " +
      "'how many' — use its count and rows verbatim; never count or filter from memory. " +
      "When the owner is narrowing to one cloth (e.g. 'show my Ungefärbt', or after they " +
      "tap a cloth pill), pass 'colorway' so the register returns exactly that cloth's " +
      "orders and you don't have to filter in your head. " +
      "Struck (cancelled) entries are omitted unless include_cancelled is true — " +
      "pass it only when the owner asks about cancelled or past entries.",
    input_schema: {
      type: "object",
      properties: {
        include_cancelled: {
          type: "boolean",
          description: "Also return struck (cancelled) entries. Default false.",
        },
        colorway: {
          type: "string", enum: ["ungefaerbt", "loden", "graphit"],
          description: "Return only orders in this cloth. Pass it whenever the owner is " +
            "looking at or picking among a single colorway.",
        },
      },
      required: [],
    },
  },
  {
    name: "recall_context",
    description:
      "Pull the signed-in patron's prior context on demand: their full client-book notes and the " +
      "tail of their most recent EARLIER conversation(s). The CUSTOMER block already summarizes " +
      "their orders, standing, recency, and the latest notes — call this only when you need more: " +
      "older notes, or what was actually said last time, to re-engage a returning patron faithfully. " +
      "Read-only.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  // NOTE: address changes are intentionally NOT a free-text model tool. A model
  // composing five address fields can (and did) mis-map them — e.g. a city into
  // the street field. Address edits go through the {{form:address-change:serial}}
  // form instead, so a human types each labeled field. The form's submit path
  // (handleFormPost → runRegisterTool → update_shipping_address) still validates
  // and writes; only the free-typed model tool is removed.
  {
    name: "remember_customer",
    description:
      "Write one short, durable, factual line to this patron's client book — a room they " +
      "mentioned, a favored cloth, a gift occasion, a hesitation, a thread to pick up later. " +
      "Only what a good clerk would note; never health, beliefs, finances, or anything " +
      "sensitive. The book is shown to the patron's own conversations and to the admin. " +
      "Do NOT record something the CLIENT BOOK above already holds — one line per durable " +
      "fact; if it is already noted, say nothing rather than repeating it.",
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
  {
    name: "join_waitlist",
    description:
      "Add this patron to the waitlist for a future edition. Use when the year's run is sold out, " +
      "when they ask to be told about the next edition, or when a cloth they want isn't available. " +
      "Use their signed-in email; you may also record a preferred cloth and a short note. " +
      "Confirm warmly once done.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The patron's email (use the signed-in one)." },
        colorway: { type: "string", description: "Optional preferred cloth: ungefaerbt, loden, or graphit." },
        note: { type: "string", description: "Optional short note about what they're after." },
      },
      required: ["email"],
    },
  },
  {
    name: "resend_confirmation",
    description:
      "Re-send a transactional email the owner already should have — the order " +
      "confirmation, the shipping note, or the cancellation note — to their email on " +
      "file. Use when a patron says they didn't receive it or want another copy. " +
      "Pick 'kind' from what the order actually is: 'confirmation' for a placed order, " +
      "'shipping' only once it has shipped, 'cancellation' only if it was cancelled. " +
      "Nothing is charged; this only re-sends an existing note.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        kind: {
          type: "string", enum: ["confirmation", "shipping", "cancellation"],
          description: "Which note to re-send.",
        },
      },
      required: ["serial", "kind"],
    },
  },
  {
    name: "track_shipment",
    description:
      "Look up where one of the owner's orders stands: its status and, once it has " +
      "shipped, the tracking number. Read-only. Call this before answering 'where is my " +
      "blanket' rather than guessing — it reads the live register.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
      },
      required: ["serial"],
    },
  },
  {
    name: "get_care_guide",
    description:
      "Give the owner the care instructions for their blanket, tailored to its cloth " +
      "(colorway). Read-only — use it when they ask how to wash, store, air, or look after " +
      "the wool. If they have no order, you may still explain general care from the KB.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
      },
      required: ["serial"],
    },
  },
  {
    name: "update_gift_details",
    description:
      "Change the gift recipient's name on one of the owner's gift orders — the name that " +
      "goes on the enclosed card. Allowed only before the order ships, and only on orders " +
      "marked as a gift. Confirm the exact spelling with the owner before calling. This does " +
      "NOT change the shipping address (that goes through the address-change form).",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        recipient_name: {
          type: "string",
          description: "The gift recipient's name for the card (1–80 characters).",
        },
      },
      required: ["serial", "recipient_name"],
    },
  },
  {
    name: "request_mending",
    description:
      "Log a mending / repair request for one of the owner's blankets — a pull, a loose " +
      "bind, a moth nibble, anything the mill should look at. Records the request and the " +
      "owner's description so the workshop can follow up; confirm warmly that it's noted. " +
      "This opens a request only — it does not schedule or promise a specific repair.",
    input_schema: {
      type: "object",
      properties: {
        serial: { type: "integer", description: "The order's serial number (Nº)." },
        note: {
          type: "string",
          description: "The owner's description of what needs mending (a sentence or two).",
        },
      },
      required: ["serial", "note"],
    },
  },
];

// Core tools the concierge leans on for basic competence. They can still be
// disabled from the admin, but the manifest flags them so the UI can warn.
const CORE_TOOLS = new Set(["get_my_orders", "recall_context"]);

/** The tools array sent to the model, with admin overrides applied:
 *  disabled tools are dropped; a non-empty description override replaces the
 *  built-in copy. An empty/absent registry leaves every tool at its default. */
// deno-lint-ignore no-explicit-any
function buildToolsForModel(data: ConciergeData): any[] {
  const reg = new Map((data.tools ?? []).map((t) => [t.name, t]));
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const tool of REGISTER_TOOLS) {
    const o = reg.get(tool.name);
    if (o && o.enabled === false) continue;
    if (o && typeof o.description === "string" && o.description.trim().length > 0) {
      out.push({ ...tool, description: o.description });
    } else {
      out.push(tool);
    }
  }
  return out;
}

/** The admin-facing tools manifest: every built-in tool, its current enabled
 *  state, the effective (possibly overridden) description, and whether the
 *  description is a custom override or the code default. */
function toolsManifest(data: ConciergeData): Array<{
  name: string; enabled: boolean; core: boolean;
  description: string; default_description: string; overridden: boolean;
}> {
  const reg = new Map((data.tools ?? []).map((t) => [t.name, t]));
  return REGISTER_TOOLS.map((tool) => {
    const o = reg.get(tool.name);
    const overridden = !!(o && typeof o.description === "string" && o.description.trim().length > 0);
    return {
      name: tool.name,
      enabled: !(o && o.enabled === false),
      core: CORE_TOOLS.has(tool.name),
      description: overridden ? (o!.description as string) : tool.description,
      default_description: tool.description,
      overridden,
    };
  });
}

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
    const cw = typeof input.colorway === "string" ? input.colorway.toLowerCase() : undefined;
    const orders = await myOrders(customer, input.include_cancelled === true, cw);
    if (orders === null) return "ERROR: the register is unreachable right now.";
    const cwLabel = cw && ["ungefaerbt", "loden", "graphit"].includes(cw) ? cw : "all";
    await logAction(cid, customer, "get_my_orders", null, cw ? { colorway: cw } : null,
      `${orders.length} orders read${cw ? ` (${cwLabel})` : ""}`);
    // Return an authoritative shape so the model reports the count and rows
    // verbatim instead of tallying a long list by hand (which it does badly).
    return JSON.stringify({
      count: orders.length,
      colorway: cwLabel,
      orders: orders.map((o) => ({ ...o, serial: o.serial ?? o.cancelled_serial })),
    });
  }

  if (name === "recall_context") {
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const notes = await pgSelect<{ note: string; created_at: string }>(
      `customer_notes?select=note,created_at&${nf}&order=created_at.desc&limit=20`,
    );
    const cf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},user_email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const convos = await pgSelect<{ id: string; created_at: string; ended_at: string | null }>(
      `concierge_conversations?select=id,created_at,ended_at&${cf}${
        cid ? `&id=neq.${cid}` : ""}&order=created_at.desc&limit=2`,
    );
    const prior: Array<{ when: string; turns: string[] }> = [];
    if (convos) {
      for (const c of convos) {
        const msgs = await pgSelect<{ role: string; content: string }>(
          `concierge_messages?select=role,content,created_at&conversation_id=eq.${c.id}` +
            `&order=created_at.desc&limit=8`,
        );
        if (msgs && msgs.length > 0) {
          prior.push({
            when: String(c.created_at).slice(0, 10),
            turns: msgs.reverse().map((m) => `${m.role === "user" ? "Patron" : "You"}: ${m.content}`),
          });
        }
      }
    }
    await logAction(cid, customer, "recall_context", null, null,
      `${notes?.length ?? 0} notes, ${prior.length} prior conversations`);
    return JSON.stringify({
      client_book: (notes ?? []).map((n) => `${String(n.created_at).slice(0, 10)}: ${n.note}`),
      prior_conversations: prior,
    });
  }

  if (name === "join_waitlist") {
    const email = (typeof input.email === "string" ? input.email.trim().toLowerCase() : "") ||
      (customer.email ?? "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return "ERROR: a valid email is needed for the waitlist — ask them for one first.";
    }
    const cw = typeof input.colorway === "string" ? input.colorway.trim().toLowerCase() : "";
    const row = await pgInsert("waitlist", {
      email,
      colorway: ["ungefaerbt", "loden", "graphit"].includes(cw) ? cw : null,
      note: typeof input.note === "string" ? input.note.trim().slice(0, 400) || null : null,
      source: "concierge",
      user_id: customer.id ?? null,
    });
    if (!row) return "ERROR: the waitlist is unreachable right now.";
    await logAction(cid, customer, "join_waitlist", null, { email }, "added to waitlist");
    return `Done — ${email} is on the waitlist for the next edition; I'll see they're told when it opens.`;
  }

  if (name === "remember_customer") {
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 240) : "";
    if (note.length < 3) return "ERROR: a note needs a few words.";
    // Don't let the book fill with repeats — if this line substantially
    // duplicates one already on file, accept the intent without a second row.
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const prior = await pgSelect<{ note: string }>(
      `customer_notes?select=note&${nf}&order=created_at.desc&limit=12`,
    );
    if (isRedundantNote(note, prior ?? [])) {
      return "Already in the client book — nothing new to add.";
    }
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
    `orders?select=serial,status,tracking,colorway,address,address2,city,state,zip,placed_at,recipient_name,is_gift` +
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
      const mail = cancelEmail(serial, order.name, order.colorway);
      bg(sendEmail(customer.email ?? "", mail.subject, mail.html, { kind: "cancelled", serial }));
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
      const mail = cancelEmail(serial, order.name, order.colorway);
      bg(sendEmail(customer.email ?? "", mail.subject, mail.html, { kind: "cancelled", serial }));
      return `Done. Nº ${serial} is cancelled.`;
    }
    return `ERROR: the register declined — ${result}.`;
  }

  if (name === "track_shipment") {
    await logAction(cid, customer, "track_shipment", serial, null, `status ${order.status}`);
    const status = order.status ?? "unknown";
    if (["shipped", "delivered"].includes(status)) {
      return JSON.stringify({
        serial, status,
        tracking: order.tracking ?? null,
        note: order.tracking
          ? `Nº ${serial} is ${status}. Tracking: ${order.tracking}.`
          : `Nº ${serial} is ${status}, but no tracking number is on the register yet.`,
      });
    }
    const stage = status === "placed" ? "entered and queued to weave"
      : status === "weaving" ? "on the loom"
      : status === "finishing" ? "off the loom, being finished and sealed"
      : status === "cancelled" ? "struck from the register (cancelled)"
      : status === "returned" ? "returned"
      : status;
    return JSON.stringify({
      serial, status, tracking: null,
      note: `Nº ${serial} has not shipped yet — it is ${stage}. Woven to order, 3–5 weeks door to door. Tracking appears here the moment it leaves the mill.`,
    });
  }

  if (name === "get_care_guide") {
    await logAction(cid, customer, "get_care_guide", serial, null, `colorway ${order.colorway}`);
    const cw = order.colorway ?? "";
    const clothName = EMAIL_COLORWAY[cw] ?? "your cloth";
    const clothNote = cw === "ungefaerbt"
      ? "Ungefärbt is undyed wool in its own colour, so it wears its natural lanolin longest — air it and it freshens itself; it needs washing least often of the three."
      : cw === "loden"
      ? "Loden is a dense, fulled cloth — it sheds light rain and resists pilling; a firm shake and an airing is usually all it wants."
      : cw === "graphit"
      ? "Graphit is piece-dyed deep grey — keep strong direct sun off it over years so the depth of colour holds."
      : "";
    return JSON.stringify({
      serial, colorway: clothName,
      care: [
        "Air, don't wash. Wool is self-cleaning — a few hours over a rail outdoors lifts most odours and creases.",
        "Spot-clean spills at once with cool water and a little wool-safe soap; blot, never rub.",
        "When it truly needs it: hand-wash cool with a wool detergent, no wringing. Press water out flat, dry flat away from heat. Never tumble-dry.",
        "Store it folded and breathing — a cotton bag, never plastic — with cedar or lavender against moth. Airing a few times a year is the best moth defence.",
        "A gentle de-pill with a wool comb keeps the face clean; a cool iron under a damp cloth relaxes a hard crease.",
        clothNote,
      ].filter(Boolean),
    });
  }

  if (name === "update_gift_details") {
    if (!order.is_gift) {
      return `ERROR: Nº ${serial} isn't marked as a gift, so there's no recipient card to name. ` +
        "If it should be a gift, that's set when the order is placed.";
    }
    if (!MUTABLE_STATUSES.includes(order.status ?? "")) {
      return `ERROR: Nº ${serial} is '${order.status}' — the card is already enclosed. ` +
        "Gift-name changes are possible only before shipment.";
    }
    const rn = String(input.recipient_name ?? "").trim();
    if (rn.length < 1 || rn.length > 80) return "ERROR: the recipient's name must be 1–80 characters.";
    const updated = await pgPatch<OrderRow>(
      `orders?serial=eq.${serial}&${ownershipFilter(customer)}`,
      { recipient_name: rn },
    );
    if (!updated || updated.length === 0) return "ERROR: the register did not accept the change.";
    await logAction(cid, customer, "update_gift_details", serial, { recipient_name: rn }, "gift name updated");
    return `Recorded. The card on Nº ${serial} now reads for ${rn}.`;
  }

  if (name === "request_mending") {
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
    if (note.length < 4) return "ERROR: a mending request needs a short description of what's wrong.";
    const row = await pgInsert("concierge_actions", {
      conversation_id: cid, user_id: customer.id, email: customer.email,
      action: "request_mending", serial, payload: { note },
      result: "mending requested",
    });
    if (!row) return "ERROR: the workshop log is unreachable right now — ask them to try again shortly.";
    return `Noted — a mending request for Nº ${serial} is logged with the workshop: "${note}". ` +
      "Someone will follow up by email. Wool is meant to be mended, not discarded — this is exactly what the mill is for.";
  }

  if (name === "resend_confirmation") {
    const KIND_MAP: Record<string, "placed" | "shipped" | "cancelled"> = {
      confirmation: "placed", shipping: "shipped", cancellation: "cancelled",
    };
    const rawKind = String(input.kind ?? "").toLowerCase();
    const mapped = KIND_MAP[rawKind];
    if (!mapped) return "ERROR: kind must be confirmation, shipping, or cancellation.";
    const st = order.status ?? "";
    if (mapped === "shipped" && !["shipped", "delivered"].includes(st)) {
      return `ERROR: Nº ${serial} hasn't shipped yet (it's '${st}'), so there's no shipping note to re-send. ` +
        "Offer the order confirmation instead, or track the shipment.";
    }
    if (mapped === "cancelled" && !["cancelled", "returned"].includes(st)) {
      return `ERROR: Nº ${serial} is '${st}', not cancelled — a cancellation note wouldn't apply.`;
    }
    if (!SUPABASE_URL || !SERVICE_KEY) return "ERROR: the mail service is unreachable right now.";
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/commission?custresend=1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({ serial, kind: mapped }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({} as Record<string, unknown>));
        const em = typeof (detail as { error?: unknown }).error === "string"
          ? (detail as { error: string }).error : "the mail service declined";
        return `ERROR: ${em}`;
      }
      const okBody = await res.json().catch(() => ({} as Record<string, unknown>));
      const to = typeof (okBody as { to?: unknown }).to === "string"
        ? (okBody as { to: string }).to : (customer.email ?? "your email on file");
      await logAction(cid, customer, "resend_confirmation", serial, { kind: rawKind }, `re-sent ${mapped}`);
      const label = mapped === "placed" ? "order confirmation"
        : mapped === "shipped" ? "shipping note" : "cancellation note";
      return `Done — the ${label} for Nº ${serial} is on its way to ${to} again. ` +
        "Give it a minute, and do check the spam folder if it's shy.";
    } catch {
      return "ERROR: the mail service didn't respond — ask them to try again in a moment.";
    }
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
  // Substance gate: nothing meaningful to grade on a one-message exchange.
  const userTurns = transcript.filter((m) => m.role === "user").length;
  if (userTurns < 2) return;
  // Sampling: goal scoring is pure analytics and fires every turn, so grade only
  // a fraction to bound background LLM cost. Admin-settable via the
  // goal_sample_rate config key (0–1); default 1 = grade every eligible turn.
  const rate = typeof data.config?.goal_sample_rate === "number"
    ? data.config.goal_sample_rate
    : 1;
  if (rate < 1 && Math.random() >= Math.max(0, rate)) return;
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
      "You evaluate a sales conversation against goals, strictly and evidence-based. For EACH " +
      "goal, judge 'met', 'partial', or 'unmet' SO FAR. Be conservative: mark 'met' ONLY when the " +
      "transcript contains clear evidence it happened, 'partial' when begun but incomplete, and " +
      "'unmet' when there is no evidence — a short or off-topic exchange leaves most goals 'unmet'. " +
      "The 'note' MUST justify the status with a specific fact from THIS transcript: quote or " +
      "paraphrase what the shopper or concierge actually said that proves it (e.g. \"shopper named " +
      "the east-facing bedroom and chose Loden\"). Never write a generic note; if you cannot cite " +
      "evidence, the status is 'unmet' and the note says what is still missing. ALSO judge the " +
      "shopper's current SALES STAGE, one of: browsing (just landed, low signal), engaged (asking real " +
      "questions), evaluating (weighing it, comparing, picturing it), objection (a specific hesitation), " +
      "ready (clear buying signals), won (they commissioned), lost (they declined and left). Respond " +
      "ONLY with a JSON object mapping each goal slug to {\"status\":\"met|partial|unmet\",\"note\":\"...\"}, " +
      "plus a key \"_stage\" set to the stage word. No prose.";
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
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const clean: Record<string, { status: string; note: string }> = {};
    for (const g of data.goals) {
      const v = parsed[g.slug] as { status?: string; note?: string } | undefined;
      const st = v && ["met", "partial", "unmet"].includes(String(v.status)) ? String(v.status) : "unmet";
      clean[g.slug] = { status: st, note: (v && typeof v.note === "string") ? v.note.slice(0, 160) : "" };
    }
    const STAGES = ["browsing", "engaged", "evaluating", "objection", "ready", "won", "lost"];
    const stageRaw = String(parsed._stage ?? "").toLowerCase().trim();
    const stage = STAGES.includes(stageRaw) ? stageRaw : null;
    // Goal grading is the primary write and must always land.
    await pgPatch(
      `concierge_conversations?id=eq.${cid}`,
      { goal_status: clean, goal_status_at: new Date().toISOString() },
    );
    // The sales stage is a SEPARATE, isolated best-effort write: if the
    // sales_stage column isn't in this database yet (migration not applied),
    // its failure must never take goal grading down with it.
    if (stage) {
      try {
        await pgPatch(`concierge_conversations?id=eq.${cid}`, { sales_stage: stage });
      } catch { /* column may not exist yet — ignore */ }
    }
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

// How hard to sell, 1 (most restrained) .. 5 (closer). Default 3 = warm
// consultant. Injected into the prompt so the NEXT MOVE selector knows how far
// to lean toward RECOMMEND / SHOW / ADVANCE versus ASK / SPACE.
const ASSERTIVENESS_GUIDANCE: Record<number, string> = {
  1: "Most restrained. Lean heavily on ASK and plain answers; volunteer little. Offer " +
    "{{action:commission}} only on an explicit, unmistakable buying signal. Rarely build desire " +
    "unprompted. When in doubt, give SPACE.",
  2: "Restrained. Mostly answer and ASK; RECOMMEND when it clearly helps. Offer the order when " +
    "interest is clear, not before. Build desire sparingly.",
  3: "Warm consultant (balanced). Mix ASK with RECOMMEND and SHOW, and ladder small yeses. When the " +
    "shopper is evaluating, build desire with one vivid, true detail. Propose the order (ADVANCE) once " +
    "genuine interest shows — gently, assumptively, never as pressure.",
  4: "Driving. Favor RECOMMEND, SHOW, and ADVANCE over ASK. Build desire early, propose the next step " +
    "sooner, and re-open a different door if the conversation warms. Still honest, still graceful with a no.",
  5: "Closer. Lead with RECOMMEND / SHOW / ADVANCE. Build desire from the first substantive turn, propose " +
    "the order early (and more than once across a conversation, though never twice in one breath), and " +
    "always drive toward an entry in the Webbuch. Honest and warm, but unmistakably selling.",
};

function assertivenessLevel(data: ConciergeData): number {
  const av = data.config?.assertiveness;
  const n = typeof av === "number" ? av : (typeof av === "string" ? parseFloat(av) : NaN);
  if (!isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function buildSystemPrompt(
  data: ConciergeData, liveState: string, signedIn: boolean,
  goalStatus?: Record<string, { status?: string; note?: string }> | null,
  section?: string | null,
): { prefix: string; suffix: string } {
  const kb = data.kbText ?? KB_MARKDOWN; // DB rows, else compiled-in fallback
  // The STATIC prompt (brand, KB, tools, SOPs, tuning) is assembled into `system`
  // and returned as `prefix` — marked cacheable at the call site. The DYNAMIC bits
  // (live state, goal status) collect separately and are returned as `suffix`, so
  // they never bust the cached prefix. Function replacements so "$" sequences in
  // content are never interpreted.
  const goalsAgenda: string[] = [];
  let system = BRAND_SYSTEM.replace("{{KB}}", () => kb);
  if (signedIn) {
    system += "\nREGISTER TOOLS\n" +
      "- This shopper is signed in and email-verified. You hold the register desk's tools: " +
      "get_my_orders (read their orders), update_colorway (only while 'placed'), " +
      "cancel_order (only while 'placed'), remember_customer (one durable line to the client book).\n" +
      "- ADDRESS CHANGES: you do NOT have a tool to type an address. To change where an unshipped " +
      "order goes, confirm WHICH order, then emit the address-change form " +
      "({{form:address-change:<serial>}}) on its own line so the owner types the new address into " +
      "labeled fields themselves. NEVER compose or dictate street/city/state/ZIP yourself, and never " +
      "claim an address changed unless the form's confirmation came back — mistyping a field (a city " +
      "into the street line) is exactly what the form prevents.\n" +
      "- Call get_my_orders before answering ANY question about their orders — never rely on memory " +
      "or on the CUSTOMER block in LIVE STATE. This includes every count ('how many…') and every filtered " +
      "list: call the tool and build your answer, count, and pills ONLY from its result, listing " +
      "every row it returns and no others. When the owner is narrowing to one cloth, call it with the " +
      "colorway filter and read back its exact count — do NOT tally or filter a long list in your head " +
      "(that is how numbers get dropped or a cloth mislabeled). If you already listed orders earlier " +
      "in the chat and are asked again, call get_my_orders again rather than trusting the earlier list. " +
      "Struck (cancelled) entries are archive: leave them out of lists and counts unless the owner " +
      "asks about cancellations or history (then call get_my_orders with include_cancelled).\n" +
      "- For a cancellation: state exactly what you are about to do and get the owner's explicit " +
      "confirmation in this conversation before calling the tool. Report the tool's result verbatim " +
      "in substance — never claim a change happened unless the tool confirmed it.\n" +
      "- This pattern governs EVERY register action (status detail, cancellation, address change, " +
      "anything that modifies an order): when more than one order could be meant, FIRST list the " +
      "eligible orders, then give tappable {{reply:...}} pills so they never have to type a number " +
      "back. If SIX OR FEWER are eligible, offer one pill per order, each on its own line. If there " +
      "are MORE than six, do NOT fall back to a prose-only list with no pills — that strands them. " +
      "Instead offer a small set of NARROWING pills first: by cloth when the clothes differ " +
      "({{reply:Show the Graphit}} / {{reply:Show the Loden}} / {{reply:Show the Ungefärbt}}), or the " +
      "most recent few — then, once they narrow, give one pill per order within that group. However " +
      "long the list, always leave at least one tappable way forward. " +
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
    // Live status (from the last evaluation) turns the goals from a static list
    // into an active agenda: the concierge sees which are still open and drives
    // them — especially advancing toward a commission when interest allows.
    const open = goalStatus
      ? data.goals.filter((g) => (goalStatus[g.slug]?.status ?? "unmet") !== "met")
      : data.goals;
    if (goalStatus && open.length === 0) {
      goalsAgenda.push("\nCONVERSATION GOALS — all met so far. Confirm the patron has everything they " +
        "need, then close warmly; do not manufacture new needs.\n");
    } else {
      const here = typeof section === "string" ? section.toLowerCase() : "";
      goalsAgenda.push("\nCONVERSATION GOALS (your active agenda — pursue naturally, never announce them; " +
        "keep advancing the OPEN ones, and when genuine interest allows, move the conversation " +
        "toward a commission or a companion cloth. Before you wrap up, make sure every open goal " +
        "here has been genuinely addressed — especially leaving no need unmet):\n" +
        open.map((g) => {
          const st = goalStatus ? (goalStatus[g.slug]?.status ?? "unmet") : null;
          const onJourney = !!here && goalSections(g).includes(here);
          return `- ${g.label}${st ? ` [${st}]` : ""}${onJourney ? " ← fits where they are right now" : ""}: ${g.description}`;
        }).join("\n") + "\n");
      const hereGoals = open.filter((g) => !!here && goalSections(g).includes(here));
      if (hereGoals.length > 0) {
        goalsAgenda.push(`The shopper is reading the '${here}' section right now — lead with the goal(s) marked "fits where they are" (` +
          hereGoals.map((g) => g.label).join("; ") + "), tying your move to what's in front of them, before the others.\n");
      }
    }
  }
  // ASSERTIVENESS — how far to lean toward driving the sale this conversation.
  system += "\nASSERTIVENESS (how to sell right now): " +
    (ASSERTIVENESS_GUIDANCE[assertivenessLevel(data)] ?? ASSERTIVENESS_GUIDANCE[3]) + "\n";

  // [HOLD] is ONLY a silence signal for a proactive check-in — never a reply.
  system += "\n[HOLD] RULE: '[HOLD]' is an internal signal you may use ONLY when a " +
    "proactive follow-up prompt asks you to check in and you decide silence is kinder. " +
    "NEVER write [HOLD] (or the word 'hold' alone) in reply to a message the visitor " +
    "actually sent — to anything they type, including a bare 'hey', always give a real, " +
    "warm answer. Never let the token [HOLD] appear in what the customer reads.\n";

  // Don't interrogate a ready buyer — the register sheet collects the details.
  system += "\nCOMMISSION BUTTON: The moment the shopper signals they want to commission, buy, " +
    "order, or 'do it' — an explicit 'I want to commission', 'let's do it', 'open the register', " +
    "'I'll take it' — put {{action:commission}} on its own line IMMEDIATELY, in that same reply. " +
    "Do NOT ask which cloth or where it ships first: the register sheet itself collects the cloth " +
    "and the shipping details, so asking beforehand is redundant friction that loses the sale. " +
    "NEVER propose opening the register ('shall I open the register?') without the {{action:commission}} " +
    "button in the same message — if you offer it, a single tap must be able to act. One clear buying " +
    "signal = show the button; do not ask the same qualifying question twice.\n" +
    "- DON'T LOOP IN DISCOVERY. Two questions in a row across turns, with no move of your own, is an " +
    "interrogation — never do it. Once you know the cloth and the shopper is plainly ready (they're " +
    "planning quantities, rooms, or gifts), STOP gathering details and ADVANCE: offer " +
    "{{action:commission}} to place the next one now. The register takes ONE blanket at a time (cloth + " +
    "four details, plus an optional gift name), so for several blankets or a set of gifts do NOT try to " +
    "pin down every name and split first — say you'll enter them one at a time, and open the register for " +
    "the FIRST one immediately with the button, then repeat per blanket. Planning can finish between " +
    "placements; momentum closes, endless planning loses the sale.\n";

  // SELLING ANGLES — admin-curated true lines the bot may weave in to build desire.
  const hooks = data.config?.hooks;
  if (Array.isArray(hooks)) {
    const lines = hooks
      .filter((h) => typeof h === "string" && (h as string).trim().length > 0)
      .map((h) => "- " + (h as string).trim().slice(0, 240));
    if (lines.length > 0) {
      system += "\nSELLING ANGLES (true, house-approved lines to weave in when building desire — " +
        "never as a script, never all at once, at most one per turn):\n" + lines.join("\n") + "\n";
    }
  }

  // OBJECTION PLAYBOOK — admin-curated responses to common hesitations. Each item
  // is {trigger, response} (or a plain string). Used for the REASSURE move.
  const objections = data.config?.objections;
  if (Array.isArray(objections)) {
    const lines = objections.map((o) => {
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const t = ((o as Record<string, unknown>).trigger ?? "").toString().trim().slice(0, 80);
        const r = ((o as Record<string, unknown>).response ?? "").toString().trim().slice(0, 300);
        if (!r) return "";
        return t ? `- When they raise ${t}: ${r}` : `- ${r}`;
      }
      const s = typeof o === "string" ? o.trim().slice(0, 300) : "";
      return s ? `- ${s}` : "";
    }).filter((l) => l.length > 0);
    if (lines.length > 0) {
      system += "\nOBJECTION PLAYBOOK (when the shopper raises one of these, REASSURE with the house's " +
        "answer, then re-open the door):\n" + lines.join("\n") + "\n";
    }
  }

  if (data.sopText) {
    system += "\nSTANDARD OPERATING PROCEDURES (follow these exactly)\n" + data.sopText + "\n";
  }
  // Admin-added images (beyond the built-in three) — tell the model they exist
  // and when to use each, so it can share them like the standard ones.
  const cfgImages = data.config?.images;
  if (cfgImages && typeof cfgImages === "object" && !Array.isArray(cfgImages)) {
    const lines = Object.entries(cfgImages as Record<string, unknown>)
      .filter(([tok, v]) => /^[a-z0-9_-]+$/i.test(tok) && v && typeof v === "object")
      .map(([tok, v]) => {
        const o = v as { description?: string; alt?: string };
        const desc = (o.description ?? o.alt ?? "").toString().slice(0, 200);
        return `- {{img:${tok}}}${desc ? " — " + desc : ""}`;
      });
    if (lines.length > 0) {
      system += "\nADDITIONAL IMAGES (admin-added; each on its own line, at most one per answer):\n" +
        lines.join("\n") + "\n";
    }
  }
  const notes = data.config?.voice_notes;
  if (typeof notes === "string" && notes.trim().length > 0) {
    system += "\nADMIN TUNING NOTES (follow these):\n" + notes;
  }
  // Dynamic tail: live state (ground truth, changes every turn) + the goal agenda
  // (per-conversation status). Kept OUT of `system` so the static prefix caches.
  const suffix = "\nLIVE STATE (server-substituted; treat as ground truth for availability):\n" +
    liveState + goalsAgenda.join("");
  return { prefix: system, suffix };
}

// ── Logging — concierge_conversations / concierge_messages ───────────────────

/** Resolves the conversation, logs the last user message. Never throws.
 * `ip` (the client's forwarded IP) is stored on the conversation for abuse/legal
 * forensics — admin-only (RLS), shown only in the PII-gated export. */
async function logUserTurn(body: ValidatedBody, customer: Customer | null, skipUser = false, ip = ""): Promise<string | null> {
  const realIp = ip && ip !== "unknown" ? ip.slice(0, 64) : null;
  try {
    // Reuse the latest conversation for this session_key, else insert one.
    let cid: string | null = null;
    if (body.sessionKey) {
      const q = `concierge_conversations?select=id,user_id,user_email,ended_at&session_key=eq.${
        encodeURIComponent(body.sessionKey)}&order=created_at.desc&limit=1`;
      const rows = await pgSelect<
        { id: string; user_id: string | null; user_email: string | null; ended_at: string | null }
      >(q);
      if (rows && rows.length > 0) {
        cid = rows[0].id;
        const patch: Record<string, unknown> = {};
        // Backfill identity if they signed in after the conversation began —
        // otherwise a signed-in chat keeps showing as anonymous in the Studio.
        if (customer && (!rows[0].user_id || !rows[0].user_email)) {
          patch.user_id = customer.id;
          patch.user_email = customer.email;
        }
        // They wrote again in a conversation we'd marked ended (a plain
        // panel-close) — it's resuming, so clear the ended flag. (An explicit
        // close/quiet rotates the session key, so this never revives those.)
        if (rows[0].ended_at) { patch.status = "active"; patch.ended_at = null; }
        if (realIp) patch.ip = realIp; // keep the latest IP seen for this session
        if (Object.keys(patch).length > 0) {
          await pgPatch(`concierge_conversations?id=eq.${cid}`, patch);
        }
      }
    }
    if (!cid) {
      const row = await pgInsert<{ id: string }>("concierge_conversations", {
        session_key: body.sessionKey,
        user_id: customer?.id ?? null,
        user_email: customer?.email ?? null,
        ip: realIp,
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

/** Scrub any tool-call plumbing the model wrote as *text* instead of invoking
 *  — function-call XML or a {{action:tool}} token. Never reaches the shopper,
 *  never gets logged. (The opener path calls the model without tools, so a
 *  model that "decides" to call one can only render it as text — this catches
 *  that.) */
function stripPlumbing(t: string): string {
  if (!t) return t;
  if (t.indexOf("<function_calls") < 0 && t.indexOf("<invoke") < 0 &&
      t.indexOf("{{") < 0) return t;
  return t
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<function_calls>[\s\S]*$/i, "")
    .replace(/<\/?(function_calls|invoke|parameter)(\s[^>]*)?>/gi, "")
    // strip ONLY plumbing tokens — keep the legit img/reply/form/commission/
    // signin vocabulary the client turns into images, pills, buttons, forms
    .replace(/\{\{[a-z_]+(?::[^}]*)?\}\}/gi, (m) => {
      const low = m.toLowerCase();
      return (low.startsWith("{{img:") || low.startsWith("{{reply:") ||
          low.startsWith("{{form:") || low === "{{action:commission}}" ||
          low === "{{action:signin}}")
        ? m
        : "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const outreach = config?.outreach;
  const images = config?.images;
  return jsonResponse(req, 200, {
    enabled: config?.enabled === false ? false : true,
    greeting: typeof config?.greeting === "string" ? config.greeting : null,
    starters: starters && typeof starters === "object" && !Array.isArray(starters) ? starters : null,
    outreach: outreach && typeof outreach === "object" && !Array.isArray(outreach) ? outreach : null,
    images: images && typeof images === "object" && !Array.isArray(images) ? images : null,
    assertiveness: assertivenessLevel({ config } as ConciergeData),
    auth: true,
    forms: forms.map((f) => ({ slug: f.slug, title: f.title, fields: f.fields })),
  });
}

// ── GET ?tools=1 — the built-in tools manifest for the admin Tools tab ────────
// Public read (the descriptions are the model-facing copy, not customer data).
// The admin UI needs the full built-in list (which only the server knows from
// REGISTER_TOOLS) plus the current enabled/override state, so it can render the
// enable/disable toggles and description editors. Writes go straight to the
// concierge_tools table under RLS, like the other config tables.
async function handleToolsGet(req: Request): Promise<Response> {
  // Admin-only: the tool manifest describes internal capabilities/prompt surface,
  // and the only caller (admin Tools tab) already sends the admin JWT.
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const data = await loadConciergeData();
  return jsonResponse(req, 200, { tools: toolsManifest(data) });
}

// ── admin gate — verify the JWT AND that the caller is in concierge_admins ────
// Returns the Customer if they're a registered admin, else null. Used by the
// eval endpoints, which read the deck and spend a (small) judge model call.
async function requireAdmin(req: Request): Promise<Customer | null> {
  const customer = await verifyUser(req);
  if (!customer?.email) return null;
  const probe = await pgProbe(
    `concierge_admins?select=email&email=eq.${encodeURIComponent(customer.email)}`,
  );
  return probe.ok && (probe.count ?? 0) > 0 ? customer : null;
}

// ── GET ?evals=1 — the behavior-eval deck (admin only) ───────────────────────
// The studio's Evals tab reads scenarios straight from concierge_evals under RLS;
// this endpoint exists so the CLI runner (evals/run.mjs) can share the SAME deck
// when given a test-admin token, keeping one source of truth. Enabled scenarios
// only; shaped exactly like evals/scenarios.mjs so the runner needs no mapping.
async function handleEvalsGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const rows = await pgSelect<{
    slug: string; name: string; description: string;
    signed_in: boolean; context: unknown; turns: unknown; sort_order: number;
  }>("concierge_evals?select=slug,name,description,signed_in,context,turns,sort_order" +
     "&enabled=is.true&order=sort_order.asc");
  if (!rows) return jsonError(req, 500, "Could not read the eval deck.");
  const scenarios = rows.map((r) => ({
    name: r.slug,
    label: r.name,
    desc: r.description,
    signedIn: r.signed_in === true,
    context: (r.context && typeof r.context === "object") ? r.context : {},
    turns: Array.isArray(r.turns) ? r.turns : [],
  }));
  return jsonResponse(req, 200, { scenarios });
}

// ── POST ?judge=1 — the pinned binary LLM judge (admin only) ─────────────────
// The eval runner (browser or CLI) sends ONE concrete criterion + a transcript;
// we return a binary {pass, reason}. Kept server-side because the Anthropic key
// must never reach the browser. Mirrors evals/judge.mjs: temperature 0, a fixed
// contract, a forced `verdict` tool, told to ignore tone/length. Cheap model.
const JUDGE_SYSTEM =
  "You are a strict, literal evaluator of a sales-concierge chatbot. You are given " +
  "ONE criterion and a chat transcript. Decide ONLY whether the ASSISTANT's LAST " +
  "message satisfies that exact criterion. Ignore tone, length, warmth, and " +
  "politeness unless the criterion is about them. Tokens like {{action:commission}}, " +
  "{{action:signin}}, and {{reply:...}} are UI elements the assistant legitimately " +
  "emits — treat them as the button/pill they render. Do not be lenient: if the " +
  "criterion is not clearly met, it fails. Reply with a single tool call.";

async function handleJudgePost(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");
  let body: { criterion?: unknown; transcript?: unknown };
  try { body = await req.json(); } catch { return jsonError(req, 400, "Bad JSON."); }
  const criterion = typeof body.criterion === "string" ? body.criterion.slice(0, 2000) : "";
  const transcript = typeof body.transcript === "string" ? body.transcript.slice(0, 12000) : "";
  if (!criterion || !transcript) return jsonError(req, 400, "criterion and transcript are required.");
  const model = Deno.env.get("EVAL_JUDGE_MODEL") || "claude-haiku-4-5-20251001";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 200, temperature: 0,
        system: JUDGE_SYSTEM,
        tool_choice: { type: "tool", name: "verdict" },
        tools: [{
          name: "verdict",
          description: "Record the pass/fail verdict for the criterion.",
          input_schema: {
            type: "object",
            properties: {
              pass: { type: "boolean", description: "true only if the last assistant message clearly satisfies the criterion" },
              reason: { type: "string", description: "one short clause (<=20 words) citing the deciding evidence" },
            },
            required: ["pass", "reason"],
          },
        }],
        messages: [{
          role: "user",
          content: "CRITERION:\n" + criterion + "\n\nTRANSCRIPT (most recent assistant message is the one to judge):\n" + transcript,
        }],
      }),
    });
    if (!res.ok) {
      return jsonError(req, 502, `Judge model error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    }
    // deno-lint-ignore no-explicit-any
    const j = await res.json() as any;
    // deno-lint-ignore no-explicit-any
    const tool = (j.content || []).find((b: any) => b.type === "tool_use" && b.name === "verdict");
    if (!tool || typeof tool.input?.pass !== "boolean") {
      return jsonError(req, 502, "Judge returned no verdict.");
    }
    return jsonResponse(req, 200, { pass: tool.input.pass, reason: String(tool.input.reason || "").slice(0, 200), model });
  } catch (e) {
    return jsonError(req, 502, "Judge error: " + (e instanceof Error ? e.message : String(e)));
  }
}

// ── GET ?secrets=1 — server-secret STATUS for the admin panel (admin only) ───
// Returns ONLY booleans (is each secret present) plus the model in effect — never
// a value. Lets the studio show a live "what's configured" readout so setup isn't
// doc-only, without ever putting a secret in the browser. Secret VALUES are set
// in the Supabase dashboard or as GitHub secrets (Deploy Concierge applies them);
// this endpoint just reports presence.
async function handleSecretsGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const has = (n: string) => !!(Deno.env.get(n) || "").trim();
  const data = await loadConciergeData();
  return jsonResponse(req, 200, {
    build: BUILD_TAG,
    model_in_effect: resolveModel(data),
    secrets: {
      // required for the concierge to answer at all
      anthropic_api_key: { set: has("ANTHROPIC_API_KEY"), required: true, purpose: "Concierge chat (required)" },
      // Supabase injects these into every function; shown for completeness
      supabase_url: { set: has("SUPABASE_URL"), required: true, purpose: "Auto-provided by Supabase" },
      supabase_service_role_key: { set: has("SUPABASE_SERVICE_ROLE_KEY"), required: true, purpose: "Auto-provided by Supabase" },
      // optional feature secrets
      resend_api_key: { set: has("RESEND_API_KEY"), required: false, purpose: "Transactional order email (optional)" },
      email_from: { set: has("EMAIL_FROM"), required: false, purpose: "Order-email sender (optional; has a default)" },
      allowed_origins: { set: has("ALLOWED_ORIGINS"), required: false, purpose: "CORS (set by the deploy workflow)" },
    },
  });
}

// ── GET ?export=1 — STREAMING conversation-transcript export (admin only) ────
// The scalable export: instead of the browser holding the whole result set in
// memory (which caps out), the server keyset-paginates conversations and streams
// CSV rows straight to the download, so memory stays bounded on BOTH ends and the
// size is limited only by the function's wall-clock, not RAM. One row per message,
// keyed by conversation_id + metadata. The `user` column is pseudonymized (a
// stable hash) unless ?pii=1. Filters: ?from / ?to (ISO date bounds).
// (For truly unbounded / warehouse-scale, the next tier is an async COPY to a
// Storage bucket + signed URL — see SCHEMA.md; this endpoint is the streaming tier.)
function csvCell(v: unknown): string {
  return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
}
// Stable pseudonym for an email — FNV-1a → base36, matching the admin client so a
// person reads as the same token in browser- and server-made exports.
function pseudoEmail(s: string | null): string {
  if (!s) return "";
  let h = 2166136261 >>> 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return "u_" + (h >>> 0).toString(36);
}
async function handleExportGet(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const pii = url.searchParams.get("pii") === "1";
  const enc = new TextEncoder();
  const HEAD = ["conversation_id", "user", "ip", "section", "sales_stage", "conversation_created_at",
    "message_created_at", "role", "model", "latency_ms", "content"];
  const CONVO_BATCH = 300, ID_CHUNK = 50;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(enc.encode(HEAD.join(",") + "\n"));
        let cursorTs: string | null = null, cursorId: string | null = null;
        for (;;) {
          let q = "concierge_conversations?select=id,created_at,user_email,section,sales_stage,ip" +
            `&order=created_at.desc,id.desc&limit=${CONVO_BATCH}`;
          if (from) q += `&created_at=gte.${encodeURIComponent(from)}`;
          if (to) q += `&created_at=lte.${encodeURIComponent(to)}`;
          if (cursorTs && cursorId) {
            // keyset: rows strictly "after" the cursor in (created_at desc, id desc)
            q += `&or=(created_at.lt.${encodeURIComponent(cursorTs)},` +
              `and(created_at.eq.${encodeURIComponent(cursorTs)},id.lt.${encodeURIComponent(cursorId)}))`;
          }
          const convos = await pgSelect<{ id: string; created_at: string; user_email: string | null; section: string | null; sales_stage: string | null; ip: string | null }>(q);
          if (!convos || convos.length === 0) break;
          const last = convos[convos.length - 1];
          cursorTs = last.created_at; cursorId = last.id;

          const byId: Record<string, typeof convos[number]> = {};
          convos.forEach((c) => { byId[c.id] = c; });
          const ids = convos.map((c) => c.id);
          for (let i = 0; i < ids.length; i += ID_CHUNK) {
            const chunk = ids.slice(i, i + ID_CHUNK);
            const msgs = await pgSelect<{ conversation_id: string; created_at: string; role: string; model: string | null; latency_ms: number | null; content: string | null }>(
              "concierge_messages?select=conversation_id,created_at,role,model,latency_ms,content" +
              `&conversation_id=in.(${chunk.join(",")})&order=conversation_id.asc,created_at.asc&limit=100000`,
            );
            let buf = "";
            for (const m of (msgs || [])) {
              const c = byId[m.conversation_id] || {} as typeof convos[number];
              const user = pii ? (c.user_email || "") : pseudoEmail(c.user_email);
              const ipCell = pii ? (c.ip || "") : ""; // IP is real PII — only in a PII export
              buf += [csvCell(m.conversation_id), csvCell(user), csvCell(ipCell), csvCell(c.section), csvCell(c.sales_stage),
                csvCell(c.created_at), csvCell(m.created_at), csvCell(m.role), csvCell(m.model),
                csvCell(m.latency_ms), csvCell(m.content)].join(",") + "\n";
            }
            if (buf) controller.enqueue(enc.encode(buf));
          }
          if (convos.length < CONVO_BATCH) break;
        }
        controller.close();
      } catch (e) {
        controller.enqueue(enc.encode(`\n"ERROR","${String(e instanceof Error ? e.message : e).replace(/"/g, "'")}"\n`));
        controller.close();
      }
    },
  });

  const headers = corsHeaders(req);
  headers["Content-Type"] = "text/csv; charset=utf-8";
  headers["Content-Disposition"] = `attachment; filename="conversations-export${pii ? "-pii" : ""}.csv"`;
  headers["Cache-Control"] = "no-store";
  return new Response(stream, { status: 200, headers });
}

// ── POST ?regrade=1 — grade conversation goals on demand (admin only) ────────
// The async grader is sampled; this lets the admin re-run goal scoring for one or
// more chats from the Conversations panel and see the scorecard update. Body:
// { conversation_id } or { ids: [...] }. Grades against the current goal set.
async function handleRegradePost(req: Request): Promise<Response> {
  if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");
  let body: { ids?: unknown; conversation_id?: unknown };
  try { body = await req.json(); } catch { return jsonError(req, 400, "Bad JSON."); }
  const raw = Array.isArray(body.ids) ? body.ids : (typeof body.conversation_id === "string" ? [body.conversation_id] : []);
  const ids = (raw as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 30);
  if (!ids.length) return jsonError(req, 400, "ids or conversation_id required.");
  const data = await loadConciergeData();
  if (data.goals.length === 0) return jsonError(req, 400, "No goals are defined to grade against.");
  const model = resolveModel(data);
  let graded = 0;
  for (const cid of ids) {
    try {
      const msgs = await pgSelect<{ role: string; content: string }>(
        `concierge_messages?select=role,content&conversation_id=eq.${encodeURIComponent(cid)}&order=created_at.asc&limit=100`,
      );
      if (msgs && msgs.length) { await evaluateGoals(cid, data, msgs as ChatMessage[], apiKey, model); graded++; }
    } catch { /* skip this one, continue the batch */ }
  }
  return jsonResponse(req, 200, { graded, requested: ids.length });
}

// ── GET ?starters=1 — personalized conversation starters for a signed-in patron ─
// Deterministic, built from their REAL orders (status, cloth, gift), so every chip
// points at something they actually have — no model call, no guessing. Anonymous
// callers (or a patron with no orders) get [], and the client falls back to the
// section defaults. The client tops these up with the generic starters.
async function handleStartersGet(req: Request): Promise<Response> {
  const customer = await verifyUser(req);
  if (!customer) return jsonResponse(req, 200, { starters: [] });
  const orders = await myOrders(customer, false);
  if (!orders || orders.length === 0) return jsonResponse(req, 200, { starters: [] });
  const clothOf = (cw: string | null) => cw && EMAIL_COLORWAY[cw] ? EMAIL_COLORWAY[cw] : "my cloth";
  const noOf = (o: OrderRow) =>
    `Nº ${Number(o.serial ?? o.cancelled_serial ?? 0).toLocaleString("en-US")}`;
  const out: string[] = [];
  const add = (s: string) => { if (s && !out.includes(s) && out.length < 4) out.push(s); };
  // orders arrive placed_at desc (most recent first)
  const shipped = orders.find((o) => o.status === "shipped");
  if (shipped) add(`Where is my ${noOf(shipped)}?`);
  const placed = orders.find((o) => o.status === "placed");
  if (placed) add(`Change the cloth on my ${clothOf(placed.colorway)} (${noOf(placed)})`);
  const gift = orders.find((o) => o.is_gift && MUTABLE_STATUSES.includes(o.status ?? ""));
  if (gift) add(`Update the gift card on ${noOf(gift)}`);
  const delivered = orders.find((o) => o.status === "delivered");
  if (delivered) add(`How should I care for my ${clothOf(delivered.colorway)}?`);
  add("Show me all my orders");
  return jsonResponse(req, 200, { starters: out.slice(0, 4) });
}

// ── GET ?selftest=1 — "what does the concierge actually know about me?" ───────
// Call it with the same Authorization the widget sends. It reports whether the
// caller is recognized as signed in, whether the newer tables/columns exist in
// THIS database, how many orders/notes are attributed to them, and the exact
// CUSTOMER block the model is handed. This is how we tell apart "code not
// deployed" (never — this endpoint proves the build is live) from "schema not
// applied" from "sign-in / attribution not landing".
async function handleSelfTest(req: Request): Promise<Response> {
  const customer = await verifyUser(req);
  const report: Record<string, unknown> = {
    build: BUILD_TAG,
    signed_in: customer !== null,
    email: customer?.email ?? null,
    user_id: customer?.id ?? null,
  };
  // Schema presence in THIS database (a 400/PGRST error ⇒ table/column missing).
  report.schema = {
    customer_notes: await pgProbe("customer_notes?select=id"),
    conversation_lifecycle: await pgProbe("concierge_conversations?select=status,ended_at"),
    goals: await pgProbe("concierge_goals?select=id"),
    order_events: await pgProbe("order_events?select=id"),
  };
  if (customer) {
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    report.orders = {
      by_user_id: await pgProbe(`orders?select=serial&user_id=eq.${encodeURIComponent(customer.id)}`),
      by_email: customer.email
        ? await pgProbe(`orders?select=serial&email=eq.${encodeURIComponent(customer.email)}`)
        : null,
    };
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    report.my_notes = await pgProbe(`customer_notes?select=id&${nf}`);
    // The literal block the model sees — orders, standing, client book, recency.
    try { report.customer_block = await customerBlock(customer); } catch (e) {
      report.customer_block = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    // Admin + logging health. The admin panel reads conversations under RLS,
    // so it shows NOTHING unless the caller's email is in concierge_admins.
    // Only an admin sees others' data here, so gate the detail behind that.
    if (customer.email) {
      const adminProbe = await pgProbe(
        `concierge_admins?select=email&email=eq.${encodeURIComponent(customer.email)}`,
      );
      const isAdmin = adminProbe.ok && (adminProbe.count ?? 0) > 0;
      report.is_admin = isAdmin;
      report.admin_note = isAdmin
        ? "You are a registered admin — the admin panel's RLS will let you read conversations."
        : "NOT a registered admin. The admin panel shows nothing under RLS until your email is " +
          "added to concierge_admins (setup.sql seeds it — run it, or add the row).";
      if (isAdmin) {
        // What the SERVICE ROLE sees (bypasses RLS): proves whether logging works
        // and whether your latest conversation is actually there.
        report.conversations_total = await pgProbe("concierge_conversations?select=id");
        const recent = await pgSelect<Record<string, unknown>>(
          "concierge_conversations?select=created_at,user_email,session_key,status,section" +
            "&order=created_at.desc&limit=6",
        );
        report.recent_conversations = recent ?? "QUERY FAILED — table or a selected column is missing";
      }
    }
  } else {
    report.hint = "Not recognized as signed in. The widget must send Authorization: " +
      "Bearer <your user JWT> (not the anon key). If you ARE signed in on the site and this " +
      "still says false, the token isn't reaching the function.";
  }
  return jsonResponse(req, 200, report);
}

// ── POST — streaming chat ────────────────────────────────────────────────────

async function handleChatPost(req: Request): Promise<Response> {
  // Rate limit (v1 behavior: 20 req / 10 min per x-forwarded-for IP).
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (await rateLimited(ip)) {
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
    const signedIn = (nudge as Record<string, unknown>)?.signedIn === true;
    let decision: string;
    if (cnt <= 2) {
      // First couple: engage with substance drawn from the conversation.
      decision = "SPEAK now (do not hold). Send one warm, specific line drawn from THIS " +
        "conversation and what you know of them — the room or person they mentioned, the cloth " +
        "they lingered on, an open goal. Never generic; something only this shopper would hear.";
    } else {
      // Later: a light, human "still here" presence — brief, low-pressure, and
      // sometimes just checking they're alright. You MAY reply exactly [HOLD] to
      // give space, but lean toward a short human line most of the time.
      decision = "This is a later check-in — keep a light, HUMAN presence, the way a clerk " +
        "lingers nearby: a brief, low-pressure line (\"Still here whenever you'd like to pick " +
        "this up\", \"Anything else on your mind?\"), warm and unhurried, at most one sentence. " +
        "Do not re-pitch or repeat yourself. If they truly seem done, you may reply exactly " +
        "[HOLD] to give space — but most of the time, a short human check-in is right.";
    }
    // For an anonymous visitor, occasionally invite them to leave their email so
    // the house can remember them — an account is how their orders and client
    // book persist. Not every time; roughly every other later check-in.
    const inviteEmail = !signedIn && cnt >= 2 && (cnt % 2 === 0);
    const emailNote = inviteEmail
      ? " Since they are NOT signed in, warmly invite them (once) to leave their email so the " +
        "house remembers them next time — put {{action:signin}} on its own line. Frame it as being " +
        "known and welcomed back, never as a form to fill."
      : "";
    validated.messages.push({
      role: "user",
      content:
        `[Context note, not the shopper's words: they have been quiet about ${secs} seconds ` +
        `(check-in #${cnt}). Follow your ENGAGEMENT & PACING procedure. ${decision}${emailNote} ` +
        `Do not greet them again as if they just arrived.]`,
    });
  }

  // Proactive opener: the visitor just opened (or reopened) the concierge. Speak
  // first, contextually, toward the goals — never wait for them to type. The
  // instruction is injected (never logged as their words); the model may call
  // recall_context to pull prior notes/conversation it doesn't already see.
  const opener = (validated.context as Record<string, unknown>)?.opener;
  const isOpener = opener === "reengage" || opener === "greet";
  if (isOpener && !isNudge) {
    validated.messages.push({
      role: "user",
      content: opener === "greet"
        ? "[Context note, not the shopper's words: they just opened the concierge and have not " +
          "spoken yet. They already see a brief house greeting, so do NOT repeat a generic hello. " +
          "Add ONE warm, specific line that opens toward a conversation goal. If CUSTOMER is present, " +
          "make it personal — greet them by first name and nod to their standing or a real order/note " +
          "(a returning patron is never a stranger), drawing on the CUSTOMER block and CLIENT BOOK " +
          "already provided above. If there is NO CUSTOMER (an anonymous visitor), open from what " +
          "they're browsing (the BROWSING section and page) — e.g. the cloth they're reading about, " +
          "gift vs. their own home — and invite them in. End with a single light question. This is a " +
          "plain spoken line: do NOT use any tools and do NOT write any tool call — just speak. Do " +
          "not mention this note. One or two sentences.]"
        : "[Context note, not the shopper's words: they just reopened the chat to pick the thread " +
          "back up. Re-engage with ONE warm, specific line that advances a conversation goal, drawn " +
          "from the conversation so far and the CUSTOMER block / CLIENT BOOK already above — never a " +
          "generic greeting, never repeating yourself. This is a plain spoken line: do NOT use any " +
          "tools and do NOT write any tool call (no function-call XML, no {{…}}) — just speak. Do not " +
          "mention this note. One or two sentences ending in a light question.]",
    });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return jsonError(req, 500, "Server is not configured (missing API key).");

  // Config-driven behavior: kill switch, model, max_tokens.
  const data = await loadConciergeData();
  if (data.config?.enabled === false) {
    return jsonError(req, 503, "The concierge is resting. Write concierge@feier-abend.co.");
  }
  const model = resolveModel(data);
  const maxTokens = typeof data.config?.max_tokens === "number" &&
      data.config.max_tokens > 0
    ? Math.floor(data.config.max_tokens)
    : 1024;

  // Signed-in awareness (anonymous on absent/invalid token; never errors).
  const customer = await verifyUser(req);
  const customerLine = customer ? await customerBlock(customer) : null;
  // Live goal status from the last evaluation, so the prompt shows which goals
  // are still open and the concierge actively drives them.
  let goalStatus: Record<string, { status?: string; note?: string }> | null = null;
  if (validated.sessionKey && data.goals.length > 0) {
    const gsRows = await pgSelect<{ goal_status: Record<string, { status?: string; note?: string }> | null }>(
      `concierge_conversations?select=goal_status&session_key=eq.${
        encodeURIComponent(validated.sessionKey)}&order=created_at.desc&limit=1`,
    );
    goalStatus = gsRows && gsRows[0] ? gsRows[0].goal_status : null;
  }
  const currentSection = typeof validated.context.section === "string" ? validated.context.section : null;
  const sysParts = buildSystemPrompt(
    data, renderLiveState(validated.context, customerLine), customer !== null, goalStatus, currentSection,
  );
  // Prompt caching: the large static prefix (brand + KB + tools + SOPs + tuning)
  // is sent as a cache_control:ephemeral block, so every later call that shares it
  // — the 2nd–4th agentic rounds, nudges, back-to-back turns within 5 min — pays
  // ~10% of that input instead of 100%. The dynamic tail (live state, goals) is a
  // second, uncached block so it never busts the cache.
  // deno-lint-ignore no-explicit-any
  const system: any[] = [
    { type: "text", text: sysParts.prefix, cache_control: { type: "ephemeral" } },
  ];
  if (sysParts.suffix && sysParts.suffix.trim().length > 0) {
    system.push({ type: "text", text: sysParts.suffix });
  }

  // Logging: resolve conversation + store the user turn, concurrently with
  // the model work; awaited again before the stream finishes.
  const conversationPromise = logUserTurn(validated, customer, isNudge || isOpener, ip);
  const startedAt = Date.now();

  // ── Semantic cache — anonymous, single-turn questions only ────────────────
  // Multi-turn answers depend on conversation context; signed-in answers on
  // the register. Neither may be cached or served from cache.
  let queryEmbedding: number[] | null = null;
  const lastUser = [...validated.messages].reverse().find((m) => m.role === "user");
  const userTurns = validated.messages.filter((m) => m.role === "user").length;
  const cacheEligible = !customer && !isNudge && !isOpener &&
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

  // ── Proactive path (nudge OR opener): the bot speaks on its own, with no
  //    tools. It buffers the full reply, scrubs any tool-call plumbing, and may
  //    give space (hold). Openers route here too — signed-in or not — so a
  //    tools-less opener can never stream raw tool-call text to anyone. ──
  if (isNudge || isOpener) {
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
              "anthropic-beta": "prompt-caching-2024-07-31",
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
        // This path runs the model WITHOUT tools; if it "decides" to call one it
        // can only write the call as text. Scrub that before anything sees it.
        text = stripPlumbing(text);

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
    const modelTools = buildToolsForModel(data);
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
                "anthropic-beta": "prompt-caching-2024-07-31",
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model, max_tokens: maxTokens, system,
                messages: convo, tools: modelTools,
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
              const label = ({
                get_my_orders: "Reading the register…",
                recall_context: "Turning back the pages…",
                track_shipment: "Checking where it stands…",
                get_care_guide: "Finding the care notes…",
                resend_confirmation: "Sending it along again…",
                request_mending: "Logging it with the workshop…",
                update_gift_details: "Naming the card…",
                update_colorway: "Amending the register…",
                update_shipping_address: "Amending the register…",
                join_waitlist: "Adding to the waitlist…",
                remember_customer: "Noting the client book…",
                cancel_order: "Striking the entry…",
              } as Record<string, string>)[block.name] ?? "Consulting the register…";
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

          finalText = stripPlumbing(finalText);
          // [HOLD] is the "stay silent" signal for a PROACTIVE beat — it must
          // never render as text. On a nudge/opener that chose silence, emit a
          // hold and say nothing. If the model emits it in reply to something the
          // visitor actually typed (where holding makes no sense), never show the
          // token — answer with a light presence instead.
          const holdish = finalText.trim().length === 0 ||
            /^\[?hold\]?\.?$/i.test(finalText.trim());
          if (holdish && (isNudge || isOpener)) {
            send({ hold: 1 });
            finalText = "";
          } else {
            if (holdish) { finalText = "I'm here — what can I help you with?"; }
            for (const piece of chunked(finalText)) send({ t: piece });
          }
          if (finalText) {
            const lastUserMsg = [...validated.messages].reverse().find((m) => m.role === "user");
            await maybeFlagGap(cid, lastUserMsg?.content, finalText);
            if (!isNudge) {
              scheduleGoalEval(cid, data, [...validated.messages, { role: "assistant", content: finalText }], apiKey, model);
            }
            const meta = await logAssistantTurn(cid, finalText, model, Date.now() - startedAt);
            if (meta) { try { controller.enqueue(encoder.encode(`data: ${meta}\n\n`)); } catch { /* gone */ } }
          }
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
      "anthropic-beta": "prompt-caching-2024-07-31",
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
  // Public lifecycle beacon (fires on pagehide, so it can't require auth), but
  // bound it: without a limit an anon caller could spam status flips. Beacons are
  // rare per visitor, so a per-IP window is invisible to real use.
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (await rateLimited(ip)) return jsonResponse(req, 200, { ok: true, noted: false });
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
    // For a signed-in patron, write ONE substantive client-book line that
    // actually summarizes what happened and what was learned — never lifecycle
    // bookkeeping. Done asynchronously (a model call), and only when the
    // conversation had enough substance to be worth remembering.
    const customer = await verifyUser(req);
    if (customer) {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      const data = await loadConciergeData();
      const model = resolveModel(data);
      if (apiKey) scheduleClientBookNote(cid, customer, apiKey, model);
    }
    return jsonResponse(req, 200, { ok: true, noted: !!customer, status });
  } catch {
    return jsonResponse(req, 200, { ok: true, noted: false });
  }
}

/** Fire-and-forget: summarize the wrapped conversation into one client-book
 *  line, if it had real substance. Skips thin/off-topic chats entirely. */
/** Normalize a note to a bag of meaningful words for cheap similarity checks. */
function noteTokens(s: string): Set<string> {
  const stop = new Set([
    "the", "and", "for", "with", "was", "her", "his", "their", "they", "she", "he",
    "a", "an", "to", "of", "in", "on", "is", "it", "that", "this", "patron", "about",
    "has", "have", "had", "but", "not", "one", "over", "into", "from", "who", "will",
  ]);
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w)),
  );
}

/** True if `note` substantially overlaps a note already in the book. Guards
 *  against near-verbatim repeats slipping past the model's own dedup. */
function isRedundantNote(note: string, prior: { note: string }[]): boolean {
  const a = noteTokens(note);
  if (a.size === 0) return false;
  for (const p of prior) {
    const b = noteTokens(p.note);
    if (b.size === 0) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    // Jaccard over the smaller set: ≥0.7 of the new note's content words are
    // already present in an existing line → treat it as a repeat.
    if (shared / a.size >= 0.7) return true;
  }
  return false;
}

function scheduleClientBookNote(
  cid: string, customer: Customer, apiKey: string, model: string,
): void {
  const p = writeClientBookNote(cid, customer, apiKey, model);
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(p);
    else p.catch(() => {});
  } catch { p.catch(() => {}); }
}

async function writeClientBookNote(
  cid: string, customer: Customer, apiKey: string, model: string,
): Promise<void> {
  try {
    const msgs = await pgSelect<{ role: string; content: string }>(
      `concierge_messages?select=role,content&conversation_id=eq.${cid}&order=created_at.asc&limit=40`,
    );
    if (!msgs || msgs.length < 2) return;                 // nothing worth noting
    const userTurns = msgs.filter((m) => m.role === "user").length;
    if (userTurns < 1) return;
    const convo = msgs
      .map((m) => `${m.role === "user" ? "Patron" : "Concierge"}: ${m.content}`)
      .join("\n").slice(0, 6000);
    // The book already knows some things about this patron. Feed the recent
    // lines in so the writer records only what is NEW — otherwise every return
    // visit re-notes the same durable facts and the book fills with repeats.
    const safeEmail = customer.email?.replace(/["\\,()]/g, "");
    const nf = safeEmail
      ? `or=${encodeURIComponent(`(user_id.eq.${customer.id},email.eq."${safeEmail}")`)}`
      : `user_id=eq.${encodeURIComponent(customer.id)}`;
    const prior = await pgSelect<{ note: string }>(
      `customer_notes?select=note&${nf}&order=created_at.desc&limit=12`,
    );
    const known = (prior ?? []).map((n) => `- ${n.note}`).join("\n");
    const sys =
      "You keep a luxury shop's private client book. From this conversation, write ONE line " +
      "(max 200 chars) capturing what is NEWLY worth remembering about THIS patron for next time: " +
      "rooms, recipients, colorways they favored or rejected, hesitations, decisions, commissions " +
      "placed or changed. Use concrete facts from the transcript. It is an internal note the patron " +
      "never sees — third person, no greeting, no fluff.\n" +
      "CRITICAL — do not repeat the book. Below is what is already recorded about this patron. " +
      "Only write a line if this conversation adds durable information NOT already captured there. " +
      "Do not restate, rephrase, or lightly update a fact the book already holds. If the " +
      "conversation held nothing new and durable (small talk, a test, an unresolved hello, or only " +
      "facts already on file), respond with exactly SKIP and nothing else.\n" +
      "ALREADY IN THE BOOK:\n" + (known || "(nothing yet)");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: 120, system: sys,
        messages: [{ role: "user", content: `CONVERSATION:\n${convo}\n\nWrite the NEW client-book line, or SKIP.` }],
      }),
    });
    if (!res.ok) return;
    // deno-lint-ignore no-explicit-any
    const msg = await res.json() as any;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    // deno-lint-ignore no-explicit-any
    let note = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (!note || note.toUpperCase() === "SKIP" || note.length < 8) return;
    note = note.slice(0, 220);
    // Belt-and-braces: if the model still echoed an existing line near-verbatim,
    // drop it. Cheap normalized comparison against what the book already holds.
    if (isRedundantNote(note, prior ?? [])) return;
    await pgInsert("customer_notes", {
      user_id: customer.id, email: customer.email, note,
    });
  } catch { /* best-effort — a missing note never breaks a wrap-up */ }
}

// ── POST ?form=1 — structured submissions from in-chat forms ─────────────────
// Same trust boundary as the model's own tool calls: verified JWT, the tool's
// ownership filters and validation, the concierge_actions audit log.

async function handleFormPost(req: Request): Promise<Response> {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (await rateLimited("f:" + ip)) {
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

// ── GET ?site=1 — storefront CMS content for the page hydrator ────────────────
// Public read of site_content (service role bypasses RLS; the copy is public
// anyway). Returns { slots: { slug: {value, alt, kind} } }; the page overrides
// only the slots present here, falling back to its hardcoded defaults.
async function handleSiteGet(req: Request): Promise<Response> {
  try {
    const rows = await pgSelect<{ slug: string; kind: string | null; value: string | null; alt: string | null }>(
      "site_content?select=slug,kind,value,alt",
    );
    const slots: Record<string, { value: string | null; alt: string | null; kind: string }> = {};
    for (const r of rows ?? []) {
      if (r && typeof r.slug === "string" && r.slug) {
        slots[r.slug] = { value: r.value ?? null, alt: r.alt ?? null, kind: r.kind ?? "text" };
      }
    }
    return jsonResponse(req, 200, { slots });
  } catch {
    return jsonResponse(req, 200, { slots: {} });
  }
}

// ── POST ?reengage=1 — a goal + journey aware line for the closed-panel bubble ─
// The client shows this instead of a hardcoded line. Reads the freshest
// goal_status, picks the open goal that fits the section the visitor is reading,
// and composes one short outreach line. Returns { text: null } to fall back to
// the client's own line (all goals met, disabled, no key, or any failure).
async function handleReengage(req: Request): Promise<Response> {
  const fallback = () => jsonResponse(req, 200, { text: null });
  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    if (await rateLimited("re:" + ip)) return fallback();
    let body: Record<string, unknown>;
    try { body = await req.json() as Record<string, unknown>; } catch { return fallback(); }
    const sessionKey = typeof body.session_key === "string" ? body.session_key.slice(0, 64) : "";
    const section = typeof body.section === "string" ? body.section.slice(0, 32).toLowerCase() : "";
    const data = await loadConciergeData();
    if (data.config?.enabled === false || data.goals.length === 0) return fallback();
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return fallback();
    const model = resolveModel(data);
    const customer = await verifyUser(req);

    let cid: string | null = null;
    let goalStatus: Record<string, { status?: string }> | null = null;
    if (sessionKey) {
      const rows = await pgSelect<{ id: string; goal_status: Record<string, { status?: string }> | null }>(
        `concierge_conversations?select=id,goal_status&session_key=eq.${
          encodeURIComponent(sessionKey)}&order=created_at.desc&limit=1`,
      );
      if (rows && rows[0]) { cid = rows[0].id; goalStatus = rows[0].goal_status; }
    }

    // Optional synchronous re-grade for the freshest possible status (admin
    // toggle, default off). One extra model call; then re-read goal_status.
    if (cid && data.config?.reengage_regrade === true) {
      const msgs = await pgSelect<{ role: string; content: string }>(
        `concierge_messages?select=role,content&conversation_id=eq.${cid}&order=created_at.asc&limit=20`,
      );
      if (msgs && msgs.filter((m) => m.role === "user").length >= 2) {
        await evaluateGoals(cid, data, msgs as ChatMessage[], apiKey, model);
        const rows2 = await pgSelect<{ goal_status: Record<string, { status?: string }> | null }>(
          `concierge_conversations?select=goal_status&id=eq.${cid}&limit=1`,
        );
        if (rows2 && rows2[0]) goalStatus = rows2[0].goal_status;
      }
    }

    const signed = customer !== null;
    const postSale = body.post_sale === true;

    let sys: string;
    if (postSale) {
      // They JUST commissioned — never "still eyeing it". Congratulate lightly if
      // natural, then invite a SECOND entry (companion cloth for another room, or
      // one as a gift with the register card in another name).
      sys =
        "You are the Mill Concierge for Feierabend. This shopper JUST commissioned a blanket and is " +
        "browsing again on the '" + (section || "page") + "' section. Write ONE short line (max 30 " +
        "words) that does NOT treat them as undecided — a light nod to their new entry is fine, then " +
        "warmly invite a SECOND blanket: a companion cloth for another room, or one as a gift with the " +
        "register card in another name. End in one light question. " +
        (signed ? "They are a signed-in patron." : "They are an anonymous visitor.") +
        " Plain text only: no markdown, no quotation marks, no {{tokens}}. Just the line.";
    } else {
      const open = goalStatus
        ? data.goals.filter((g) => (goalStatus![g.slug]?.status ?? "unmet") !== "met")
        : data.goals;
      if (open.length === 0) return fallback();               // all met — don't push
      const goal = open.find((g) => !!section && goalSections(g).includes(section)) || open[0];
      sys =
        "You are the Mill Concierge for Feierabend, a numbered German wool blanket. Write ONE short " +
        "outreach line (max 30 words) to a shopper who is reading the '" + (section || "page") +
        "' section and has paused with the chat closed. Advance THIS goal, tied to what's in front of " +
        "them: " + goal.label + " — " + goal.description + ". Warm, specific, ending in one light " +
        "question. " + (signed ? "They are a signed-in patron; a small nod to that is welcome." :
        "They are an anonymous visitor.") + " Plain text only: no markdown, no quotation marks, no " +
        "{{tokens}}, no greeting boilerplate. Just the line.";
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 90, system: sys,
        messages: [{ role: "user", content: "Write the line now." }] }),
    });
    if (!res.ok) return fallback();
    // deno-lint-ignore no-explicit-any
    const msg = await res.json() as any;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    // deno-lint-ignore no-explicit-any
    let text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    text = stripPlumbing(text).replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 240);
    if (text.length < 4) return fallback();
    return jsonResponse(req, 200, { text });
  } catch { return fallback(); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method === "GET" && new URL(req.url).searchParams.get("config")) {
    return await handleConfigGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("site")) {
    return await handleSiteGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("tools")) {
    return await handleToolsGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("starters")) {
    return await handleStartersGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("evals")) {
    return await handleEvalsGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("secrets")) {
    return await handleSecretsGet(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("export")) {
    return await handleExportGet(req);
  }
  if (req.method === "POST" && new URL(req.url).searchParams.get("regrade")) {
    return await handleRegradePost(req);
  }
  if (req.method === "POST" && new URL(req.url).searchParams.get("judge")) {
    return await handleJudgePost(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("selftest")) {
    return await handleSelfTest(req);
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("cachecheck")) {
    // Admin-only: this diagnostic WRITES (insert+delete a probe row) and runs an
    // embedding, so leaving it unauthenticated is a write/compute-amplification
    // surface. It has no client caller — it's a manual health check.
    if (!(await requireAdmin(req))) return jsonError(req, 403, "Administrators only.");
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
  if (new URL(req.url).searchParams.get("reengage")) return await handleReengage(req);
  if (new URL(req.url).searchParams.get("form")) return await handleFormPost(req);
  return await handleChatPost(req);
});
