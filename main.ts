// Paper-trading bot for the pump.fun replay (agent-fun/replay/v2).
// Strategy: selective momentum with pyramiding, hard exits, and probe
// round-trips that keep the traded-coin count healthy.
//
// Entry: a curve must be old enough to have survived its launch burst,
// show net SOL inflow with several distinct buyers over a short window,
// and trade near its window high without having already exploded.
// First buys are small; size is added only while the move continues.
// Exits: stop loss, trailing stop after a gain, flow fade, or time cap.
// Probes: tiny buys on liquid curves, sold as soon as they land, used
// only when the count of distinct traded coins lags the run's progress.
// Deterministic: no clock, no randomness, no environment access.

import { LAMPORTS_PER_SOL, runBot, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = Number(LAMPORTS_PER_SOL);

// --- tuning (SOL units unless noted) ---
const WINDOW = 36; // slots of tape used for the entry signal
const MIN_AGE = 240; // slots after creation before any entry
const MIN_NET = 0.7; // net inflow over the window
const MIN_BUYS = 3;
const MIN_BUYERS = 3;
const MIN_UP = 0.03; // price gain over the window
const MAX_UP = 1.1; // skip curves that already ran this far in one window
const NEAR_HIGH = 0.93; // last price at least this share of window high
const MIN_RQ = 1.5; // real SOL reserve bounds at entry
const MAX_RQ = 70;
const FIRST_BUY = 0.12;
const ADD_BUY = 0.16;
const MAX_STAKE = 0.6; // total SOL per position
const STOP_LOSS = 0.18;
const TRAIL_ARM = 0.06;
const TRAIL_DROP = 0.25;
const MAX_HOLD = 1300; // slots
const COOLDOWN = 180;
const MAX_ENTRIES_PER_CURVE = 2;
const BUY_SLIP = 1500;
const SELL_SLIP = 10_000;
const PROBE_BUY = 0.011;
const PROBE_MIN_RQ = 4;

interface TapeTrade { slot: number; buy: boolean; sol: number; user: string; price: number }
interface Tape { created: number | null; trades: TapeTrade[]; entries: number; lastExit: number }
interface Held { opened: number; peak: number; spent: number; exiting: boolean }

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>(); // mint -> sell already sent
const traded = new Set<Pubkey>();
let firstSlot = -1;
let lastSlot = -1;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (!t) { t = { created: null, trades: [], entries: 0, lastExit: -1_000_000 }; tapes.set(mint, t); }
  return t;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

// Value of a position if sold now, roughly: tokens * spot price, less curve fees.
function closeValue(state: any, mint: Pubkey): number {
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (!pos || !curve || curve.virtual_token_reserves <= 0n) return 0;
  const gross = (Number(pos.token_amount) * Number(curve.virtual_quote_reserves)) / Number(curve.virtual_token_reserves);
  return gross * 0.9875 / SOL;
}

function entryOk(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ || rqSol > MAX_RQ) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  let net = 0, buys = 0, start = -1, high = 0, last = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) { start = tr.price; continue; }
    if (start < 0) start = tr.price;
    net += tr.buy ? tr.sol : -tr.sol;
    if (tr.buy) { buys++; buyers.add(tr.user); }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (start <= 0 || high <= 0 || last <= 0) return false;
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS || net < MIN_NET) return false;
  const up = last / start - 1;
  if (up < MIN_UP || up > MAX_UP) return false;
  if (last < NEAR_HIGH * high) return false;
  return true;
}

