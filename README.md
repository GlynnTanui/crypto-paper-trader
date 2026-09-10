# Crypto Paper Trader

**PAPER ONLY. $10,000 virtual USD. No real orders, exchange accounts, API keys, deposits, or withdrawals.**

[Open the dashboard](https://glynntanui.github.io/crypto-paper-trader/) |
[FundingPips $5,000 research](https://glynntanui.github.io/crypto-paper-trader/fundingpips.html) |
[Account controls and run history](https://github.com/GlynnTanui/crypto-paper-trader/actions/workflows/paper.yml) |
[Public durable data](https://github.com/GlynnTanui/crypto-paper-trader/tree/paper-data)

A dependency-free Node.js research engine and persistent simulated account with a read-only GitHub Pages trading terminal. BTC-USD and ETH-USD use only public Coinbase Exchange market candles. There is **no validated profitable strategy here**: the frozen rules lost money in the untouched holdout. This is an educational experiment, not an investment recommendation or an executable trading system.

## What is real, and what is simulated?

Market candles are real public market observations. Every balance, position, order fill, fee and P&L in the account is **simulated**. The account starts empty with $10,000; research trades and returns are never transferred into it. Historical research lives in a separately labeled dashboard section.

The forward account is a **hypothetical bar-based replay ledger starting at initialization**, not evidence of contemporaneous trading. Each job processes completed candles since the previous checkpoint. Even a normally scheduled run simulates earlier bar opens/closes after those bars have finished. Delayed runs replay missing bars with their historical timestamps, not the runner's wall-clock time. There is no market connectivity for real orders.

The repository, account, history and dashboard are **public** by explicit choice. Never add personal data, tokens, credentials or real financial account information. The browser only reads same-origin public JSON. It cannot place trades or persist account changes.

## Frozen strategy

Parameters are in [`src/config.js`](src/config.js), fingerprinted in persisted state and research. Changing parameters without an explicit state migration fails closed; research is not used to tune automation.

| Rule | Exact implementation |
| --- | --- |
| Market / bars | BTC-USD, then ETH-USD; long only, spot-style, no leverage; 15-minute UTC bars |
| Trend | EMA(20) > EMA(50), and close > EMA(20) |
| Trigger | Closed bar's close strictly exceeds the highest **high of the prior 20 bars**, excluding the signal bar |
| Indicator initialization | SMA-seeded EMAs and Wilder ATR(14), recomputed from a fixed window of 150 preceding bars plus the current bar; this makes batched and single-bar runs identical |
| Earliest entry | Next bar's open, plus adverse entry slippage; never at the signal bar's close |
| Entry gap filter | Skip if next open <= proposed stop, or absolute gap from signal close > signal ATR |
| Stop | Signal close minus 2 x signal ATR(14); fixed, never widened |
| Target | Entry fill price + 2 x (entry fill price - stop); fixed |
| Time exits | Close after 16 bars / 4 hours maximum; close at the 23:45-00:00 UTC bar's end regardless; no setup crosses midnight |
| Same-bar ambiguity | Stop wins if stop and target both touched, including entry bar |
| Opening gaps | Stop fills at worse opening price; target fills at target, never with favorable gap improvement |
| Intrabar timing | Stop/target fill timestamps use bar close as an interval label; the true touch time is unknown |
| Quantity | Floored to 8 decimals, limited by cash, exposure, and stop-distance risk **including modeled entry/exit fees and slippage** |
| Costs | 0.10% fee per side, 0.05% adverse slippage per side, charged on every fill; buy-and-hold pays the same entry and terminal exit costs |

Stop risk is a sizing budget, **not a guaranteed loss limit**. Opening gaps, price jumps and exit costs can exceed it. Fees are an explicit modeling assumption, not a verified Coinbase fee tier; actual retail taker fees, spread and slippage may be much higher. No queue position, partial fills, funding, tax, latency or order-book impact is modeled. A single-symbol setup is preferred by the fixed BTC-then-ETH ordering if capacity is scarce.

## Risk limits and account arithmetic

| Limit | Value / behavior |
| --- | --- |
| Starting balance | $10,000 virtual USD |
| Planned stop risk | 0.25% of opening marked equity per trade, inclusive of modeled costs |
| Position exposure | At entry, at most 25% of marked equity per asset |
| Total exposure | At entry, at most 50%; at most 2 simultaneous positions, 1 per asset |
| Daily loss guard | 1.5% of UTC day-start equity; realized and unrealized change included |
| Drawdown guard | 8% from the highest recorded candle-close equity; persistent halt |
| Pause | Discards pending entries and blocks new ones; existing stops, targets, time/session and risk exits still run |
| Resume | Allows future qualifying setups only; does not clear risk guards |

Risk checks run at bar open before entries and at bar close. Breaching a guard liquidates remaining positions at the modeled open/close with costs and blocks entries. Daily halt clears at the next UTC day boundary; maximum-drawdown halt does **not** clear on resume. There is deliberately no reset/fund-refill button. Any future reset or migration must explicitly preserve and archive the existing ledger. Limits are not intrabar guarantees, and exposure may drift above entry caps as prices change.

Cash equals starting cash minus buy notionals/fees plus sell notionals minus sell fees. Equity equals cash plus marked positions. Realized P&L includes both sides' fees on closed trades; unrealized P&L includes entry fees but not a hypothetical future exit fee. Net P&L equals realized plus unrealized. Monetary ledger fields are rounded to eight decimals, and reconciled within $0.00001. Each fill has a deterministic ID and a SHA-256 hash chain. Git commits add a second audit trail; a repository owner could rewrite Git history, so this is auditable, not tamper-proof custody.

## Historical research: initial frozen evaluation

Data: [Coinbase Exchange historical candles](https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles), fetched from `https://api.exchange.coinbase.com/products/{BTC-USD|ETH-USD}/candles?granularity=900`, with paginated UTC start/end parameters. Provider restrictions are respected; there is no alternate exchange, quote-currency substitution or synthetic fallback.

The initial dataset has **8,790 bars per symbol**, including 150 warmup bars: **2026-06-10 10:30 UTC through 2026-09-10 00:00 UTC (exclusive)**. It covers 90 evaluation days plus warmup. Training is **2026-06-12 through 2026-08-11**, holdout is **2026-08-11 through 2026-09-10**, all UTC with exclusive end dates. Parameters were chosen and frozen before results, with no fitting, optimization or holdout tuning. Both windows start independently at $10,000, with no inherited positions; terminal positions are liquidated with costs.

| Metric | Training (60 days) | Untouched holdout (30 days) | Holdout, doubled costs |
| --- | ---: | ---: | ---: |
| Net return | -8.14% | -7.51% | -8.09% |
| Ending virtual equity | $9,186.31 | $9,249.13 | $9,191.16 |
| Maximum candle-close drawdown | 8.14% | 8.09% | 8.09% |
| Closed trades | 87 | 132 | 88 |
| Win rate | 18.39% | 28.79% | 26.14% |
| Profit factor | 0.295 | 0.507 | 0.324 |
| Fees | $386.78 | $585.31 | $668.70 |
| Equal-weight BTC/ETH buy-and-hold | +5.93% | +26.79% | +26.41% |
| Cash benchmark | 0.00% | 0.00% | 0.00% |

**The strategy underperformed cash and buy-and-hold; all three runs hit the drawdown halt.** Risk guards can overshoot their threshold due to discrete bars and liquidation costs. Stress doubles fees to 0.20% and slippage to 0.10% per side, reruns cost-aware sizing, and can change the number of trades. Profit factor is gross winning trade P&L divided by absolute losing trade P&L, both net of costs; it is `null` when no losses make it undefined. Drawdown is measured at recorded bar closes, not the worst intrabar value. Buy-and-hold has 100% exposure, unlike the strategy's 50% cap, so its risk is not matched.

The exact full-precision report and the original public candles are versioned on `paper-data` as `research.json` and `research-candles.json`. Dataset SHA-256 (JSON-serialized market object): `1b05f9c3577a3d18e9ba6494df7f89825be83fc4cc9b048a4a9a8bcb66f47d5e`. Future explicitly requested research refreshes update the dashboard report, not this initial evaluation or the forward account. Data revisions may change a new provider fetch; use the committed cache for exact reproducibility.

## Run locally

### Separate FundingPips Standard research

**EXCHANGE-DATA PROXY - NOT VERIFIED FUNDINGPIPS PASS.** The [research page](https://glynntanui.github.io/crypto-paper-trader/fundingpips.html) publishes actual historical simulations of independent **$5,000** scenarios. They are not real FundingPips accounts or new live paper accounts. The original `PAPER-001`, its frozen parameters, $10,000 capital and disappointing initial research above remain unchanged. Research code never writes the `paper-data` account branch.

The [preregistration](research/fundingpips/protocol.json) was committed as `5284f5d` before broad-history acquisition and any candidate performance inspection. Four hypotheses (hourly trend breakout, trend pullback, range reversion and session breakout), two coarse parameters each, and two small cost-inclusive risk budgets (0.10% / 0.25%) define **all 16 candidates**. Economic hypotheses are not evidence of intraday profitability; the cited time-series-momentum literature concerns different instruments/horizons. There is no search for a lucky challenge path or post-final winning parameter.

**Result: none of the 16 candidates met the development criteria.** The development-only selection was committed as `b3a936e` before final execution. Its two diagnostic controls both lost money in the final window:

| Final Jan 1-Jun 9, 2026 | Pullback, 2 ATR / 0.10% risk | Reversion, 2.5 sigma / 0.10% risk |
| --- | ---: | ---: |
| Net return / ending virtual equity | -0.7525% / $4,962.37 | -0.3128% / $4,984.36 |
| Net profit factor / completed trades | 0.719 / 65 | 0.252 / 12 |
| Net expectancy per trade | -$0.58 | -$1.30 |
| Conservative intrabar DD / close DD | 1.171% / 1.120% | 0.466% / 0.456% |
| Double-cost / triple-cost return | -1.160% / -1.506% | -0.385% / -0.446% |
| 120-day base-cost two-phase scenarios | 0 passes, 6 pending, 17 censored | 0 passes, 15 inactivity, 3 pending, 5 censored |

Each horizon/cost group contains 23 overlapping starts. Only **6** starts have a full 120-day calendar horizon (15 for 60 days). In the 120-day full-horizon subset, pullback has 6 pending and reversion 3 inactivity / 3 pending. Neither scenario reached a two-phase pass; these are not probability estimates. Final cash returned 0%; fully invested, costed BTC/ETH buy-and-hold returned -37.224%, at very different risk. Both controls' fixed-path break-even friction estimates are negative: even zero costs would not have produced a positive gross-mid result. No candidate is recommended or activated.

The exact deterministic [report hash](research/fundingpips/results-hash.json) is `f63897243de116f53cc4f20a1eb295f45a1fb4f0f6469aee84be19865118379c`. The [full results](research/fundingpips/results.json), all development attempts and every predefined sensitivity remain published, including unfavorable results.

| Window | Use |
| --- | --- |
| 2024-01-01 to 2025-07-01 | Development training |
| 2025-07-01 to 2026-01-01 | Development validation and doubled-cost ranking |
| 2026-01-01 to 2026-06-10 | Final, never previously used by this project (not universally blind) |
| 2026-06-12 to 2026-09-10 | **Already-exposed** recent robustness context, never a fresh holdout |

Dates are UTC, with exclusive endpoints. Real Coinbase BTC/ETH spot observations start on 2023-12-18 for warmup. Validated 15-minute candles supply completed UTC hourly indicators; entries occur only at the immediately following eligible 15-minute open. All variants, rejection reasons, fixed selection, final stress/neighbor cases, ledgers and provenance are downloadable. Two distinct families are selected using development only; if no family qualifies, the predeclared ranking supplies **ineligible diagnostic controls**, not recommended strategies. An open data-gap path is ineligible regardless of its prefix return.

**Data gaps are not fabricated or hidden.** [Amendments](research/fundingpips/amendments.json) were committed before performance inspection. A1 allows a missing 15-minute candle to be reconstructed only from all three valid real Coinbase 5-minute source candles. A2 initially proposed whole-day completeness exclusions; **A3 supersedes that noncausal approach**. The primary simulation retains entries before an outage and resets the 336-hour indicator warmup only after missing data becomes observable. A flat gap leaves known cash unchanged. An open position at a gap halts its run/cohort as `data-indeterminate`, preserving unresolved inventory, entry fee and last-known marked equity without inventing an exit. Prefix metrics are not full-period returns. All affected cohorts remain counted. Missing timestamps, source repairs and gaps are public in the provenance; no interpolation or alternate exchange is used.

The separate CFD-style engine models long/short unit quantities, one position total, deterministic BTC-before-ETH priority, net free margin and 90% of available leveraged buying power. Ordinary evaluation leverage is 2x; the additional current Master 1x run is **leverage sensitivity only**, not funded-account compliance. Mon-Thu entries are 06:00-16:00 UTC, Friday 06:00-14:00 (end exclusive); flat by 20:00 daily or 16:00 Friday, with family-specific 4/6/8-hour maximum holds. Those cutoffs are conservative assumptions, not verified broker sessions. Stop-first ambiguity, adverse opening gaps, both-direction spread/slippage and fees, and cost-inclusive sizing are explicit. Close drawdown and a conservative favorable-before-adverse intrabar drawdown **bound** are separate. The bound is not observed tick chronology. Managed runs add a 1% daily internal stop and persistent 6% close-peak-to-adverse-equity stop; economic runs do not halt to conceal later losses.

| Per-side cost assumption | Commission | Half-spread | Adverse slippage | Total |
| --- | ---: | ---: | ---: | ---: |
| Base | 4 bps | 2 bps | 1 bp | 7 bps |
| Double | 8 bps | 4 bps | 2 bps | 14 bps |
| Triple | 12 bps | 6 bps | 3 bps | 21 bps |

The published crypto commission formula is conservatively interpreted as **0.04% per side**; its actual side convention, lot/contract sizes, minimum/step, spreads, swaps and symbol inventory remain unverified. These are **proxy costs, not actual FundingPips execution costs**. Break-even all-in bps divides gross mid-price P&L by two-sided mid-price turnover on the fixed simulated trades; a negative value means even zero friction did not suffice. Repriced stress runs resize and can change fills, unlike that fixed-path diagnostic. Equal-dollar BTC/ETH buy-and-hold pays the same entry and final exit costs but is not day-trading or risk matched; cash earns zero.

Official current new-purchase Standard rules were retrieved on **2026-09-10**; [Standard](https://help.fundingpips.com/hc/en-us/articles/34501809112081-2-Step-Standard) was updated at 08:46:42 UTC. Each phase starts at $5,000: phase 1 needs +$400 and phase 2 +$250, net realized and flat, with at least three assumed entry trading days each. Phase 2 begins on the subsequent UTC date after phase 1, without reusing its chronology; unknown administrative waiting is ignored. The fixed daily floor is 95% of `max(opening balance, opening equity)` at current UTC+3 midnight (21:00 UTC), not ratcheted on intraday profits; opening equity includes bid/ask proxy marks. Overall balance or equity touching $4,500 fails. Equity checks conservatively reserve liquidation costs. Fixed UTC+3 is counterfactually applied across history; historical DST and the firm's exact trading-day attribution are not verified. Thirty calendar days without a completed trade is inactivity.

Weekly starting cohorts use the final window and 60/120-day **analytical horizons, not firm deadlines**. Pass, modeled breach, internal risk stop, inactivity, pending, right-censored and data-indeterminate are distinct. Failed/indeterminate paths cannot resume into a pass. Both all-start and fully observed horizon counts are shown, as are sequential phase timings. Overlapping cohorts are dependent scenarios: their fractions are **not future passing probabilities**.

**Broker compliance stays indeterminate.** Spot OHLC is not CFD bid/ask or tick history. Actual minimum-lot/margin affordability on $5,000 is unknown. The authoritative historical news/speech calendar is unavailable; evaluation forbids deliberate news trading, and no verified news-compliance claim is made. Master event restrictions, temporary no-weekend-holding rule, idea-risk and payout requirements are distinct from evaluation. No payout cycle was selected. The page links all official rule sources and separately documents Master conditions; leverage sensitivity does not assess payouts. Zero swaps assume modeled early flat avoids an unverified rollover; crypto is not presumed swap-free.

No purchase, credentials, real orders, funded-account automation, webhook or API permission is implied. Do not connect GitHub Actions to FundingPips: account-access restrictions and owned-EA requirements still apply. An independent manual forward-demo would require verified broker contract/news/session details and genuinely new observations before drawing stronger conclusions.

Reproduce the separate published study from committed source and real-data cache (Node 22+, no dependencies):

```powershell
npm run fundingpips:verify
```

For an explicitly new research revision only, the separate acquisition/development/final commands are `npm run fundingpips:fetch`, `npm run fundingpips:development`, and `npm run fundingpips:final`. Development writes an immutable `selection.json` before final execution; changed source/data/development locks fail rather than silently reselecting. Final execution requires that exact lock. Reproduction uses a temporary directory and checks the deterministic report hash. Fetching uses incremental ignored `runtime/fundingpips-cache` pages; the gzip market archive and audit results live under `research/fundingpips/` on the source branch, **not** in the account's state. A refetch may revise provider data; use the committed archive for exact reproduction.

### Original paper account commands

Requires Node.js 22 or later. **No npm dependencies or install step.**

```powershell
npm test
npm run research
npm run simulate
npm run build
```

These commands create local ignored `runtime` data and a static `dist` site; they do not push, deploy, or trade. Serve `dist` over HTTP with a static server to preview it; opening HTML via `file://` cannot fetch JSON. `DATA_DIR` selects an explicit local data directory; `OUTPUT_DIR` selects build output. Default build output is `dist`, which is replaced on each build.

To reproduce the published report from the committed candles in a fresh clone:

```powershell
git clone --branch paper-data --single-branch https://github.com/GlynnTanui/crypto-paper-trader.git runtime
npm run research -- --cached
npm test
npm run build
```

Do not overwrite an existing local `runtime` folder; use a fresh clone or a separate `DATA_DIR`. The cached report retains its original dataset/split; the `generatedAt` timestamp records the reproduction time.

## Automation, controls and persistence

[`Paper account and Pages`](.github/workflows/paper.yml) runs on changes to `main`, manually, and at **:07, :22, :37, :52 each hour**. It runs the engine, validates the state, commits the durable `paper-data` branch, builds the static dashboard, and explicitly deploys Pages in the same workflow. This avoids relying on `GITHUB_TOKEN` pushes triggering another workflow.

Open [Actions -> Paper account and Pages -> Run workflow](https://github.com/GlynnTanui/crypto-paper-trader/actions/workflows/paper.yml), choose **main**, then:

| Control | Effect |
| --- | --- |
| `evaluate` | Process new closed bars once; retrying identical bars cannot duplicate fills |
| `pause` | Persistently pause new entries; continue protective/time exits on subsequent jobs |
| `resume` | Resume new signals without bypassing daily/drawdown guards |
| `refresh_research` | Optional fresh 90-day historical report, independent of the forward balance |

Only users with repository write access can dispatch controls. A pause/resume is applied before the unprocessed batch: it affects that whole hypothetical catch-up batch, not a precisely timestamped live market instruction. A valid pause persists even if market fetch fails. It cannot instantly exit a position; scheduled protective management can itself be delayed.

`paper-data` stores `state.json` (canonical account), `health.json`, `snapshot.json`, and research/cache files. This survives runner restarts and Pages artifact expiration. Fills and equity history are retained in full; the current JSON keeps the latest 2,000 signal decisions and 500 activity events, with prior versions retained in Git history. Jobs serialize under a repository-wide concurrency group without canceling a running job. Pending jobs may be replaced by GitHub; their missing bars are handled by the next successful replay. State pushes are ordinary fast-forward pushes, never forced; a conflict fails rather than overwriting another writer. Do not manually edit this branch during a run.

The workflow uses only standard Ubuntu GitHub-hosted runners and built-in repository tokens. Simulation has repository contents-write permission; the separate Pages job has pages-write and OIDC permission; CI has contents-read only. No browser secrets, paid external services or exchange credentials are used.

## Failure modes and limitations

- Every account is validated and reconciled before a state commit or build. Invalid schema, changed parameters, broken hashes, negative cash, duplicate fills and missing initialized state fail closed rather than resetting to $10,000.
- Candle timestamps, OHLC, numeric values, USD pairs, aligned coverage and closed-bar status are validated. Runtime allows a two-minute publication grace, and rejects a latest close older than 30 minutes. Missing, conflicting or invalid candles abort the whole batch.
- Network/timeouts, HTTP 408/429 and selected 5xx statuses retry at most four attempts with bounded exponential backoff. Authorization/region failures do not retry or bypass restrictions.
- Data errors retain the account and publish an error status when the account can still be validated. A corrupted ledger cannot be published; the prior site remains available and becomes visibly stale. Workflow failure remains red even if an error-state dashboard successfully deploys.
- More than seven days of missing account bars halts automatic catch-up for operator investigation, rather than silently skipping history. Recovery requires an explicit audited code/state procedure, not deleting the account. Public candle history is not a guaranteed service.
- GitHub scheduled Actions are **not continuous, guaranteed on time, or suitable for executable day trading**. Queue delays and outages can last much longer than 15 minutes; public repository schedules may automatically disable after **60 days of no repository activity**. Check Actions regularly and re-enable if necessary.
- Dashboard polling is every 60 seconds with cache busting. CDN caching may still delay updates. It shows market close time, last successful job, approximate next expected update, and a stale warning after 60 minutes. This is not a real-time price feed.
- Hash chaining and Git history help audit the simulation but do not prevent a repository administrator from rewriting history. This is not a brokerage account, audited fund track record, or a guarantee of present or future profit.

## Repository map

`src/engine.js` holds accounting and bar execution; `indicators.js` deterministic signals; `market.js` public candle validation/fetching; `research.js` independent research; `run.js` forward orchestration; `publish.js` public schema; `build.js` static publishing; `web/` the terminal UI; `test/` native Node tests; `.github/workflows/` CI, durable automation and deployment.
