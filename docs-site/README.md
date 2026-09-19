# Nelo documentation site

A [Mintlify](https://mintlify.com) site. 16 pages, `docs.json` holds the navigation.

```
docs.json              Navigation, theme, metadata
introduction.mdx       What Nelo is
quickstart.mdx         Clone → install → test
architecture.mdx       Every moving part
concepts/              Trust model, voucher format, replay, Trust Stake
reference/             Vault program, packages, services, apps
economics/             Reserve model, unit economics
operations/            Deployment, testing, status
```

## Preview locally

```bash
npm i -g mint
cd docs-site && mint dev        # http://localhost:3000
```

## Deploy

The site is deployed at the Mintlify **`nelo`** deployment, with `docs-site/` as
the content directory.

- Push to the default branch and Mintlify rebuilds.
- Custom domain → set it in the dashboard. A CNAME at the registrar for
  `udokaam.dev` has to point at Mintlify's target; the dashboard shows the exact
  value. Custom domains are a paid-plan feature.

## The rule for these pages

Three states are kept apart, deliberately, and every page respects it:

- **Proven** — a test that has actually executed, or a run on devnet
- **Written** — code exists and compiles, but has never run
- **Declared stub** — deliberately not real, labelled as such at every call site

`operations/status.mdx` and `operations/testing.mdx` are the ledger. Keep them
accurate rather than flattering — a named stub reads as confidence, a discovered
one reads as spin.
