/* ============================================================================
 * CLIMA-SHIELD  ·  Climate Adaptation Strategy Simulator
 * engine.js  —  The simulation / decision engine (NO DOM, fully testable)
 *
 * This module is the MANDATORY core of E-03. It implements, in pure logic:
 *   1. Multiple future scenarios
 *   2. Competing objectives + user weights
 *   3. Budget constraints (enforced in the engine, not the UI)
 *   4. Intervention strategy simulation (measurable parameters)
 *   5. Uncertainty quantification (seeded stochastic sampling)
 *   6. Sensitivity analysis (one-factor-at-a-time)
 *   7. Large-scale strategy exploration (generate -> filter -> evaluate -> rank)
 *   8. Reproducible comparisons (seed + full config captured by caller)
 *
 * Design choices (free per the problem statement):
 *   - Protection model: saturating "coverage"  p = 100*(1 - Π(1 - eff_i))
 *   - Scenario severity reduces realized score:  score = protection*(1 - k*severity)
 *   - Reproducibility via a seeded PRNG (mulberry32).
 * ==========================================================================*/

(function (global) {
  'use strict';

  /* ----------------------------- math helpers ---------------------------- */
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function round(x, d) { d = d == null ? 1 : d; var m = Math.pow(10, d); return Math.round(x * m) / m; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Deterministic PRNG so that identical seed + config => identical results.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function uniform(rng, lo, hi) { return lo + (hi - lo) * rng(); }

  function normalizeWeights(w) {
    w = w || { flood: 0.5, heat: 0.3, water: 0.2 };
    var s = (w.flood || 0) + (w.heat || 0) + (w.water || 0) || 1;
    return { flood: (w.flood || 0) / s, heat: (w.heat || 0) / s, water: (w.water || 0) / s };
  }

  /* ------------------------- intervention library ------------------------ */
  // Each intervention has measurable model parameters used by the engine.
  // eff values are 0..100 "effectiveness" ratings against each objective.
  var INTERVENTIONS = [
    { id: 'drainage',  name: 'Drainage Improvement',        short: 'DRN', cost: 40, flood: 90, heat: 15, water: 30, desc: 'Upgrade storm-water drainage to cut urban flooding.' },
    { id: 'floodbar',  name: 'Flood Barriers',              short: 'FLB', cost: 50, flood: 95, heat: 5,  water: 10, desc: 'Levees & movable barriers protecting low-lying zones.' },
    { id: 'trees',     name: 'Tree Plantation',             short: 'TRE', cost: 20, flood: 40, heat: 75, water: 45, desc: 'Urban afforestation for shade and infiltration.' },
    { id: 'waterstor', name: 'Water Storage',               short: 'WST', cost: 35, flood: 35, heat: 20, water: 90, desc: 'Reservoirs & tanks securing water supply.' },
    { id: 'rainharv',  name: 'Rainwater Harvesting',        short: 'RWH', cost: 25, flood: 45, heat: 25, water: 80, desc: 'Capture runoff for reuse and flood relief.' },
    { id: 'cooling',   name: 'Cooling Centres',             short: 'COO', cost: 15, flood: 5,  heat: 90, water: 5,  desc: 'Refuge spaces during heat waves.' },
    { id: 'green',     name: 'Urban Green Corridors',       short: 'UGC', cost: 30, flood: 35, heat: 70, water: 50, desc: 'Connected greenways for cooling & drainage.' },
    { id: 'heatinfra', name: 'Heat-Resistant Infrastructure', short: 'HRI', cost: 45, flood: 20, heat: 85, water: 15, desc: 'Reflective, ventilated, resilient structures.' },
    { id: 'ews',       name: 'Early Warning System',        short: 'EWS', cost: 18, flood: 60, heat: 40, water: 35, desc: 'Sensors & alerts reducing reaction time.' },
    { id: 'wetland',   name: 'Wetland Restoration',         short: 'WET', cost: 28, flood: 70, heat: 30, water: 65, desc: 'Natural buffers absorbing flood & storing water.' }
  ];

  var DEFAULT_SCENARIOS = [
    { id: 'mild',     name: 'Mild',     rainfall: 15, temp: 1.5, waterStress: 30, population: 10 },
    { id: 'moderate', name: 'Moderate', rainfall: 30, temp: 3.0, waterStress: 60, population: 12 },
    { id: 'severe',   name: 'Severe',   rainfall: 45, temp: 4.5, waterStress: 85, population: 14 }
  ];

  var DEFAULT_UNCERTAINTY = { rainfallRel: 0.15, tempRel: 0.15, waterRel: 0.15, effRel: 0.10, samples: 150 };

  /* ----------------------------- model core ------------------------------ */
  // Scenario -> per-objective severity (can exceed 1 under extreme stress;
  // the FINAL objective score is clamped to [0,100], not the severity itself,
  // so a "Severe" future still has headroom for sensitivity perturbations).
  function severity(scn) {
    var f = scn.rainfall / 50;
    var h = scn.temp / 6;
    var w = scn.waterStress / 100;
    var popFactor = 1 + clamp((scn.population || 10) - 10, 0, 40) / 100 * 0.25;
    return { flood: f * popFactor, heat: h * popFactor, water: w * popFactor };
  }

  // Combined protection (saturating coverage model) for a set of interventions.
  function protection(ids, libMap, effMul) {
    effMul = effMul == null ? 1 : effMul;
    var pf = 1, ph = 1, pw = 1;
    for (var i = 0; i < ids.length; i++) {
      var iv = libMap[ids[i]]; if (!iv) continue;
      pf *= (1 - clamp(iv.flood / 100 * effMul, 0, 1));
      ph *= (1 - clamp(iv.heat / 100 * effMul, 0, 1));
      pw *= (1 - clamp(iv.water / 100 * effMul, 0, 1));
    }
    return { flood: 100 * (1 - pf), heat: 100 * (1 - ph), water: 100 * (1 - pw) };
  }

  // Objective-weighted score for one scenario, after applying severity penalty.
  // Penalty is linear in severity and the FINAL score is clamped to [0,100],
  // so extreme futures (severity > 1) push scores toward zero realistically.
  function objectiveScore(prot, sev, weights) {
    var f = clamp(prot.flood * (1 - 0.45 * sev.flood), 0, 100);
    var h = clamp(prot.heat * (1 - 0.45 * sev.heat), 0, 100);
    var w = clamp(prot.water * (1 - 0.45 * sev.water), 0, 100);
    return weights.flood * f + weights.heat * h + weights.water * w;
  }

  // Evaluate a strategy across all scenarios (nominal effectiveness = 1).
  function evaluateStrategy(ids, scenarios, weights, libMap, effMul) {
    var prot = protection(ids, libMap, effMul);
    var per = scenarios.map(function (s) {
      var sev = severity(s);
      return {
        id: s.id, name: s.name,
        score: round(objectiveScore(prot, sev, weights)),
        flood: round(prot.flood * (1 - 0.45 * sev.flood)),
        heat: round(prot.heat * (1 - 0.45 * sev.heat)),
        water: round(prot.water * (1 - 0.45 * sev.water)),
        baseFlood: round(prot.flood), baseHeat: round(prot.heat), baseWater: round(prot.water)
      };
    });
    var scores = per.map(function (p) { return p.score; });
    var avg = scores.reduce(function (a, b) { return a + b; }, 0) / (scores.length || 1);
    return { perScenario: per, avg: round(avg), best: round(Math.max.apply(null, scores)), worst: round(Math.min.apply(null, scores)) };
  }

  function planName(idx, ids, libMap) {
    return 'Plan ' + (idx + 1) + ' · ' + ids.map(function (id) { return libMap[id].short; }).join('+');
  }

  /* ------------------- large-scale combination exploration ---------------- */
  // Generate every subset, prune by budget (branch & bound), evaluate.
  function explore(ids, libMap, budget) {
    var items = ids.map(function (id) { return libMap[id]; }).filter(Boolean).sort(function (a, b) { return a.cost - b.cost; });
    var feasible = [];
    var nodes = 0;
    // Hard cap to stay responsive; above this we switch to heuristic search.
    var total = Math.pow(2, items.length) - 1;
    if (items.length <= 16) {
      (function rec(i, chosen, cost) {
        nodes++;
        if (i === items.length) { if (chosen.length) feasible.push({ ids: chosen.slice(), cost: cost }); return; }
        var it = items[i];
        if (cost + it.cost <= budget) rec(i + 1, chosen.concat(it.id), cost + it.cost); // include
        rec(i + 1, chosen, cost); // exclude
      })(0, [], 0);
      return { feasible: feasible, nodes: nodes, total: total, method: 'full-enumeration' };
    }
    // Heuristic path (greedy + swap neighbourhood) for very large libraries.
    return heuristicSearch(items, budget, libMap);
  }

  function heuristicSearch(items, budget, libMap) {
    var nodes = 0;
    var best = [];
    function scoreOf(ids) { var p = protection(ids, libMap, 1); return p.flood * 0.33 + p.heat * 0.33 + p.water * 0.34; }
    // greedy by cost-efficiency
    var ranked = items.slice().sort(function (a, b) { return (b.flood + b.heat + b.water) / b.cost - (a.flood + a.heat + a.water) / a.cost; });
    var chosen = [], cost = 0;
    ranked.forEach(function (it) { if (cost + it.cost <= budget) { chosen.push(it.id); cost += it.cost; } });
    var bestScore = scoreOf(chosen);
    var improved = true;
    while (improved) {
      improved = false;
      for (var i = 0; i < items.length; i++) {
        for (var j = 0; j < chosen.length; j++) {
          nodes++;
          var trial = chosen.slice(); trial.splice(j, 1);
          if (trial.indexOf(items[i].id) === -1) trial.push(items[i].id);
          var tc = trial.reduce(function (a, id) { return a + libMap[id].cost; }, 0);
          if (tc <= budget) {
            var sc = scoreOf(trial);
            if (sc > bestScore + 1e-9) { bestScore = sc; chosen = trial; improved = true; }
          }
        }
      }
    }
    return { feasible: [{ ids: chosen, cost: cost }], nodes: nodes, total: Math.pow(2, items.length) - 1, method: 'heuristic-search' };
  }

  /* --------------------------- robustness score --------------------------- */
  // Project-defined metric: how consistently a plan performs (low variability).
  function robustnessFromCV(cv) {
    var score = round(clamp(100 * (1 - 2.0 * cv), 0, 100));
    var cat = cv < 0.05 ? 'ROBUST' : (cv < 0.10 ? 'MODERATE' : 'FRAGILE');
    return { score: score, category: cat, cv: round(cv, 3) };
  }

  /* ------------------------------ main run ------------------------------- */
  // config = { city, population, horizon, budget, availableInterventionIds,
  //            scenarios[], weights{}, uncertainty{}, seed, customPlan? }
  function runSimulation(config) {
    var lib = config.interventions || INTERVENTIONS;
    var libMap = {}; lib.forEach(function (iv) { libMap[iv.id] = iv; });
    var weights = normalizeWeights(config.weights);
    var avail = (config.availableInterventionIds && config.availableInterventionIds.length)
      ? config.availableInterventionIds : INTERVENTIONS.map(function (iv) { return iv.id; });
    var exp = explore(avail, libMap, config.budget);
    var u = config.uncertainty || DEFAULT_UNCERTAINTY;
    var samples = u.samples || 150;
    var rng = mulberry32(config.seed || 12345);

    var plans = exp.feasible.map(function (f, idx) {
      var ev = evaluateStrategy(f.ids, config.scenarios, weights, libMap, 1);
      var severe = ev.perScenario.filter(function (p) { return /severe/i.test(p.name); })[0];
      return {
        index: idx,
        name: planName(idx, f.ids, libMap),
        ids: f.ids,
        interventions: f.ids.map(function (id) { return libMap[id].name; }),
        short: f.ids.map(function (id) { return libMap[id].short; }).join('+'),
        cost: f.cost,
        budgetRemaining: round(config.budget - f.cost),
        perScenario: ev.perScenario,
        avg: ev.avg,
        bestScenario: ev.best,
        worstScenario: ev.worst,
        severeScore: severe ? severe.score : ev.worst
      };
    });

    // Uncertainty quantification: stochastic sampling for the top plans.
    var top = plans.slice().sort(function (a, b) { return b.avg - a.avg; }).slice(0, 20);
    top.forEach(function (plan) {
      var dist = [];
      for (var s = 0; s < samples; s++) {
        var scns = config.scenarios.map(function (sc) {
          return {
            id: sc.id, name: sc.name, population: sc.population,
            rainfall: sc.rainfall * (1 + uniform(rng, -u.rainfallRel, u.rainfallRel)),
            temp: sc.temp * (1 + uniform(rng, -u.tempRel, u.tempRel)),
            waterStress: sc.waterStress * (1 + uniform(rng, -u.waterRel, u.waterRel))
          };
        });
        var effM = 1 + uniform(rng, -u.effRel, u.effRel);
        dist.push(evaluateStrategy(plan.ids, scns, weights, libMap, effM).avg);
      }
      var mean = dist.reduce(function (a, b) { return a + b; }, 0) / dist.length;
      var mn = Math.min.apply(null, dist), mx = Math.max.apply(null, dist);
      var variance = dist.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / dist.length;
      var std = Math.sqrt(variance);
      plan.uncertainty = { avg: round(mean), min: round(mn), max: round(mx), std: round(std, 2), range: round(mx - mn), full: dist };
      plan.robustness = robustnessFromCV(mean > 0 ? std / mean : 1);
      plan.costEfficiency = round(plan.avg / plan.cost * 100, 1);
    });

    // All other plans get a scenario-spread robustness estimate (cheap).
    plans.forEach(function (p) {
      if (!p.uncertainty) {
        var sc = p.perScenario.map(function (x) { return x.score; });
        var mean = sc.reduce(function (a, b) { return a + b; }, 0) / sc.length;
        var sd = Math.sqrt(sc.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / sc.length);
        p.uncertainty = { avg: p.avg, min: round(Math.min.apply(null, sc)), max: round(Math.max.apply(null, sc)), std: round(sd, 2), range: round(Math.max.apply(null, sc) - Math.min.apply(null, sc)), note: 'scenario-spread estimate' };
        p.robustness = robustnessFromCV(mean > 0 ? sd / mean : 1);
        p.costEfficiency = round(p.avg / p.cost * 100, 1);
      }
    });

    plans.sort(function (a, b) { return b.avg - a.avg; });
    plans.forEach(function (p, i) { p.rank = i + 1; });

    var recommended = plans[0];
    // Recommendation categories
    var bySevere = plans.slice().sort(function (a, b) { return b.severeScore - a.severeScore; })[0];
    var byRobust = plans.slice().sort(function (a, b) {
      var ra = a.robustness.category === 'ROBUST' ? 2 : a.robustness.category === 'MODERATE' ? 1 : 0;
      var rb = b.robustness.category === 'ROBUST' ? 2 : b.robustness.category === 'MODERATE' ? 1 : 0;
      return (rb - ra) || (b.robustness.score - a.robustness.score);
    })[0];
    var byCost = plans.slice().sort(function (a, b) { return b.costEfficiency - a.costEfficiency; })[0];

    return {
      meta: {
        feasibleCount: exp.feasible.length,
        theoreticalCount: exp.total,
        evaluatedNodes: exp.nodes,
        method: exp.method,
        weights: weights,
        samples: samples
      },
      plans: plans,
      recommended: recommended,
      categories: { bestOverall: recommended, bestSevere: bySevere, mostRobust: byRobust, mostCostEfficient: byCost }
    };
  }

  /* --------------------------- sensitivity ------------------------------- */
  // One-factor-at-a-time: how much does the top plan's score move?
  function sensitivity(config, strategyIds) {
    var libMap = {}; INTERVENTIONS.forEach(function (iv) { libMap[iv.id] = iv; });
    var lib = config.interventions || INTERVENTIONS;
    var libMap = {}; lib.forEach(function (iv) { libMap[iv.id] = iv; });
    var base = runSimulation(config);
    var strat = strategyIds ? strategyIds : (base.recommended ? base.recommended.ids : null);
    var basePlan = strategyIds ? base.plans.filter(function (p) { return sameIds(p.ids, strategyIds); })[0] : base.recommended;
    var baseline = basePlan ? basePlan.avg : (base.recommended ? base.recommended.avg : 0);
    var weights = normalizeWeights(config.weights);

    function evalUnder(c) {
      if (c._reExplore) {
        var r = runSimulation(c);
        return r.recommended ? r.recommended.avg : 0;
      }
      return evaluateStrategy(strat, c.scenarios, normalizeWeights(c.weights || weights), libMap, c._effMul || 1).avg;
    }
    function perturb(kind) {
      var c = JSON.parse(JSON.stringify(config));
      if (kind === 'budget') { c.budget = round(c.budget * 0.8); c._reExplore = true; }
      if (kind === 'rainfall') c.scenarios.forEach(function (s) { s.rainfall *= 1.3; });
      if (kind === 'temp') c.scenarios.forEach(function (s) { s.temp += 1.0; });
      if (kind === 'waterStress') c.scenarios.forEach(function (s) { s.waterStress = clamp(s.waterStress * 1.2, 0, 120); });
      if (kind === 'population') c.scenarios.forEach(function (s) { s.population *= 1.4; });
      if (kind === 'effectiveness') c._effMul = 0.9;
      if (kind === 'weights') c.weights = { flood: 0.3, heat: 0.4, water: 0.3 };
      return c;
    }
    var defs = [
      { key: 'budget', label: 'Budget (−20%)' },
      { key: 'rainfall', label: 'Rainfall (+30%)' },
      { key: 'temp', label: 'Temperature (+1°C)' },
      { key: 'population', label: 'Population (+40%)' },
      { key: 'waterStress', label: 'Water stress (+20%)' },
      { key: 'effectiveness', label: 'Effectiveness (−10%)' },
      { key: 'weights', label: 'Objective weights shifted' }
    ];
    var out = defs.map(function (d) {
      var c = perturb(d.key);
      var ns = evalUnder(c);
      var impact = round(ns - baseline);
      var mag = Math.abs(impact);
      // Thresholds are expressed in score points (0-100 scale). The typical
      // impact range for this model is ~1-8 points, so we grade accordingly.
      var cls = mag >= 5 ? 'HIGH' : (mag >= 2.5 ? 'MEDIUM' : 'LOW');
      return { key: d.key, label: d.label, newScore: round(ns), impact: impact, classification: cls };
    });
    return { baseline: baseline, strategy: strat, tests: out };
  }

  /* --------------------------- stress test ------------------------------- */
  // "Try to break this plan": combine adverse shifts, decompose the drivers.
  function stressTest(config, strategyIds) {
    var lib = config.interventions || INTERVENTIONS;
    var libMap = {}; lib.forEach(function (iv) { libMap[iv.id] = iv; });
    var weights = normalizeWeights(config.weights);
    var base = evaluateStrategy(strategyIds, config.scenarios, weights, libMap, 1).avg;

    function shift(c, kind) {
      c = JSON.parse(JSON.stringify(c));
      if (kind === 'rainfall') c.scenarios.forEach(function (s) { s.rainfall *= 1.2; });
      if (kind === 'temp') c.scenarios.forEach(function (s) { s.temp += 1.0; });
      if (kind === 'waterStress') c.scenarios.forEach(function (s) { s.waterStress = clamp(s.waterStress * 1.15, 0, 120); });
      if (kind === 'population') c.scenarios.forEach(function (s) { s.population *= 1.25; });
      if (kind === 'effectiveness') c._effMul = 0.9;
      return c;
    }
    // Combined adverse future (budget stress handled separately for feasibility).
    var stressed = JSON.parse(JSON.stringify(config));
    stressed.scenarios.forEach(function (s) {
      s.rainfall *= 1.2; s.temp += 1.0; s.waterStress = clamp(s.waterStress * 1.15, 0, 120); s.population *= 1.25;
    });
    stressed._effMul = 0.9;
    var stressedBudget = round(config.budget * 0.85);
    var stressedScore = evaluateStrategy(strategyIds, stressed.scenarios, weights, libMap, stressed._effMul).avg;
    var planCost = strategyIds.reduce(function (a, id) { return a + libMap[id].cost; }, 0);
    var feasibleUnderStress = planCost <= stressedBudget;

    // Driver decomposition (each adverse factor alone).
    var drivers = [
      { key: 'rainfall', label: 'Higher rainfall' },
      { key: 'temp', label: 'Higher temperature' },
      { key: 'waterStress', label: 'Higher water stress' },
      { key: 'population', label: 'Higher population' },
      { key: 'effectiveness', label: 'Lower effectiveness' }
    ].map(function (d) {
      var c = shift(config, d.key);
      var sc = evaluateStrategy(strategyIds, c.scenarios, weights, libMap, c._effMul || 1).avg;
      return { label: d.label, impact: round(sc - base) };
    }).sort(function (a, b) { return a.impact - b.impact; });

    return {
      baseline: round(base),
      stressed: round(stressedScore),
      change: round(stressedScore - base),
      feasibleUnderStress: feasibleUnderStress,
      planCost: planCost,
      stressedBudget: stressedBudget,
      drivers: drivers,
      primaryDriver: drivers[0]
    };
  }

  function sameIds(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var sa = a.slice().sort(), sb = b.slice().sort();
    for (var i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
    return true;
  }

  /* ------------------------------ public API ------------------------------ */
  var API = {
    INTERVENTIONS: INTERVENTIONS,
    DEFAULT_SCENARIOS: DEFAULT_SCENARIOS,
    DEFAULT_UNCERTAINTY: DEFAULT_UNCERTAINTY,
    clamp: clamp, round: round, normalizeWeights: normalizeWeights,
    severity: severity, protection: protection, evaluateStrategy: evaluateStrategy,
    explore: explore, runSimulation: runSimulation, sensitivity: sensitivity, stressTest: stressTest,
    robustnessFromCV: robustnessFromCV, sameIds: sameIds, mulberry32: mulberry32
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.ClimaShield = API;
})(typeof window !== 'undefined' ? window : this);
