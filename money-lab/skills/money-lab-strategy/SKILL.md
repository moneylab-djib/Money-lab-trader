---
name: money-lab-strategy
description: Research opportunities, run a small portfolio of staged experiments, review weekly and compound what works
auto-activate: true
---
# Money Lab strategy

Suggestions are optional hypotheses, not tasks or rankings. Ignore them when evidence points elsewhere.

## Choose
1. Call `money_lab_status` and `recall_facts` first. Reuse prior evidence before new research.
2. Shortlist a few concrete user problems. For each, note: user problem, evidence links with dates,
   existing alternatives, differentiator, permitted acquisition channel, monetization hypothesis,
   estimated cost, next test and uncertainty. No scoring formulas; predictions are not demand.
3. Select a bounded test and record it with `record_experiment` (status `exploring`, then `building`).
   Keep a portfolio of at most 3 active experiments; each must be cheap to keep alive.

## Research sessions
- Use `web_search` and `web_fetch` to study demand (what people search for, ask about, complain about),
  competitors (features, prices, weaknesses) and channels. Save findings with sources and dates in
  `~/research/`; your context window forgets, your files do not.
- Spend on research in proportion to the decision it informs; declare it with `set_budget_focus`.

## Stages
For each experiment, set numeric criteria and a review window before building:
1. Traffic: real visitors from a permitted channel (e.g. N visits/week from search).
2. Usage: visitors actually use it (e.g. share of visits that complete the main action).
3. Revenue: someone pays, or a monetization source pays out.
Invest more in what passes a stage; kill what stalls after its window and record why in ~/LESSONS.md.

## Build
- Quality is the product: check every page with `view_page` (desktop, mobile, and print for anything
  people print or save as PDF) and compare with the best competitor before shipping.
- Reuse and grow your library (`~/library`: components, templates, scripts) and turn procedures that
  worked into skills, so each product is faster and better than the last.
- Prefer ordinary deterministic software and browser-side processing. Not every user action needs an LLM.
- Do not assume every PDF/Office conversion works reliably in a browser; test it.
- Start free. Do not add payments or ads before a free version shows genuine use.
- Publish static sites in your own GitHub organization when you have credentials (git, gh, GitHub
  Pages). Pay for services only within the owner's price caps; record every cost with `record_experiment`.
- Accounts that need a human (email/phone verification, CAPTCHA, identity, payment/ad accounts): ask with
  `request_help` (exact human action, cost, resume condition), then sleep. Never fake identities or
  bypass platform controls.

## Observe
- Set a review date that fits the channel: days for direct offers, weeks for organic search or ads.
  The review date does not authorize more spending.
- Record metrics with `record_experiment`. Separate genuine independent usage from your own tests,
  owner traffic and gifts. Zero visitors is an acquisition result, not proof of zero demand.
- Estimated ad income is not cash. Provider-confirmed revenue and money received are reported by the operator.
- No unsolicited automated messages, fabricated engagement, generated clicks or mass low-value SEO pages.

## Stop
Mark the experiment `finished` with a result. Stop active spending; delete sandboxes you no longer need,
keep a low-cost artifact only if it is worth its hosting cost, and record any delivery or refund obligations.
