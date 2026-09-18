# On a handset

Everything in this repo that a machine can check, a machine now checks: 268 tests and
four typechecks on every push, and the trust model proven on devnet. What is left is the
set of questions only a physical Android phone can answer, and they are the ones the
product's core claim rests on.

This is the order to ask them in, and what a pass looks like.

## First, a correction worth making

**MWA and StrongBox are in different apps, and they never meet.**

| App | Answers | Uses |
|---|---|---|
| `apps/payer` | Does the offline crypto work on this hardware? | `@nelo/voucher`, `@noble/curves`, `@nelo/attest` |
| `apps/merchant` | Does the sale work? | MWA, Privy, Solana Pay, `@nelo/pay`, `@nelo/ledger` |

`apps/merchant` has **no dependency on `@nelo/attest` at all** — check its `package.json`.
So "run MWA against a wallet to get `isStrongBoxAvailable()`" cannot happen: connecting a
wallet and probing the secure element are different apps, different weeks, different
questions.

## The order, and why

**Payer probe first.** Not because it matters more, but because it is ten minutes,
self-driving, and it tests the deepest assumptions in the project. Launch it and it runs
every check by itself — no taps, no wallet, no devnet SOL. If `@nelo/voucher` misbehaves
under Hermes, you want that on day one, not after an hour of MWA setup.

**Merchant second.** Longer, needs a wallet app, devnet USDC and ideally a second device
to pay from.

If you only have time for one, invert it — the merchant app is what week 2 is graded on
and what the video shows.

---

# Phase 1 — the payer probe

Answers week 1's open questions. Roughly ten minutes.

### 1.1 Build and install

```bash
pnpm --filter @nelo/payer build:dev
```

Install from the EAS link. **Sign in to expo.dev on the phone's browser first** — the
`development` profile is `distribution: internal`, so a logged-out browser gets
*"Account not found"*, which looks like a broken link and is not one.

### 1.2 Start Metro and launch

```bash
pnpm --filter @nelo/payer start
```

A development client does **not** embed the JS bundle — it pulls it from Metro at runtime.
So this step, not the build, is the first time any of this code has ever executed.

**Pass:** the screen draws a list of checks. **Fail:** a red box. Either way you have
learned something no test could tell you.

### 1.3 Read the results

The probe runs these on its own, in order:

| Check | What it proves |
|---|---|
| `@nelo/voucher` encode/decode | `BigInt` and `DataView` behave under Hermes as they do in Node |
| a **tampered** voucher is rejected | verification is not a no-op — the probe checks this before it checks anything passes |
| `@noble/curves` P-256 verify | the offline verification path works on device |
| `attest.isAvailable()` | the native module linked |
| `attest.isStrongBoxAvailable()` | this handset has a secure element |
| `generateAttestedKey` → `sign` | a hardware key produces a signature the codec accepts |

**The one to read carefully** is the signature check. A StrongBox key signs DER with a
possibly high S; the chain wants 64 raw bytes, low-S. If `derToRawSignature()` gets that
wrong, everything still looks fine on the phone and nothing settles on chain. This is the
first time that conversion meets real hardware output.

<br>

> **If `isStrongBoxAvailable()` is false**, that is not a failure. StrongBox is API 28+
> and absent from much budget hardware — which is the hardware this product targets. The
> correct behaviour is to say so and degrade to online-only. Confirm the app does exactly
> that and never quietly falls back to a software key.

---

# Phase 2 — the merchant till

Week 2's deliverable. Budget an hour the first time.

### 2.1 Install and bundle

```bash
pnpm --filter @nelo/merchant build:dev
pnpm --filter @nelo/merchant start
```

**This is the step that has never happened.** Both import bugs found so far — the missing
`awaitPayment` export and the missing `ScrollView` import — were this class, caught by
eye. The typecheck now catches that class, but a typecheck proves the types, not the
render.

Walk every screen before touching a wallet: keypad, amount entry, the day-book (tap
**Today** — that is the screen `ScrollView` would have crashed), and the balance row.

### 2.2 Get a wallet app on the phone

Install a Solana wallet with MWA support — Phantom or Solflare — and **switch it to
devnet** in its settings. Fund it with devnet SOL.

Without this, **Connect wallet** has nothing to talk to. That is itself worth seeing once:
the app should say so rather than hang.

### 2.3 Connect

Tap **Connect wallet**. The wallet's authorisation sheet appears.

**Pass:** it returns, the address is stored, and the balance row appears. Decline it
deliberately once too — a declined authorisation must surface a message, not fail
silently, because the merchant is standing at a counter.

Reopen the app afterwards: the grant is remembered in SecureStore, so it should open ready
to trade without asking again.

### 2.4 Take a payment

