(() => {
  "use strict";

  const POLL_MS = 60_000;
  const STALE_MS = 60 * 60_000;
  const FETCH_TIMEOUT_MS = 15_000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const state = {
    snapshot: null,
    research: null,
    snapshotError: "",
    researchError: "",
    checkedAt: null,
    fetching: false,
    range: "all",
    allFills: false,
  };
  const moneyFormat = new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 });
  const timeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const dateFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", year: "numeric", month: "short", day: "2-digit",
  });
  const shortDateFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", month: "short", day: "2-digit",
  });
  const shortTimeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const $ = (id) => document.getElementById(id);
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rows = (value) => Array.isArray(value) ? value.filter((row) => row && typeof row === "object" && !Array.isArray(row)) : [];
  const text = (value, fallback = "—") => typeof value === "string" && value.trim() ? value : fallback;
  const money = (value) => isNumber(value) ? moneyFormat.format(value) : "—";
  const signedMoney = (value) => isNumber(value) ? `${value > 0 ? "+" : value < 0 ? "−" : ""}${money(Math.abs(value))}` : "—";
  const number = (value) => isNumber(value) ? numberFormat.format(value) : "—";
  const percent = (value, signed = false) => isNumber(value)
    ? `${signed && value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}%` : "—";
  const ratioPercent = (value) => isNumber(value) ? percent(value * 100) : "—";
  const timestamp = (value) => {
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const time = (value) => timestamp(value) !== null ? `${timeFormat.format(new Date(value))} UTC` : "—";
  const date = (value) => timestamp(value) !== null ? dateFormat.format(new Date(value)) : "—";
  const newest = (value, key = "time") => rows(value).slice().reverse().sort((a, b) => (timestamp(b[key]) ?? -Infinity) - (timestamp(a[key]) ?? -Infinity));

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function setText(id, value) {
    $(id).textContent = value;
  }

  function setTone(node, value) {
    node.classList.remove("positive", "negative");
    if (isNumber(value) && value !== 0) node.classList.add(value > 0 ? "positive" : "negative");
    return node;
  }

  function setMetric(id, value, formatter = money, tone = false) {
    const node = $(id);
    node.textContent = formatter(value);
    if (tone) setTone(node, value);
  }

  function cell(value, className) {
    return element("td", className, value);
  }

  function emptyRow(target, columns, message) {
    const row = element("tr");
    const item = cell(message, "empty-cell");
    item.colSpan = columns;
    row.append(item);
    target.replaceChildren(row);
  }

  function appendDetail(node, value, className = "") {
    node.append(element("span", `cell-detail ${className}`.trim(), value));
  }

  function detailRow(label, value) {
    const row = element("div");
    row.append(element("dt", "", label), element("dd", "", value));
    return row;
  }

  function ageLabel(value) {
    const ms = timestamp(value);
    if (ms === null) return "unknown age";
    const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
    if (minutes < 1) return "less than a minute ago";
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
  }

  function renderStatus() {
    const snapshot = state.snapshot;
    const meta = object(snapshot?.meta);
    const account = object(snapshot?.account);
    const notice = $("data-notice");
    const badge = $("account-status");
    const marketTime = timestamp(meta.marketAsOf);
    const isStale = marketTime !== null && Date.now() - marketTime > STALE_MS;
    let label = "Awaiting snapshot";
    let tone = "";
    const warnings = [];
    let error = false;

    if (state.snapshotError) {
      error = true;
      warnings.push(`${state.snapshotError} ${snapshot ? "Showing the last successfully loaded snapshot; values may be out of date." : "No account values are available."} The page retries every 60 seconds, or select Refresh.`);
    }
    if (snapshot) {
      if (meta.status === "error") {
        error = true;
        warnings.push(`The simulator reports an error. ${text(meta.message, "Check the GitHub Actions run log before relying on these values.")}`);
      } else if (meta.status === "initializing") {
        warnings.push(`The simulator is initializing. ${text(meta.message, "Waiting for its first completed paper run.")}`);
      } else if (meta.status !== "healthy") {
        warnings.push("Snapshot health is not reported. Treat displayed values as unverified.");
      }
      if (isStale) {
        warnings.push(`Stale market data: the last closed bar is ${ageLabel(meta.marketAsOf)} (${time(meta.marketAsOf)}). It is more than 60 minutes old; this is not a current market quote.`);
      } else if (marketTime === null) {
        warnings.push("The last market close time is unavailable. Market freshness cannot be verified.");
      } else if (marketTime > Date.now() + 60_000) {
        warnings.push("The published market close time is in the future. Check the source timestamps and device clock.");
      }
      if (typeof meta.catchUp === "string" && meta.catchUp.trim()) {
        warnings.push(`Execution model: ${meta.catchUp}`);
      } else if (meta.catchUp === true) {
        warnings.push("Catch-up processing is reported. Replayed bars and resulting fills are hypothetical—not trades executed when those bars occurred.");
      }
      if (meta.status === "healthy" && typeof meta.message === "string" && meta.message.trim()) {
        warnings.push(meta.message);
      }
      label = error ? "Data error" : isStale ? "Stale market data" : meta.status === "initializing" ? "Initializing" : meta.status === "healthy" && marketTime !== null ? "Snapshot available" : "Freshness unverified";
      tone = error ? "is-error" : isStale || meta.status !== "healthy" || marketTime === null || marketTime > Date.now() + 60_000 ? "is-warning" : "is-healthy";
      if (!error && account.riskHalt) {
        label = "Risk halt";
        tone = "is-warning";
      } else if (!error && account.paused === true) {
        label = "New entries paused";
        tone = "is-warning";
      }
    } else if (state.snapshotError) {
      label = "Snapshot unavailable";
      tone = "is-error";
    }
    badge.className = `status-badge ${tone}`.trim();
    setText("account-status-text", label);
    notice.hidden = Boolean(snapshot && warnings.length === 0);
    notice.className = `notice ${error ? "notice-error" : warnings.length ? "notice-warning" : ""}`.trim();
    const message = warnings.join(" ");
    if (message && notice.textContent !== message) notice.textContent = message;

    const accountWarnings = [];
    if (account.paused === true) accountWarnings.push("New paper entries are paused. Existing protective and time-based exits may remain managed. Account changes require an authorized GitHub Actions dispatch.");
    if (account.riskHalt) accountWarnings.push(`Risk halt: ${text(account.riskHalt, "A configured risk limit has stopped new entries.")}`);
    $("account-notice").hidden = accountWarnings.length === 0;
    setText("account-notice", accountWarnings.join(" "));
    setText("market-asof", marketTime === null ? "Close time not yet published" : `Last close ${time(meta.marketAsOf)} · ${ageLabel(meta.marketAsOf)}`);
    $("market-asof").parentElement.classList.toggle("caution", isStale || marketTime === null);
    setText("published-at", time(meta.generatedAt));
    setText("last-success", time(meta.lastSuccessAt));
    setText("next-update", time(meta.nextExpectedUpdate));
    setText("checked-at", state.checkedAt ? time(state.checkedAt) : "—");
  }

  function renderAccount() {
    const account = object(state.snapshot?.account);
    const config = object(state.snapshot?.config);
    const netPnl = isNumber(account.equity) && isNumber(account.startingBalance)
      ? account.equity - account.startingBalance : undefined;
    setText("account-id", text(account.id, "PAPER-001"));
    setMetric("equity", account.equity);
    setText("equity-note", isNumber(account.startingBalance) ? `${money(account.startingBalance)} initial virtual capital` : "Virtual funds · starting balance unreported");
    setMetric("net-pnl", netPnl, signedMoney, true);
    setMetric("net-return", account.netReturnPct, (value) => `${percent(value, true)} since inception · net of costs`, true);
    setMetric("cash", account.cash);
    setText("cash-note", isNumber(account.dayPnl) ? `Day P&L ${signedMoney(account.dayPnl)}` : "Unallocated virtual USD");
    setMetric("exposure", account.exposure);
    const exposurePct = isNumber(account.exposure) && isNumber(account.equity) && account.equity > 0
      ? account.exposure / account.equity * 100 : undefined;
    setText("exposure-note", `${percent(exposurePct)} of equity · ${ratioPercent(config.maxExposure)} limit`);
    setMetric("drawdown", account.drawdownPct, percent);
    setText("drawdown-note", `Maximum observed ${percent(account.maxDrawdownPct)}`);
    setMetric("realized-pnl", account.realizedPnl, signedMoney, true);
    setMetric("unrealized-pnl", account.unrealizedPnl, signedMoney, true);
    setMetric("total-fees", account.totalFees);
  }

  function renderMarkets() {
    const markets = rows(state.snapshot?.market);
    const decisions = newest(state.snapshot?.decisions);
    const symbols = ["BTC-USD", "ETH-USD"];
    const fragment = document.createDocumentFragment();
    for (const symbol of symbols) {
      const market = markets.find((item) => item.symbol === symbol) || {};
      const decision = decisions.find((item) => item.symbol === symbol) || {};
      const article = element("article", "market-item");
      article.setAttribute("aria-label", symbol);
      const row = element("div", "market-row");
      const asset = element("div", "asset-name");
      const emblem = element("span", `asset-emblem${symbol === "ETH-USD" ? " eth" : ""}`, symbol === "BTC-USD" ? "₿" : "◇");
      emblem.setAttribute("aria-hidden", "true");
      const name = element("div");
      name.append(element("strong", "", symbol), element("small", "", symbol === "BTC-USD" ? "Bitcoin" : "Ethereum"));
      asset.append(emblem, name);
      row.append(asset, element("span", "market-price", money(market.price)));
      const signal = element("div", "market-signal");
      signal.append(element("span", "", "Last decision"), element("span", "signal-tag", text(decision.signal, text(market.signal, "Pending"))));
      article.append(row, signal);
      article.append(element("p", "decision-reason", text(decision.reason, "No published decision for this asset.")));
      article.append(element("p", "decision-time", `Decision ${time(decision.time)}`));
      article.append(element("p", "decision-time", `Price as of ${time(market.asOf)}`));
      fragment.append(article);
    }
    $("markets").replaceChildren(fragment);
  }

  function renderPositions() {
    const positions = newest(state.snapshot?.positions, "entryTime");
    const target = $("positions-table");
    const available = Array.isArray(state.snapshot?.positions);
    setText("position-count", available ? String(positions.length) : "—");
    if (positions.length === 0) {
      emptyRow(target, 5, available ? "No open positions. Cash is a position, too." : "Position data has not been published.");
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const position of positions) {
      const row = element("tr");
      const asset = cell(text(position.symbol), "cell-symbol");
      appendDetail(asset, `${number(position.quantity)} units`, "mono");
      const entry = cell(money(position.entryPrice), "numeric");
      appendDetail(entry, time(position.entryTime));
      const stopTarget = cell(money(position.stop), "numeric");
      appendDetail(stopTarget, `Target ${money(position.target)}`);
      row.append(asset, entry, cell(money(position.markPrice), "numeric"), stopTarget,
        setTone(cell(signedMoney(position.unrealizedPnl), "numeric"), position.unrealizedPnl));
      fragment.append(row);
    }
    target.replaceChildren(fragment);
  }

  function renderFills() {
    const fills = newest(state.snapshot?.fills);
    const available = Array.isArray(state.snapshot?.fills);
    const visible = state.allFills ? fills : fills.slice(0, 12);
    const target = $("fills-table");
    setText("fill-count", available ? String(fills.length) : "—");
    $("show-fills").hidden = fills.length <= 12;
    $("show-fills").setAttribute("aria-expanded", String(state.allFills));
    setText("show-fills", state.allFills ? "Show latest 12" : `Show all ${fills.length} fills`);
    setText("ledger-description", available ? `${visible.length} of ${fills.length} hypothetical fills · newest first` : "Fill history is unavailable.");
    if (visible.length === 0) {
      emptyRow(target, 7, available ? "No fills yet. The simulator waits for a qualifying closed-bar signal." : "The fill ledger has not been published.");
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const fill of visible) {
      const row = element("tr");
      const asset = cell(text(fill.symbol), "cell-symbol");
      appendDetail(asset, text(fill.reason, "Reason not supplied"), "cell-reason");
      const side = cell("");
      side.append(element("span", `fill-side${fill.side === "BUY" ? " buy" : ""}`, text(fill.side)));
      const realized = fill.side === "BUY" ? null : fill.realizedPnl;
      row.append(cell(time(fill.time), "mono"), asset, side, cell(number(fill.quantity), "numeric"),
        cell(money(fill.price), "numeric"), cell(money(fill.fee), "numeric"), setTone(cell(signedMoney(realized), "numeric"), realized));
      fragment.append(row);
    }
    target.replaceChildren(fragment);
  }

  function renderActivity() {
    const items = newest(state.snapshot?.activity).slice(0, 6);
    const target = $("activity-list");
    if (!items.length) {
      target.replaceChildren(element("li", "section-empty", Array.isArray(state.snapshot?.activity) ? "No simulator events recorded yet." : "Activity has not been published."));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const li = element("li", "activity-item");
      li.dataset.level = text(item.level, "info").toLowerCase();
      const eventTime = element("time", "", time(item.time));
      if (timestamp(item.time) !== null) eventTime.dateTime = item.time;
      li.append(element("span", "activity-level", text(item.level, "info")), element("p", "", text(item.message, "Event message unavailable.")), eventTime);
      fragment.append(li);
    }
    target.replaceChildren(fragment);
  }

  function renderRisk() {
    const config = object(state.snapshot?.config);
    const entries = [
      ["Risk per trade", ratioPercent(config.riskPerTrade), "of equity"],
      ["Total exposure cap", ratioPercent(config.maxExposure), "of equity"],
      ["Per-position cap", ratioPercent(config.maxPositionExposure), "of equity"],
      ["Open positions cap", number(config.maxPositions), "positions"],
      ["Daily loss limit", ratioPercent(config.dailyLossLimit), ""],
      ["Drawdown halt", ratioPercent(config.maxDrawdown), ""],
      ["Fee per side", ratioPercent(config.feeRate), ""],
      ["Slippage per side", ratioPercent(config.slippageRate), ""],
    ];
    const fragment = document.createDocumentFragment();
    for (const [label, value, unit] of entries) {
      const item = detailRow(label, value);
      if (unit) item.lastElementChild.append(element("small", "", unit));
      fragment.append(item);
    }
    $("risk-grid").replaceChildren(fragment);
    const strategy = $("strategy-detail");
    strategy.replaceChildren(
      element("p", "", "Long only, no leverage. Signals are evaluated after a closed bar; hypothetical entries use the next bar’s open, with configured fees and slippage. Historical catch-up is not live execution."),
      element("p", "", `Published parameters: ${number(config.intervalMinutes)}-minute bars · EMA ${number(config.emaFast)} / ${number(config.emaSlow)} · ${number(config.breakoutBars)}-bar breakout · ATR ${number(config.atrPeriod)} · stop ${number(config.stopAtr)}× ATR · target ${number(config.targetR)}R · maximum hold ${number(config.maxHoldBars)} bars.`),
      element("p", "", "Risk limits constrain the model; they do not guarantee loss limits, execution prices or profitability."),
    );
  }

  function svgElement(tag, attributes = {}, content) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function renderChart() {
    const allPoints = rows(state.snapshot?.equityHistory)
      .filter((point) => isNumber(point.equity) && timestamp(point.time) !== null)
      .sort((a, b) => timestamp(a.time) - timestamp(b.time));
    // Relative ranges are anchored to the last recorded point, not fabricated current data.
    const latestTime = allPoints.length ? timestamp(allPoints[allPoints.length - 1].time) : null;
    const cutoff = state.range === "all" || latestTime === null ? -Infinity : latestTime - Number(state.range) * 86_400_000;
    const points = allPoints.filter((point) => timestamp(point.time) >= cutoff);
    const chart = $("equity-chart");
    const title = svgElement("title", { id: "chart-title" }, "Forward paper account equity in USD");
    const description = svgElement("desc", { id: "chart-description" });
    chart.replaceChildren(title, description);
    $("chart-empty").hidden = points.length > 0;
    setText("chart-count", `${points.length} recorded ${points.length === 1 ? "point" : "points"}`);
    const table = $("equity-table");
    if (!points.length) {
      description.textContent = "No valid recorded forward equity is available. No illustrative data is shown.";
      setText("chart-period", "Waiting for the first recorded point");
      emptyRow(table, 4, "No recorded equity in this range.");
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const point of points.slice().reverse()) {
      const row = element("tr");
      row.append(cell(time(point.time), "mono"), cell(money(point.equity), "numeric"),
        cell(money(point.cash), "numeric"), cell(percent(point.drawdownPct), "numeric"));
      fragment.append(row);
    }
    table.replaceChildren(fragment);
    const first = points[0];
    const last = points[points.length - 1];
    let low = Infinity;
    let high = -Infinity;
    for (const point of points) {
      low = Math.min(low, point.equity);
      high = Math.max(high, point.equity);
    }
    description.textContent = `${points.length} recorded account equity points, ${time(first.time)} to ${time(last.time)}. First ${money(first.equity)}, latest ${money(last.equity)}, low ${money(low)}, high ${money(high)}. Historical research is excluded. The table below contains each recorded point.`;
    setText("chart-period", `${time(first.time)} — ${time(last.time)}`);
    const width = Math.max($("chart-wrap").clientWidth || 880, 250);
    const narrow = width < 560;
    const height = chart.clientHeight || (narrow ? 235 : 300);
    const padding = { left: 14, right: 78, top: 20, bottom: 34 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const startBalance = state.snapshot?.account?.startingBalance;
    if (isNumber(startBalance)) {
      low = Math.min(low, startBalance);
      high = Math.max(high, startBalance);
    }
    const margin = Math.max((high - low) * 0.17, Math.abs(high) * 0.0005, 1);
    low -= margin;
    high += margin;
    const start = timestamp(first.time);
    const end = timestamp(last.time);
    const x = (point) => start === end ? padding.left + plotWidth / 2 : padding.left + (timestamp(point.time) - start) / (end - start) * plotWidth;
    const y = (value) => padding.top + (high - value) / (high - low) * plotHeight;
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const defs = svgElement("defs");
    const gradient = svgElement("linearGradient", { id: "equity-fill", x1: "0", y1: "0", x2: "0", y2: "1" });
    gradient.append(svgElement("stop", { offset: "0%", "stop-color": "#84e6bc", "stop-opacity": ".13" }),
      svgElement("stop", { offset: "100%", "stop-color": "#84e6bc", "stop-opacity": "0" }));
    defs.append(gradient);
    chart.append(defs);
    for (let index = 0; index <= 4; index += 1) {
      const value = high - (high - low) * index / 4;
      const axisY = y(value);
      chart.append(svgElement("line", { x1: padding.left, y1: axisY, x2: width - padding.right, y2: axisY, class: "chart-grid" }));
      chart.append(svgElement("text", { x: width - padding.right + 12, y: axisY + 4, class: "chart-axis" },
        new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)));
    }
    const ticks = narrow ? 3 : 5;
    for (let index = 0; index < ticks; index += 1) {
      const tickTime = start + (end - start) * index / (ticks - 1);
      const axisX = padding.left + plotWidth * index / (ticks - 1);
      chart.append(svgElement("line", { x1: axisX, y1: padding.top, x2: axisX, y2: height - padding.bottom, class: "chart-grid" }));
      if (start === end && index !== Math.floor(ticks / 2)) continue;
      const label = end - start < 86_400_000 ? shortTimeFormat.format(new Date(tickTime)) : shortDateFormat.format(new Date(tickTime));
      chart.append(svgElement("text", { x: axisX, y: height - 10, class: "chart-axis", "text-anchor": index === 0 ? "start" : index === ticks - 1 ? "end" : "middle" }, label));
    }
    if (isNumber(startBalance)) chart.append(svgElement("line", {
      x1: padding.left, y1: y(startBalance), x2: width - padding.right, y2: y(startBalance), class: "chart-baseline",
    }));
    const coordinates = points.map((point) => `${x(point).toFixed(2)},${y(point.equity).toFixed(2)}`);
    if (points.length > 1) {
      chart.append(svgElement("path", { d: `M${coordinates.join(" L")} L${x(last)},${height - padding.bottom} L${x(first)},${height - padding.bottom} Z`, fill: "url(#equity-fill)" }));
      chart.append(svgElement("path", { d: `M${coordinates.join(" L")}`, class: "chart-path" }));
    }
    const dot = svgElement("circle", { cx: x(last), cy: y(last.equity), r: 4, class: "chart-point" });
    dot.append(svgElement("title", {}, `${money(last.equity)} at ${time(last.time)}`));
    chart.append(dot);
  }

  const researchMetrics = [
    ["Starting virtual capital", "startingBalance", money],
    ["Ending equity", "endingEquity", money],
    ["Net return", "netReturnPct", (value) => percent(value, true), true],
    ["Maximum drawdown", "maxDrawdownPct", percent],
    ["Trades", "tradeCount", number],
    ["Win rate", "winRatePct", percent],
    ["Profit factor", "profitFactor", (value) => value === null ? "Undefined" : isNumber(value) ? value.toFixed(2) : "—"],
    ["Total fees", "totalFees", money],
    ["Fee per side", "feeRate", ratioPercent],
    ["Slippage per side", "slippageRate", ratioPercent],
    ["Cash benchmark", "cashReturnPct", (value) => percent(value, true)],
    ["Buy-and-hold benchmark", "buyAndHoldReturnPct", (value) => percent(value, true)],
  ];

  function renderResearch() {
    const report = state.research;
    const status = $("research-status");
    $("research-content").hidden = !report;
    status.hidden = Boolean(report && !state.researchError);
    status.className = `research-status${state.researchError ? " is-error" : ""}`;
    if (state.researchError) {
      status.textContent = `${state.researchError} ${report ? "Showing the previously loaded report, which may be out of date." : "Research is pending or unavailable. No results are assumed."} Refresh to retry.`;
    } else if (!report) {
      status.textContent = "Research is pending. Training, holdout and cost-stress metrics will appear only after a report is published.";
    }
    if (!report) return;
    setText("research-assessment", text(report.assessment, "No published assessment. These historical results do not validate profitability."));
    const splits = object(report.split);
    const groups = [object(report.training), object(report.holdout), object(report.stress)];
    const dates = [
      [groups[0].from ?? splits.trainFrom, groups[0].to ?? splits.trainTo],
      [groups[1].from ?? splits.holdoutFrom, groups[1].to ?? splits.holdoutTo],
      [groups[2].from ?? splits.holdoutFrom, groups[2].to ?? splits.holdoutTo],
    ];
    const fragment = document.createDocumentFragment();
    const period = element("tr", "research-period");
    period.append(cell("Evaluation window (UTC)"));
    for (const [from, to] of dates) period.append(cell(`${date(from)} — ${date(to)}`));
    fragment.append(period);
    for (const [label, key, formatter, emphasize] of researchMetrics) {
      const row = element("tr", emphasize ? "metric-emphasis" : "");
      row.append(cell(label));
      for (const group of groups) row.append(cell(formatter(group[key])));
      fragment.append(row);
    }
    $("research-table").replaceChildren(fragment);
    setText("research-generated", `Published ${time(report.generatedAt)}`);
    setText("research-methodology", text(report.methodology, "Methodology has not been supplied. Do not infer independent validation from these metrics."));
    const data = object(report.data);
    const counts = object(data.barsPerSymbol);
    const parameters = object(report.parameters);
    const provenance = [
      ["Provider", text(report.provider)],
      ["Markets", Array.isArray(report.symbols) ? report.symbols.filter((value) => typeof value === "string").join(" · ") || "—" : "—"],
      ["Bar interval", isNumber(report.intervalMinutes) ? `${report.intervalMinutes} minutes` : "—"],
      ["Source window", `${time(data.from)} — ${time(data.to)}`],
      ["Bars per market", `BTC-USD: ${number(counts["BTC-USD"])} · ETH-USD: ${number(counts["ETH-USD"])}`],
      ["Data SHA-256", text(data.sha256)],
      ["Historical parameters", `EMA ${number(parameters.emaFast)} / ${number(parameters.emaSlow)} · breakout ${number(parameters.breakoutBars)} · ATR ${number(parameters.atrPeriod)} · stop ${number(parameters.stopAtr)}× ATR · target ${number(parameters.targetR)}R · max hold ${number(parameters.maxHoldBars)} bars`],
      ["Stress definition", "Holdout period with double the baseline fee rate and slippage rate; no change to the forward account."],
    ];
    $("research-provenance").replaceChildren(...provenance.map(([key, value]) => detailRow(key, value)));
  }

  function renderSnapshot() {
    renderAccount();
    renderMarkets();
    renderPositions();
    renderFills();
    renderActivity();
    renderRisk();
    renderChart();
    renderStatus();
  }

  async function fetchJSON(path) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = new URL(path, window.location.href);
      url.searchParams.set("_", String(Date.now()));
      const response = await fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid JSON object");
      return data;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function failureMessage(error, source) {
    if (error?.name === "AbortError") return `The ${source} request timed out.`;
    if (error instanceof SyntaxError) return `The published ${source} is not valid JSON.`;
    return `Unable to load the ${source}${error?.message?.startsWith("HTTP ") ? ` (${error.message})` : ""}.`;
  }

  async function refresh() {
    if (state.fetching) return;
    state.fetching = true;
    $("refresh").disabled = true;
    $("refresh").setAttribute("aria-busy", "true");
    const snapshotTask = (async () => {
      try {
        const snapshot = await fetchJSON("./data/snapshot.json");
        if (!snapshot.meta && !snapshot.account) throw new Error("Unrecognized snapshot");
        if (snapshot.meta?.schemaVersion !== undefined && snapshot.meta.schemaVersion !== 1) throw new Error("Unsupported snapshot schema");
        state.snapshot = snapshot;
        state.snapshotError = "";
        renderSnapshot();
      } catch (error) {
        state.snapshotError = failureMessage(error, "account snapshot");
      } finally {
        state.checkedAt = new Date().toISOString();
        renderStatus();
      }
    })();
    const researchTask = (async () => {
      try {
        const research = await fetchJSON("./data/research.json");
        const hasMetrics = [research.training, research.holdout, research.stress]
          .some((value) => Object.keys(object(value)).length > 0);
        state.research = hasMetrics ? research : null;
        state.researchError = "";
      } catch (error) {
        state.researchError = failureMessage(error, "research report");
      }
      renderResearch();
    })();
    try {
      await Promise.all([snapshotTask, researchTask]);
    } finally {
      state.fetching = false;
      $("refresh").disabled = false;
      $("refresh").removeAttribute("aria-busy");
    }
  }

  $("refresh").addEventListener("click", refresh);
  $("show-fills").addEventListener("click", () => {
    state.allFills = !state.allFills;
    renderFills();
  });
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.range = button.dataset.range;
      document.querySelectorAll("[data-range]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      renderChart();
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      renderStatus();
      if (!state.checkedAt || Date.now() - timestamp(state.checkedAt) >= POLL_MS) refresh();
    }
  });
  let resizeTimeout;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimeout);
    resizeTimeout = window.setTimeout(renderChart, 150);
  });
  window.setInterval(refresh, POLL_MS);
  window.setInterval(renderStatus, 15_000);
  refresh();
})();
