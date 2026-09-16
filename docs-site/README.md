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

This site is **not yet connected to a Mintlify deployment.** The Mintlify account
reachable from this repo has three deployments (`agent-circle`, `retinaos`,
`arc-doc`) and none of them is Nelo.

1. Create a deployment at [dashboard.mintlify.com](https://dashboard.mintlify.com),
   pointing it at this repo with `docs-site/` as the content directory.
2. Custom domain → set it there. A CNAME at the registrar for `udokaam.dev` has to
   point at Mintlify's target; the dashboard shows the exact value. Custom domains
   are a paid-plan feature.
3. Push to the default branch; Mintlify rebuilds.

## The rule for these pages

Three states are kept apart, deliberately, and every page respects it:

- **Proven** — a test that has actually executed, or a run on devnet
- **Written** — code exists and compiles, but has never run
- **Declared stub** — deliberately not real, labelled as such at every call site

`operations/status.mdx` and `operations/testing.mdx` are the ledger. Keep them
accurate rather than flattering — a named stub reads as confidence, a discovered
one reads as spin.