You need devnet USDC at mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` in a
**second** wallet — Circle runs a devnet faucet for it. A second phone is ideal; a desktop
wallet scanning the QR works.

1. Type an amount, press **Charge**
2. Scan the QR from the paying wallet, send
3. The till should flip to **Paid** on its own

**What this proves that no test can:** `awaitPayment` polling real devnet RPC, the
reference actually landing in transaction metadata, and the validation accepting a genuine
payment rather than only rejecting forged ones.

Then check the day-book grouped the sale under today, and the balance row moved.

> **Try underpaying once.** Send less than asked. The till must refuse it and say *"that
> was not enough"* rather than accept it or spin forever. That path has unit tests and has
> never met a real transaction.

---

# Phase 3 — Privy onboarding

Needs a Privy app ID, which is yours to create.

### 3.1 Create the app

At `dashboard.privy.io`: new app, enable **SMS** as a login method, enable **embedded
Solana wallets**, and register the Android application ID `com.nelo.merchant`.

Skipping that last one gives `invalid_native_app_id`, which the app labels as a **setup
problem** rather than blaming the merchant — that labelling is deliberate and this is the
error it was written for.

### 3.2 Point the app at it

```bash
echo 'EXPO_PUBLIC_PRIVY_APP_ID=your-app-id' >> .env
```

Restart Metro. **No rebuild needed** — `EXPO_PUBLIC_` values are inlined when Metro
bundles, and a dev client bundles on every start.

### 3.3 Walk it

The onboarding route only appears once an app ID is present. Then:

market → phone number → SMS code → wallet created → payout account → till

**Pass:** you reach the till holding an address you were never shown a key for. That is
step 2's done-when, exactly.

Worth deliberately testing, because each has tested logic and untested wiring:

- a wrong code → *"That code is not right"*, and you can retype
- **Send it again** within 30s → refused locally with the seconds remaining, never spending a Privy attempt
- a landline or a mistyped number → refused before any SMS is sent

---

# What a second handset buys you

Week 1 step 3's done-when is *"the no-StrongBox handset refuses to emit an offline voucher
and says why"*. A cheap phone without a secure element proves the degradation path.

> **State this one accurately.** `@nelo/attest` enforces no-software-fallback at the module
> level, and the probe detects and labels the condition correctly — but the enforcement
> point a merchant would actually hit cannot exist until something emits vouchers, and
> that is week 3. The handset confirms detection and honest labelling. It does not yet
> confirm a refusal to emit, because there is nothing to refuse.

---

# Everything else on your end, in order

Code is not the blocker on any of these. Ordered by what unblocks the most.

### Do now

1. **Phase 1 and 2 above.** Closes week 1 step 2 and week 2 step 1, and is the largest
   unknown left in the project.
2. **Create the Privy app** → phase 3. Closes week 2 step 2.

### Decide

3. **Launch currency, or an NGN source.** Pyth publishes no NGN feed — 39 FX pairs and
   the naira is not among them. Manila (PHP) is covered; Lagos is not. Either pick a
   covered launch currency or source NGN from Switchboard or a commercial feed. Hermes
   also wants an API key for prices.
   Until this is settled the till runs a configured rate and says so on screen, which is
   honest but is not week 2 step 3's done-when. **This has been blocking all week.**

4. **`k` and the hard cap, together.** The reserve model finds the curve *raises* required
   reserve below ~$250 of staked value, and the $500 hard cap needs ~$81,000 of stake to
   bind. Neither can be set without the other. Both are `RiskConfig` updates, not
   redeploys — so this is a decision, not a deployment.

5. **The reserve line and the premium claim.** The model contradicts two figures the deck
   asserts: the 0.20% insurance line does not cover expected loss (28.1 bps implied), and
   reserve relief funds a premium of ~1.001×, not the illustrative 1.5×. Both should be
   settled before the deck goes out.

### Chase

6. **A payout partner sandbox.** Week 2 step 8. The ledger is real and the stub is honest,
   so the fork is cheap — but the real leg cannot be built against an API nobody has
   access to. This was flagged in the plan as slip risk #1 with a decision date that has
   passed.

7. **A Mintlify deployment** pointing at `docs-site/`, and a hostname —
   `docs.udokaam.dev` via CNAME, or `udokaam.dev/nelo` via a rewrite on whatever serves
   the apex.

### Still unbuilt

8. **Kora relayer** — week 2 step 4, not started. Done-when: *a merchant with zero SOL
   completes a sale.* Needs infrastructure, not a decision.

9. **Slashing** — the freeze blocks the exit, so stake cannot walk away from a loss it
   backs, but nothing yet *moves* it to a reserve because there is no reserve account.
   That is the other half of "first-loss capital".
