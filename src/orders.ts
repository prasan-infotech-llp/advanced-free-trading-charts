/* Demo order model + a pretend backend. Swap `fakeApi` for your real API calls. */

import { isNseSymbol } from "./datafeeds/relianceDatafeed";

export type Side = "long" | "short";
export type Leg = "tp" | "sl";

export interface Order {
  id: string;
  symbol: string;
  side: Side;
  quantity: number;
  entry: number;
  tp: number | null;
  sl: number | null;
  createdAt: number;
}

export interface NewOrder {
  symbol: string;
  side: Side;
  quantity: number;
  entry: number;
  tp: number | null;
  sl: number | null;
}

/** An execution to show as an arrow on the chart. */
export interface Execution {
  id: string;
  symbol: string;
  time: number;
  price: number;
  side: "buy" | "sell";
  kind: "entry" | "exit";
  quantity: number;
  text?: string;
}

let nextOrderId = 1;
let nextExecId = 1;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Profit / loss of `quantity` moved from `entry` to `price`. */
export function pnlOf(side: Side, entry: number, price: number, quantity: number): number {
  return (price - entry) * quantity * (side === "long" ? 1 : -1);
}

/** Why a TP / SL price is invalid for this order, or null when it's fine. */
export function validateLeg(side: Side, leg: Leg, entry: number, price: number): string | null {
  const above = price > entry;
  if (leg === "tp" && side === "long" && !above) return "Take-profit must be above the entry for a long";
  if (leg === "tp" && side === "short" && above) return "Take-profit must be below the entry for a short";
  if (leg === "sl" && side === "long" && above) return "Stop-loss must be below the entry for a long";
  if (leg === "sl" && side === "short" && !above) return "Stop-loss must be above the entry for a short";
  return null;
}

export const fakeApi = {
  async placeOrder(input: NewOrder): Promise<Order> {
    await delay(300);
    for (const leg of ["tp", "sl"] as const) {
      const price = input[leg];
      if (price !== null) {
        const error = validateLeg(input.side, leg, input.entry, price);
        if (error) throw new Error(error);
      }
    }
    return { ...input, id: `ORD-${String(nextOrderId++).padStart(4, "0")}`, createdAt: Date.now() };
  },

  async modifyLeg(order: Order, leg: Leg, price: number): Promise<void> {
    await delay(350);
    const error = validateLeg(order.side, leg, order.entry, price);
    if (error) throw new Error(error);
  },

  async removeLeg(_order: Order, _leg: Leg): Promise<void> {
    await delay(250);
  },

  async closeOrder(_order: Order): Promise<void> {
    await delay(300);
  },

  /**
   * Pretend trade history: four round-trip trades on past candles. A real backend would return
   * your fills (time, price, side, qty) — here we derive them from the candles on screen.
   */
  async getTradeHistory(symbol: string, candles: { time: number; open: number; close: number }[]): Promise<Execution[]> {
    await delay(400);
    const out: Execution[] = [];
    if (candles.length < 60) return out;
    const span = Math.min(candles.length - 10, 160);
    const start = candles.length - span;
    for (let t = 0; t < 4; t++) {
      const inIdx = start + Math.floor((span / 4) * t) + 3;
      const outIdx = Math.min(candles.length - 2, inIdx + 8 + ((t * 5) % 12));
      const side: Side = t % 2 === 0 ? "long" : "short";
      const qty = [0.5, 0.25, 1, 0.4][t];
      const entry = candles[inIdx].open;
      const exit = candles[outIdx].close;
      const result = pnlOf(side, entry, exit, qty);
      const tradeId = `HIST-${String(t + 1).padStart(3, "0")}`;
      out.push({
        id: `EX-${nextExecId++}`,
        symbol,
        time: candles[inIdx].time,
        price: round2(entry),
        side: side === "long" ? "buy" : "sell",
        kind: "entry",
        quantity: qty,
        text: `${tradeId} · opened ${side}`,
      });
      out.push({
        id: `EX-${nextExecId++}`,
        symbol,
        time: candles[outIdx].time,
        price: round2(exit),
        side: side === "long" ? "sell" : "buy",
        kind: "exit",
        quantity: qty,
        text: `${tradeId} · closed · ${formatSigned(result)} ${quoteCurrency(symbol)}`,
      });
    }
    return out;
  },
};

export function newExecutionId(): string {
  return `EX-${nextExecId++}`;
}

function round2(v: number): number {
  return Number(v.toFixed(2));
}

export function quoteCurrency(symbol: string): string {
  if (isNseSymbol(symbol)) return "INR";
  for (const q of ["USDT", "USDC", "FDUSD", "BUSD", "BTC", "ETH", "BNB"]) {
    if (symbol.endsWith(q) && symbol.length > q.length) return q;
  }
  return "";
}

export function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

export function formatSigned(value: number, digits = 2): string {
  // Values that round to zero show as +0.00, never −0.00.
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? "+" : "−"}${Math.abs(rounded).toFixed(digits)}`;
}
