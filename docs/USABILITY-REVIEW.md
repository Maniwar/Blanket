# Studio usability review — first pass (mechanical audit)
*2026-07-16 · method: rendered-text inventory of every panel (jargon lexicon,
info-badge coverage, free-text input count), plus the 112-check interaction
harness. An interactive walkthrough round (screenshots of every panel at
desktop + mobile, driven as a non-technical merchant) is queued as the
second pass.*

## The numbers

| panel | words | ⓘ badges | free-text inputs | jargon in rendered text |
| --- | ---: | ---: | ---: | --- |
| tuning | 3,684 | 48 | 11 | JSON, deploy, env var, fallback, localStorage, slug, token |
| conversion | 1,009 | 17 | 0 | — |
| calendar | 409 | 5* | 1 | — |
| tools | 398 | 0 | 0 | JSON, deploy, slug, token |
| nps | 388 | 3 | 0 | — |
| customers | 369 | 1 | 4 | — |
| spend | 309 | 6 | 0 | CI, cache, deploy |
| edition | 287 | 2 | 0 | SQL |
| evals | 287 | 0 | 0 | API key, deploy, token |
| conversations | 177 | 0 | 1 | — |
| procedures | 115 | 0 | 0 | — |
| actions | 95 | 0 | 1 | — |
| website | 57 | 0 | 0 | deploy |
| knowledge | 28 | 0 | 0 | — |

\* plus the 15+ badges added in the options round live inside JS-built
editors, not counted by the static pass.

## Fixed in this pass

1. **The studio now lands on Conversations (Front desk)**, not Tuning.
   Tuning is the most technical panel in the product (3,684 words, 11
   free-text fields, seven jargon families) and it was the first thing
   every merchant saw, every visit. The daily work — the queue — is now
   the front door; deep links and section memory unchanged.
2. *(Earlier this week, same thread of work: internal doc filenames
   removed from all product copy; info-badges on every calendar option;
   no visible slugs anywhere on the Calendar tab.)*

## Queued for the interactive round (ranked)

1. **Tools + Evals have zero info-badges** and speak JSON/slug/token/API
   key in their notes — the same treatment Calendar got (plain-words
   badges, humanized copy) is owed here.
2. **Tuning free-text pass**: 11 free inputs — some are genuinely prose
   (voice notes), but several deserve the Sam-round treatment (pickers,
   presets, consequence-first labels).
3. **Goals/Forms editors still render "slug"** as an identifier label
   (auto-generated already; the label could simply not say slug).
4. **Website / Knowledge / Procedures / Actions have no explanatory
   badges at all** — small panels, but a first-time merchant gets no help.
5. **Merchant feedback box**: a lightweight "Something unclear? Tell the
   house" control — decided: it belongs on the Judge & Coach tab surface
   (one findings queue for everything), not as a floating widget; build it
   with that tab.
6. **Interactive walkthrough**: screenshot every panel desktop + mobile as
   a merchant persona, empty-state coverage check, action-feedback check
   (every button visibly confirms), dead-end check (every card links
   onward) — the cal-harness method, widened to the whole studio.
