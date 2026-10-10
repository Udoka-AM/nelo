# Nelo: the 3-minute video

**Hard limit 3:00.** Aim for 2:45 so an edit never pushes it over. Times are cumulative.

Record on the **signed release APKs**, two Android phones. Shoot phone screens with a screen
recorder (`adb shell screenrecord` or the phone's own) and the counter scenes on a second phone or
camera. Put a shopkeeper on camera, not a developer.

Fill before recording: `₦[amount]`, `[N] seconds`, the Solscan link for the cash-out, the paj.cash
order id. Replace anything in brackets with what really happened, or cut the line.

---

## 0:00–0:15 · Cold open: the network is down

| Picture | Voice-over |
|---|---|
| A busy stall, late afternoon. The bank terminal on the counter shows **"Transaction failed"** or **"No network"**. The shopkeeper sighs. | "In Lagos, about one card payment in four fails. On a bad afternoon it's worse." |
| Close on her phone: signal bars at zero. | "When the network drops, she takes cash, or she loses the sale." |

## 0:15–0:30 · The promise

| Picture | Voice-over |
|---|---|
| Title card: **Nelo**. Under it: *Take payments on the phone you already own. Paid into your own bank. Even offline.* | "This is Nelo. It turns the phone she already has into a till that keeps working when the network doesn't, and pays her in naira, into her own bank." |

## 0:30–1:15 · The offline sale (the whole product in one shot)

| Picture | Voice-over |
|---|---|
| Both phones, side by side. Swipe down: **airplane mode on**, on both. Hold for a beat. | "Both phones are in airplane mode. No signal, no Wi-Fi." |
| Till: she types **₦2,500**, taps charge. A QR appears. | "She enters the amount." |
| Customer's phone: Nelo Pay scans the till's code, shows the amount, customer taps **Pay**. Their code appears; the till scans it. | "The customer's phone signs the payment inside its secure chip, a key that never leaves the hardware, against money they locked on chain while they were online." |
| Till: **"Paid ₦2,500"**, offline badge. | "The till checks the signature on the spot. Sale done. Still no network." |
| Till: airplane mode **off**. Balance ticks up; "Settled". Optional: Solana Explorer showing the redemption. | "The moment the till sees a network, the payment settles on Solana by itself. She signs nothing and pays no fee." |

## 1:15–1:40 · The double spend

| Picture | Voice-over |
|---|---|
| The customer shows the **same** payment code to the till again. Till: **refused, already received**. | "Can the same payment be used twice? The till refuses it." |
| Mac terminal, `pnpm rehearse`, highlight: *second voucher at the same sequence → reported → vault frozen*. | "And if a tampered phone forged a second payment for another till, the chain catches it on reconnect, freezes that vault, and takes its stake. Offline money is prepaid, never a promise." |

## 1:40–2:20 · Real naira in a real bank (mainnet)

| Picture | Voice-over |
|---|---|
| Till: **Cash out**. Enter **₦[amount]**, pick the bank, type the account number. The account holder's name appears. | "At the end of the day she cashes out. She sees whose account it is before anything moves." |
| Wallet sheet opens on **mainnet**; she approves. | "One approval in her own wallet. Nelo never holds her money or her key." |
| Till: *Sent → paj.cash is paying your bank → **Paid to your bank*** | "Real USDC on Solana mainnet goes to our payout partner, paj.cash…" |
| Her banking app: **credit alert ₦[amount]**. Cut to the Solscan transaction for a second. | "…and [N] seconds later, it's in her bank account. In naira." |

## 2:20–2:45 · Why it only works here

| Picture | Voice-over |
|---|---|
| Simple animation or two slides from the deck: secure chip → P-256 signature → Solana precompile. | "This only works on a phone, because it needs a secure chip and a camera in the same hand. And it only works on Solana, which can verify that chip's signature on chain, with fees small enough for a ₦2,500 sale." |
| Shopkeeper, smiling, next to the dead bank terminal. | "No terminal to rent, no deposit, no afternoon of lost sales." |

## 2:45–2:55 · Close

| Picture | Voice-over |
|---|---|
| End card: **Nelo** · repo link · *Built for CLOCK IN · Solana Mobile × Radiants* · team names. | "Nelo. Take payments anywhere. Get paid at home." |

---

## Shot list (record these, then cut)

1. The stall and the failed bank terminal (or a staged "No network" screen).
2. Both phones going into airplane mode, in one take.
3. The full offline sale, both screens, in one take if you can.
4. The till coming back online and settling (gateway terminal showing `POST relay /v1/redeem → 200` is a good cutaway).
5. The same code shown twice and refused.
6. `pnpm rehearse` in a terminal, scrolled to the double-spend lines.
7. The cash-out from amount to "Paid to your bank", in one take.
8. The bank credit alert, and the transaction on Solscan.
9. The shopkeeper, a few seconds, for the open and close.

## Rules of thumb

- Captions on screen for every spoken line: many judges watch muted.
- Never show an API key, the `whsec_` secret, `.env` files or a recovery phrase on screen.
- Say "devnet" if anyone could mistake the offline sale for mainnet: the cash-out is mainnet, the
  offline payments run on devnet. The deck's "What actually ran" slide says the same.
- Time the final cut. 3:00 is a hard limit.
