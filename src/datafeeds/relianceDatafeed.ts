/**
 * Example custom datafeed: NSE stocks (Reliance and a few others) with SIMULATED prices.
 *
 * This is a complete, from-scratch implementation of the `IDatafeed` interface — the same shape your
 * own feed would have. Replace the "data source" part (the simulated price generator) with calls to
 * your broker / market-data API and the rest stays the same:
 *
 *   resolveSymbol  → describe a symbol (name, exchange, price precision)
 *   getHistory     → return a page of candles (older ones as the user scrolls back)
 *   subscribeBars  → push live candle updates
 *   unsubscribeBars / destroy → stop those updates
 *
 * The prices are a random walk, not real market data. A real NSE session runs 09:15–15:30 IST on
 * weekdays; this demo trades around the clock so the live candle always moves.
 */
import type {
  BarCallback,
  HistoryRequest,
  HistoryResponse,
  IDatafeed,
  Resolution,
  SubscribeOptions,
  SymbolInfo,
} from "@trading/datafeed";
import type { OHLCVBar } from "@trading/core";
import type { TerminalSymbol } from "@trading/terminal";

// ── Symbols and timeframes this feed offers ─────────────────────────────

interface StockSpec {
  name: string;
  /** Starting price in INR for the simulation. */
  price: number;
  /** Seed for the simulated prices, so every page load shows the same history. */
  seed: number;
}

const STOCKS: Record<string, StockSpec> = {
  RELIANCE: { name: "Reliance Industries", price: 1420, seed: 11 },
  TCS: { name: "Tata Consultancy Services", price: 3050, seed: 23 },
  INFY: { name: "Infosys", price: 1480, seed: 37 },
  HDFCBANK: { name: "HDFC Bank", price: 990, seed: 41 },
};

/** For the terminal's symbol search (`symbols` prop). */
export const NSE_SYMBOLS: TerminalSymbol[] = Object.entries(STOCKS).map(([symbol, s]) => ({
  symbol,
  name: s.name,
  description: "NSE · Equity · simulated",
}));

/** Timeframes this feed can serve (`resolutions` prop). */
export const NSE_RESOLUTIONS: Resolution[] = ["1", "5", "15", "60", "240", "D"];

const RESOLUTION_SECONDS: Partial<Record<Resolution, number>> = {
  "1": 60,
  "5": 300,
  "15": 900,
  "60": 3600,
  "240": 14400,
  D: 86400,
};

export function isNseSymbol(symbol: string): boolean {
  return symbol in STOCKS;
}

// ── Simulated data source (replace with your API) ───────────────────────

const BASE_SECONDS = 60; // simulated 1-minute candles; other timeframes are built from them
const HISTORY_DAYS = 30;

