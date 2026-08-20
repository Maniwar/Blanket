# Support mode — answer first, escalate as a ticket

How the concierge handles what it *cannot* answer: it opens a **ticket** — a
durable, threaded, owned work item an agent resolves from the studio's Support
queue — and hands the customer a reference number. Written for the merchant
first, engineers second.

Support mode is **off by default**. A house that runs no support desk must never
be able to promise one, so with `config.support.enabled` absent or false the
model never even sees the ticket tools (the same master-switch cascade the
calendar uses).

---

## The rule the whole thing exists to enforce

> **Answering is always better than escalating.**

A ticket is for what the knowledge genuinely does not cover, what is **broken**,
or what the customer explicitly wants a human for. Opening a ticket for something
the concierge could have answered is a failure, not a courtesy — it moves work to
a human who did not need to do it. Equally, guessing to *avoid* a ticket is worse:
"I don't know, and here is how I'll get you a real answer" is a good turn.

This is why the escalation rate has a complement worth watching:
**deflection** — the share of conversations that never needed a person.

---

## Three axes, three jobs

A ticket is classified on three independent axes, because each drives something
different. Conflating them is the usual reason helpdesk routing goes wrong.

| Axis | Values | What it drives |
| --- | --- | --- |
| **`type`** | `question` · `bug` · `feedback` | The **intake script** — what the concierge must capture |
| **`area`** | the configured product surfaces | The **queue** — which team owns it |
| **`priority`** | `low` · `normal` · `high` · `urgent` | The **SLA clock** |

### Intake differs by type

Because a bug, a feature request and a question need different things to be
actionable:

- **`bug`** — what they **did**, what they **expected**, what **happened**
  instead, and where. One round of questions, not an interrogation: if they are
  plainly blocked, the ticket opens with what's known rather than being held
  hostage to detail.
- **`feedback`** — the underlying **need** and how they work around it today, not
  merely the feature they named. Thanked plainly, and **never** promised a build,
  a priority, or "passed to the roadmap".
- **`question`** — the exact question in their words, plus anything the concierge
  already ruled out, so nobody repeats its work.

### Priority is impact, not tone

`urgent` means **blocked with no workaround**. An annoyed customer who has a
workaround is not urgent. The concierge is told to say what it set and why.

### Area is a tag it may not invent

The concierge may only use an area from the configured list. An unrecognised area
is **dropped**, and the ticket lands untriaged for a human — because a wrong tag
routes to the wrong queue, which is worse than no tag at all.

---

## Routing — most specific wins

`open_support_ticket` resolves the assignee from `config.support.routing` in this
order, first hit wins:

```
  "type:area"   →   "area"   →   "type"   →   unassigned (triage)
```

So a house can send **reports bugs** to one team, **all of billing** to another,
and **all feedback** to product, without enumerating the cross product:

```json
"routing": {
  "bug:reports": "eng-reports@example.com",
  "billing":     "billing@example.com",
  "feedback":    "product@example.com"
}
```

Nothing matching is a feature, not a failure: it lands unassigned for triage.

---

## The SLA clock

At creation each ticket is stamped with two deadlines from its priority:
`due_at` (first response) and `resolve_due_at` (resolution). Defaults, overridable
per priority in `config.support.sla`:

| Priority | First response | Resolution |
| --- | --- | --- |
| `urgent` | 30 min | 4 h |
| `high` | 2 h | 8 h |
| `normal` | 8 h | 48 h |
| `low` | 24 h | 7 d |

A **breach** is an unmet deadline on work still owed — the ticket is `open` or
`pending`, the deadline has passed, and the thing it was owed (a first response,
a resolution) has not happened. The queue badge and the KPI count the same rule,
so they can never disagree.

**An internal note does not stop the first-response clock.** A private note to
your own team is not a response to the customer — treating it as one is how
helpdesks flatter their own metrics.

---

## The thread, and the internal-note boundary

Every ticket carries a thread of messages, each authored by `customer`, `agent`,
`concierge`, or `system`, and each either **`public`** (the customer sees it) or
**`internal`** (agents only).

The internal boundary is enforced **structurally, in the RLS policy** — an owner
may select their own messages *only* where `visibility = 'public'`. It is not a
filter the query remembers to apply, so a private note cannot leak through a
client that forgets. The customer-facing RPC filters again on top (defence in
depth), and a `customer` author can never write an internal note at all.

---

## Lifecycle rules are triggers, not code paths

Two different clients write tickets: the **concierge** (service role, through the
RPCs) and the **studio's queue** (an admin, writing the tables directly under
RLS). If the status handshake lived only inside an RPC, the studio would silently
skip it — an agent's reply would never stop the SLA clock.

So the rules are **triggers**, invariants of the data, true no matter who writes:

| Trigger | When | What it guarantees |
| --- | --- | --- |
| `support_message_sync` | after a message insert | An agent's first **public** reply stops the first-response clock and moves `open → pending`; a **customer** reply reopens (`pending`/`resolved` → `open`); an **internal** note does neither |
| `support_ticket_stamp` | before a ticket update | `resolved_at` / `closed_at` stamped on the status change |
| `support_ticket_audit` | after a ticket update | Status and assignment changes write their own internal audit line into the thread |

