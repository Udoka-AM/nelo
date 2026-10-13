# Contributing to Nelo

Welcome. Start with [`AGENTS.md`](AGENTS.md), the hand-over: the map of the repository, the
commands, the conventions and where the work stands. Then read
[`docs/ROADMAP.md`](docs/ROADMAP.md) for why each part was built the way it was.

## Your first day

```bash
pnpm install
anchor test                                                        # the program suite
pnpm -r --filter "./packages/*" --filter "./services/*" test        # TypeScript suites
pnpm exec tsc -p tsconfig.check.json                               # typecheck
```

All three pass on a clean clone. If one does not, that is the first bug to fix. To run the apps
on phones against the relayer and settlement service, follow
[`docs-site/quickstart.mdx`](docs-site/quickstart.mdx) and the
[operations runbooks](docs-site/operations).

## How we work

- **Small commits to `main`**, each with a short subject and a body that says what was wrong and
  what changed. Changes to `programs/` go through a pull request so CI runs `anchor test` first.
- **Tests come with behaviour changes.** In the program, write the negative test before the
  positive one: a check that passes because nothing was checked is worse than no check.
- **Comments explain why**, not what. Match the surrounding code.
- **Before pushing app code**, run the typechecks and an `expo export` of the app you touched;
  Metro resolves every import at bundle time and catches what tests miss.
- **Say what is proven.** "Built", "tested" and "ran on a handset" are different claims. Keep
  [the status page](docs-site/operations/status.mdx) accurate rather than flattering.

## Never

- Commit a keypair, a mnemonic or a real API key. `.env` files are gitignored.
- Put a secret in an `EXPO_PUBLIC_` variable: those are compiled into the app and are public.
- Point a test at paj.cash's API: it has no staging, and every call there moves real money.
- Import `@coral-xyz/anchor`; the 1.x client is `@anchor-lang/core`.
