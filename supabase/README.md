# Concierge Backend — Setup

The AI sales concierge on the site talks to a Supabase Edge Function
(`supabase/functions/concierge/`), which proxies streaming chat to the
Anthropic API. The API key lives only in Supabase — never in the browser
or the repo.

## Setup

1. **Create a free Supabase project** at [supabase.com](https://supabase.com).
   Note the **project ref** (the short ID in the project URL, e.g.
   `abcdefghijklmnop` in `https://supabase.com/dashboard/project/abcdefghijklmnop`).

2. **Create a Supabase access token**: dashboard → your account (top right)
   → **Access Tokens** → generate a new token.

3. **Add GitHub repo secrets** (repo → Settings → Secrets and variables →
   Actions):
   - `SUPABASE_ACCESS_TOKEN` — the token from step 2
   - `SUPABASE_PROJECT_REF` — the project ref from step 1
   - `ANTHROPIC_API_KEY` — your Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

4. **Run the deploy**: repo → Actions → **Deploy Concierge** → Run workflow.
   The workflow links the project, sets the function secrets, deploys the
   function, and prints the endpoint URL in its final step.

5. **Wire up the front end**: copy the printed endpoint
   (`https://<project-ref>.supabase.co/functions/v1/concierge`) into the
   `FEIER_CONCIERGE_CONFIG` line near the bottom of `index.html` (the
   `endpoint` field) and push.

6. **Verify** with curl — this matches the wire contract the front end uses:

   ```bash
   curl -N "https://<project-ref>.supabase.co/functions/v1/concierge" \
     -H "Content-Type: application/json" \
     -d '{
       "messages": [{"role": "user", "content": "Is the wool section still available?"}],
       "context": {"section": "wool", "claimed": 14213, "remaining": 787,
                   "slot": "14,214", "holdClock": "09:12", "loomClock": "2d 4h 10m"}
     }'
   ```

   You should see a stream of Server-Sent Events:

   ```
   data: {"t":"Yes — "}

   data: {"t":"thread 14,214 in the wool section is"}

   data: {"t":" still yours to claim..."}

   data: [DONE]
   ```

## Cost

A typical answer costs well under a cent (short prompts, `max_tokens` capped
at 1024). If you want it even cheaper, set a `MODEL` env var on the function
to a cheaper model, e.g.:

```bash
supabase secrets set MODEL="claude-haiku-4-5"
```

## Security

`ALLOWED_ORIGINS` (set by the workflow to `https://maniwar.github.io`)
restricts which **browsers** may call the function via CORS — it does not
stop direct `curl` calls. Abuse is bounded by the built-in rate limit
(**20 requests per 10 minutes per IP**) and the `max_tokens: 1024` cap on
each response. Watch your Anthropic usage dashboard; if usage looks wrong,
rotate the API key (create a new one, update the `ANTHROPIC_API_KEY` repo
secret, re-run the deploy, then revoke the old key).

## FUTURE — personalization

The path to order-tracking personalization is already laid out: the Edge
Function will join Supabase `customer` / `order` tables into the LIVE STATE
block of the system prompt (see the `renderLiveState` note in
`functions/concierge/index.ts`), so the concierge can answer per-customer
questions like shipping status. The front end already sends the section and
allocation context on every request, so no front-end changes are needed to
extend the state.
