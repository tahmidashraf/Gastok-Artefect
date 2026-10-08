"""Regenerate the eight matplotlib figures with publisher-safe fonts.

The versions shipped with the thesis embed DejaVuSans as a Type 3 font. IEEE (and
several other publishers) reject Type 3 fonts in submitted figures, so these are
rebuilt with TrueType (fonttype 42) in a serif face that matches the paper body.

Every value below is taken from the paper's own tables, which are in turn the
thesis's measured results; the database recovery times are read directly from the
retained raw result file.

Usage:  python regen_figures.py
"""

import glob
import json
import os

import matplotlib
matplotlib.use("Agg")
matplotlib.rcParams["pdf.fonttype"] = 42      # TrueType, not Type 3
matplotlib.rcParams["ps.fonttype"] = 42
import matplotlib.pyplot as plt
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "figures")
REPO = os.path.abspath(os.path.join(HERE, ".."))

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["DejaVu Serif", "Times New Roman", "serif"],
    "font.size": 9,
    "axes.grid": True,
    "grid.alpha": 0.3,
    "grid.linewidth": 0.5,
    "axes.linewidth": 0.7,
    "legend.frameon": True,
    "legend.framealpha": 0.9,
    "legend.fontsize": 8,
    "figure.dpi": 200,
})

C1155, C20, C721 = "#1f77b4", "#2ca02c", "#d62728"


def save(fig, name):
    p = os.path.join(OUT, name)
    fig.savefig(p, bbox_inches="tight")
    plt.close(fig)
    print("wrote", name)


# --------------------------------------------------------------- Benchmark A
X = [10, 50, 100, 500]
a1155 = [52591, 52591, 52591, 52603]
a20 = [70608, 70608, 70608, 70620]
a721 = [318283, 1318763, 2569363, 12574175]

fig, ax = plt.subplots(figsize=(3.4, 2.5))
ax.plot(X, a1155, "o-", color=C1155, ms=4, lw=1.3, label="ERC-1155")
ax.plot(X, a20, "s--", color=C20, ms=4, lw=1.3, label="ERC-20")
ax.plot(X, a721, "^-.", color=C721, ms=4, lw=1.3, label="ERC-721 (1 NFT/fraction)")
ax.set_yscale("log")
ax.set_xlabel("Units issued to one holder")
ax.set_ylabel("Total gas (log)")
ax.set_title("Benchmark A: single-holder issuance", fontsize=9)
ax.legend(loc="center right")
save(fig, "figA_single_holder_gas.pdf")

# --------------------------------------------------------------- Benchmark B
inv = [10, 50, 100, 500]
tot1155 = [316100, 1481494, 2938456, 14692316]
tot20 = [300120, 1314752, 2583054, 12846906]
tot721 = [524722, 2436874, 4827076, 24067016]
per1155 = [t / n for t, n in zip(tot1155, inv)]
per20 = [t / n for t, n in zip(tot20, inv)]
per721 = [t / n for t, n in zip(tot721, inv)]

fig, ax = plt.subplots(figsize=(3.4, 2.5))
ax.plot(inv, per1155, "o-", color=C1155, ms=4, lw=1.3, label="ERC-1155")
ax.plot(inv, per20, "s--", color=C20, ms=4, lw=1.3, label="ERC-20")
ax.plot(inv, per721, "^-.", color=C721, ms=4, lw=1.3, label="ERC-721")
ax.set_ylim(0, 60000)
ax.set_xlabel("Number of investors (1 fraction each)")
ax.set_ylabel("Gas per investor")
ax.set_title("Benchmark B: per-investor distribution cost", fontsize=9)
ax.legend(loc="center right")
save(fig, "figB_per_investor_gas.pdf")

