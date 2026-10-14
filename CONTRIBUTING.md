# Contributing to PurseString

Thanks for helping make agent spending safe. You don't need payments experience to contribute: most of the codebase is plain TypeScript, and the mock rail means you never touch real money.

## Find something to work on

1. Browse issues labelled [`good first issue`](https://github.com/suseendar1414/pursestring/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) (small, well-scoped) or [`help wanted`](https://github.com/suseendar1414/pursestring/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) (bigger).
2. Comment **"I'd like to take this"** and we'll assign it to you. One open assignment per person at a time keeps things moving.
3. If you have your own idea, open an issue first so we can agree on the approach before you write code.
4. Questions are welcome in [Discord](https://discord.gg/YOUR_INVITE).

## Set up in two minutes

```bash
git clone https://github.com/suseendar1414/pursestring.git
cd pursestring
npm install       # installs and builds
npm test          # 33 tests, no network needed
npm run dev       # run the MCP server from source over stdio
```

Try it against a real MCP client with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Use a scratch state directory so you don't mix test data with your own: `PURSESTRING_HOME=/tmp/pursestring-dev`.

## Making a change

- Branch from `main`, keep PRs focused on one thing.
- Add or update tests in `test/`. Policy changes need a test in `test/policy.test.ts`; flow changes in `test/governance.test.ts`.
- Run `npm run typecheck && npm test` before pushing. CI runs the same, plus a Docker build.
- Update the docs (`README.md`, `docs/`) when behaviour or configuration changes.
- Write the PR description as before/after: what a user saw before, what they see now.

## Adding a payment rail

1. Create `src/adapters/<rail>.ts` implementing `CardAdapter` from `src/adapters/types.ts`:
   - `issueCard(req)` creates a card capped at `req.amount`. When `req.single_use` is true it must close after one authorization; otherwise lock it to the merchant with a monthly cap.
   - `getCard(ref)` re-fetches the same card by `ref.token`. This is what makes retries return the same card, so don't create a new card here.
   - Set `kind` to `"card"` or `"bank_transfer"`, and implement `closeCard(ref)` if the rail can close cards (single-use cards are closed when their TTL ends).
   - If the rail can ask for real-time authorization (like Lithic ASA), add an endpoint in `src/http.ts` that verifies the rail's signature and calls `gov.authorize()`.
2. Register it in `src/adapters/index.ts`. Rails that are named but not built yet live in `src/adapters/planned.ts`: replace the entry there and add it to `RAILS` in `src/config.ts` if it's new.
3. Never write card numbers or CVVs to disk or logs. Return them only in `CardDetails`.
4. Add tests that stub `fetch` (see how `test/helpers.ts` wraps the mock adapter), and a section in `docs/deploy.md`.

## Ground rules

- Be kind. We follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security issues go to [SECURITY.md](SECURITY.md), not public issues.
- By contributing you agree your work is licensed under the [Apache License 2.0](LICENSE).
