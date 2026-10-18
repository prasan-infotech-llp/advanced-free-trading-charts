import { useEffect, useState } from "react";
import {
  formatPrice,
  formatSigned,
  pnlOf,
  quoteCurrency,
  type Leg,
  type NewOrder,
  type Order,
  type Side,
} from "./orders";
import "./OrderSidebar.css";

export interface LogEntry {
  time: string;
  text: string;
  tone: "info" | "ok" | "error";
}

interface OrderSidebarProps {
  symbol: string;
  lastPrice: number | null;
  orders: Order[];
  log: LogEntry[];
  onPlace: (order: NewOrder) => Promise<void>;
  onClose: (id: string) => void;
  onRemoveLeg: (id: string, leg: Leg) => void;
  executionCount: number;
  onLoadHistory: () => void;
}

export function OrderSidebar({
  symbol,
  lastPrice,
  orders,
  log,
  onPlace,
  onClose,
  onRemoveLeg,
  executionCount,
  onLoadHistory,
}: OrderSidebarProps) {
  const currency = quoteCurrency(symbol);

  const [side, setSide] = useState<Side>("long");
  const [quantity, setQuantity] = useState("0.5");
  const [priceMode, setPriceMode] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState("");
  const [tpOn, setTpOn] = useState(true);
  const [tpPct, setTpPct] = useState("1");
  const [slOn, setSlOn] = useState(true);
  const [slPct, setSlPct] = useState("0.8");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill the limit price with the market price the first time it is shown.
  useEffect(() => {
    if (priceMode === "limit" && !limitPrice && lastPrice) setLimitPrice(formatPrice(lastPrice));
  }, [priceMode, limitPrice, lastPrice]);

  const qty = Number(quantity);
  const entry = priceMode === "market" ? lastPrice : Number(limitPrice) || null;
  const dir = side === "long" ? 1 : -1;
  const tpPrice = entry && tpOn && Number(tpPct) > 0 ? round(entry * (1 + (dir * Number(tpPct)) / 100)) : null;
  const slPrice = entry && slOn && Number(slPct) > 0 ? round(entry * (1 - (dir * Number(slPct)) / 100)) : null;
  const canSubmit = !!entry && qty > 0 && !submitting;

  const submit = async () => {
    if (!entry || !(qty > 0)) return;
    setSubmitting(true);
    setError(null);
    try {
      await onPlace({ symbol, side, quantity: qty, entry: round(entry), tp: tpPrice, sl: slPrice });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside className="sidebar">
      {/* ------------------------------------------------------------ order form */}
      <section className="sb-section">
        <div className="sb-header">
          <h2 className="sb-title">New order</h2>
          <span className="sb-symbol">{symbol}</span>
        </div>

        <div className="sb-sides" role="radiogroup" aria-label="Side">
          <button
            type="button"
            role="radio"
            aria-checked={side === "long"}
            className={`sb-side is-long${side === "long" ? " is-active" : ""}`}
            onClick={() => setSide("long")}
          >
            Buy / Long
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={side === "short"}
            className={`sb-side is-short${side === "short" ? " is-active" : ""}`}
            onClick={() => setSide("short")}
          >
            Sell / Short
          </button>
        </div>

        <label className="sb-field">
          <span className="sb-label">Quantity</span>
          <input
            className="sb-input"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>

        <div className="sb-field">
          <div className="sb-label-row">
            <span className="sb-label">Entry price</span>
            <div className="sb-tabs">
              {(["market", "limit"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`sb-tab${priceMode === m ? " is-active" : ""}`}
                  onClick={() => setPriceMode(m)}
                >
                  {m === "market" ? "Market" : "Limit"}
                </button>
              ))}
            </div>
          </div>
          {priceMode === "market" ? (
            <div className="sb-input sb-readonly">
              {lastPrice ? formatPrice(lastPrice) : "—"} <span className="sb-muted">{currency} · live</span>
            </div>
          ) : (
            <input
              className="sb-input"
              inputMode="decimal"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
            />
          )}
        </div>

        <LegInput
          title="Take profit"
          tone="profit"
          on={tpOn}
          onToggle={setTpOn}
          pct={tpPct}
          onPct={setTpPct}
          price={tpPrice}
          pnl={entry && tpPrice ? pnlOf(side, entry, tpPrice, qty || 0) : null}
          currency={currency}
        />
        <LegInput
          title="Stop loss"
          tone="loss"
          on={slOn}
          onToggle={setSlOn}
          pct={slPct}
          onPct={setSlPct}
          price={slPrice}
          pnl={entry && slPrice ? pnlOf(side, entry, slPrice, qty || 0) : null}
          currency={currency}
        />

        {error && <p className="sb-error">{error}</p>}

        <button
          type="button"
          className={`sb-submit ${side === "long" ? "is-long" : "is-short"}`}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? "Placing…" : `${side === "long" ? "Buy" : "Sell"} ${qty > 0 ? qty : ""} ${symbol}`}
        </button>
        <p className="sb-hint">Demo only — nothing is sent to an exchange.</p>
      </section>

      {/* ----------------------------------------------------------- open orders */}
      <section className="sb-section sb-orders">
        <div className="sb-header">
          <h2 className="sb-title">Open orders</h2>
          <span className="sb-count">{orders.length}</span>
        </div>
        {orders.length === 0 ? (
          <p className="sb-empty">No orders on {symbol}. Place one above — its lines appear on the chart.</p>
        ) : (
          orders.map((o) => {
            const live = lastPrice !== null ? pnlOf(o.side, o.entry, lastPrice, o.quantity) : null;
            return (
              <div key={o.id} className="sb-order">
                <div className="sb-order-top">
                  <span className={`sb-badge ${o.side === "long" ? "is-long" : "is-short"}`}>
                    {o.side === "long" ? "LONG" : "SHORT"}
                  </span>
                  <span className="sb-order-size">
                    {o.quantity} @ {formatPrice(o.entry)}
                  </span>
                  <span className={`sb-order-pnl ${live !== null && live < 0 ? "is-loss" : "is-profit"}`}>
                    {live !== null ? `${formatSigned(live)} ${currency}` : "—"}
                  </span>
                </div>
                <div className="sb-order-legs">
                  <OrderLeg label="TP" tone="profit" price={o.tp} onRemove={() => onRemoveLeg(o.id, "tp")} />
                  <OrderLeg label="SL" tone="loss" price={o.sl} onRemove={() => onRemoveLeg(o.id, "sl")} />
                </div>
                <div className="sb-order-foot">
                  <span className="sb-muted">{o.id}</span>
                  <button type="button" className="sb-close" onClick={() => onClose(o.id)}>
                    Close position
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* ---------------------------------------------------------- trade history */}
      <section className="sb-section">
        <div className="sb-header">
          <h2 className="sb-title">Executions on chart</h2>
          <span className="sb-count">{executionCount}</span>
        </div>
        <p className="sb-empty">
          Entries and exits are marked with arrows on their candle. Hover an arrow for details.
        </p>
        <button type="button" className="sb-secondary" onClick={onLoadHistory}>
          Load sample trade history
        </button>
      </section>

      {/* ------------------------------------------------------------- activity */}
      <section className="sb-section sb-log">
        <h2 className="sb-title">Activity</h2>
        {log.length === 0 ? (
          <p className="sb-empty">Drag a TP / SL line on the chart to modify an order.</p>
        ) : (
          log.map((entry, i) => (
            <div key={i} className={`sb-log-row is-${entry.tone}`}>
              <span className="sb-log-time">{entry.time}</span>
              {entry.text}
            </div>
          ))
        )}
      </section>
    </aside>
  );
}

function LegInput({
  title,
  tone,
  on,
  onToggle,
  pct,
  onPct,
  price,
  pnl,
  currency,
}: {
  title: string;
  tone: "profit" | "loss";
  on: boolean;
  onToggle: (on: boolean) => void;
  pct: string;
  onPct: (v: string) => void;
  price: number | null;
  pnl: number | null;
  currency: string;
}) {
  return (
    <div className={`sb-leg is-${tone}${on ? "" : " is-off"}`}>
      <label className="sb-switch">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <span className="sb-switch-track" aria-hidden />
        <span className="sb-label">{title}</span>
      </label>
      {on && (
        <div className="sb-leg-body">
          <div className="sb-pct">
            <input className="sb-input" inputMode="decimal" value={pct} onChange={(e) => onPct(e.target.value)} />
            <span className="sb-pct-unit">%</span>
          </div>
          <div className="sb-leg-result">
            <span>{price ? formatPrice(price) : "—"}</span>
            <span className={`sb-leg-pnl is-${tone}`}>{pnl !== null ? `${formatSigned(pnl)} ${currency}` : ""}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderLeg({
  label,
  tone,
  price,
  onRemove,
}: {
  label: string;
  tone: "profit" | "loss";
  price: number | null;
  onRemove: () => void;
}) {
  return (
    <div className={`sb-order-leg is-${tone}${price === null ? " is-empty" : ""}`}>
      <span className="sb-order-leg-label">{label}</span>
      <span>{price !== null ? formatPrice(price) : "not set"}</span>
      {price !== null && (
        <button type="button" className="sb-leg-remove" title={`Remove ${label}`} onClick={onRemove}>
          ✕
        </button>
      )}
    </div>
  );
}

function round(price: number): number {
  return Number(price.toFixed(price >= 1000 ? 2 : price >= 1 ? 4 : 6));
}
