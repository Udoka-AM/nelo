# nelo growth model behind the Projection slide. Run: python3 docs/deck/growth-model.py
# Months 1-3 are the plan (500 -> 4,000 users, 4 businesses : 1 payer at launch);
# from month 4 shops and payers recruit each other (the flywheel), slowing towards a ceiling.
# Flywheel: months 1-3 fixed by the plan (500 -> 4,000, 4 businesses : 1 payer);
# from month 4 each side recruits the other.
B={1:400,2:1130,3:3200}; P={1:100,2:283,3:800}
gB=0.12
a=0.02
b=0.6
gP=0.10
SAT_B=100_000; SAT_P=3_000_000
for m in range(4,37):
    b0,p0=B[m-1],P[m-1]
    B[m]=b0+(gB*b0+a*p0)*(1-b0/SAT_B)
    P[m]=p0+(b*b0+gP*p0)*(1-p0/SAT_P)
avg_daily=895
share={1:0.10,2:0.20,3:0.25}
NET=0.0061
payer_rev={1:1.44,2:4.14,3:5.18}
agent={1:0,2:0.02,3:0.05}
for y in (1,2,3):
    ms=range(12*y-11,12*y+1)
    gmv=sum(B[m]*avg_daily*share[y]*30.4 for m in ms)
    pr=sum(P[m]*payer_rev[y]/12 for m in ms)
    rev=gmv*NET+pr+gmv*agent[y]*0.005
    print(y,round(B[12*y]),round(P[12*y]),round(B[12*y]+P[12*y]),f"gmv {gmv/1e6:.1f}M rev {rev/1e6:.2f}M nonbiz {(pr+gmv*agent[y]*.005)/rev:.0%}")
print([ (m,round(B[m]),round(P[m])) for m in range(1,13)])