fig, ax = plt.subplots(figsize=(3.4, 2.5))
ax.plot(inv, [v / 1e6 for v in tot1155], "o-", color=C1155, ms=4, lw=1.3, label="ERC-1155")
ax.plot(inv, [v / 1e6 for v in tot20], "s--", color=C20, ms=4, lw=1.3, label="ERC-20")
ax.plot(inv, [v / 1e6 for v in tot721], "^-.", color=C721, ms=4, lw=1.3, label="ERC-721")
ax.set_xlabel("Number of investors")
ax.set_ylabel("Total distribution gas (millions)")
ax.set_title("Benchmark B: total multi-investor distribution gas", fontsize=9)
ax.legend(loc="upper left")
save(fig, "figB_total_distribution_gas.pdf")

# --------------------------------------------------------------- Benchmark C
P = [1, 10, 25, 50]
c1155 = [1667644, 4512544, 9254344, 17157144]
c20 = [1969209, 10737324, 25351554, 49708404]
c721 = [1708507, 4737997, 9787447, 18202997]

x = np.arange(len(P))
w = 0.26
fig, ax = plt.subplots(figsize=(3.4, 2.5))
ax.bar(x - w, [v / 1e6 for v in c1155], w, color=C1155, label="ERC-1155 (1 contract)")
ax.bar(x, [v / 1e6 for v in c20], w, color=C20, label="ERC-20 ($P$ contracts)")
ax.bar(x + w, [v / 1e6 for v in c721], w, color=C721, label="ERC-721 (1 contract)")
ax.set_xticks(x)
ax.set_xticklabels(P)
ax.set_xlabel("Number of properties")
ax.set_ylabel("Total gas (millions)")
ax.set_title("Benchmark C: multi-property catalogue cost", fontsize=9)
ax.legend(loc="upper left")
save(fig, "figC_multi_property_gas.pdf")

# --------------------------------------------------- Exp 7: local EVM throughput
loads = [5, 10, 25, 50, 100, 200, 500]
tps = [902.4, 1030.3, 1009.7, 1009.9, 920.8, 1008.5, 920.8]
sd = [202.9, 99.0, 41.4, 43.3, 79.2, 21.2, 34.7]

fig, ax = plt.subplots(figsize=(3.4, 2.5))
ax.errorbar(loads, tps, yerr=sd, fmt="o-", color=C1155, ms=4, lw=1.2,
            capsize=3, elinewidth=0.9, label="mean $\\pm$ SD (5 reps)")
ax.set_ylim(0, 1400)
ax.set_xlabel("Concurrent mint submissions (local EVM)")
ax.set_ylabel("Contract-execution throughput (tx/s)")
ax.set_title("Local EVM contract-execution throughput\n(NOT network TPS)", fontsize=8.5)
ax.legend(loc="lower right")
save(fig, "figX_local_evm_throughput.pdf")

# ------------------------------------------------- Exp 17: PostgreSQL behaviour
W = [1, 2, 5, 10, 25]
rc_t, rr_t, ser_t = [990, 597, 848, 1105, 1260], [1381, 709, 443, 432, 474], [1484, 684, 386, 375, 436]
rc_r, rr_r, ser_r = [0, 0, 0, 0, 0], [0, 0, 6.5, 27.5, 146], [0, 0, 7, 31, 167.5]

fig, ax = plt.subplots(figsize=(3.4, 2.5))
ax.plot(W, rc_t, "o-", color=C1155, ms=4, lw=1.3, label="READ COMMITTED")
ax.plot(W, rr_t, "s--", color=C20, ms=4, lw=1.3, label="REPEATABLE READ")
ax.plot(W, ser_t, "^-.", color=C721, ms=4, lw=1.3, label="SERIALIZABLE")
ax.set_xlabel("Concurrent workers")
ax.set_ylabel("Throughput (events/s)")
ax.set_title("PostgreSQL throughput vs concurrency by isolation level", fontsize=8.5)
ax.legend(loc="center right")
save(fig, "figX_pg_throughput.pdf")

fig, ax = plt.subplots(figsize=(3.4, 2.5))
ax.plot(W, rc_r, "o-", color=C1155, ms=4, lw=1.3, label="READ COMMITTED")
ax.plot(W, rr_r, "s--", color=C20, ms=4, lw=1.3, label="REPEATABLE READ")
ax.plot(W, ser_r, "^-.", color=C721, ms=4, lw=1.3, label="SERIALIZABLE")
ax.set_xlabel("Concurrent workers")
ax.set_ylabel("Serialization retries (handled)")
ax.set_title("PostgreSQL serialization retries vs concurrency", fontsize=8.5)
ax.legend(loc="upper left")
save(fig, "figX_pg_retries.pdf")

