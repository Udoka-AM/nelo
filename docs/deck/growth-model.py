# nelo growth model behind the deck's Market and Projection slides.
# Run: python3 docs/deck/growth-model.py
#
# Grounded in Nigeria's POS market today:
#   NIBSS, Q1 2026: N18.78T through POS in one quarter (~$48B a year at N1,550/$)
#   CBN, Mar 2025: 5.9M active POS terminals (8.36M registered)
#   => an average terminal moves ~$23 a day (NIBSS) to ~$71 (CBN, broader count)
#
# The plan, as a funded company would run it: launch on the Play Store with
# paj.cash and UseAzza live, 500 users in month 1 (4 businesses : 1 payer),
# 4,000 by month 3, then field sales plus the network effect (every shop brings
# its customers onto nelo pay; every customer asks the next shop).
FX = 1550
NIBSS_POS_PER_QUARTER = 18.78e12
ACTIVE_TERMINALS = 5.9e6
SAM = NIBSS_POS_PER_QUARTER * 4 / FX           # $ a year

# Anchors (month: count); geometric between them.
BUSINESSES = {1: 400, 3: 3_200, 12: 50_000, 24: 200_000, 36: 500_000}
PAYERS = {1: 100, 3: 800, 12: 100_000, 24: 1_000_000, 36: 3_500_000}

ACTIVE = 0.70                                   # share of signed businesses trading in a month
DAILY_ON_NELO = {1: 25, 2: 35, 3: 40}           # $ per active business per day, moving upmarket
NET_TAKE = 0.0091                               # 0.50% fee + 0.80% payout spread - 0.29% reserve - 0.10% rebate
PAYER_REVENUE = {1: 1.44, 2: 4.14, 3: 5.18}     # $ per nelo pay user per year from services
AGENT_SHARE = {1: 0, 2: 0.02, 3: 0.05}          # share of volume via the agent API, at 0.5%
CAC = 15                                        # $ to sign a business (field sales commission)


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

print(f"Nigeria POS volume ${SAM / 1e9:.0f}B a year; {ACTIVE_TERMINALS / 1e6:.1f}M active terminals")
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
