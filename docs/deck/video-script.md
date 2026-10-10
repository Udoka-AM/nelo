# nelo: the 3-minute video

**Hard limit 3:00.** Aim for 2:50 so an edit never pushes it over. Times are cumulative.
It follows the deck (`docs/deck/nelo-deck.pptx`) and the site's look: black aurora for the
title and close, the two-tone headlines ("A payment terminal. *With no terminal.*"), blue for
business, orange for nelo pay.

Record on the **signed release APKs**, two Android phones. Shoot screens with a screen recorder
and the counter scenes on a second phone or camera. Put a shopkeeper on camera, not a developer.

Fill before recording: `₦[amount]`, `[N] seconds`, the Solscan link for the cash-out, the paj.cash
order id. Replace anything in brackets with what really happened, or cut the line.

---

## 0:00–0:12 · Cold open: the network is down

| Picture | Voice-over |
|---|---|
| A busy stall, late afternoon. The bank terminal on the counter: **"Transaction failed"**. She sighs. | "In Lagos, about one card payment in four fails. Most afternoons, it's worse." |
| Close on her phone: no signal. | "When the network drops, she takes cash, or loses the sale." |

## 0:12–0:24 · Title

| Picture | Voice-over |
|---|---|
| Black aurora. White type: **Every business can now take payments on Solana.** Muted line under it: *Even when the network is down.* The two phones from the title slide float in; the "Payment taken · ₦2,500" chip pops in. | "This is nelo. Every business can now take payments on Solana, even when the network is down." |

## 0:24–1:05 · The offline sale

| Picture | Voice-over |
|---|---|
| Both phones side by side. Airplane mode **on**, on both, in one take. | "Both phones in airplane mode. No signal, no Wi-Fi." |
| The till (nelo for business): she types **₦2,500**, a code appears. | "She enters the amount on nelo, on the phone she already owns." |
| The customer's phone (nelo pay): scans, shows the amount, **Pay**. Their code appears; the till scans it. | "The customer pays from nelo pay. Their phone's secure chip signs the payment, against money already locked on Solana." |
| Till: **Payment taken · ₦2,500**. | "The till checks the signature on the spot. Sale done. Still no network." |
| Airplane mode **off** on the till. "Settled"; the balance ticks up. | "When the till sees a network, the payment settles on Solana by itself. She signs nothing and pays no fee." |

## 1:05–1:25 · The double spend

| Picture | Voice-over |
|---|---|
| The same payment code shown again. Till: **refused, already received**. | "Can the same payment be used twice? No." |
| Terminal, `pnpm rehearse`: *second voucher at the same sequence → reported → vault frozen*. | "And a tampered phone that forges a second payment is caught on reconnect: its vault is frozen and its stake taken. Offline money is prepaid, never a promise." |

## 1:25–1:55 · Real naira in a real bank (mainnet)

| Picture | Voice-over |
|---|---|
| Till: **Cash out**, **₦[amount]**, bank and account number; the holder's name appears. | "At the end of the day she cashes out, and sees whose account it is before anything moves." |
| Wallet sheet on **mainnet**; she approves. | "One approval in her own wallet. nelo never holds her money or her key." |
| Till: *Sent → paying your bank → **Paid to your bank*** | "Real USDC on Solana mainnet goes to our payout partner, paj.cash…" |
| Her banking app: **credit alert ₦[amount]**. Solscan for a second. | "…and [N] seconds later it's in her bank account, in naira. With UseAzza, the same cash-out reaches nine more currencies." |

## 1:55–2:20 · The business

| Picture | Voice-over |
|---|---|
| Deck, Market slide: TAM $1.4T → SAM $42B → SOM $39.2M, the six categories lighting up. | "One point four trillion dollars already moves on phones in Africa. We start with businesses: market traders, restaurants, couriers and taxis, field services, fashion and jewellery, supermarkets." |
| Year-one slide: the bars climbing, month 1 to month 12. | "A hundred businesses in our first ninety days. Three hundred in year one." |

## 2:20–2:42 · nelo pay grows up

| Picture | Voice-over |
|---|---|
| Dark slide: the six nelo pay services appear one by one. | "Every customer who pays with nelo pay can pay a friend. From month six, nelo pay becomes their money app: cash out, savings that earn, bill payments, stocks, and an API for AI agents to pay. All on Solana. All felt in naira." |
| Three-year projection: the stacked bars; "From nelo pay and agents: 30%". | "That's $28.5M a year by year three, with nearly a third from nelo pay and agents." |

## 2:42–2:52 · Close

| Picture | Voice-over |
|---|---|
| Black aurora, the nelo mark, *Every business can now take payments on Solana.* github.com/Udoka-AM/nelo · udoka-am.github.io/nelo · team names. | "nelo. Take payments anywhere, even when the network is down." |

---

## Shot list (record these, then cut)

1. The stall and the failed bank terminal.
2. Both phones going into airplane mode, one take.
3. The full offline sale, both screens, one take if you can.
4. The till reconnecting and settling.
5. The same code shown twice and refused.
6. `pnpm rehearse` in a terminal, scrolled to the double-spend lines.
7. The cash-out from amount to "Paid to your bank", one take.
8. The bank credit alert, and the transaction on Solscan.
9. Screen captures of deck slides 1, 8, 10, 11 and 12 (export them as images from PowerPoint).
10. The shopkeeper, a few seconds, for the open and close.

## Rules of thumb

- Captions for every spoken line: many judges watch muted.
- Never show an API key, the `whsec_` secret, `.env` files or a recovery phrase on screen.
- The cash-out is on mainnet; the offline payments run on devnet. Say "devnet" on screen once,
  as the deck's "What actually ran" slide does.
- The nelo pay services after paying a friend, UseAzza payouts and the projections are plans,
  not shipped: the voice-over says "from month six" and the deck labels the model illustrative.
  Keep it that way.
- Time the final cut. 3:00 is a hard limit.
