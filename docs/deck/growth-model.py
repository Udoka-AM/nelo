# nelo growth model behind the deck's Market and Projection slides.
# Run: python3 docs/deck/growth-model.py
#
# Grounded in Nigeria's POS market today:
#   CBN, Q1 2026: N59.33T through POS in one quarter (~$153B a year at N1,550/$);
#   NIBSS-settled alone N18.78T (~$48B)
#   CBN, Mar 2025: 5.9M active POS terminals (8.36M registered)
#   => an average terminal moves ~$23 a day (NIBSS) to ~$71 (CBN, broader count)
#
# The till is a phone the merchant already owns: no terminal to buy, wait for or
# rent, and it takes transfers, wallets and offline payments a terminal cannot.
# So distribution is set against the POS base itself: a third of today's active
# terminals by year 3, and they handle a fuller share of each shop's takings
# ($100 a day per active business, above today's ~$71 per terminal).
#
# The plan, as a funded company would run it: launch on the Play Store with
# paj.cash and UseAzza live, 500 users in month 1 (4 businesses : 1 payer),
# 4,000 by month 3, then field sales plus the network effect (every shop brings
# its customers onto nelo pay; every customer asks the next shop).
FX = 1550
NIBSS_POS_PER_QUARTER = 18.78e12
CBN_POS_PER_QUARTER = 59.33e12                  # CBN Q1 2026: the whole POS channel, 2.92B transactions
ACTIVE_TERMINALS = 5.9e6
SAM = CBN_POS_PER_QUARTER * 4 / FX             # $ a year; NIBSS-settled alone is ~$48B

# Anchors (month: count); geometric between them.
BUSINESSES = {1: 400, 3: 3_200, 12: 150_000, 24: 800_000, 36: 2_000_000}
PAYERS = {1: 100, 3: 800, 12: 300_000, 24: 2_500_000, 36: 8_000_000}

ACTIVE = 0.70                                   # share of signed businesses trading in a month
DAILY_ON_NELO = {1: 100, 2: 100, 3: 100}           # $ per active business per day
NET_TAKE = 0.0091                               # 0.50% fee + 0.80% payout spread - 0.29% reserve - 0.10% rebate
PAYER_REVENUE = {1: 1.44, 2: 4.14, 3: 5.18}     # $ per nelo pay user per year from services
AGENT_SHARE = {1: 0, 2: 0.02, 3: 0.05}          # share of volume via the agent API, at 0.5%
CAC = 30                                        # $ to sign a business (field sales commission)


def interp(anchors):
    ks = sorted(anchors)
    out = {}
    for k0, k1 in zip(ks, ks[1:]):
        g = (anchors[k1] / anchors[k0]) ** (1 / (k1 - k0))
        for m in range(k0, k1 + 1):
            out[m] = anchors[k0] * g ** (m - k0)
    return out


B, P = interp(BUSINESSES), interp(PAYERS)
B[2], P[2] = (B[1] * B[3]) ** 0.5, (P[1] * P[3]) ** 0.5

print(f"Nigeria POS volume ${SAM / 1e9:.0f}B a year (CBN); {ACTIVE_TERMINALS / 1e6:.1f}M active terminals")
print("Users by month, year one:", [round(B[m] + P[m]) for m in range(1, 13)])
monthly_net = DAILY_ON_NELO[1] * ACTIVE * 30.4 * NET_TAKE
print(f"Net revenue per signed business ${monthly_net:.2f}/month; CAC ${CAC} paid back in {CAC / monthly_net:.1f} months")
for y in (1, 2, 3):
    months = range(12 * y - 11, 12 * y + 1)
    volume = sum(B[m] * ACTIVE * DAILY_ON_NELO[y] * 30.4 for m in months)
    payer = sum(P[m] * PAYER_REVENUE[y] / 12 for m in months)
    agents = volume * AGENT_SHARE[y] * 0.005
    revenue = volume * NET_TAKE + payer + agents
    exit_volume = B[12 * y] * ACTIVE * DAILY_ON_NELO[y] * 365
    print(f"Year {y}: {B[12 * y]:,.0f} businesses ({B[12 * y] / ACTIVE_TERMINALS:.1%} of active terminals), "
          f"{P[12 * y]:,.0f} nelo pay users; volume ${volume / 1e6:,.0f}M; revenue ${revenue / 1e6:.1f}M "
          f"({(payer + agents) / revenue:.0%} from nelo pay + agents); exit ARR ${exit_volume * NET_TAKE / 1e6:.1f}M; "
          f"{exit_volume / SAM:.1%} of NG POS volume at year end")
