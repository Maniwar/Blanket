# In-chat forms

The concierge can hand the shopper a small structured form inside the chat —
a proper set of labelled fields with a submit button — instead of collecting an
address or a change field by field in prose. This is how the bot makes a
low-friction, low-error edit to an existing order.

Forms are defined in the **admin studio → Tools → Form tools**, stored in the
`concierge_forms` table, and delivered to the widget with the rest of the
concierge config. Everything below is editable without a deploy. (Forms are one
of the two kinds of tool the concierge can use — see [`TOOLS.md`](TOOLS.md).)

---

## 1. What a form is

A form is three things bound together:

| Piece | What it is | Where it lives |
|-------|-----------|----------------|
| **slug** | the handle used in the token (`address-change`) | `concierge_forms.slug` |
| **submit tool** | the register write path the submission runs | `concierge_forms.submit_tool` |
| **fields** | the labelled inputs shown to the shopper (JSON) | `concierge_forms.fields` |

When the concierge decides a form is the right move, it emits a token on its own
line:

```
{{form:address-change:1287}}
```

The widget replaces that token with a rendered form. The number after the slug is
the **order serial** the edit applies to. On submit, the widget POSTs the values
back; the edge function re-validates against the form's own field definitions and
runs the bound submit tool as that signed-in patron.

### Register-edit forms are order-scoped

A **register-edit** form (like `address-change`) carries a serial, so it **always
acts on one existing order**. That is a deliberate constraint: the submit path is
a register write on a specific entry (`Nº 1287`), gated by ownership.

The one exception is an **inquiry form** — a form whose submit tool is
`submit_inquiry` (e.g. `make-an-offer`, `book-a-viewing`). Inquiry forms are
lead capture, not a register write: they carry **no serial**, require **no
sign-in**, and work for anonymous visitors. See [`INQUIRIES.md`](INQUIRIES.md).
Everything else (joining the waitlist, leaving a note) is handled by the
concierge's own conversational tools, not by a form.

---

## 2. The field schema

`fields` is a JSON **array**; each element is one input:

```json
{
  "name": "address",
  "label": "Street address",
  "type": "text",
  "required": true,
  "maxlength": 120,
  "autocomplete": "address-line1"
}
```

| Key | Meaning | Notes |
|-----|---------|-------|
| `name` | the key sent to the submit tool | must match what the tool expects |
| `label` | shown above the input | keep it short |
| `type` | `text` · `state` · `zip` | see below |
| `required` | `true` blocks submit if empty | server re-checks |
| `maxlength` | soft cap in the UI | server also trims to 200 |
| `autocomplete` | browser autofill hint | e.g. `postal-code` |

**Field types**

- `text` — a plain single-line input.
- `state` — a US state input (two-letter code; validated `^[A-Z]{2}$`).
- `zip` — a US ZIP (validated `12345` or `12345-6789`).

There is **no dropdown/select field type yet** (see Limitations). A form needs
**at least one field** — a zero-field form is dropped by the widget and never
renders.

---

## 3. Submit tools

A form binds to exactly one **submit tool**. Because forms are order-scoped, the
tool must be a register write path that takes a serial. Two qualify today, and the
admin "Add form" picker offers only these (the server safely rejects anything
else at submit time):

| Submit tool | What it does | Guard |
|-------------|-------------|-------|
| `update_shipping_address` | change the delivery address | only before shipment |
| `update_colorway` | change the cloth | only while the order is still `placed` |

Each expects specific field `name`s:

- **`update_shipping_address`** → `address`, `address2` (optional), `city`,
  `state` (type `state`), `zip` (type `zip`).
- **`update_colorway`** → `colorway` (one of `ungefaerbt`, `loden`, `graphit`).

The admin picker pre-fills the correct starter fields when you choose a tool, so
a new form is usable immediately.