The audit line re-enters the message trigger as a `system` author, which only
touches `updated_at` — so the cycle terminates.

---

## CSAT

On a `resolved` or `closed` ticket the requester can rate 1–5 with an optional
comment (`submit_ticket_csat`, owner-scoped by the email that raised it). It is
stored on the ticket and averaged in the metrics — a rating tied to a specific
resolution, which is a different question from the relationship-level
[NPS](NPS.md).

---

## The agent queue (studio → Front desk → Support)

- **KPI strip** — open now, SLA breaches (red when non-zero), median first
  response, CSAT, and **Deflected** (escalation's complement).
- **Queue** — filter by status / type / area / priority, plus free-text over
  subject, email and `#ref`. Type, priority and breached-SLA show as pills. The
  area filter is populated from the *same* configured list the concierge may tag
  with, so the two cannot drift.
- **Ticket detail** — the whole thread *including* internal notes (that is the
  point of this view), the app context the bot captured, a jump to the
  conversation it escalated from, inline status / priority / area / assignee
  controls, and a reply box with an explicit **internal note** toggle.

---

## Metadata the bot brings back

So an agent does not have to ask "what page were you on?", `open_ticket` carries
an app-context envelope into `meta`: `page_url`, `section`, `user_agent`,
`app_version`, `captured_at`. A signed-in customer's email and id come from the
account and are never re-asked. The ticket also stores `conversation_id`, so the
full chat that produced it is one click away.

`meta` is deliberately a free-form jsonb rather than columns: it is the part
every adopting app defines differently.

---

## Metrics — `support_metrics(p_days)`

Admin-only. Volume and mix (`by_status`, `by_priority`, `by_type`, and `by_area`
split by type — the "where is it hurting" read), SLA breach counts, first-response
average and median, resolution average, CSAT average and count, per-agent load,
a daily series, and the **escalation rate** (`tickets ÷ conversations`) whose
complement is deflection.

---

## Portability — this is load-bearing

Support depends on **nothing** from the commerce schema. A ticket links only to
what every install has: a conversation, an email/user, and a free-form `meta`.
There is no foreign key to `orders`, no serial, no colorway. Everything
brand-specific (areas, routing, SLA, categories of work) is **configuration**.

That is deliberate. The same schema is meant to drop into a different Supabase
app — a CRM, a SaaS product — as a config exercise rather than a rewrite. The
engine's own tables and RPCs carry no brand vocabulary, so the kit vendors them
unchanged and the stamp has nothing to rewrite.

---

## Configuration (`concierge_config` key `support`)

Absent keys fall back to the built-in defaults; `enabled` absent means **off**.

### The shape

```json
{
  "enabled": true,
  "areas": ["reports", "billing", "auth", "dashboard"],
  "routing": {
    "bug:reports": "eng-reports@example.com",
    "billing": "billing@example.com",
    "feedback": "product@example.com"
  },
  "sla": {
    "urgent": { "first_response_mins": 30, "resolve_mins": 240 },
    "high":   { "first_response_mins": 120, "resolve_mins": 480 }
  }
}
```

### The live reference config (this house)

```json
{
  "enabled": true,
  "areas": ["order", "delivery", "care", "product", "account", "website"],
  "routing": {
    "bug:website": "concierge@feier-abend.co",
    "order":       "register@feier-abend.co",
    "delivery":    "register@feier-abend.co",
    "care":        "workshop@feier-abend.co",
    "product":     "workshop@feier-abend.co",
    "account":     "concierge@feier-abend.co",
    "website":     "concierge@feier-abend.co",
    "feedback":    "concierge@feier-abend.co"
  },
  "sla": { "urgent": {"first_response_mins": 30, "resolve_mins": 240},
           "high":   {"first_response_mins": 120, "resolve_mins": 480},
           "normal": {"first_response_mins": 480, "resolve_mins": 2880},
           "low":    {"first_response_mins": 1440, "resolve_mins": 10080} }
}
```

Two choices in there are worth copying when you configure a new house:

- **There is no `mending` area, on purpose.** The concierge already has a
  `request_mending` tool. An area for it would teach the model to escalate work
  it can already do itself — the precise failure the answer-first rule exists to
  prevent. **Before adding an area, check no tool already covers it.**
- **Routing points at role addresses, not people.** Assignment survives someone
  leaving, and no individual's inbox becomes load-bearing for the demo.

The SLA block above is written out explicitly even though it matches the
built-in defaults, so the numbers are visible and editable rather than implicit.

---

## Files

| Concern | Where |
| --- | --- |
| Tables, RLS, triggers, RPCs, metrics | `supabase/setup.sql` (SUPPORT section) |
| Master switch, tools, SUPPORT prompt block | `supabase/functions/concierge/index.ts` |
| Agent queue | `admin.html` (Front desk → Support) |
| Schema reference | [`supabase/SCHEMA.md`](supabase/SCHEMA.md) |
