/* ============================================================================
 * CLIMA-SHIELD · app.js
 * UI layer: reads configuration, calls the engine, renders the dashboard,
 * and handles reproducibility (history), stress test, what-if lab & export.
 * The engine (engine.js) produces ALL numerical results; this file only
 * presents them and reads inputs.
 * ==========================================================================*/
(function () {
  'use strict';
  var E = window.ClimaShield;
  var MODEL_VERSION = '1.0';

  /* ----------------------------- state ----------------------------------- */
  var state = {
    city: 'Nagpur', population: 24, horizon: 15, budget: 100, seed: 12345,
    interventions: E.INTERVENTIONS.map(function (i) { return Object.assign({ available: true }, i); }),
    scenarios: E.DEFAULT_SCENARIOS.map(function (s) { return Object.assign({}, s); }),
    weights: { flood: 50, heat: 30, water: 20 },
    uncertainty: { rainfallRel: 0.15, tempRel: 0.15, waterRel: 0.15, effRel: 0.10, samples: 150 },
    result: null, meta: null, selectedRank: 1, pinned: [],
    history: []
  };
  var HIST_KEY = 'climashield_history_v1';

  /* ----------------------------- helpers --------------------------------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fmt(n, d) { d = d == null ? 1 : d; return Number(n).toFixed(d); }
  function pill(cat) { return '<span class="pill ' + cat + '">' + cat + '</span>'; }

  function buildConfig() {
    var w = E.normalizeWeights({ flood: state.weights.flood, heat: state.weights.heat, water: state.weights.water });
    return {
      city: state.city, population: state.population, horizon: state.horizon,
      budget: state.budget, seed: state.seed,
      interventions: state.interventions.map(function (i) { return Object.assign({}, i); }),
      availableInterventionIds: state.interventions.filter(function (i) { return i.available; }).map(function (i) { return i.id; }),
      scenarios: clone(state.scenarios),
      weights: w,
      uncertainty: clone(state.uncertainty)
    };
  }

  /* --------------------------- config editors ---------------------------- */
  function renderScenarios() {
    var box = $('scenarioEditors'); box.innerHTML = '';
    state.scenarios.forEach(function (s, idx) {
      var d = el('div', 'scn');
      d.innerHTML =
        '<div class="scn-head"><span>🌐 Scenario</span>' +
        '<input data-i="' + idx + '" data-f="name" value="' + s.name + '"></div>' +
        '<div class="grid2">' +
        '<label>Rainfall +%<input type="number" data-i="' + idx + '" data-f="rainfall" value="' + s.rainfall + '"></label>' +
        '<label>Temp +°C<input type="number" step="0.1" data-i="' + idx + '" data-f="temp" value="' + s.temp + '"></label>' +
        '<label>Water stress<input type="number" data-i="' + idx + '" data-f="waterStress" value="' + s.waterStress + '"></label>' +
        '<label>Population (lakh)<input type="number" data-i="' + idx + '" data-f="population" value="' + s.population + '"></label>' +
        '</div>';
      if (state.scenarios.length > 1) {
        var del = el('button', 'mini-del', '🗑');
        del.title = 'Remove scenario';
        del.onclick = function () { state.scenarios.splice(idx, 1); renderScenarios(); };
        d.querySelector('.scn-head').appendChild(del);
      }
      box.appendChild(d);
    });
    box.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var i = +inp.dataset.i, f = inp.dataset.f;
        state.scenarios[i][f] = (f === 'name') ? inp.value : parseFloat(inp.value);
      });
    });
  }

  function renderInterventions() {
    var box = $('interventionEditors'); box.innerHTML = '';
    state.interventions.forEach(function (iv, idx) {
      var d = el('div', 'iv');
      d.innerHTML =
        '<div class="iv-head"><label style="display:flex;gap:8px;align-items:center;margin:0">' +
        '<input type="checkbox" class="chk" data-i="' + idx + '" ' + (iv.available ? 'checked' : '') + '>' +
        '<span class="nm">' + iv.name + '</span></label>' +
        '<span class="cost">₹' + iv.cost + ' Cr</span></div>' +
        '<p class="hint" style="margin:4px 0 0">' + iv.desc + '</p>' +
        '<div class="eff">' +
        '<label>Flood<input type="number" data-i="' + idx + '" data-f="cost" value="' + iv.cost + '"></label>' +
        '<label>Flood eff<input type="number" data-i="' + idx + '" data-f="flood" value="' + iv.flood + '"></label>' +
        '<label>Heat eff<input type="number" data-i="' + idx + '" data-f="heat" value="' + iv.heat + '"></label>' +
        '<label>Water eff<input type="number" data-i="' + idx + '" data-f="water" value="' + iv.water + '"></label>' +
        '</div>';
      // keep checkbox + cost label in sync
      d.querySelector('.chk').addEventListener('change', function (e) {
        state.interventions[idx].available = e.target.checked;
      });
      d.querySelectorAll('.eff input').forEach(function (inp) {
        inp.addEventListener('input', function () {
          var f = inp.dataset.f;
          state.interventions[idx][f] = parseFloat(inp.value) || 0;
          if (f === 'cost') d.querySelector('.cost').textContent = '₹' + state.interventions[idx].cost + ' Cr';
        });
      });
      box.appendChild(d);
    });
  }

  function syncWeightLabels() {
    $('wFloodVal').textContent = state.weights.flood + '%';
    $('wHeatVal').textContent = state.weights.heat + '%';
    $('wWaterVal').textContent = state.weights.water + '%';
  }
  function syncUncLabels() {
    $('uRainVal').textContent = Math.round(state.uncertainty.rainfallRel * 100) + '%';
    $('uTempVal').textContent = Math.round(state.uncertainty.tempRel * 100) + '%';
    $('uWaterVal').textContent = Math.round(state.uncertainty.waterRel * 100) + '%';
    $('uEffVal').textContent = Math.round(state.uncertainty.effRel * 100) + '%';
  }

  /* ------------------------------ run ------------------------------------ */
  function runSimulation() {
    var config = buildConfig();
    var res = E.runSimulation(config);
    var simId = nextSimId();
    state.meta = {
      simId: simId, ts: new Date().toISOString(), modelVersion: MODEL_VERSION,
      seed: config.seed, config: config
    };
    state.result = res;
    state.selectedRank = res.recommended.rank;
    state.pinned = res.plans.slice(0, 3).map(function (p) { return p.short; });
    saveHistory(simId, res, config);
    $('simId').textContent = simId;
    $('simSeed').textContent = 'seed ' + config.seed;
    $('emptyState').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    renderDashboard();
  }

  function nextSimId() {
    var n = parseInt(localStorage.getItem('climashield_counter') || '1041', 10) + 1;
    localStorage.setItem('climashield_counter', n);
    return 'SIM-' + n;
  }

  /* --------------------------- dashboard --------------------------------- */
  function getPlan(rank) {
    return state.result.plans.filter(function (p) { return p.rank === rank; })[0];
  }

  function renderDashboard() {
    var res = state.result, m = state.meta;
    var r = res.recommended;
    var html = '';

    /* summary stats */
    html += '<div class="card"><h3>📊 Simulation Summary <span class="tag">' + m.simId + '</span> <span class="tag">' + res.meta.method + '</span></h3>';
    html += '<div class="stat-row">';
    html += stat('Strategies explored', res.meta.theoreticalCount.toLocaleString(), 'theoretical 2^n−1');
    html += stat('Feasible (within budget)', res.meta.feasibleCount, 'after budget filter');
    html += stat('Recommended avg', fmt(r.avg), 'overall score');
    html += stat('MC samples', res.meta.samples, 'uncertainty');
    html += stat('Model version', MODEL_VERSION, '');
    html += '</div></div>';

    /* recommendation categories */
    html += '<div class="card"><h3>🏆 Recommendation Categories</h3><div class="stat-row">';
    html += catCard('Best Overall', res.categories.bestOverall);
    html += catCard('Best for Severe', res.categories.bestSevere);
    html += catCard('Most Robust', res.categories.mostRobust);
    html += catCard('Most Cost-Efficient', res.categories.mostCostEfficient);
    html += '</div></div>';

    /* ranking table */
    html += '<div class="card"><h3>📈 Strategy Ranking &amp; Comparison <span class="tag">click a row to inspect · pin up to 3</span></h3>';
    html += '<div class="tray" id="tray"></div>';
    html += '<div style="overflow:auto;max-height:420px"><table id="rankTable"><thead><tr>' +
      '<th>#</th><th>Strategy</th><th>Cost</th><th>Budget left</th><th>Avg</th><th>Worst</th><th>Severe</th><th>Robust.</th><th>₹-eff</th><th>Pin</th></tr></thead><tbody>';
    res.plans.slice(0, 40).forEach(function (p) {
      html += '<tr data-rank="' + p.rank + '" class="' + (p.rank === state.selectedRank ? 'sel' : '') + '">' +
        '<td><span class="rank-badge">' + p.rank + '</span></td>' +
        '<td>' + p.name + '<br><small style="color:var(--muted)">' + p.interventions.join(', ') + '</small></td>' +
        '<td>₹' + p.cost + '</td><td>₹' + p.budgetRemaining + '</td>' +
        '<td><b>' + fmt(p.avg) + '</b></td><td>' + fmt(p.worstScenario) + '</td><td>' + fmt(p.severeScore) + '</td>' +
        '<td>' + pill(p.robustness.category) + '</td><td>' + fmt(p.costEfficiency) + '</td>' +
        '<td><input type="checkbox" class="pin" data-short="' + p.short + '" ' + (state.pinned.indexOf(p.short) >= 0 ? 'checked' : '') + '></td></tr>';
    });
    html += '</tbody></table></div></div>';

    /* comparison matrix of pinned plans */
    html += renderComparison();

    /* selected plan detail */
    html += renderPlanDetail(getPlan(state.selectedRank));

    /* sensitivity analysis */
    html += renderSensitivity();

    /* stress test */
    html += renderStressTest();

    /* what-if lab */
    html += renderWhatIf();

    /* reproducibility / config */
    html += renderConfigSummary();

    /* exports */
    html += '<div class="card"><h3>⬇ Export &amp; Reproducibility</h3><div class="btnrow">' +
      '<button class="btn tiny" id="expJson">Export full report (JSON)</button>' +
      '<button class="btn tiny" id="expCsv">Export ranking (CSV)</button>' +
      '<button class="btn tiny" id="expCfg">Export configuration (JSON)</button>' +
      '<button class="btn tiny" id="copyCfg">Copy reproducible command</button>' +
      '</div><p class="hint">Re-running this exact configuration with the same seed reproduces identical results.</p></div>';

    $('dashboard').innerHTML = html;
    wireDashboard();
  }

  function stat(k, v, sub) { return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + (sub ? ' <small>' + sub + '</small>' : '') + '</div></div>'; }
  function catCard(title, p) {
    if (!p) return '';
    return '<div class="stat"><div class="k">' + title + '</div><div class="v" style="font-size:15px">' + p.name + '</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:4px">avg ' + fmt(p.avg) + ' · cost ₹' + p.cost + ' · ' + pill(p.robustness.category) + '</div></div>';
  }

  /* ---------------- comparison matrix (pinned plans) -------------------- */
  function renderComparison() {
    var res = state.result;
    var plans = state.pinned.map(function (sh) { return res.plans.filter(function (p) { return p.short === sh; })[0]; }).filter(Boolean);
    if (!plans.length) return '<div class="card"><h3>🔍 Comparison Tray</h3><p class="hint">Pin plans using the checkboxes in the ranking table to compare them side-by-side.</p></div>';
    var scnNames = state.scenarios.map(function (s) { return s.name; });
    var h = '<div class="card"><h3>🔍 Strategy Comparison Matrix</h3><div style="overflow:auto"><table><thead><tr><th>Metric</th>';
    plans.forEach(function (p) { h += '<th>' + p.name + '</th>'; });
    h += '</tr></thead><tbody>';
    function row(label, fn) { h += '<tr><td>' + label + '</td>'; plans.forEach(function (p) { h += '<td>' + fn(p) + '</td>'; }); h += '</tr>'; }
    row('Total cost', function (p) { return '₹' + p.cost + ' Cr'; });
    row('Budget remaining', function (p) { return '₹' + p.budgetRemaining + ' Cr'; });
    row('Overall performance (avg)', function (p) { return '<b>' + fmt(p.avg) + '</b>'; });
    state.scenarios.forEach(function (s, i) {
      row(s.name + ' scenario', function (p) { return fmt(p.perScenario[i].score); });
    });
    row('Flood score (avg of scenarios)', function (p) { var a = p.perScenario.reduce(function (x, q) { return x + q.flood; }, 0) / p.perScenario.length; return fmt(a); });
    row('Heat score (avg of scenarios)', function (p) { var a = p.perScenario.reduce(function (x, q) { return x + q.heat; }, 0) / p.perScenario.length; return fmt(a); });
    row('Water score (avg of scenarios)', function (p) { var a = p.perScenario.reduce(function (x, q) { return x + q.water; }, 0) / p.perScenario.length; return fmt(a); });
    row('Best-case (scenario)', function (p) { return fmt(p.bestScenario); });
    row('Worst-case (scenario)', function (p) { return fmt(p.worstScenario); });
    row('Uncertainty avg ± std', function (p) { return fmt(p.uncertainty.avg) + ' ± ' + fmt(p.uncertainty.std, 1); });
    row('Uncertainty range', function (p) { return fmt(p.uncertainty.min) + '–' + fmt(p.uncertainty.max); });
    row('Robustness', function (p) { return pill(p.robustness.category) + ' (' + p.robustness.score + ')'; });
    row('Cost-efficiency', function (p) { return fmt(p.costEfficiency); });
    h += '</tbody></table></div></div>';
    return h;
  }

  /* ----------------------- selected plan detail -------------------------- */
  function renderPlanDetail(p) {
    if (!p) return '';
    var scnNames = state.scenarios.map(function (s) { return s.name; });
    var h = '<div class="card"><h3>🎯 Selected Strategy — ' + p.name + '</h3>';
    h += '<div class="stat-row">';
    h += stat('Total cost', '₹' + p.cost + ' Cr', 'of ₹' + state.budget);
    h += stat('Budget remaining', '₹' + p.budgetRemaining + ' Cr', p.budgetRemaining >= 0 ? '' : 'OVER BUDGET');
    h += stat('Overall (avg)', fmt(p.avg), 'across scenarios');
    h += stat('Best-case', fmt(p.bestScenario), 'scenario');
    h += stat('Worst-case', fmt(p.worstScenario), 'scenario');
    h += stat('Robustness', p.robustness.category, 'score ' + p.robustness.score);
    h += '</div>';

    /* per-objective grouped bars per scenario */
    h += '<h3 style="margin-top:14px;font-size:12px;color:var(--muted)">Per-objective realised score by scenario</h3>';
    h += '<div class="bars">';
    p.perScenario.forEach(function (sc, i) {
      h += '<div class="bar-col"><div class="bar" style="height:' + sc.flood + '%;background:linear-gradient(180deg,#7db0ff,#4f8cff)"><span class="lbl">' + fmt(sc.flood, 0) + '</span></div><div class="bar-cap" style="color:var(--flood)">F</div></div>';
      h += '<div class="bar-col"><div class="bar" style="height:' + sc.heat + '%;background:linear-gradient(180deg,#ffb38a,#ff8a5b)"><span class="lbl">' + fmt(sc.heat, 0) + '</span></div><div class="bar-cap" style="color:var(--heat)">H</div></div>';
      h += '<div class="bar-col"><div class="bar" style="height:' + sc.water + '%;background:linear-gradient(180deg,#7fe3ec,#36c5d1)"><span class="lbl">' + fmt(sc.water, 0) + '</span></div><div class="bar-cap" style="color:var(--water)">W</div></div>';
      h += '<div class="bar-col" style="justify-content:flex-end"><div class="bar-cap" style="color:var(--text);font-weight:700;margin-bottom:6px">' + sc.name + '</div><div class="bar-cap">Σ ' + fmt(sc.score) + '</div></div>';
    });
    h += '</div>';
    h += '<div class="legend">' +
      '<span><i class="dot" style="background:var(--flood)"></i> Flood</span>' +
      '<span><i class="dot" style="background:var(--heat)"></i> Heat</span>' +
      '<span><i class="dot" style="background:var(--water)"></i> Water</span>' +
      '<span>Bar height = realised score (0–100) after scenario severity</span></div>';

    /* uncertainty */
    h += '<div class="detail-grid" style="margin-top:14px"><div>';
    h += '<h3 style="font-size:12px;color:var(--muted)">Uncertainty quantification</h3>';
    h += '<div class="stat-row">';
    h += stat('Mean', fmt(p.uncertainty.avg), 'over ' + state.meta.samples + ' samples');
    h += stat('Best-case', fmt(p.uncertainty.max), 'max sample');
    h += stat('Worst-case', fmt(p.uncertainty.min), 'min sample');
    h += stat('Std-dev', fmt(p.uncertainty.std, 1), 'variability');
    h += stat('Range', fmt(p.uncertainty.range), 'max−min');
    h += '</div></div>';
    /* robustness gauge */
    h += '<div><h3 style="font-size:12px;color:var(--muted)">Robustness score (project metric)</h3>';
    h += '<div class="stat-row">';
    h += stat('Category', p.robustness.category, 'CV ' + p.robustness.cv);
    h += stat('Score', p.robustness.score, '/100');
    h += stat('Cost-efficiency', fmt(p.costEfficiency), 'avg per ₹Cr');
    h += '</div></div></div>';

    h += '<p class="hint" style="margin-top:10px"><b>Interventions in this strategy:</b> ' + p.interventions.join(', ') + '</p>';
    h += '</div>';
    return h;
  }

  /* --------------------------- sensitivity ------------------------------- */
  function renderSensitivity() {
    var p = getPlan(state.selectedRank);
    var s = E.sensitivity(buildConfig(), p.ids);
    var h = '<div class="card"><h3>🧪 Sensitivity Analysis <span class="tag">one-factor-at-a-time on ' + p.name + '</span></h3>';
    h += '<p class="hint">Baseline overall score: <b>' + fmt(s.baseline) + '</b>. Each bar shows the change when one assumption is perturbed. ' + pill(s.tests.filter(function (t) { return t.classification === 'HIGH'; }).length ? 'HIGH' : 'LOW') + ' sensitivity = largest impact.</p>';
    s.tests.forEach(function (t) {
      var mag = Math.abs(t.impact);
      var w = Math.min(100, mag / 8 * 100);
      var color = t.classification === 'HIGH' ? 'var(--bad)' : t.classification === 'MEDIUM' ? 'var(--warn)' : 'var(--good)';
      var sign = t.impact > 0 ? '+' : '';
      h += '<div class="sens-bar"><div class="nm">' + t.label + '</div>' +
        '<div class="track"><div class="fill" style="width:' + w + '%;background:' + color + '"></div></div>' +
        '<div class="imp" style="color:' + color + '">' + sign + fmt(t.impact) + '</div>' +
        '<div style="width:70px">' + pill(t.classification) + '</div></div>';
    });
    h += '</div>';
    return h;
  }

  /* --------------------------- stress test ------------------------------- */
  function renderStressTest() {
    var p = getPlan(state.selectedRank);
    var st = E.stressTest(buildConfig(), p.ids);
    var h = '<div class="card"><h3>💥 Strategy Stress Test <span class="tag">our differentiator · "Try to Break This Plan"</span></h3>';
    h += '<div class="btnrow"><button class="btn primary" id="breakBtn">💥 Try to Break This Plan</button>' +
      '<span class="hint" style="align-self:center">Applies: rainfall +20%, temp +1°C, water stress +15%, population +25%, effectiveness −10%, budget −15%.</span></div>';
    h += '<div id="stressOut">' + stressOutHtml(st) + '</div>';
    h += '</div>';
    return h;
  }
  function stressOutHtml(st) {
    var color = st.change < -5 ? 'var(--bad)' : st.change < -2 ? 'var(--warn)' : 'var(--good)';
    var h = '<div class="stat-row">';
    h += stat('Normal performance', fmt(st.baseline), '');
    h += stat('Stressed performance', fmt(st.stressed), 'adverse future');
    h += stat('Change', (st.change > 0 ? '+' : '') + fmt(st.change), 'impact');
    h += stat('Feasible under stress?', st.feasibleUnderStress ? 'YES' : 'NO',
      st.feasibleUnderStress ? '' : 'cost ₹' + st.planCost + ' > stressed budget ₹' + st.stressedBudget);
    h += '</div>';
    h += '<h3 style="font-size:12px;color:var(--muted);margin-top:12px">Which assumption hurt most?</h3>';
    h += '<div class="sens-bar"><div class="nm">Primary driver</div><div class="track"><div class="fill" style="width:100%;background:var(--bad)"></div></div>' +
      '<div class="imp" style="color:var(--bad)">' + st.primaryDriver.label + ' (' + fmt(st.primaryDriver.impact) + ')</div></div>';
    st.drivers.forEach(function (d) {
      var mag = Math.abs(d.impact); var w = Math.min(100, mag / 5 * 100);
      h += '<div class="sens-bar"><div class="nm">' + d.label + '</div><div class="track"><div class="fill" style="width:' + w + '%;background:var(--warn)"></div></div>' +
        '<div class="imp">' + fmt(d.impact) + '</div></div>';
    });
    return h;
  }

  /* --------------------------- what-if lab ------------------------------- */
  function renderWhatIf() {
    var p = getPlan(state.selectedRank);
    var h = '<div class="card"><h3>🔬 What-If Laboratory <span class="tag">interactive before/after</span></h3>';
    h += '<div class="detail-grid"><div>';
    h += '<label>Budget multiplier <span class="wval" id="wiBudVal">1.0×</span><input type="range" id="wiBud" min="0.5" max="1.5" step="0.05" value="1"></label>';
    h += '<label>Rainfall multiplier <span class="wval" id="wiRainVal">1.0×</span><input type="range" id="wiRain" min="0.5" max="1.8" step="0.05" value="1"></label>';
    h += '<label>Temperature add (°C) <span class="wval" id="wiTempVal">+0</span><input type="range" id="wiTemp" min="0" max="4" step="0.5" value="0"></label>';
    h += '</div><div>';
    h += '<label>Population multiplier <span class="wval" id="wiPopVal">1.0×</span><input type="range" id="wiPop" min="0.5" max="2" step="0.05" value="1"></label>';
    h += '<label>Water stress multiplier <span class="wval" id="wiWatVal">1.0×</span><input type="range" id="wiWat" min="0.5" max="1.8" step="0.05" value="1"></label>';
    h += '<label>Effectiveness multiplier <span class="wval" id="wiEffVal">1.0×</span><input type="range" id="wiEff" min="0.6" max="1.2" step="0.05" value="1"></label>';
    h += '</div></div>';
    h += '<div class="btnrow"><button class="btn primary" id="wiCompare">⚖ Compare</button></div>';
    h += '<div id="wiOut"><p class="hint">Adjust the sliders, then press Compare to see how ' + p.name + ' performs BEFORE vs AFTER.</p></div>';
    h += '</div>';
    return h;
  }

  /* ----------------------- reproducibility summary ----------------------- */
  function renderConfigSummary() {
    var c = state.meta.config;
    var h = '<div class="card"><h3>🧾 Simulation Configuration &amp; Reproducibility</h3>';
    h += '<div class="cfg-summary">';
    h += 'Simulation ID: <code>' + state.meta.simId + '</code> &nbsp;|&nbsp; Model version: <code>' + state.meta.modelVersion + '</code> &nbsp;|&nbsp; Seed: <code>' + state.meta.seed + '</code><br>';
    h += 'Timestamp: <code>' + state.meta.ts + '</code><br>';
    h += 'City: <code>' + c.city + '</code> &nbsp;|&nbsp; Population: <code>' + c.population + ' lakh</code> &nbsp;|&nbsp; Horizon: <code>' + c.horizon + ' yrs</code><br>';
    h += 'Budget: <code>₹' + c.budget + ' Cr</code><br>';
    h += 'Objective weights: Flood <code>' + Math.round(c.weights.flood * 100) + '%</code>, Heat <code>' + Math.round(c.weights.heat * 100) + '%</code>, Water <code>' + Math.round(c.weights.water * 100) + '%</code><br>';
    h += 'Uncertainty: rainfall ±<code>' + Math.round(c.uncertainty.rainfallRel * 100) + '%</code>, temp ±<code>' + Math.round(c.uncertainty.tempRel * 100) + '%</code>, water ±<code>' + Math.round(c.uncertainty.waterRel * 100) + '%</code>, eff ±<code>' + Math.round(c.uncertainty.effRel * 100) + '%</code>, samples <code>' + c.uncertainty.samples + '</code><br>';
    h += 'Scenarios: ' + c.scenarios.map(function (s) { return s.name + ' (rain ' + s.rainfall + '%, temp ' + s.temp + '°C, ws ' + s.waterStress + ', pop ' + s.population + ')'; }).join(' · ') + '<br>';
    h += 'Available interventions: <code>' + c.availableInterventionIds.length + '</code> of ' + c.interventions.length + '<br>';
    h += 'Explored: <code>' + state.result.meta.theoreticalCount + '</code> theoretical combinations → <code>' + state.result.meta.feasibleCount + '</code> feasible (' + state.result.meta.method + ').';
    h += '</div></div>';
    return h;
  }

  /* --------------------------- wiring ------------------------------------ */
  function wireDashboard() {
    // ranking row select
    $('rankTable').querySelectorAll('tbody tr').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.classList.contains('pin')) return;
        state.selectedRank = +tr.dataset.rank;
        renderDashboard();
      });
    });
    // pins
    $('rankTable').querySelectorAll('.pin').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var sh = cb.dataset.short;
        if (cb.checked) { if (state.pinned.indexOf(sh) < 0) state.pinned.push(sh); }
        else { state.pinned = state.pinned.filter(function (x) { return x !== sh; }); }
        renderDashboard();
      });
    });
    // stress test
    $('breakBtn').addEventListener('click', function () {
      var p = getPlan(state.selectedRank);
      var st = E.stressTest(buildConfig(), p.ids);
      $('stressOut').innerHTML = stressOutHtml(st);
    });
    // what-if
    var sliders = ['wiBud', 'wiRain', 'wiTemp', 'wiPop', 'wiWat', 'wiEff'];
    sliders.forEach(function (id) {
      $(id).addEventListener('input', function () {
        $('wiBudVal').textContent = fmt($('wiBud').value, 2) + '×';
        $('wiRainVal').textContent = fmt($('wiRain').value, 2) + '×';
        $('wiTempVal').textContent = '+' + fmt($('wiTemp').value, 1);
        $('wiPopVal').textContent = fmt($('wiPop').value, 2) + '×';
        $('wiWatVal').textContent = fmt($('wiWat').value, 2) + '×';
        $('wiEffVal').textContent = fmt($('wiEff').value, 2) + '×';
      });
    });
    $('wiCompare').addEventListener('click', function () {
      var p = getPlan(state.selectedRank);
      var c = buildConfig();
      var libMap = {}; c.interventions.forEach(function (i) { libMap[i.id] = i; });
      var w = c.weights;
      var before = E.evaluateStrategy(p.ids, c.scenarios, w, libMap, 1).avg;
      var scns = c.scenarios.map(function (s) {
        return {
          id: s.id, name: s.name, population: 10,
          rainfall: s.rainfall * parseFloat($('wiRain').value),
          temp: s.temp + parseFloat($('wiTemp').value),
          waterStress: s.waterStress * parseFloat($('wiWat').value)
        };
      });
      // population multiplier applied via scenario.population
      scns.forEach(function (s, i) { s.population = c.scenarios[i].population * parseFloat($('wiPop').value); });
      var after = E.evaluateStrategy(p.ids, scns, w, libMap, parseFloat($('wiEff').value)).avg;
      var budgetAfter = state.budget * parseFloat($('wiBud').value);
      var feasible = p.cost <= budgetAfter;
      var h = '<div class="stat-row">';
      h += stat('BEFORE (avg)', fmt(before), '');
      h += stat('AFTER (avg)', fmt(after), '');
      h += stat('Δ performance', (after - before > 0 ? '+' : '') + fmt(after - before), 'impact');
      h += stat('Budget after', '₹' + fmt(budgetAfter, 0) + ' Cr', feasible ? 'plan feasible' : 'plan INFEASIBLE (₹' + p.cost + ')');
      h += '</div>';
      $('wiOut').innerHTML = h;
    });
    // exports
    $('expJson').onclick = function () { download(state.meta.simId + '_report.json', JSON.stringify({ meta: state.meta, result: state.result }, null, 2), 'application/json'); };
    $('expCsv').onclick = function () { download(state.meta.simId + '_ranking.csv', rankingCSV(), 'text/csv'); };
    $('expCfg').onclick = function () { download(state.meta.simId + '_config.json', JSON.stringify(state.meta.config, null, 2), 'application/json'); };
    $('copyCfg').onclick = function () {
      var cmd = 'clima-shield run --seed ' + state.meta.seed + ' --budget ' + state.meta.config.budget + ' --weights ' +
        Math.round(state.meta.config.weights.flood * 100) + '/' + Math.round(state.meta.config.weights.heat * 100) + '/' + Math.round(state.meta.config.weights.water * 100);
      navigator.clipboard && navigator.clipboard.writeText(cmd);
      $('copyCfg').textContent = 'Copied!'; setTimeout(function () { $('copyCfg').textContent = 'Copy reproducible command'; }, 1500);
    };
  }

  function rankingCSV() {
    var rows = [['rank', 'strategy', 'interventions', 'cost', 'budgetRemaining', 'avg', 'worst', 'severe', 'robustness', 'costEfficiency', 'uncMin', 'uncMax', 'uncStd']];
    state.result.plans.forEach(function (p) {
      rows.push([p.rank, p.name, p.interventions.join(';'), p.cost, p.budgetRemaining, p.avg, p.worstScenario, p.severeScore, p.robustness.category, p.costEfficiency, p.uncertainty.min, p.uncertainty.max, p.uncertainty.std]);
    });
    return rows.map(function (r) { return r.join(','); }).join('\n');
  }

  function download(name, text, type) {
    var b = new Blob([text], { type: type }); var u = URL.createObjectURL(b);
    var a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(u);
  }

  /* ----------------------------- history --------------------------------- */
  function saveHistory(simId, res, config) {
    state.history.unshift({
      simId: simId, ts: state.meta.ts, seed: config.seed, budget: config.budget,
      recommended: res.recommended.name, avg: res.recommended.avg,
      feasible: res.meta.feasibleCount, config: config
    });
    if (state.history.length > 30) state.history.length = 30;
    localStorage.setItem(HIST_KEY, JSON.stringify(state.history));
    renderHistory();
  }
  function renderHistory() {
    var box = $('historyList'); if (!box) return; box.innerHTML = '';
    if (!state.history.length) { box.innerHTML = '<p class="hint">No simulations yet.</p>'; return; }
    state.history.forEach(function (h) {
      var d = el('div', 'hist-item');
      d.innerHTML = '<div class="t">' + h.simId + '</div><div class="m">' + new Date(h.ts).toLocaleString() +
        '<br>seed ' + h.seed + ' · budget ₹' + h.budget + ' · ' + h.feasible + ' feasible<br>best: ' + h.recommended + ' (' + fmt(h.avg) + ')</div>';
      d.onclick = function () { loadConfig(h.config); runSimulation(); };
      box.appendChild(d);
    });
  }
  function loadConfig(cfg) {
    state.city = cfg.city; state.population = cfg_value(cfg, 'population', 24); state.horizon = cfg.horizon;
    state.budget = cfg.budget; state.seed = cfg.seed;
    state.interventions = cfg.interventions.map(function (i) { return Object.assign({ available: true }, i); });
    // mark availability from availableInterventionIds
    state.interventions.forEach(function (iv) { iv.available = cfg.availableInterventionIds.indexOf(iv.id) >= 0; });
    state.scenarios = clone(cfg.scenarios);
    state.weights = { flood: Math.round(cfg.weights.flood * 100), heat: Math.round(cfg.weights.heat * 100), water: Math.round(cfg.weights.water * 100) };
    state.uncertainty = clone(cfg.uncertainty);
    syncInputs(); renderScenarios(); renderInterventions(); syncWeightLabels(); syncUncLabels();
  }
  function cfg_value(cfg, k, def) { return cfg[k] == null ? def : cfg[k]; }
  function syncInputs() {
    $('city').value = state.city; $('population').value = state.population; $('horizon').value = state.horizon;
    $('budget').value = state.budget; $('seed').value = state.seed;
    $('wFlood').value = state.weights.flood; $('wHeat').value = state.weights.heat; $('wWater').value = state.weights.water;
    $('uRain').value = Math.round(state.uncertainty.rainfallRel * 100);
    $('uTemp').value = Math.round(state.uncertainty.tempRel * 100);
    $('uWater').value = Math.round(state.uncertainty.waterRel * 100);
    $('uEff').value = Math.round(state.uncertainty.effRel * 100);
    $('uSamples').value = state.uncertainty.samples;
  }

  /* ------------------------------ init ----------------------------------- */
  function init() {
    try { state.history = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { state.history = []; }
    renderScenarios(); renderInterventions(); syncWeightLabels(); syncUncLabels(); renderHistory();

    $('city').addEventListener('input', function () { state.city = this.value; });
    $('population').addEventListener('input', function () { state.population = +this.value; });
    $('horizon').addEventListener('input', function () { state.horizon = +this.value; });
    $('budget').addEventListener('input', function () { state.budget = +this.value; });
    $('seed').addEventListener('input', function () { state.seed = +this.value; });

    ['wFlood', 'wHeat', 'wWater'].forEach(function (id, i) {
      $(id).addEventListener('input', function () {
        state.weights[id.slice(1).toLowerCase()] = +this.value; syncWeightLabels();
      });
    });
    ['uRain', 'uTemp', 'uWater', 'uEff'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        var key = { uRain: 'rainfallRel', uTemp: 'tempRel', uWater: 'waterRel', uEff: 'effRel' }[id];
        state.uncertainty[key] = (+this.value) / 100; syncUncLabels();
      });
    });
    $('uSamples').addEventListener('input', function () { state.uncertainty.samples = +this.value; });

    $('addScenarioBtn').addEventListener('click', function () {
      state.scenarios.push({ id: 'custom' + state.scenarios.length, name: 'Custom ' + (state.scenarios.length), rainfall: 30, temp: 3, waterStress: 60, population: 12 });
      renderScenarios();
    });
    $('runBtn').addEventListener('click', runSimulation);
    $('resetBtn').addEventListener('click', function () {
      state.interventions = E.INTERVENTIONS.map(function (i) { return Object.assign({ available: true }, i); });
      state.scenarios = E.DEFAULT_SCENARIOS.map(function (s) { return Object.assign({}, s); });
      state.budget = 100; state.seed = 12345; state.weights = { flood: 50, heat: 30, water: 20 };
      state.uncertainty = { rainfallRel: 0.15, tempRel: 0.15, waterRel: 0.15, effRel: 0.10, samples: 150 };
      syncInputs(); renderScenarios(); renderInterventions(); syncWeightLabels(); syncUncLabels();
    });
    $('historyToggle').addEventListener('click', function () { $('historyDrawer').classList.toggle('hidden'); });
    $('historyClose').addEventListener('click', function () { $('historyDrawer').classList.add('hidden'); });
    $('clearHistory').addEventListener('click', function () { state.history = []; localStorage.removeItem(HIST_KEY); renderHistory(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
