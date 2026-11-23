# The Personal Pilot — what it is and why it makes sense

Personal Agent is a personal agent that works inside a real browser, on your machine,
at your pace — including hours when you are asleep. It is not a chatbot with a
browser bolted on; it is an agent whose entire working environment is the web page
you can see, driven click by click under your review.

## The core idea

**The browser is the tool, the browser is the vault.**
Passwords and sign-ins live where they already live — in the browser profile and
the operating system's password store — never in the agent, never in a database of
ours, never in a cloud service. The pilot never asks you to hand over your
credentials, and there is no credential database to leak. The app's own encrypted
vault holds only the things you deliberately give it (e.g. an API key you add
yourself), and it never sees page credentials at all.

**It is built for patience, not speed.**
Most agent demos show off fast, clever actions. The Personal Pilot is for the
opposite: the 40-field onboarding form, the export that takes eleven minutes,
the deadline you have to keep checking, the form wizard with 12 pages, the queue
you babysit for an hour. Work that a careful human *can* do but shouldn't have to:
repetitive, watchful, long. Set it going before bed; review it with coffee.

**AI babysitting a process is the job description.**
A process you already know how to run, babysat by something that does not get
bored, does not skim, and does not skip the verification step at 2 a.m. It waits,
watches, compares, fills, retries, and flags what it could not finish — then it
stops and waits for you.

## Why this shape and not an API integration

- No API means no integration to build, no scopes to negotiate, no contract to
  maintain. If a human can do it in a browser, the pilot can attempt it.
- The page you watch is the same page the agent reads — no mismatch between
  "the API says X" and "the screen showed Y." WYSIWYG verification is built in.
- When the site updates its API, agents built on APIs break silently. A browser
  agent sees what you see and fails visibly, not plausibly.

## Guardrails that make it usable overnight

- **Every consequential action is gated.** Fills, clicks, submissions — each is
  proposed, logged, and requires your approval (or runs under an explicit,
  pre-scoped grant). Nothing purchases, publishes, posts, deletes, or sends on
  its own.
- **Sensitive pages are off-limits to the agent's eyes.** Pages containing
  password fields are detected and hidden from the agent entirely — it cannot
  act on or even read sign-in surfaces.
- **Local-first.** Inference runs on your machine (Ollama); automation runs on
  your machine; the audit log lives on your machine. The public demo page is a
  shell with no powers and no data.
- **You can always take the wheel.** The pilot pauses for review; the browser
  window is right there; you can finish by hand at any point.

## Where it earns its keep

- Overnight form marathons: grant applications, procurement portals, insurance,
  registration renewals, permit tracking.
- Monitoring with judgment: restocks, eligibility windows, queue positions,
  release notes that mention your dependency.
- Content pipelines you assembled yourself: gather → draft → place into the CMS,
  one approval at a time.
- Anything you'd otherwise open twenty tabs and a spreadsheet to supervise.

## What it is not

Not an unsupervised agent with your wallet and publishing rights. Not a cloud
service that holds your logins. Not a replacement for judgment on money,
credentials, or anything public-facing — those stay behind explicit human
approval, by design.

## Relationship to other tools

- Personal Agent itself is the product: the reviewable, local, gated agent.
- BrowserOS neo (see `agentic-browser-choice.md`) is the general-purpose agentic
  browser used for other work; Personal Pilot borrows ideas from that world but
  keeps its own tighter trust boundary because it is the thing being sold/used
  as a personal tool.

## Status honesty

Implemented and verified today: isolated browser, per-action approval flow,
chat with local or (optionally) cloud models, local encrypted vault for API
keys, send-only Telegram notifications, local-first inference, blocked
credential access. In progress: longer unattended runs, richer triggers,
provider-pluggable models. See `production-preparation-status.md` for the
running log. Nothing here sends credentials anywhere.
