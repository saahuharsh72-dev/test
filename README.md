# CLIMA-SHIELD — Climate Adaptation Strategy Simulator (E-03)

A self-contained **simulation / decision engine** that explores many possible
climate-adaptation strategies, tests them across uncertain futures, respects
real-world budget constraints, and compares their trade-offs — reproducibly.

> No framework, no database, no build step. Pure logic in `engine.js`,
> presentation in `app.js`. Open `index.html` (or serve the folder).

## Run it

```bash
cd clima-shield
python3 -m http.server 8000 --bind 0.0.0.0
# open http://localhost:8000
```

## Mandatory E-03 requirements → where they live

| # | Requirement | Implementation |
|---|-------------|----------------|
| 1 | Multiple future scenarios | `engine.severity()` + `evaluateStrategy()` over `config.scenarios` (Mild / Moderate / Severe + custom) |
| 2 | Competing objectives + priorities | Flood / Heat / Water scores, user weights (`normalizeWeights`), combined decision score |
| 3 | Budget constraints (enforced in engine) | `explore()` prunes every combination whose cost > budget before evaluation |
| 4 | Intervention strategy simulation | `protection()` coverage model over measurable intervention parameters (cost, flood/heat/water eff) |
| 5 | Uncertainty quantification | Seeded Monte-Carlo sampling (`mulberry32`) → mean / best / worst / std / range |
| 6 | Sensitivity analysis | One-factor-at-a-time `sensitivity()` with HIGH/MEDIUM/LOW classification |
| 7 | Large-scale exploration | `explore()` generates all 2ⁿ subsets, branch-and-bound budget pruning, full enumeration up to 16 items then heuristic search |
| 8 | Reproducible comparisons | Full config (seed, model version, inputs) captured per run; stored in history; re-runnable |

## Differentiators (our additions, clearly labelled)

- **Strategy Stress Test — "Try to Break This Plan"** (`engine.stressTest`): applies adverse shifts (rainfall +20%, temp +1°C, water stress +15%, population +25%, effectiveness −10%, budget −15%) and decomposes which assumption hurt most.
- **Robustness Score** (project-defined): coefficient-of-variation based → ROBUST / MODERATE / FRAGILE.
- **What-If Laboratory**: interactive before/after sliders.
- **Explainable results**: sensitivity + stress drivers explain *why* a plan ranks where it does (engine numbers, not AI guesses).

## Model (implementation choices — free per spec)

- **Protection** (saturating coverage): `p = 100·(1 − Π(1 − effᵢ/100))`
- **Realised score** for an objective under a scenario:
  `score = clamp( protection · (1 − 0.45·severity), 0, 100 )`
  where `severity = rainfall/50 (flood), temp/6 (heat), waterStress/100 (water)`, scaled mildly by population.
- **Overall** per scenario = Σ objective-weight · score.
- **Uncertainty**: perturb scenario params & effectiveness within seeded ranges, resample N times.

## Files

- `engine.js` — the simulation/decision engine (no DOM, fully unit-testable).
- `app.js` — UI: config editors, dashboard, history, stress test, what-if, export.
- `styles.css` — theme.
- `index.html` — structure.

## Reproducibility

Every run records: Simulation ID, model version, random seed, timestamp, city,
budget, scenarios + params, objective weights, uncertainty params, available
interventions, and the full result. Re-running the identical configuration with
the same seed reproduces identical results. History is persisted in
`localStorage` and clickable to reload + re-run.
