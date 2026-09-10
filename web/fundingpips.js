(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const number = (value, digits = 2, missing = 'Not recorded') => finite(value)
    ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : missing;
  const money = (value) => finite(value)
    ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : 'Not recorded';
  const percent = (value) => finite(value) ? `${number(value)}%` : 'Not recorded';
  const integer = (value) => number(value, 0);
  const pf = (value) => number(value, 2, 'Not defined');
  const expectancy = (value) => finite(value) ? money(value) : 'Not defined';
  const days = (value) => finite(value) ? `${number(value, 1)} days` : 'Not attained';
  const bps = (value) => finite(value) ? `${number(value)} bp` : 'Not defined';
  const multiple = (value) => finite(value) ? `${number(value)}×` : 'Not recorded';
  const valueText = (value, fallback = 'Not recorded') => typeof value === 'string' && value.length ? value : fallback;
  const statusText = (metrics) => metrics.status === 'running' && metrics.complete === true
    ? 'Historical window completed without a halt · not live'
    : valueText(metrics.status);
  const date = (value, time = false) => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Not recorded';
    const iso = new Date(value).toISOString();
    return time ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
  };
  const outcomeNames = {
    pass: 'Conditional proxy pass', breach: 'Modeled breach', 'internal-stop': 'Internal risk stop',
    inactivity: 'Inactivity', pending: 'Pending at horizon', censored: 'Right-censored at data end',
    'data-indeterminate': 'Data-indeterminate · open-gap path'
  };
  const caseNames = {
    base: 'Baseline · economic 2×', double: 'Double costs · economic 2×',
    triple: 'Triple costs · economic 2×', managed: 'Managed · base costs 2×',
    master1x: 'Master 1× · leverage only', neighbor: 'Fixed neighbor · not selectable',
    exposed: 'Already exposed · not a fresh holdout'
  };
  const splitNames = {
    training: 'Training · Jan 2024–Jun 2025', validation: 'Validation · Jul–Dec 2025',
    final: 'Final · Jan–09 Jun 2026', exposed: 'Already exposed · 12 Jun–09 Sep 2026'
  };
  const metricFields = [
    ['Net return', 'netReturnPct', percent],
    ['Ending equity · USD', 'endingEquity', money],
    ['Recorded cash balance · USD', 'endingBalance', money],
    ['Net profit factor', 'profitFactor', pf],
    ['Net expectancy / trade', 'expectancy', expectancy],
    ['Net P&L · USD', 'netPnl', money],
    ['Completed trades', 'tradeCount', integer],
    ['Win rate · net trades', 'winRatePct', percent],
    ['Long / short trades', null, (_, m) => `${integer(m.longTrades)} / ${integer(m.shortTrades)}`],
    ['Commission · USD', 'totalFees', money],
    ['Spread + slippage · USD', 'spreadSlippage', money],
    ['Total execution costs · USD', null, (_, m) => finite(m.totalFees) && finite(m.spreadSlippage) ? money(m.totalFees + m.spreadSlippage) : 'Not recorded'],
    ['Turnover · entry + exit USD', 'turnover', money],
    ['Turnover / initial capital', 'turnoverMultiple', multiple],
    ['Gross mid-price P&L · USD', 'grossMidPnl', money],
    ['Break-even all-in / side', 'breakEvenAllInBpsPerSide', bps],
    ['Maximum close drawdown', 'maxCloseDrawdownPct', percent],
    ['Conservative intrabar DD bound', 'maxIntrabarDrawdownPct', percent],
    ['Worst day P&L · USD', 'worstDayPnl', money],
    ['Worst day return', 'worstDayPct', percent],
    ['Longest losing trade streak', 'maxLosingStreak', integer],
    ['Time in market', 'exposureTimePct', percent],
    ['Peak gross exposure / equity', 'maxExposurePct', percent],
    ['Mean gross exposure / equity', 'meanExposurePct', percent],
    ['Entry trading days', 'entryTradingDays', integer],
    ['Completed-trade days', 'completedTradingDays', integer]
  ];
  const placeholders = {
    'development-data': 'Development rows',
    'finalist-data': 'Final scenarios',
    'benchmark-data': 'Benchmark observations',
    'cohort-data': 'Cohort groups and individual starts',
    'family-data': 'Exact protocol family rules',
    'provenance-data': 'Data coverage and provenance'
  };
  let chartId = 0;
  const chartCleanups = [];

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function signed(value, format = percent) {
    return el('span', format(value), finite(value) ? (value < 0 ? 'negative' : value > 0 ? 'positive' : '') : '');
  }

  function term(list, label, value) {
    const group = el('div');
    group.append(el('dt', label), value instanceof Node ? value : el('dd', value));
    list.append(group);
  }

  function fill(id, child) {
    const target = $(id);
    target.classList.remove('data-placeholder');
    target.replaceChildren(child);
  }

  function table(caption, columns, rows, className = '') {
    const region = el('div', undefined, 'table-scroll');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', `${caption}. Horizontally scrollable table.`);
    region.tabIndex = 0;
    const element = el('table', undefined, className);
    element.append(el('caption', caption));
    const head = el('thead'), heading = el('tr'), body = el('tbody');
    for (const column of columns) {
      const th = el('th', typeof column === 'string' ? column : column.label);
      th.scope = 'col';
      if (column.numeric) th.className = 'numeric';
      heading.append(th);
    }
    head.append(heading);
    for (const cells of rows) {
      const row = el('tr');
      cells.forEach((value, index) => {
        const cell = el(index === 0 ? 'th' : 'td');
        if (index === 0) cell.scope = 'row';
        if (columns[index]?.numeric) cell.className = 'numeric';
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value === null || value === undefined ? 'Not recorded' : String(value);
        row.append(cell);
      });
      body.append(row);
    }
    if (!rows.length) {
      const row = el('tr'), cell = el('td', 'No observations published for this table.');
      cell.colSpan = columns.length;
      row.append(cell);
      body.append(row);
    }
    element.append(head, body);
    region.append(element);
    return region;
  }

  const numericColumn = (label) => ({ label, numeric: true });

  function lazyDetails(label, build, className = 'method-detail') {
    const detail = el('details', undefined, className);
    detail.append(el('summary', label));
    let built = false;
    detail.addEventListener('toggle', () => {
      if (!detail.open || built) return;
      try {
        detail.append(build());
        built = true;
      } catch {
        detail.append(el('p', 'This detail could not be displayed. Inspect the downloadable JSON or ledger instead.', 'notice caution'));
        built = true;
      }
    });
    return detail;
  }

  function metricsGrid(metrics, compact = false) {
    const list = el('dl', undefined, `metric-grid${compact ? ' compact' : ''}`);
    for (const [label, key, format] of metricFields) {
      const value = format(key ? metrics[key] : null, metrics);
      const dd = el('dd', value);
      if (['netReturnPct', 'netPnl', 'expectancy'].includes(key) && finite(metrics[key])) {
        dd.className = metrics[key] < 0 ? 'negative' : metrics[key] > 0 ? 'positive' : '';
      }
      const prefixLabels = { netReturnPct: 'Marked prefix return · incomplete', endingEquity: 'Last-known marked equity · USD', netPnl: 'Marked prefix P&L · incomplete' };
      term(list, metrics.complete === false && prefixLabels[key] ? prefixLabels[key] : label, dd);
    }
    return list;
  }

  function runDetails(metrics) {
    const wrapper = el('div', undefined, 'detail-content');
    wrapper.append(
      el('p', `Observed run: ${date(metrics.from, true)} → ${date(metrics.to, true)}. Status: ${statusText(metrics)}. Reason: ${valueText(metrics.reason, 'None recorded')}. Stopped at: ${date(metrics.stoppedAt, true)}.`),
      el('p', metrics.complete === false
        ? 'Data-gap completeness flag: false. Unresolved inventory; marked prefix only.'
        : metrics.complete === true
          ? 'Data-gap completeness flag: true. No unresolved open-gap endpoint; a managed halt may still end before the requested horizon.'
          : 'Data-gap completeness flag: not recorded.', 'metric-note'),
      el('p', valueText(metrics.endpointMeaning), metrics.complete === false ? 'notice caution' : 'metric-note'),
      metricsGrid(metrics, true)
    );
    if (metrics.complete === false) {
      wrapper.append(el('p', 'Incomplete open-gap path. PF, expectancy, turnover and spread/slippage summarize completed trades; commission also includes the unresolved entry fee. No exit is invented, and the marked prefix is not a full-period return.', 'notice caution'));
      if (metrics.unresolvedPosition) {
        wrapper.append(table('Unresolved position preserved in the published run', ['Field', 'Recorded value'],
          Object.entries(metrics.unresolvedPosition).map(([key, value]) => [key, finite(value) ? number(value, 8) : valueText(value)])));
      }
    }
    const events = Array.isArray(metrics.riskEvents) ? metrics.riskEvents : [];
    if (events.length) {
      const list = el('ul', undefined, 'event-list');
      events.forEach((event) => list.append(el('li', `${date(event.time, true)} · ${valueText(event.reason)} · ${valueText(event.certainty)}`)));
      wrapper.append(el('h4', 'Recorded risk events'), list);
    } else wrapper.append(el('p', 'No risk events recorded in this run. This is not verified firm compliance.', 'metric-note'));
    return wrapper;
  }

  function developmentCell(metrics) {
    const node = el('div');
    node.append(signed(metrics.netReturnPct));
    node.append(el('span', `PF ${pf(metrics.profitFactor)} · ${integer(metrics.tradeCount)} trades`, 'cell-detail'));
    node.append(el('span', `DD ${percent(metrics.maxIntrabarDrawdownPct)} · intrabar bound`, 'cell-detail'));
    if (metrics.complete === false) node.append(el('span', 'INDETERMINATE · marked prefix only', 'cell-detail caution'));
    return node;
  }

  function renderDevelopment(report) {
    const rows = report.development.map((row) => {
      const identity = el('div');
      identity.append(
        el('span', row.candidate.id, 'candidate-id'),
        el('span', `${row.candidate.family} · parameter ${number(row.candidate.parameter, 1)}`, 'cell-detail'),
        el('span', `${percent(finite(row.candidate.riskRate) ? row.candidate.riskRate * 100 : null)} risk budget`, 'cell-detail')
      );
      const selected = report.selection.finalists.find((item) => item.candidate.id === row.candidate.id);
      if (selected) identity.append(el('span', row.eligible ? 'Preselected · qualified' : 'Preselected · diagnostic only', 'cell-detail caution'));
      const eligibility = lazyDetails(row.eligible ? 'Development-qualified · inspect gates' : 'Ineligible · inspect rejection reasons', () => {
        const content = el('div');
        const reasons = el('ul');
        if (row.eligible) reasons.append(el('li', 'Passed all preregistered development gates. This does not establish final profitability or firm compliance.'));
        else row.rejectionReasons.forEach((reason) => reasons.append(el('li', reason)));
        content.append(reasons, el('p', `Development-only ranking score: ${number(row.score, 4)}.`));
        row.validationQuarters.forEach((quarter) => content.append(el('p', `Validation quarter ${quarter.from} to ${quarter.to} (exclusive): ${money(quarter.netPnl)} net.`)));
        content.append(table(`Managed development runs · ${row.candidate.id}`,
          ['Run', numericColumn('Net / marked prefix return'), numericColumn('PF'), numericColumn('Trades'), numericColumn('Close DD'), numericColumn('Intrabar DD bound'), 'Endpoint status'],
          [['Training', row.managedTraining], ['Validation', row.managedValidation]].map(([name, m]) => [
            name, signed(m.netReturnPct), pf(m.profitFactor), integer(m.tradeCount),
            percent(m.maxCloseDrawdownPct), percent(m.maxIntrabarDrawdownPct),
            m.complete === false ? 'DATA-INDETERMINATE · marked prefix only' : `Flat endpoint · ${statusText(m)}`
          ])));
        return content;
      }, 'eligibility-detail');
      return [identity, developmentCell(row.training), developmentCell(row.validation), developmentCell(row.validationDouble), eligibility];
    });
    fill('development-data', table('All preregistered development candidates, in protocol order. Returns are net of modeled costs.',
      ['Candidate / risk budget', numericColumn('Training · base'), numericColumn('Validation · base'), numericColumn('Validation · double costs'), 'Eligibility / evidence'], rows, 'development-table'));
    $('candidate-count').textContent = `${integer(report.development.length)} shown · ${integer(report.selection.eligibleCount)} development-qualified`;
  }

  function svgNode(tag, attributes = {}, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function dailyChart(rows, initial, drawdown, candidate) {
    const figure = el('figure', undefined, 'chart-figure');
    const title = drawdown ? 'Daily close drawdown' : 'Daily equity · USD';
    const id = `research-chart-${++chartId}`;
    figure.append(el('h4', title));
    const legend = el('div', undefined, 'legend');
    const legendItem = (text, className) => {
      const item = el('span');
      item.append(el('i', undefined, className), document.createTextNode(text));
      legend.append(item);
    };
    if (drawdown) legendItem('Daily close DD', 'drawdown');
    else {
      legendItem('End equity', '');
      legendItem('Daily minimum equity', 'minimum');
      legendItem('Initial capital', 'reference');
    }
    figure.append(legend);
    const svg = svgNode('svg', { role: 'img', 'aria-labelledby': `${id}-title ${id}-description`, viewBox: '0 0 640 270' });
    figure.append(svg);
    const caption = drawdown
      ? 'Daily close observations only—not true intrabar maximum drawdown. Use the reported conservative intrabar bound above.'
      : 'Real published daily rows. Dashed daily minima are summaries, not a tradable path or verified tick lows. Gaps are not interpolated. A terminal close timestamp may equal the exclusive period boundary.';
    figure.append(el('figcaption', caption, 'chart-caption'));
    const observations = rows.map((row) => ({
      time: typeof row.time === 'string' ? Date.parse(row.time) : NaN,
      main: drawdown ? row.closeDrawdownPct : row.endEquity, minimum: row.minEquity
    })).filter((row) => finite(row.time));
    let previousWidth = 0;
    function draw() {
      const width = Math.max(280, Math.round(svg.getBoundingClientRect().width || 640));
      if (width === previousWidth) return;
      previousWidth = width;
      svg.setAttribute('viewBox', `0 0 ${width} 270`);
      svg.replaceChildren(
        svgNode('title', { id: `${id}-title` }, `${candidate}: ${title}`),
        svgNode('desc', { id: `${id}-description` }, `${caption} ${integer(observations.length)} dated observations. Exact values are available in the accessible daily table immediately below both charts.`)
      );
      const available = observations.filter((row) => finite(row.main));
      if (!available.length) {
        svg.append(svgNode('text', { x: 20, y: 130, class: 'chart-axis' }, 'No finite daily values published.'));
        return;
      }
      const left = drawdown ? 54 : 72, right = width - 18, top = 20, bottom = 230;
      const times = observations.map((row) => row.time);
      const first = Math.min(...times), last = Math.max(...times);
      const values = observations.flatMap((row) => drawdown ? [row.main] : [row.main, row.minimum]).filter(finite);
      const reference = drawdown ? 0 : initial;
      if (finite(reference)) values.push(reference);
      const minimum = Math.min(...values), maximum = Math.max(...values);
      const padding = Math.max((maximum - minimum) * 0.12, drawdown ? 0.1 : Math.max(Math.abs(minimum) * 0.005, 1));
      const low = drawdown ? 0 : minimum - padding, high = maximum + padding;
      const x = (time) => last === first ? (left + right) / 2 : left + (time - first) / (last - first) * (right - left);
      const y = (value) => drawdown
        ? top + (value - low) / (high - low) * (bottom - top)
        : bottom - (value - low) / (high - low) * (bottom - top);
      for (let index = 0; index <= 3; index++) {
        const value = low + (high - low) * index / 3, position = y(value);
        svg.append(
          svgNode('line', { x1: left, x2: right, y1: position, y2: position, class: 'chart-gridline' }),
          svgNode('text', { x: left - 9, y: position + 4, 'text-anchor': 'end', class: 'chart-axis' }, drawdown ? `${number(value, 1)}%` : number(value, 0))
        );
      }
      if (finite(reference)) svg.append(svgNode('line', { x1: left, x2: right, y1: y(reference), y2: y(reference), class: 'chart-reference' }));
      const pathFor = (key) => {
        let path = '', previous = null;
        for (const row of observations) {
          if (!finite(row[key])) { previous = null; continue; }
          const continuous = previous !== null && row.time > previous && row.time - previous <= 36 * 3600000;
          path += `${continuous ? 'L' : 'M'}${x(row.time).toFixed(2)},${y(row[key]).toFixed(2)} `;
          previous = row.time;
        }
        return path;
      };
      if (!drawdown) svg.append(svgNode('path', { d: pathFor('minimum'), class: 'chart-line chart-minimum' }));
      svg.append(svgNode('path', { d: pathFor('main'), class: `chart-line${drawdown ? ' chart-dd' : ''}` }));
      if (available.length === 1) svg.append(svgNode('circle', { cx: x(available[0].time), cy: y(available[0].main), r: 3, fill: drawdown ? 'var(--cyan)' : 'var(--mint)' }));
      const labelDate = (time) => new Date(time).toISOString().slice(5, 10);
      svg.append(
        svgNode('text', { x: left, y: 255, class: 'chart-axis' }, labelDate(first)),
        svgNode('text', { x: right, y: 255, 'text-anchor': 'end', class: 'chart-axis' }, labelDate(last))
      );
      if (width >= 450) svg.append(svgNode('text', { x: (left + right) / 2, y: 255, 'text-anchor': 'middle', class: 'chart-axis' }, '2026 · UTC observation date'));
    }
    const frame = requestAnimationFrame(draw);
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(draw);
      observer.observe(svg);
      chartCleanups.push(() => { cancelAnimationFrame(frame); observer.disconnect(); });
    } else {
      window.addEventListener('resize', draw);
      chartCleanups.push(() => { cancelAnimationFrame(frame); window.removeEventListener('resize', draw); });
    }
    return figure;
  }

  function dailyTable(finalist) {
    const result = table(`Baseline daily observations · ${finalist.candidate.id}. Day uses the fixed UTC+3 platform-date convention; timestamp is the row's last recorded observation, including an exclusive terminal close boundary.`,
      ['Platform day', 'Last observation · UTC', numericColumn('End equity'), numericColumn('Minimum equity'), numericColumn('Close DD'), numericColumn('Net day P&L'), numericColumn('Opening baseline'), numericColumn('Daily floor'), numericColumn('Closed trades')],
      finalist.equity.map((row) => [
        valueText(row.day), date(row.time, true), money(row.endEquity), money(row.minEquity),
        percent(row.closeDrawdownPct), signed(row.netPnl, money), money(row.baseline), money(row.floor), integer(row.trades)
      ]));
    result.classList.add('daily-table');
    return result;
  }

  function renderFinalists(report) {
    const fragment = document.createDocumentFragment();
    report.finalists.forEach((finalist) => {
      const panel = el('article', undefined, 'result-panel'), heading = el('div', undefined, 'result-heading');
      const title = el('h3', finalist.candidate.id);
      title.id = `final-${finalist.candidate.id}`;
      panel.setAttribute('aria-labelledby', title.id);
      heading.append(title, el('p', finalist.role, 'result-role'));
      panel.append(heading, el('p', finalist.assessment, 'result-assessment'), metricsGrid(finalist.cases.base.metrics));
      if (finalist.cases.base.metrics.complete === false) panel.append(el('p', `${finalist.cases.base.metrics.endpointMeaning}. The daily charts end at the observed prefix; no unresolved trade is treated as closed.`, 'notice caution'));
      panel.append(el('p', 'Baseline economic run · all dollar amounts are virtual USD. PF and expectancy use net completed trades. Maximum close DD uses all 15-minute execution-bar closes; daily chart snapshots cannot reconstruct that maximum or the intrabar bound. Break-even all-in basis points per side use fixed simulated quantities and the mid-price path, not a reoptimized trade set. A negative break-even value means this fixed path loses even before positive execution costs.', 'metric-note'));
      const charts = el('div', undefined, 'charts');
      charts.append(dailyChart(finalist.equity, finalist.cases.base.metrics.initial, false, finalist.candidate.id));
      charts.append(dailyChart(finalist.equity, finalist.cases.base.metrics.initial, true, finalist.candidate.id));
      panel.append(charts, lazyDetails(`Accessible daily data · ${integer(finalist.equity.length)} rows`, () => dailyTable(finalist)));
      panel.append(el('h4', 'Every locked final and sensitivity case', 'subheading'));
      const rows = Object.keys(caseNames).map((key) => {
        const run = finalist.cases[key], metrics = run.metrics;
        const label = el('div', caseNames[key], 'case-label');
        label.append(el('span', key === 'neighbor' ? `Parameter neighbor: ${finalist.neighborCandidate.id}` : `${date(metrics.from)} → ${date(metrics.to)}`, 'cell-detail'));
        return [label, signed(metrics.netReturnPct), money(metrics.endingEquity), pf(metrics.profitFactor), integer(metrics.tradeCount),
          percent(metrics.maxCloseDrawdownPct), percent(metrics.maxIntrabarDrawdownPct),
          metrics.complete === false ? 'DATA-INDETERMINATE · marked prefix only' : `Flat endpoint · ${statusText(metrics)}`];
      });
      panel.append(table(`All cases · ${finalist.candidate.id}. Economic and managed results are different counterfactuals.`,
        ['Case', numericColumn('Net / marked prefix return'), numericColumn('End / last-known equity'), numericColumn('PF'), numericColumn('Trades'), numericColumn('Close DD'), numericColumn('Intrabar DD bound'), 'Endpoint status'], rows));
      Object.entries(caseNames).forEach(([key, label]) => {
        panel.append(lazyDetails(`${label} · full metrics & risk events`, () => runDetails(finalist.cases[key].metrics), 'case-detail'));
      });
      fragment.append(panel);
    });
    fill('finalist-data', fragment);
  }

  function renderBenchmarks(report) {
    const rows = Object.keys(splitNames).map((split) => {
      const benchmark = report.benchmarks[split];
      const cashEquity = finite(benchmark.initial) && finite(benchmark.cashReturnPct)
        ? benchmark.initial * (1 + benchmark.cashReturnPct / 100) : null;
      return [splitNames[split], percent(benchmark.cashReturnPct), money(cashEquity), signed(benchmark.netReturnPct),
        money(benchmark.endingBalance), money(benchmark.totalFees)];
    });
    fill('benchmark-data', table('Costed equal-dollar BTC/ETH buy-and-hold versus cash. Spread/slippage is included in returns; commission is shown separately.',
      ['Fixed period', numericColumn('Cash return'), numericColumn('Cash equity'), numericColumn('Buy-and-hold net'), numericColumn('Buy-and-hold equity'), numericColumn('Buy-and-hold commission')], rows));
  }

  function fraction(passes, starts, value) {
    return `${integer(passes)} / ${integer(starts)} · ${finite(value) ? percent(value * 100) : 'Not defined'}`;
  }

  function cohortPhaseDetails(cohort) {
    const wrapper = el('div', undefined, 'phase-detail');
    wrapper.append(el('p', `Requested horizon end: ${date(cohort.horizonEnd, true)}. Observed end: ${date(cohort.observedEnd, true)}. ${valueText(cohort.compliance)}`));
    [['Phase 1 · fresh $5,000 / +$400 target', cohort.phase1], ['Phase 2 · fresh $5,000 / +$250 target', cohort.phase2]].forEach(([label, phase]) => {
      wrapper.append(el('h4', label));
      if (phase) wrapper.append(runDetails(phase));
      else wrapper.append(el('p', 'Not started within the observed window.'));
    });
    return wrapper;
  }

  function cohortStarts(group, candidate) {
    return table(`${candidate} · ${group.horizonDays}-day ${group.costs} costs · every weekly start. Target durations shown only when attained.`,
      ['Start · UTC', 'Outcome', 'Full horizon within data?', numericColumn('Phase 1 duration'), numericColumn('Phase 2 duration'), numericColumn('Total pass duration'), 'Observed through · UTC', 'Reason / phase evidence'],
      group.cohorts.map((cohort) => {
        const evidence = el('div', valueText(cohort.reason, 'No terminal reason recorded'));
        evidence.append(lazyDetails('Inspect both phases', () => cohortPhaseDetails(cohort), 'case-detail'));
        return [
          date(cohort.start), outcomeNames[cohort.outcome] || valueText(cohort.outcome),
          cohort.fullHorizonObserved === true ? 'Yes · gaps remain possible' : cohort.fullHorizonObserved === false ? 'No' : 'Not recorded',
          days(cohort.phase1Days), days(cohort.phase2Days), days(cohort.totalDays), date(cohort.observedEnd, true), evidence
        ];
      }), 'cohort-starts');
  }

  function renderCohorts(report) {
    const fragment = document.createDocumentFragment();
    report.finalists.forEach((finalist) => {
      const panel = el('article', undefined, 'cohort-panel');
      panel.append(el('h3', finalist.candidate.id), el('p', finalist.role, 'caution'));
      const rows = [];
      finalist.cohortGroups.forEach((group) => {
        const title = `${integer(group.horizonDays)} days · ${group.costs} costs`;
        [
          ['All starts', group.starts, group.outcomes, group.passFractionAllStarts],
          ['Fully observed subset', group.fullyObservedOpportunities, group.fullyObservedOutcomes, group.passFractionFullyObserved]
        ].forEach(([population, count, outcomes, value]) => {
          rows.push([title, el('span', population, 'population'), integer(count), integer(outcomes.pass), integer(outcomes.breach),
            integer(outcomes['internal-stop']), integer(outcomes.inactivity), integer(outcomes.pending), integer(outcomes.censored),
            integer(outcomes['data-indeterminate']), fraction(outcomes.pass, count, value)]);
        });
      });
      panel.append(table(`Outcome counts · ${finalist.candidate.id}. Subset rows are already included in all-start rows.`,
        ['Horizon / costs', 'Population', numericColumn('Opportunities'), numericColumn('Pass'), numericColumn('Breach'),
          numericColumn('Internal stop'), numericColumn('Inactivity'), numericColumn('Pending'), numericColumn('Censored'), numericColumn('Data-indeterminate'), numericColumn('Observed pass fraction')], rows, 'cohort-table'));
      panel.append(table(`Attained-target medians · ${finalist.candidate.id}. Null = not attained; these are not unconditional completion-time forecasts.`,
        ['Horizon / costs', numericColumn('Phase 1 median'), numericColumn('Phase 2 median'), numericColumn('Total pass median')],
        finalist.cohortGroups.map((group) => [
          `${integer(group.horizonDays)} days · ${group.costs}`, days(group.medianPhase1Days),
          days(group.medianPhase2Days), days(group.medianTotalPassDays)
        ])));
      finalist.cohortGroups.forEach((group) => panel.append(lazyDetails(
        `${integer(group.horizonDays)} days · ${group.costs} costs · all ${integer(group.starts)} individual starts`,
        () => cohortStarts(group, finalist.candidate.id)
      )));
      fragment.append(panel);
    });
    fill('cohort-data', fragment);
  }

  function renderFamilies(protocol) {
    const fragment = document.createDocumentFragment();
    protocol.families.forEach((family) => {
      const row = el('article', undefined, 'family-row'), content = el('div');
      row.append(el('h4', family.id));
      content.append(
        el('p', `Hypothesis, not evidence: ${family.hypothesis}`),
        el('p', family.rule, 'family-rule'),
        el('p', `Preregistered parameters: ${family.parameters.map((value) => number(value, 1)).join(' / ')}. Each is tested at 0.10% and 0.25% inclusive stop risk; entries/exits obey the shared causal and execution rules above.`, 'family-risk')
      );
      row.append(content);
      fragment.append(row);
    });
    fill('family-data', fragment);
  }

  function renderProvenance(report, provenance, amendments) {
    const wrapper = el('div'), coverage = el('dl', undefined, 'provenance-list');
    const gapDates = Array.isArray(provenance.gapUtcDates) ? provenance.gapUtcDates : provenance.excludedUtcDates;
    term(coverage, 'Provider', provenance.provider);
    term(coverage, 'Source interval · UTC, end exclusive', `${date(provenance.from)} → ${date(provenance.to)}`);
    term(coverage, 'Frozen acquisition timestamp', date(provenance.retrievedAt, true));
    Object.entries(provenance.barsPerSymbol).forEach(([symbol, count]) => term(coverage, `${symbol} · aligned real 15m bars`, integer(count)));
    term(coverage, 'Expected 15m bars / symbol', integer(provenance.expectedBarsPerSymbol));
    term(coverage, 'A1 · recovered real 15m bars', integer(provenance.recovered15mBars));
    term(coverage, 'Missing original 15m source bars', integer(provenance.missing15mSourceBars));
    term(coverage, 'UTC dates with gaps · not whole-day exclusions', integer(gapDates.length));
    wrapper.append(coverage);
    wrapper.append(el('p', valueText(provenance.coveragePolicy), 'notice caution'));
    wrapper.append(lazyDetails(`Every UTC gap date · ${integer(gapDates.length)} dates · pre-gap activity retained`, () => el('p',
      gapDates.length ? gapDates.join(' · ') : 'No UTC gap dates are recorded in this provenance.',
      'excluded-dates')));
    wrapper.append(lazyDetails('Recorded hashes & acquisition revision record', () => {
      const list = el('dl', undefined, 'hash-list');
      term(list, 'Market SHA256 · report / provenance', valueText(report.marketSha256));
      term(list, 'Frozen protocol SHA256', valueText(report.protocolSha256));
      term(list, 'Locked selection SHA256', valueText(report.selectionSha256));
      Object.entries(report.sourceSha256 || {}).forEach(([file, hash]) => term(list, `Engine source · ${file}`, valueText(hash)));
      term(list, 'Compressed market archive hash', valueText(provenance.archiveSha256));
      term(list, 'Archive hash encoding (not plain file SHA256)', valueText(provenance.archiveHashEncoding));
      term(list, 'Revision record', valueText(provenance.revisions));
      return list;
    }));
    fill('provenance-data', wrapper);
    $('amendments-data').replaceChildren();
    amendments.forEach((amendment) => {
      const article = el('article', undefined, 'amendment-record');
      article.append(el('h3', `${amendment.id} · ${amendment.date}`));
      ['stage', 'reason', 'change', 'biasDisclosure', 'unchanged'].forEach((key) => {
        if (typeof amendment[key] === 'string') article.append(el('p', `${key === 'biasDisclosure' ? 'Bias disclosure' : key[0].toUpperCase() + key.slice(1)}: ${amendment[key]}`));
      });
      $('amendments-data').append(article);
    });
    $('amendments-detail').hidden = false;
  }

  function validate(report, protocol, provenance, amendments) {
    const require = (condition, message) => { if (!condition) throw new Error(`Incompatible or incomplete research artifacts: ${message}`); };
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    require(object(report) && report.schemaVersion === 1 && typeof report.assessment === 'string', 'results schema or assessment missing.');
    require(object(protocol) && object(provenance) && Array.isArray(amendments), 'protocol, provenance or amendments missing.');
    require(report.account?.initial === 5000 && protocol.account?.initial === 5000, 'independent $5,000 scenario identity mismatch.');
    require(report.protocolId === protocol.id && report.protocolSha256 === provenance.protocolSha256 && report.marketSha256 === provenance.marketSha256, 'recorded artifact identities do not match. This page does not recompute hashes.');
    require(Array.isArray(protocol.candidates) && protocol.candidates.length === 16 && Array.isArray(report.development) && report.development.length === 16, 'all 16 development candidates are required.');
    require(new Set(report.development.map((row) => row.candidate?.id)).size === 16 &&
      protocol.candidates.every((candidate, i) => report.development[i]?.candidate?.id === candidate.id), 'candidate identities or protocol order differ.');
    report.development.forEach((row) => {
      require(typeof row.eligible === 'boolean' && Array.isArray(row.rejectionReasons) && Array.isArray(row.validationQuarters), 'development eligibility evidence missing.');
      ['training', 'validation', 'validationDouble', 'managedTraining', 'managedValidation'].forEach((key) => require(object(row[key]), `development ${key} metrics missing.`));
    });
    require(object(report.selection) && Array.isArray(report.selection.finalists) && Array.isArray(report.finalists), 'locked finalist selection missing.');
    require(report.finalists.length === 2 && report.selection.finalists.length === 2, 'both preselected families must be published.');
    require(report.selection.eligibleCount === report.development.filter((row) => row.eligible).length, 'eligible count mismatch.');
    report.finalists.forEach((finalist, index) => {
      const locked = report.selection.finalists[index];
      require(finalist.candidate?.id === locked.candidate?.id && finalist.eligible === locked.eligible && typeof finalist.role === 'string', 'finalists differ from locked order or eligibility.');
      require(object(finalist.cases) && Array.isArray(finalist.equity) && Array.isArray(finalist.cohortGroups), 'final metrics, daily rows or cohorts missing.');
      Object.keys(caseNames).forEach((key) => {
        const metrics = finalist.cases[key]?.metrics;
        require(object(metrics), `final case ${key} missing.`);
        require(typeof metrics.complete === 'boolean' && typeof metrics.endpointMeaning === 'string' &&
          (metrics.unresolvedPosition === null || object(metrics.unresolvedPosition)), `final case ${key} endpoint-completeness evidence missing.`);
      });
      require(finalist.neighborCandidate?.id && finalist.cohortGroups.length === 4, 'fixed neighbor or all four cohort groups missing.');
      const groups = new Set(finalist.cohortGroups.map((group) => `${group.horizonDays}:${group.costs}`));
      require(['60:base', '60:double', '120:base', '120:double'].every((key) => groups.has(key)), 'expected 60/120 × base/double groups missing.');
      finalist.cohortGroups.forEach((group) => {
        require(Array.isArray(group.cohorts) && group.cohorts.length === group.starts && object(group.outcomes) && object(group.fullyObservedOutcomes), 'individual starts or outcome counts missing.');
        const outcomes = ['pass', 'breach', 'internal-stop', 'inactivity', 'pending', 'censored', 'data-indeterminate'];
        require(outcomes.every((key) => Number.isInteger(group.outcomes[key]) && Number.isInteger(group.fullyObservedOutcomes[key])), 'all seven outcome counts, including data-indeterminate, must be recorded.');
        require(outcomes.reduce((sum, key) => sum + group.outcomes[key], 0) === group.starts &&
          outcomes.reduce((sum, key) => sum + group.fullyObservedOutcomes[key], 0) === group.fullyObservedOpportunities, 'outcome totals do not reconcile.');
        require(group.cohorts.every((cohort) => object(cohort.phase1) && (cohort.phase2 === null || object(cohort.phase2)) &&
          typeof cohort.fullHorizonObserved === 'boolean' && outcomes.includes(cohort.outcome)), 'per-start phase evidence or observation status missing.');
      });
    });
    require(object(report.benchmarks) && Object.keys(splitNames).every((key) => object(report.benchmarks[key])), 'all baseline comparison periods missing.');
    require(object(report.data) && Array.isArray(report.data.gapUtcDates) && typeof report.data.coveragePolicy === 'string', 'finalized report gap dates or coverage policy missing.');
    require(Array.isArray(protocol.families) && protocol.families.length === 4, 'four executable families missing.');
    require(object(provenance.barsPerSymbol) && (Array.isArray(provenance.gapUtcDates) || Array.isArray(provenance.excludedUtcDates)), 'source coverage or current UTC gap dates missing.');
    require(amendments.some((item) => item.id === 'A3'), 'current causal-gap A3 amendment missing.');
    require(Array.isArray(report.limitations), 'published limitations missing.');
  }

  function render(report, protocol, provenance, amendments) {
    $('report-assessment').textContent = report.assessment;
    $('report-assessment').classList.toggle('caution', report.selection.eligibleCount === 0);
    const summary = $('study-summary');
    summary.replaceChildren();
    term(summary, 'Development-qualified', `${integer(report.selection.eligibleCount)} / ${integer(report.development.length)}`);
    term(summary, 'Preselected final families', integer(report.finalists.length));
    term(summary, 'Development runs · all retained', integer(report.attemptedRuns?.development));
    term(summary, 'Standalone final / sensitivity runs', integer(report.attemptedRuns?.finalStandalone));
    term(summary, 'Overlapping cohort paths', integer(report.attemptedRuns?.cohortPaths));
    $('report-stamp').textContent = `${date(report.generatedAt, true)} · ${valueText(report.generatedAtMeaning)} ${valueText(report.selection.statement, '')}`;
    $('report-gap-note').textContent = `Published gap policy · ${integer(report.data.gapUtcDates.length)} UTC gap dates in the source history. ${report.data.coveragePolicy} Data-indeterminate endpoint metrics are last-known marked prefixes, not completed full-window realized returns.`;
    renderDevelopment(report);
    renderFinalists(report);
    renderBenchmarks(report);
    renderCohorts(report);
    renderFamilies(protocol);
    renderProvenance(report, provenance, amendments);
    $('limitations-list').replaceChildren(...report.limitations.map((text) => el('li', text)));
    $('limitations-detail').hidden = false;
    $('assessment-content').hidden = false;
  }

  function reset(failed = false) {
    chartCleanups.splice(0).forEach((cleanup) => cleanup());
    $('assessment-content').hidden = true;
    $('limitations-detail').hidden = true;
    $('amendments-detail').hidden = true;
    Object.entries(placeholders).forEach(([id, label]) => {
      $(id).classList.add('data-placeholder');
      $(id).textContent = `${label} ${failed ? 'are unavailable. No result is inferred.' : 'have not been loaded.'}`;
    });
    $('candidate-count').textContent = '16 preregistered attempts';
  }

  async function fetchJson(file, signal) {
    const response = await fetch(`./fundingpips/${file}`, { cache: 'no-cache', signal });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}. The published artifact is unavailable.`);
    try { return await response.json(); }
    catch { throw new Error(`${file}: response is not valid JSON. Check the published artifact rather than assuming a result.`); }
  }

  async function load() {
    const status = $('load-status'), retry = $('retry-load');
    reset();
    retry.hidden = true;
    retry.disabled = true;
    status.className = 'load-status';
    status.textContent = 'Loading the published results, protocol, amendments and provenance. No illustrative performance is shown.';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const [report, protocol, provenance, amendments] = await Promise.all(
        ['results.json', 'protocol.json', 'provenance.json', 'amendments.json'].map((file) => fetchJson(file, controller.signal))
      );
      validate(report, protocol, provenance, amendments);
      render(report, protocol, provenance, amendments);
      status.className = 'load-status is-loaded';
      status.textContent = 'Published artifacts loaded. Historical snapshot—not a live account or a browser verification of the engine.';
    } catch (error) {
      controller.abort();
      reset(true);
      status.className = 'load-status is-error';
      const message = error.name === 'AbortError'
        ? 'Loading timed out after 45 seconds.'
        : valueText(error.message, 'The research files could not be read.');
      status.textContent = `Research unavailable. ${message} No performance or pass assessment is shown. Retry, open the downloads below, or check that the site build published research/fundingpips to fundingpips.`;
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      retry.disabled = false;
    }
  }

  $('retry-load').addEventListener('click', load);
  load();
})();
