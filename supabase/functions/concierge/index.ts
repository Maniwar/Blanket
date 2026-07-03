/**
 * Feierabend — Decke 01 · AI Sales Concierge (Supabase Edge Function, Deno)
 *
 * Purpose:
 *   Server-side proxy between the static GitHub Pages front end and the
 *   Anthropic Messages API. Keeps the API key out of the browser, enforces
 *   validation + rate limiting, and re-shapes Anthropic's SSE stream into
 *   the simple event format the front end expects.
 *
 * Wire contract (the front end depends on this exactly):
 *   Request:  POST, Content-Type: application/json
 *     {
 *       "messages": [{"role":"user"|"assistant","content":"..."}],   // 1..20 items, content <= 2000 chars
 *       "context":  {"section":..., "claimed":..., "remaining":...,  // optional
 *                    "slot":..., "holdClock":..., "loomClock":...}
 *     }
 *   Response: text/event-stream
 *     data: {"t":"chunk of text"}\n\n   (one per text delta)
 *     data: [DONE]\n\n                  (end of stream)
 *   Errors:   non-200 with JSON body {"error":"message"} (CORS headers included).
 *
 * FUTURE: order-tracking personalization — this function will join Supabase
 * customer/order tables (via the service-role client) into LIVE STATE here,
 * so the concierge can answer "where is my blanket?" per signed-in customer.
 */

import { BRAND_SYSTEM, KB_MARKDOWN } from "./kb.ts";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  let allowOrigin = "";
  if (ALLOWED_ORIGINS.includes("*")) {
    allowOrigin = origin || "*";
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    allowOrigin = origin;
  }
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return headers;
}

function jsonError(
  req: Request,
  status: number,
  message: string,
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window, keyed by client IP
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function validateBody(
  body: unknown,
): { messages: ChatMessage[]; context: Record<string, unknown> } | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  const { messages, context } = body as Record<string, unknown>;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) {
    return "messages must be an array of 1 to 20 items.";
  }
  for (const m of messages) {
    if (typeof m !== "object" || m === null) {
      return "Each message must be an object.";
    }
    const { role, content } = m as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") {
      return "Each message role must be 'user' or 'assistant'.";
    }
    if (typeof content !== "string" || content.length === 0 ||
      content.length > 2000) {
      return "Each message content must be a non-empty string of at most 2000 characters.";
    }
  }
  if (context !== undefined &&
    (typeof context !== "object" || context === null ||
      Array.isArray(context))) {
    return "context, if provided, must be an object.";
  }
  return {
    messages: messages as ChatMessage[],
    context: (context ?? {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

function renderLiveState(ctx: Record<string, unknown>): string {
  const val = (key: string) => {
    const v = ctx[key];
    return v === undefined || v === null || v === "" ? "unknown" : String(v);
  };
  return [
    `section: ${val("section")}`,
    `claimed: ${val("claimed")}`,
    `remaining: ${val("remaining")}`,
    `slot: ${val("slot")}`,
    `holdClock: ${val("holdClock")}`,
    `loomClock: ${val("loomClock")}`,
  ].join(" | ");
  // FUTURE: append per-customer order status here (joined from Supabase
  // customer/order tables) once accounts exist.
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonError(req, 405, "Method not allowed. Use POST.");
  }

  const ip = (req.headers.get("x-forwarded-for") ?? "unknown")
    .split(",")[0].trim();
  if (rateLimited(ip)) {
    return jsonError(
      req,
      429,
      "Too many requests. The concierge takes a short pause — try again in a few minutes.",
    );
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return jsonError(req, 400, "Request body must be valid JSON.");
  }
  const validated = validateBody(parsed);
  if (typeof validated === "string") {
    return jsonError(req, 400, validated);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return jsonError(req, 500, "Server is not configured (missing API key).");
  }

  const system = BRAND_SYSTEM
    .replace("{{LIVE_STATE}}", renderLiveState(validated.context))
    .replace("{{KB}}", KB_MARKDOWN);

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("MODEL") ?? "claude-sonnet-4-5",
      max_tokens: 1024,
      system,
      messages: validated.messages,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return jsonError(
      req,
      502,
      detail || `Upstream error (${upstream.status}).`,
    );
  }

  // Re-shape Anthropic SSE into the front end's contract:
  //   content_block_delta/text_delta -> data: {"t": "..."}\n\n ; end -> data: [DONE]\n\n
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

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
                if (
                  evt.type === "content_block_delta" &&
                  evt.delta?.type === "text_delta" &&
                  typeof evt.delta.text === "string"
                ) {
                  controller.enqueue(encoder.encode(
                    "data: " + JSON.stringify({ t: evt.delta.text }) + "\n\n",
                  ));
                }
                // All other event types (message_start, content_block_start,
                // message_delta, message_stop, ping, ...) are ignored.
              } catch {
                // Ignore unparseable event payloads.
              }
            }
          }
        }
      } catch {
        // Upstream read failed mid-stream; fall through to [DONE] so the
        // front end terminates cleanly.
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
});