# --------------------------------------------- Exp 12: DB fault recovery times
# Two fault-injection runs are retained. The thesis and this paper report the run
# whose metrics are mean 45.9 ms / P95 179 ms, so the figure must be plotted from
# THAT run. Summary statistics are taken from the run's own metrics block rather
# than recomputed, because the harness computes P95 over the full scenario set
# while only a subset has a recovery phase; recomputing here would silently
# contradict the text.
PAPER_MEAN, PAPER_P95 = 45.9, 179

raw = sorted(glob.glob(os.path.join(REPO, "results", "database-faults", "raw", "*.json")))
chosen = None
for p in raw:
    m = json.load(open(p)).get("metrics", {})
    if m.get("meanRecoveryMs") == PAPER_MEAN and m.get("p95RecoveryMs") == PAPER_P95:
        chosen = p
        break
if chosen is None:
    raise SystemExit(
        f"no fault-injection run matches the reported metrics "
        f"(mean {PAPER_MEAN} ms, P95 {PAPER_P95} ms); refusing to plot a figure "
        f"that would contradict the paper"
    )

d = json.load(open(chosen))
metrics = d["metrics"]
pairs = []
for s in d.get("scenarios", []):
    for key in ("recoveryMs", "recovery_ms", "recoveryTimeMs", "durationMs"):
        if isinstance(s.get(key), (int, float)):
            pairs.append((s["no"], float(s[key])))
            break

labels = [f"#{n}" for n, _ in pairs]
vals = [v for _, v in pairs]
fig, ax = plt.subplots(figsize=(3.4, 2.5))
ax.bar(range(len(vals)), vals, color="#2ca02c", edgecolor="#1a661a", linewidth=0.5)
ax.set_xticks(range(len(labels)))
ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
ax.set_xlabel("Fault scenario")
ax.set_ylabel("Recovery time (ms)")
ax.set_title(
    f"DB fault recovery times "
    f"(mean {metrics['meanRecoveryMs']} ms, P95 {metrics['p95RecoveryMs']} ms)",
    fontsize=8.5)
save(fig, "figX_db_recovery_times.pdf")
print(f"  recovery: run={os.path.basename(chosen)} scenarios_with_recovery={len(vals)} "
      f"mean={metrics['meanRecoveryMs']} p95={metrics['p95RecoveryMs']}")

# ---------------------------------------------------------------------------
# Experiment 16: PostgreSQL per-scenario recovery times (reviewer request)
# ---------------------------------------------------------------------------
pg = sorted(glob.glob(os.path.join(REPO, "results", "postgres", "raw", "pg_faults_*.json")))
pgd = json.load(open(pg[-1]))
pairs = [(x["no"], float(x["recoveryMs"]))
         for x in pgd.get("scenarios", []) if isinstance(x.get("recoveryMs"), (int, float))]
if pairs:
    labels = [f"#{n}" for n, _ in pairs]
    vals = [v for _, v in pairs]
    mean = sum(vals) / len(vals)
    p95 = sorted(vals)[max(0, int(round(0.95 * len(vals))) - 1)]
    fig, ax = plt.subplots(figsize=(3.4, 2.5))
    ax.bar(range(len(vals)), vals, color="#1f77b4", edgecolor="#12496f", linewidth=0.5)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    ax.set_xlabel("PostgreSQL fault scenario")
    ax.set_ylabel("Recovery time (ms)")
    ax.set_title(f"PostgreSQL fault recovery times "
                 f"(mean {mean:.0f} ms, P95 {p95:.0f} ms)", fontsize=8.5)
    save(fig, "figX_pg_recovery_times.pdf")
    print(f"  pg recovery: n={len(vals)} mean={mean:.1f} p95={p95:.0f} max={max(vals):.0f}")
