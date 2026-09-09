# Cowork prompt — business slide deck

Paste this into Cowork. Run it once per product, swapping the two lines marked
`>>> SET THIS`. It is written to be self-contained: the build-plan URL carries all
the research, numbers and sourcing, so Cowork does not need this conversation.

---

```
Build a business pitch deck as a .pptx file.

>>> SET THIS — product: Nelo
>>> SET THIS — build plan: https://claude.ai/code/artifact/d61c0258-3b7c-43db-ab2f-e89a49f0519d

(The other two, if you need them:
 Prove — https://claude.ai/code/artifact/5d92c195-45e1-4c98-b226-3b28341231f4
 Bits  — https://claude.ai/code/artifact/b8bd7eaf-b968-4fef-b5a1-41971508a3b8)

FIRST: read the build plan at the URL above. It is the single source of truth for
the product, the market figures, the unit economics, the stack and the risks. Every
number in the deck must come from it — do not invent figures, and do not round them
into something rosier than the source. Where the plan labels something "model, not
forecast", the slide must carry that label too.

CONTEXT — who this deck is for

This is a submission to CLOCK IN, a Solana Mobile hackathon presented by Radiants.
Submissions close 8 October 2026. Deliverables are a working Android APK, a demo
video of at most 3 minutes, a GitHub repo that clones and runs, and this deck.

Judging is four categories at 25% each:
  - Stickiness & PMF — does it solve something people care about?
  - User Experience — is it good to use?
  - Innovation / X-Factor — does it bring something new?
  - Presentation & Demo — can you show clearly why it deserves attention?

The judges are Anatoly Yakovenko (Solana co-founder), Mert (Helius), Chase (Solana
DevRel), Akshay, Beeman (developer tooling) and Ethelsec (security). Four of the six
are infrastructure, tooling or security people. They read technical claims closely
and they have sat through hundreds of pitch decks. Assume they will check anything
that sounds too good.

Prize ladder: 1st $30,000 USDC, 2nd $25,000, 3rd $20,000, 4th $15,000, 5th $10,000,
$5,000 each for 6th–10th, plus $10,000 in SKR for best SKR integration.

DECK STRUCTURE — 12 slides, in this order

1.  Title. Product name, the one-line description from the build plan, team names
    and roles. Nothing else.
2.  The problem. One concrete scene with real numbers from the build plan. A person,
    not a market. No bullet lists of pain points.
3.  Why now. The specific thing that changed recently and made this buildable — the
    build plan names it explicitly. This slide is where Innovation is won.
4.  The product. What it actually is, in plain language, with app screenshots or
    mockups. A judge who reads only this slide should understand the thing.
5.  How it works. One diagram of the technical mechanism, end to end. Label every
    component. This is the slide the security and infra judges will linger on, so it
    must be accurate rather than pretty.
6.  Why this is only possible on a phone, and only on Solana. Two claims, each
    defended in one sentence. The rules forbid "a website in a wrapper" — this slide
    is the answer to that objection before it is raised.
7.  Market. Size the opportunity with the sourced figures from the build plan.
    Show TAM / SAM / SOM, and be explicit that SOM is the beachhead described in the
    plan's distribution section. Cite sources in small type on the slide itself.
8.  Business model. How money is made, with the unit-economics table from the build
    plan reproduced faithfully — including the "model, not forecast" caveat and the
    stated assumptions. Show revenue at the two or three scale points the plan gives.
9.  Distribution. How the first hundred users are acquired, then the first ten
    thousand. Use the plan's distribution section. Be specific about channels; avoid
    the word "viral".
10. What actually ran. Demo evidence — what was built, what was tested, what is
    stubbed. Name the stubs. Judges punish a discovered stub far harder than a
    declared one.
11. Roadmap. The next 90 days after the hackathon, in three phases, with the one
    commercial dependency the plan identifies as blocking.
12. Team and ask. Who built it, why this team, and what would unlock the next stage.

DESIGN

Serious, dense, engineering-credible. Think a technical company's investor update,
not a startup landing page. One accent colour, a strong neutral palette, generous
white space, real typographic hierarchy. No stock photography, no gradients, no
emoji as bullets, no "revolutionary" or "game-changing" anywhere in the copy.

Charts must be readable at a glance and labelled with the values they reach. Tables
should use tabular figures. Sources go in 8pt type at the foot of any slide carrying
an external number.

WRITING

Short declarative sentences. Active voice. Specific over clever. Where the build
plan states a limitation or a risk honestly, keep it — the honesty is a scoring
asset with this panel, not a weakness to design around. Never claim a partnership
that is a conversation, or a metric that is a projection.

Output a .pptx file.
```

---

## If you would rather not use Cowork

I can build the same deck here as an HTML artifact instead — that renders as slides
you can present from a browser and share by link, and I can pull the numbers directly
rather than re-reading them. Say which product and I will do it.