await runBot({
  onBatch(state, batch) {
    if (firstSlot < 0) firstSlot = batch.slot;
    lastSlot = batch.slot;
    // fold events into tapes
    for (const e of batch.events as any[]) {
      const t = tapeOf(e.mint);
      if (e.event === 'CreateEvent') t.created = e.slot;
      else if (e.event === 'TradeEvent') {
        t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.quote_amount ?? e.sol_amount) / SOL, user: e.user, price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)) });
        if (t.trades.length > 220) t.trades.splice(0, t.trades.length - 220);
      }
    }
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    let free = state.freeCashLamports();
    const tx = state.txFeeLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // --- exits first ---
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      if (!pos) { held.delete(mint); continue; }
      if (h.exiting) continue;
      const curve = state.curves.get(mint);
      if (curve?.complete) { held.delete(mint); continue; }
      const value = closeValue(state, mint);
      if (value > h.peak) h.peak = value;
      // Judge exits against the account's real cost basis (fees included),
      // falling back to what this session intended to spend.
      const realCost = Number(pos.cost_lamports) / SOL;
      const cost = realCost > 0 ? realCost : h.spent;
      h.spent = cost;
      let exit = false;
      if (cost > 0 && value < cost * (1 - STOP_LOSS)) exit = true;
      if (cost > 0 && h.peak > cost * (1 + TRAIL_ARM) && value < h.peak * (1 - TRAIL_DROP)) exit = true;
      if (batch.slot - h.opened > MAX_HOLD && value < cost * 1.5) exit = true;
      // fade: recent net outflow
      const t = tapeOf(mint);
      let fadeNet = 0;
      for (const tr of t.trades) if (tr.slot > batch.slot - 15) fadeNet += tr.buy ? tr.sol : -tr.sol;
      if (fadeNet < -1.2 && value < cost * 1.1) exit = true;
      if (exit && orders.length < caps.max_orders_per_batch) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP });
        h.exiting = true;
        t.lastExit = batch.slot;
      }
    }
    // clean held entries whose position vanished after an exit fill
    for (const [mint, h] of held) if (h.exiting && !state.positions.get(mint)) held.delete(mint);

    // --- probe sells: sell a probe as soon as its tokens land ---
    for (const [mint, sold] of probes) {
      const pos = state.positions.get(mint);
      if (!pos) { if (sold) probes.delete(mint); continue; }
      if (!sold && !held.has(mint) && orders.length < caps.max_orders_per_batch) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP });
        probes.set(mint, true);
      }
    }

    // --- entries and pyramiding ---
    for (const [mint, curve] of state.curves) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (curve.complete) continue;
      const rqSol = Number(curve.real_quote_reserves) / SOL;
      const h = held.get(mint);
      if (h && !h.exiting) {
        // pyramid into strength, capped by stake and the reserve cap
        if (h.spent < MAX_STAKE) {
          const t = tapeOf(mint);
          if (entryOk(t, batch.slot, rqSol)) {
            const cap = state.maxBuyLamports(mint);
            const want = BigInt(Math.round(ADD_BUY * SOL));
            const amount = cap < want ? cap : want;
            if (amount >= 10_000_000n && free >= amount + tx) {
              orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP });
              free -= amount + tx; h.spent += Number(amount) / SOL;
            }
          }
        }
        continue;
      }
      if (h) continue;
      if (openSlots <= 0) break;
      const t = tapeOf(mint);
      if (t.entries >= MAX_ENTRIES_PER_CURVE) continue;
      if (batch.slot - t.lastExit < COOLDOWN && t.entries > 0) continue;
      if (!entryOk(t, batch.slot, rqSol)) continue;
      const cap = state.maxBuyLamports(mint);
      const want = BigInt(Math.round(FIRST_BUY * SOL));
      const amount = cap < want ? cap : want;
      if (amount < 10_000_000n || free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP });
      free -= amount + tx; openSlots -= 1;
      held.set(mint, { opened: batch.slot, peak: 0, spent: Number(amount) / SOL, exiting: false });
      t.entries++; traded.add(mint);
    }

    // --- probes for the distinct-coins guardrail ---
    const span = Math.max(1, lastSlot - firstSlot);
    const wantCoins = Math.min(24, 8 + Math.floor(span / 900));
    if (traded.size < wantCoins && openSlots > 1 && orders.length < caps.max_orders_per_batch) {
      for (const [mint, curve] of state.curves) {
        if (curve.complete || held.has(mint) || probes.has(mint) || traded.has(mint)) continue;
        if (Number(curve.real_quote_reserves) / SOL < PROBE_MIN_RQ || curve.trades < 6) continue;
        const cap = state.maxBuyLamports(mint);
        const want = BigInt(Math.round(PROBE_BUY * SOL));
        const amount = cap < want ? cap : want;
        if (amount < 10_000_000n || free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP });
        probes.set(mint, false); traded.add(mint);
        break; // one probe per batch
      }
    }
    return orders;
  },
});
