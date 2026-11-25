// Rebound Rider — pump.fun paper-trading bot for make.fun's
// "Pump.fun Paper Sprint: Any Bot Can Win" (agent-fun/replay/v2).
//
// Idea: on a 6-hour window most pump.fun coins either pop early and fade or
// dump then bounce. This bot buys each coin at most once, on one of two
// confirmed moves, and exits fast so the 5 open-position slots keep turning
// over (the guardrail needs a >= 0.01 SOL round trip on >= 20 coins):
//
//   A. Momentum breakout: price up >= 10% from its first-seen price, after
//      at least 5 trades (v4: strict bar — v1's +6%/3-trade chase filled
//      late at the top; v2 showed dip-only is the better half, this tests
//      whether a strong trend adds anything on top of it).
//   B. Dip bounce: price peaked >= 10% above first-seen, fell >= 12% from
//      that peak, then bounced >= 4% off the dip low. We buy the turn, not
//      the falling knife.
//
// Exits, measured against the filled cost basis (cost per token held):
//   take profit +10%, trailing stop -2% off the peak once the peak is +4%,
//   hard stop -4%, stale exit after 2000 slots without reaching +3% (frees
//   the slot for a fresher coin). Sells are always the full position.
//
// All math is integer (BigInt) ratios on the curve's virtual reserves, so
// the two graded executions agree byte for byte. No clock, no randomness,
// no network, no environment reads. Diagnostics go to stderr only.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

const SCALE = 1_000_000_000_000n; // price scale: quote lamports per token * 1e12
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per buy
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL (guardrail floor)
const BUY_SLIPPAGE_BPS = 2_000;
const SELL_SLIPPAGE_BPS = 10_000;

const MOMENTUM_TRADES = 5;
const MOMENTUM_BPS = 1_000; // +10% vs first-seen price (v4: strict momentum back on)
const DIP_PEAK_BPS = 1_000; // peak >= +10% vs first-seen
const DIP_DROP_BPS = 1_200; // fell >= 12% from the peak
const DIP_BOUNCE_BPS = 400; // bounced >= 4% off the dip low (v2 setting)

const TAKE_PROFIT_BPS = 1_000; // +10% vs cost basis
const TRAIL_ARM_BPS = 400; // trailing arms once peak is +4%
const TRAIL_BPS = 200; // -2% off the peak since entry
const STOP_BPS = 400; // -4% hard stop vs cost basis
const STALE_SLOTS = 2_000; // ~13 min with no progress: free the slot
const STALE_BPS = 300; // stale exit unless already +3%

function priceOf(curve: {
  virtual_quote_reserves: bigint;
  virtual_token_reserves: bigint;
}): bigint {
  if (curve.virtual_token_reserves === 0n) return 0n;
  return (curve.virtual_quote_reserves * SCALE) / curve.virtual_token_reserves;
}

/** A coin we have seen, with its price history since first sight. */
interface Track {
  first: bigint;
  peak: bigint;
  /** Lowest price since the peak was last set. */
  low: bigint;
  trades: number;
  /** True once a buy was sent for this coin (one buy per coin, ever). */
  decided: boolean;
}

/** A position we hold, with its cost basis and peak since entry. */
interface Held {
  costPerToken: bigint;
  peak: bigint;
  entrySlot: number;
}

const tracks = new Map<string, Track>();
const held = new Map<string, Held>();

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // ---- exits: one pass over what we hold -------------------------------
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        held.delete(mint);
        continue;
      }
      const price = priceOf(curve);
      if (price === 0n) continue;
      let h = held.get(mint);
      if (h === undefined) {
        h = {
          costPerToken: (pos.cost_lamports * SCALE) / pos.token_amount,
          peak: price,
          entrySlot: state.slot,
        };
        held.set(mint, h);
      }
      if (price > h.peak) h.peak = price;
      const cost = h.costPerToken;
      const takeProfit = (price * 10_000n) / cost >= 10_000n + BigInt(TAKE_PROFIT_BPS);
      const trailing =
        (h.peak * 10_000n) / cost >= 10_000n + BigInt(TRAIL_ARM_BPS) &&
        (price * 10_000n) / h.peak <= 10_000n - BigInt(TRAIL_BPS);
      const stopped = (price * 10_000n) / cost <= 10_000n - BigInt(STOP_BPS);
      const stale =
        state.slot - h.entrySlot > STALE_SLOTS &&
        (price * 10_000n) / cost < 10_000n + BigInt(STALE_BPS);
      if (takeProfit || trailing || stopped || stale) {
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        held.delete(mint);
        console.error(
          `sell ${mint.slice(0, 8)} price=${price} cost=${cost} tp=${takeProfit} trail=${trailing} stop=${stopped} stale=${stale}`,
        );
      }
    }
    // Drop held records for positions that are gone (sold, completed, flattened).
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // ---- entries: one pass over this batch's events ----------------------
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const mint = e.mint;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve);
      if (price === 0n) continue;
      let t = tracks.get(mint);
      if (t === undefined) {
        t = { first: price, peak: price, low: price, trades: 0, decided: false };
        tracks.set(mint, t);
      }
      if (e.event === 'TradeEvent') t.trades += 1;
      if (price > t.peak) {
        t.peak = price;
        t.low = price;
      } else if (price < t.low) {
        t.low = price;
      }
      if (t.decided) continue;
      if (state.positions.has(mint)) {
        t.decided = true;
        continue;
      }
      // A buy already in flight for this mint also counts as decided.
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) {
          pendingBuy = true;
          break;
        }
      }
      if (pendingBuy) {
        t.decided = true;
        continue;
      }
      const momentum =
        t.trades >= MOMENTUM_TRADES &&
        (price * 10_000n) / t.first >= 10_000n + BigInt(MOMENTUM_BPS);
      const dipBounce =
        (t.peak * 10_000n) / t.first >= 10_000n + BigInt(DIP_PEAK_BPS) &&
        (price * 10_000n) / t.peak <= 10_000n - BigInt(DIP_DROP_BPS) &&
        (price * 10_000n) / t.low >= 10_000n + BigInt(DIP_BOUNCE_BPS);
      if (!momentum && !dipBounce) continue;
      const cap = state.maxBuyLamports(mint);
      let amount = STAKE_LAMPORTS;
      if (cap < amount) amount = cap;
      if (free - tx < amount) amount = free - tx;
      if (amount < MIN_BUY_LAMPORTS) continue; // cap/cash too small yet: retry later
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      t.decided = true;
      free -= amount + tx;
      slots -= 1;
      console.error(
        `buy ${mint.slice(0, 8)} ${momentum ? 'momentum' : 'dip-bounce'} amount=${amount} price=${price} first=${t.first} peak=${t.peak} low=${t.low}`,
      );
    }
    return orders;
  },
});
