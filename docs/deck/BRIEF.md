# Investor deck brief

The brief for building or rebuilding Nelo's investor deck, by hand or with an AI design tool.
It is self-contained: [`../BUILD.md`](../BUILD.md) carries the research, numbers and sourcing,
and [`growth-model.py`](growth-model.py) carries the projection.

---

```
Build an investor pitch deck for Nelo as an editable .pptx file.

SOURCE OF TRUTH: docs/BUILD.md (the product and business plan) and
docs/deck/growth-model.py (the three-year model). Every number in the deck must come from
them. Do not invent figures or round them into something rosier than the source. Where the
plan labels something "model, not forecast", the slide carries that label too.

AUDIENCE

Seed investors, payment partners and senior engineers deciding whether to join. They read
hundreds of decks, they know African payments, and the technical ones will check the claims.
Put the strongest information first on every slide.

STRUCTURE — 11 slides, in this order

1.  Title. "Every business can now take payments on Solana." Sub-line: "Even when the network
    is down." Proof chips: live on mainnet, paid into a Nigerian bank, works with no network,
    any Android phone. The two app screens.
2.  The founder. Udoka A.M, with photo and the credentials in BUILD.md §12. Only the founder.
3.  It already works. The mainnet cash-out into a Nigerian bank, the offline sale, the refused
    double spend; signed apps, 500+ tests, two payout partners.
4.  The problem. A quarter of card payments fail (29.23% on 15 May 2026). One concrete scene.
5.  The product. nelo for business and nelo pay, with screens.
6.  How it works. Lock, sign, hand over, verify, settle. Why only on a phone, why only on
    Solana.
7.  SKR Trust Stake. Stake for a higher limit, slashed for cheating, rebates in SKR.
8.  Market. $153B of Nigerian POS volume through 5.9M terminals; TAM / SAM / SOM; who Nelo
    serves (seven segments, including hospitality). Sources in small type.
9.  Business model. 0.91% net on business volume; 0.3–1.5% on nelo pay services from month 6.
10. Projection. Users by month in year one; the three-year table from growth-model.py; the
    roadmap strip. Labelled as a model.
11. Risks. Six risks and what already mitigates each.

DESIGN

Black background with a dark purple aurora gradient, Montserrat (ExtraBold headlines, Light
body), white text, lilac #F7DAFF accent, purple #CB6CE6 secondary. Text in short blocks,
left-aligned, on outlined dark cards. Icons on lilac circles. Charts labelled with the values
they reach. No stock photography, no emoji, no "revolutionary".

WRITING

Short declarative sentences. Specific over clever. Keep every limitation the plan states; a
named limitation reads as confidence, a discovered one reads as spin. Never claim a
partnership that is a conversation, or a metric that is a projection.
```
