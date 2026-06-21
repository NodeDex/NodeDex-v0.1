# Contributing to NodeDex

Thanks for your interest in improving NodeDex. Issues and pull requests are welcome.

## Contributor License Agreement (CLA)

By submitting a contribution you agree to the Contributor License Agreement: you grant
**NodeDex** the right to license your contribution under the project's current license
(**AGPL-3.0**) **and** under a separate **commercial license**. This is what keeps
dual-licensing possible (AGPL for everyone + a commercial option for those who can't
accept copyleft).

A CLA bot will ask you to sign once on your first pull request. You only sign once; it
covers all future contributions.

## Development setup

```bash
# server
cd server
npm install
npm run build
npm test          # full suite — should be green before you open a PR

# tui
cd ../tui
npm install
npm run typecheck
```

## Ground rules

- **Keep the test suite green.** Run `npm test` in `server/` before opening a PR.
- **The pipeline is v2-only.** The legacy v1 extraction front-half is retired and
  intentionally un-turnable — please don't re-enable it. New extraction work goes through
  the v2 (COMPREHEND / transform) path.
- **Read-only MCP surface.** The agent-facing MCP tools are read-only by design; the
  server-side pipeline is the only writer. Keep that boundary.
- Match the style and comment density of the surrounding code.

## Reporting bugs / asking questions

Open a GitHub issue. For commercial-licensing questions, email **nodedex.dev@gmail.com**.
