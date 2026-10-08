"""Sensitivity of the standard-selection crossover to heterogeneous holdings.

The cost model in the paper assumes a homogeneous workload: N investors each holding
one fraction of each of P properties. A reviewer asked what happens when portfolios
are heterogeneous - investors holding only a subset of properties, with varying
numbers of holders per property.

The model's per-investor term counts BALANCE WRITES, so the quantity that actually
drives cost is the number of distinct (investor, property) holdings, which we call
claims. Under heterogeneity the natural generalisation is

    C(P, H) = A + P*L + H*d          with H = total claims,

so the homogeneous case is the special case H = P*N. The claim to be tested is that
the crossover is preserved when N is read as the MEAN NUMBER OF HOLDERS PER PROPERTY,
H/P, rather than a uniform per-property count.

This script tests that by Monte Carlo over heterogeneous portfolios.

Run: python heterogeneity_analysis.py
"""

import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(20260916)

# Fitted constants (Table: cost-model constants), Experiment 11 benchmark contracts.
A1155, L1155, D1155 = 1_351_486.0, 13_843.0, 29_353.0
A20, DEP20, D20 = 994_784.0, 718_052.0, 25_622.0


def cost_1155(P, H):
    return A1155 + P * L1155 + H * D1155


def cost_20(P, H):
    return A20 + P * DEP20 + H * D20


def crossover_N(P):
    """Homogeneous break-even holders per property.

    Setting C_1155 < C_20 with H = P*N and solving for N. Both one-off terms must
    appear: an earlier derivation dropped A20 and consequently mis-stated the
    crossover at small P.
    """
    return ((A20 - A1155) + P * (DEP20 - L1155)) / (P * (D1155 - D20))


def simulate(P, mean_holders, dispersion, investors_pool, trials=400):
    """Heterogeneous portfolios: each property draws its holder count from a
    distribution with the given mean and dispersion (Poisson-like when
    dispersion=1, heavily skewed when larger)."""
    wins_1155 = 0
    ratios = []
    for _ in range(trials):
        if dispersion <= 1.0:
            counts = rng.poisson(mean_holders, size=P)
        else:
            # negative-binomial style overdispersion
            shape = mean_holders / (dispersion - 1.0)
            counts = rng.negative_binomial(max(shape, 0.05), 0.5, size=P)
            counts = np.round(counts * mean_holders / max(counts.mean(), 1e-9)).astype(int)
        counts = np.clip(counts, 0, investors_pool)
        H = int(counts.sum())
        c1, c2 = cost_1155(P, H), cost_20(P, H)
        wins_1155 += int(c1 < c2)
        ratios.append(c2 / c1)
    return wins_1155 / trials, float(np.mean(ratios))


report = {"constants": {"A1155": A1155, "L1155": L1155, "d1155": D1155,
                        "A20": A20, "D20_per_property": DEP20, "d20": D20},
          "cases": []}

print("=" * 78)
print("HETEROGENEOUS HOLDINGS: does the crossover survive?")
print("=" * 78)
print(f"{'P':>4} {'mean holders':>13} {'dispersion':>11} {'N*(P)':>8} "
      f"{'ERC-1155 wins':>14} {'mean cost ratio':>16}")

for P in (2, 10, 50):
    nstar = crossover_N(P)
    for mean_holders in (5, 25, 100, 150, 200, 400):
        for disp in (1.0, 3.0):
            frac, ratio = simulate(P, mean_holders, disp, investors_pool=10_000)
            report["cases"].append({"P": P, "meanHolders": mean_holders,
                                    "dispersion": disp, "NStar": nstar,
                                    "erc1155WinRate": frac, "meanCostRatio": ratio})
            tag = "uniform " if disp == 1.0 else "skewed  "
            print(f"{P:>4} {mean_holders:>13} {tag:>11} {nstar:>8.1f} "
                  f"{frac*100:>13.0f}% {ratio:>16.3f}")

print()
print("=" * 78)
print("AGREEMENT WITH THE HOMOGENEOUS PREDICTION")
print("=" * 78)
agree = 0
total = 0
for c in report["cases"]:
    predicted_1155 = c["meanHolders"] < c["NStar"]
    observed_1155 = c["erc1155WinRate"] > 0.5
    ok = predicted_1155 == observed_1155
    agree += ok
    total += 1
    if not ok:
        print(f"  MISMATCH P={c['P']} mean={c['meanHolders']} disp={c['dispersion']} "
              f"N*={c['NStar']:.1f} winRate={c['erc1155WinRate']:.2f}")
print(f"  the homogeneous rule (compare mean holders per property with N*) predicts")
print(f"  the heterogeneous outcome in {agree}/{total} configurations")

report["agreement"] = f"{agree}/{total}"
out = os.path.join(HERE, "heterogeneity_analysis.json")
with open(out, "w") as f:
    json.dump(report, f, indent=2)
print(f"\nwrote {out}")
