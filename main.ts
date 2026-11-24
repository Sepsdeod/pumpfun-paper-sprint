// Pump.fun Paper Sprint — "many small runners" momentum bot.
//
// Idea: on a 6-hour window, most new pump.fun curves either die fast or run
// hard for a short while. This bot fishes for the runners with many small,
// identical bets placed EARLY — only in a coin's first minutes of life —
// and gets out fast, win or lose:
//
//   * ENTRY — only coins younger than 60 batches since their CreateEvent.
//     The opening tape must show real buying: at least 3 buy trades from at
//     least 3 distinct wallets, net SOL inflow above 0.2 SOL, price up
//     2%-60% from its create price, real SOL reserves between 0.3 and 30
//     SOL, and the creator must not have sold yet. One buy of 0.05 SOL per
//     coin, at most 5 open, at most 2 entries per coin.
//   * EXIT — sell the whole position on the first of: +20% take-profit vs
//     cost, -8% stop-loss vs cost, an 8% pullback from the position's peak
//     value, a 120-batch time limit, or the coin's creator selling while
//     held. The replay closes completed curves by itself.
//   * SPREAD — 0.05 SOL buys clear the 0.01 SOL minimum round-trip bar
//     with room for fees, and the capital keeps rotating onto fresh coins
//     instead of piling into one.
//
// Deterministic: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream. Diagnostics go to stderr;
// stdout carries replies only.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type BuyInput, type OrderInput, type Pubkey, type SellInput } from './vendor/makefun-bot.ts';

// --- tuning constants (SOL units unless noted) -------------------------------
const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per entry
const MIN_BUY_TRADES = 3;
const MIN_BUYERS = 3;
const MIN_NET_INFLOW_SOL = 0.2;
const MIN_PRICE_UP = 0.02;
const MAX_PRICE_UP = 0.6;
const MIN_REAL_SOL = 0.3;
const MAX_REAL_SOL = 30;
const MAX_ENTRY_AGE_BATCHES = 60; // only buy coins this young
const TAKE_PROFIT = 1.2; // sell when value >= cost * 1.20
const STOP_LOSS = 0.92; // sell when value <= cost * 0.92
const TRAIL_DROP = 0.92; // sell when value <= peak value * 0.92
const MAX_HOLD_BATCHES = 120;
const COOLDOWN_BATCHES = 300;
const MAX_ENTRIES_PER_MINT = 2;
const MAX_SLIPPAGE_BPS = 10_000;

// --- per-curve tape ----------------------------------------------------------
interface Tape {
  firstPrice: number; // SOL per token when first seen
  buySol: number; // SOL spent by buyers in observed trades
  sellSol: number; // SOL taken out by sellers in observed trades
  buyTrades: number;
  buyers: Set<string>;
  seenSeq: number;
  creator: string | null; // wallet that created the curve
  creatorSold: boolean; // the creator has sold some of their own coins
}

interface Held {
  cost: bigint; // lamports spent (fees included), as reported by the account
  entrySeq: number; // batch seq of the buy fill
  peakValue: bigint; // best mark-to-market value seen (lamports)
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const entries = new Map<Pubkey, number>();
const lastExitSeq = new Map<Pubkey, number>();
const pendingBuy = new Set<Pubkey>();

/** Price in SOL per token from a curve's virtual reserves. */
function priceOf(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

/** Mark-to-market value of a token balance at the current price. */
function valueOf(state: BotState, mint: Pubkey, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

// --- strategy core -----------------------------------------------------------
function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const caps = state.hello.caps;
  const tx = state.txFeeLamports();

  // 1. Fold fills into our own books: buys that landed open a Held record,
  //    sells that landed close it. Harness closes (_complete_/_flatten_)
  //    arrive as fills too; dropping them from `held` keeps the map honest.
  for (const fill of batch.fills) {
    if (fill.status !== 'filled') {
      if (fill.side === 'buy') pendingBuy.delete(fill.mint);
      continue;
    }
    if (fill.side === 'buy') {
      pendingBuy.delete(fill.mint);
      const pos = state.positions.get(fill.mint);
      if (pos !== undefined) {
        held.set(fill.mint, { cost: pos.cost_lamports, entrySeq: batch.seq, peakValue: pos.cost_lamports });
      }
    } else {
      if (fill.client_id.startsWith('_')) {
        held.delete(fill.mint);
      } else if (!state.positions.has(fill.mint)) {
        held.delete(fill.mint);
        lastExitSeq.set(fill.mint, batch.seq);
      }
    }
  }

  // 2. Update tapes from this batch's events, and seed a tape for any curve
  //    first seen through a mark (its price becomes the reference price).
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const existing = tapes.get(e.mint);
      if (existing === undefined) {
        tapes.set(e.mint, {
          firstPrice: 0,
          buySol: 0,
          sellSol: 0,
          buyTrades: 0,
          buyers: new Set<string>(),
          seenSeq: batch.seq,
          creator: e.creator,
          creatorSold: false,
        });
      } else if (existing.creator === null) {
        existing.creator = e.creator;
      }
    } else if (e.event === 'TradeEvent') {
      let tape = tapes.get(e.mint);
      if (tape === undefined) {
        tape = { firstPrice: 0, buySol: 0, sellSol: 0, buyTrades: 0, buyers: new Set<string>(), seenSeq: batch.seq, creator: null, creatorSold: false };
        tapes.set(e.mint, tape);
      }
      const sol = Number(BigInt(e.sol_amount)) / 1e9;
      if (e.is_buy) {
        tape.buySol += sol;
        tape.buyTrades += 1;
        if (tape.buyers.size < 500) tape.buyers.add(e.user);
      } else {
        tape.sellSol += sol;
        if (tape.creator !== null && e.user === tape.creator) tape.creatorSold = true;
      }
    }
  }
  // Seed reference prices for tapes first seen in this batch.
  for (const e of batch.events) {
    const tape = tapes.get(e.mint);
    if (tape !== undefined && tape.firstPrice === 0) {
      const p = priceOf(state, e.mint);
      if (p > 0) tape.firstPrice = p;
    }
  }

