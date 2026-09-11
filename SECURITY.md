# Reporting a security problem

Thank you for looking. This is a health tool, so a bug here can expose
something a person would never choose to publish.

## How to report

Use **[Report a vulnerability](https://github.com/DrBradStanfield/roadmap/security/advisories/new)**
on this repository. That opens a private thread with the maintainer. Nobody
else can read it, and it stays private until there is a fix to publish.

Please do not open a public issue for a security problem. A public issue is a
working set of instructions for anyone who reads it first.

## Please do not include your own health data

A report needs the behaviour, not your record. Describe what you did, what
happened, and what you expected. If a value is essential to the reproduction,
use an invented one. The same rule applies to file names, which often carry a
person's name and a clinic's.

## What is in scope

The code in this repository: the browser widget, the server routes under
`app/`, the shared logic in `packages/health-core/`, the command line tools in
`tools/`, and the hosted connector at `mcp.drstanfield.com`.

Particularly interesting:

- Anything that lets one person read or write another person's record.
- Anything that puts a health value somewhere it should never be: a log, an
  error report, a public GitHub issue, an analytics counter.
- Anything that gets a request past the connector's consent screen, its
  origin check, or its per-connection limits.
- Anything that lets text written by a user become an instruction rather than
  data.

Out of scope: the Shopify storefront theme, third-party services we do not
run, and reports produced solely by an automated scanner with no working
reproduction.

## What happens next

One person maintains this. You should get a first reply within a few days. If
the report is valid, the fix, the release, and the credit are all worked out
with you in the private thread before anything is published. You are welcome
to be named or to stay anonymous.

## What the tool promises, so you know what counts as a break

Health data lives in the user's own storage, not on our server. There is no
server-side health database and no API that stores a health record. The
server holds operational data only: reminder rows, chat routing counters,
anonymous product events. If you find something that contradicts that, it is a
security problem even if nothing crashed.

The full architecture is in [CLAUDE.md](CLAUDE.md) and
[docs/reference.md](docs/reference.md).