A third submit tool, **`submit_inquiry`**, powers the anonymous, serial-less
**inquiry forms** (`make-an-offer`, `book-a-viewing`) — lead capture rather than a
register write. Its rules are its own; see [`INQUIRIES.md`](INQUIRIES.md).

> Cancellation is intentionally **not** a form. It releases the serial back to the
> edition and is handled by the concierge's `cancel_order` tool in conversation,
> where the bot can confirm intent first.

---

## 4. Adding and configuring a form (admin)

**Tools → Form tools → Create form tool:**

1. Click **Add form**. A new draft appears.
2. Enter a **slug** (letters, numbers, dashes — this is the token handle).
3. Pick a **submit tool** from the dropdown. Its starter fields load into the JSON
   box automatically.
4. Adjust the **title** (shown on the form) and the **fields** JSON if needed.
5. **Save.** The slug and submit tool freeze once saved (they are referenced by
   the token and by your SOPs); title, fields, and enabled stay editable.

To change an existing form, edit its title/fields/enabled and **Save**. To retire
one, untick **Enabled** — it stops being offered but the definition is kept.

---

## 5. Instructing *when* the bot offers a form

Defining a form makes it *available*; it does not make the bot use it. The
concierge is told, automatically, that the form exists and how to emit it (it
never invents slugs or dictates fields through chat). You steer *when* it reaches
for one through the two places you already tune behaviour:

- **Procedures (SOPs).** Write the trigger the way you'd brief a clerk, e.g.
  *"When a signed-in owner wants to change where an unshipped order goes, hand them
  the `address-change` form for that order rather than typing the address back and
  forth."*
- **Tuning notes.** Nudge tone/eagerness, e.g. *"Prefer the form for address and
  colorway edits; it's faster and avoids mistakes."*

The bot emits `{{form:<slug>:<serial>}}` on its own line once the order in
question is identified.

---

## 6. Worked example — the address-change form

Seeded in `setup.sql`:

```json
[
  {"name":"address",  "label":"Street address",            "type":"text",  "required":true,  "maxlength":120, "autocomplete":"address-line1"},
  {"name":"address2", "label":"Apt, suite — if needed",    "type":"text",  "required":false, "maxlength":120, "autocomplete":"address-line2"},
  {"name":"city",     "label":"City",                      "type":"text",  "required":true,  "maxlength":80,  "autocomplete":"address-level2"},
  {"name":"state",    "label":"State",                     "type":"state", "required":true},
  {"name":"zip",      "label":"ZIP",                       "type":"zip",   "required":true,  "autocomplete":"postal-code"}
]
```

- **slug:** `address-change` · **submit tool:** `update_shipping_address`
- The bot emits `{{form:address-change:1287}}` when a signed-in owner asks to
  reroute an unshipped order.
- On submit, the edge function validates each field, confirms the patron owns
  Nº 1287, and writes the new address — refusing if the order has already shipped.

---

## 7. Trust & audit

A form submission crosses the **same trust boundary as the concierge's own tool
calls** — it is not a shortcut around them:

- **Verified identity.** A **register-edit** form's submit endpoint requires a
  valid signed-in JWT; an anonymous visitor can't submit. (Inquiry forms are the
  exception — lead capture is anonymous by design; see [`INQUIRIES.md`](INQUIRIES.md).)
- **Ownership filters.** The write only touches orders belonging to that patron.
- **Server-side validation.** Field values are re-validated and the submit tool
  applies its own guards (status checks, format checks).
- **Rate limited.** Submissions share the register's rate limiter.
- **Audited.** Every submission is logged to `concierge_actions`, visible in the
  admin's **Register actions** tab (searchable by email, action, or order Nº).

---

## 8. Limitations & future work

- **No select/radio field type.** Constrained choices (like colorway) are plain
  text today and validated server-side; a `select` type with options is the clean
  fix. *(Backlog.)*
- **Order-scoped only.** By design — see §1.
- **Two submit tools.** More order write paths can be exposed as they're added to
  the register; the picker is scoped to whatever the edge function actually
  supports.