  // 3. Exits first: take profit, stop loss, trailing stop, time limit.
  //    Exits free a slot before entries are considered in the same batch.
  let slots = caps.max_open_positions - state.committedPositionCount();
  for (const [mint, pos] of state.positions) {
    const h = held.get(mint);
    const value = valueOf(state, mint, pos.token_amount);
    if (value <= 0n) continue;
    if (h !== undefined && value > h.peakValue) h.peakValue = value;
    const cost = h !== undefined ? h.cost : pos.cost_lamports;
    const tape = tapes.get(mint);
    let exit = false;
    if (value >= (cost * 120n) / 100n) exit = true; // +20% (TAKE_PROFIT)
    else if (value <= (cost * 92n) / 100n) exit = true; // -8% (STOP_LOSS)
    else if (h !== undefined && value <= (h.peakValue * 92n) / 100n) exit = true; // -8% from peak (TRAIL_DROP)
    else if (h !== undefined && batch.seq - h.entrySeq >= MAX_HOLD_BATCHES) exit = true;
    else if (tape !== undefined && tape.creatorSold) exit = true; // creator is dumping
    if (!exit) continue;
    if (orders.length >= caps.max_orders_per_batch) break;
    const sell: SellInput = { side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
    orders.push(sell);
    held.delete(mint);
    lastExitSeq.set(mint, batch.seq);
  }

  // 4. Entries: walk this batch's mints in event order, buy the ones whose
  //    tape shows genuine buying pressure and a healthy early rise.
  let free = state.freeCashLamports();
  const seenThisBatch = new Set<Pubkey>();
  for (const e of batch.events) {
    const mint = e.mint;
    if (seenThisBatch.has(mint)) continue;
    seenThisBatch.add(mint);
    if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
    if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
    if ((entries.get(mint) ?? 0) >= MAX_ENTRIES_PER_MINT) continue;
    const lastExit = lastExitSeq.get(mint);
    if (lastExit !== undefined && batch.seq - lastExit < COOLDOWN_BATCHES) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const tape = tapes.get(mint);
    if (tape === undefined || tape.firstPrice <= 0) continue;
    if (batch.seq - tape.seenSeq > MAX_ENTRY_AGE_BATCHES) continue; // too old: the early run is over
    if (tape.creatorSold) continue; // creator already dumping
    if (tape.buyTrades < MIN_BUY_TRADES) continue;
    if (tape.buyers.size < MIN_BUYERS) continue;
    if (tape.buySol - tape.sellSol < MIN_NET_INFLOW_SOL) continue;
    const price = priceOf(state, mint);
    if (price <= 0) continue;
    const rise = price / tape.firstPrice - 1;
    if (rise < MIN_PRICE_UP || rise > MAX_PRICE_UP) continue;
    const realSol = Number(curve.real_quote_reserves) / 1e9;
    if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
    const cap = state.maxBuyLamports(mint);
    if (cap < STAKE_LAMPORTS) continue;
    if (free < STAKE_LAMPORTS + tx) continue;
    const buy: BuyInput = { side: 'buy', mint, quote_lamports: STAKE_LAMPORTS, max_slippage_bps: MAX_SLIPPAGE_BPS };
    orders.push(buy);
    pendingBuy.add(mint);
    entries.set(mint, (entries.get(mint) ?? 0) + 1);
    free -= STAKE_LAMPORTS + tx;
    slots -= 1;
  }

  return orders;
}

await runBot({ onBatch });