/** Small seeded random number generator (mulberry32): same seed, same numbers. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One simulated 1-minute candle following `prevClose`. */
function nextMinute(time: number, prevClose: number, anchor: number, rand: () => number): OHLCVBar {
  // Random walk with a gentle pull back towards the starting price, so it never drifts away.
  const drift = ((anchor - prevClose) / anchor) * 0.002;
  const close = prevClose * (1 + drift + (rand() - 0.5) * 0.0016);
  const open = prevClose;
  const wick = prevClose * 0.0006;
  return {
    time,
    open: round2(open),
    high: round2(Math.max(open, close) + rand() * wick),
    low: round2(Math.min(open, close) - rand() * wick),
    close: round2(close),
    volume: Math.round(2000 + rand() * 18000),
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Hand the chart copies: this feed keeps changing its own live candle. */
const copy = (bars: OHLCVBar[]) => bars.map((b) => ({ ...b }));

/** Roll 1-minute candles up into a longer timeframe (5m, 1h, 1D, …). */
function aggregate(bars: OHLCVBar[], seconds: number): OHLCVBar[] {
  if (seconds === BASE_SECONDS) return bars;
  const out: OHLCVBar[] = [];
  for (const b of bars) {
    const time = Math.floor(b.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume = (last.volume ?? 0) + (b.volume ?? 0);
    } else {
      out.push({ ...b, time });
    }
  }
  return out;
}

// ── The datafeed ────────────────────────────────────────────────────────

interface Subscription {
  options: SubscribeOptions;
  onBar: BarCallback;
}

export class RelianceDatafeed implements IDatafeed {
  /** Most candles one getHistory call returns; the chart pages by this. */
  readonly maxBarsPerRequest = 1000;

  /** Simulated 1-minute history per symbol, extended as time passes. */
  private _minutes = new Map<string, { bars: OHLCVBar[]; rand: () => number }>();
  private _subscriptions = new Map<string, Subscription>();
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _uid = 0;

  onReady(callback: () => void): void {
    setTimeout(callback, 0);
  }

  async resolveSymbol(symbol: string): Promise<SymbolInfo> {
    const stock = STOCKS[symbol.toUpperCase()];
    if (!stock) throw new Error(`Unknown NSE symbol: ${symbol}`);
    return {
      symbol: symbol.toUpperCase(),
      name: stock.name,
      description: `${stock.name} · NSE`,
      exchange: "NSE",
      type: "stock",
      pricescale: 100, // prices shown with 2 decimals (₹1420.35)
      minmov: 1,
      session: "24x7",
      timezone: "Asia/Kolkata",
    };
  }

  async getHistory(request: HistoryRequest): Promise<HistoryResponse> {
    const seconds = RESOLUTION_SECONDS[request.resolution];
    if (!seconds) return { bars: [], noData: true };
    const all = aggregate(this._history(request.symbol), seconds);
    const limit = Math.min(request.countBack ?? this.maxBarsPerRequest, this.maxBarsPerRequest);

    // Forward page (replay, go-to-date): candles from startTime on. noData = nothing newer left.
    if (request.startTime != null) {
      const start = all.findIndex((b) => b.time >= request.startTime!);
      if (start === -1) return { bars: [], noData: true };
      return { bars: copy(all.slice(start, start + limit)), noData: start + limit >= all.length };
    }

    // Backward page (normal loading and scrolling back): candles up to `to`. noData = nothing older left.
    let end = all.length;
    while (end > 0 && all[end - 1].time > request.to) end--;
    const start = Math.max(0, end - limit);
    return { bars: copy(all.slice(start, end)), noData: start === 0 };
  }

  subscribeBars(options: SubscribeOptions, onBar: BarCallback): string {
    const uid = `nse_${++this._uid}`;
    this._subscriptions.set(uid, { options, onBar });
    // One timer drives every subscription; it runs only while someone is watching.
    this._timer ??= setInterval(() => this._tick(), 1000);
    return uid;
  }

  unsubscribeBars(subscriberUID: string): void {
    this._subscriptions.delete(subscriberUID);
    if (this._subscriptions.size === 0 && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  destroy(): void {
    this._subscriptions.clear();
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** 1-minute history for a symbol, generated on first use and brought up to the current minute. */
  private _history(symbol: string): OHLCVBar[] {
    const key = symbol.toUpperCase();
    const stock = STOCKS[key];
    if (!stock) return [];
    let entry = this._minutes.get(key);
    if (!entry) {
      const rand = seededRandom(stock.seed);
      const now = Math.floor(Date.now() / 1000 / BASE_SECONDS) * BASE_SECONDS;
      const bars: OHLCVBar[] = [];
      let close = stock.price;
      for (let t = now - HISTORY_DAYS * 86400; t <= now; t += BASE_SECONDS) {
        const bar = nextMinute(t, close, stock.price, rand);
        bars.push(bar);
        close = bar.close;
      }
      entry = { bars, rand };
      this._minutes.set(key, entry);
    }
    this._catchUp(key);
    return entry.bars;
  }

  /** Add candles for any minutes that started since the last update. */
  private _catchUp(symbol: string): void {
    const entry = this._minutes.get(symbol)!;
    const now = Math.floor(Date.now() / 1000 / BASE_SECONDS) * BASE_SECONDS;
    let last = entry.bars[entry.bars.length - 1];
    while (last.time < now) {
      last = nextMinute(last.time + BASE_SECONDS, last.close, STOCKS[symbol].price, entry.rand);
      entry.bars.push(last);
    }
  }

  /** Every second: move each watched symbol's live candle and push it to the charts. */
  private _tick(): void {
    const watched = new Set([...this._subscriptions.values()].map((s) => s.options.symbol.toUpperCase()));
    for (const symbol of watched) {
      const entry = this._minutes.get(symbol);
      if (!entry) continue;
      this._catchUp(symbol);
      const live = entry.bars[entry.bars.length - 1];
      live.close = round2(live.close * (1 + (entry.rand() - 0.5) * 0.0005));
      live.high = Math.max(live.high, live.close);
      live.low = Math.min(live.low, live.close);
      live.volume = (live.volume ?? 0) + Math.round(entry.rand() * 400);
    }
    for (const { options, onBar } of this._subscriptions.values()) {
      const seconds = RESOLUTION_SECONDS[options.resolution];
      const entry = this._minutes.get(options.symbol.toUpperCase());
      if (!seconds || !entry) continue;
      // The live candle of this timeframe = the 1-minute candles since it opened, rolled up.
      const periodStart = Math.floor(entry.bars[entry.bars.length - 1].time / seconds) * seconds;
      let i = entry.bars.length - 1;
      while (i > 0 && entry.bars[i - 1].time >= periodStart) i--;
      const [bar] = aggregate(entry.bars.slice(i), seconds);
      if (bar) onBar({ ...bar });
    }
  }
}
