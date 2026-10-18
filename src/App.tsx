import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TradingTerminal, type TradingChart } from "@trading/terminal";
import "@trading/terminal/styles.css";
import { OrderSidebar, type LogEntry } from "./OrderSidebar";
import { Navbar, type FeedSource } from "./Navbar";
import { NSE_RESOLUTIONS, NSE_SYMBOLS, RelianceDatafeed } from "./datafeeds/relianceDatafeed";
import {
  fakeApi,
  formatPrice,
  formatSigned,
  newExecutionId,
  pnlOf,
  quoteCurrency,
  type Execution,
  type Leg,
  type NewOrder,
  type Order,
} from "./orders";
import "./App.css";

const START_SYMBOL = { binance: "BTCUSDT", custom: "RELIANCE" } as const;

/** "?feed=custom" opens the custom datafeed example directly (shareable link). */
function feedFromUrl(): FeedSource {
  return new URLSearchParams(window.location.search).get("feed") === "custom" ? "custom" : "binance";
}

/** Chart line ids for an order's entry / TP / SL. */
const lineId = (orderId: string, part: "entry" | Leg) => `${orderId}:${part}`;

function App() {
  const [feed, setFeed] = useState<FeedSource>(feedFromUrl);
  // The custom datafeed is created once and shared by every chart of the terminal.
  const customDatafeed = useMemo(() => new RelianceDatafeed(), []);
  const [orders, setOrders] = useState<Order[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [symbol, setSymbol] = useState<string>(START_SYMBOL[feed]);
  const [lastPrice, setLastPrice] = useState<number | null>(null);

  // Refs give chart callbacks (created once per line) access to the latest state.
  const chartRef = useRef<TradingChart | null>(null);
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const executionsRef = useRef(executions);
  executionsRef.current = executions;
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  const write = useCallback((text: string, tone: LogEntry["tone"] = "info") => {
    const time = new Date().toLocaleTimeString();
    setLog((prev) => [{ time, text, tone }, ...prev].slice(0, 30));
  }, []);

  const findOrder = (id: string) => ordersRef.current.find((o) => o.id === id);

  /* ------------------------------------------------------------ executions */

  /** Arrow on the candle where the execution happened. */
  const drawExecution = useCallback(
    (chart: TradingChart, exec: Execution) => {
      const marker = chart.createTradeMarker({
        id: exec.id,
        time: exec.time,
        price: exec.price,
        side: exec.side,
        kind: exec.kind,
        quantity: exec.quantity,
        text: exec.text,
      });
      marker.onClick(() =>
        write(`Clicked ${exec.kind} ${exec.side} ${exec.quantity} @ ${formatPrice(exec.price)}${exec.text ? ` — ${exec.text}` : ""}`),
      );
    },
    [write],
  );

  const addExecution = useCallback(
    (exec: Execution) => {
      setExecutions((prev) => [...prev, exec]);
      if (chartRef.current && exec.symbol === symbolRef.current) drawExecution(chartRef.current, exec);
    },
    [drawExecution],
  );

  /** Execution at the current candle (used when placing / closing demo orders). */
  const executionNow = (order: Order, kind: "entry" | "exit", price: number, text: string): Execution => ({
    id: newExecutionId(),
    symbol: order.symbol,
    time: chartRef.current?.engine.bars.at(-1)?.time ?? Math.floor(Date.now() / 1000),
    price,
    side: (order.side === "long") === (kind === "entry") ? "buy" : "sell",
    kind,
    quantity: order.quantity,
    text,
  });

  const loadHistory = useCallback(async () => {
    const chart = chartRef.current;
    if (!chart) return;
    write(`Loading trade history for ${symbolRef.current}…`);
    const history = await fakeApi.getTradeHistory(symbolRef.current, chart.engine.bars);
    // Replace any previously loaded history for this symbol.
    setExecutions((prev) => [
      ...prev.filter((e) => !(e.symbol === symbolRef.current && e.text?.startsWith("HIST-"))),
      ...history,
    ]);
    for (const m of chart.getTradeMarkers()) if (m.text?.startsWith("HIST-")) m.remove();
    for (const exec of history) drawExecution(chart, exec);
    write(`Loaded ${history.length} executions (${history.length / 2} trades) — hover the arrows for details`, "ok");
  }, [drawExecution, write]);

  /* ---------------------------------------------------------- order actions */

  const modifyLeg = useCallback(
    async (orderId: string, leg: Leg, price: number, previous: number) => {
      const order = findOrder(orderId);
      if (!order) return;
      const name = leg.toUpperCase();
      write(`${orderId} ${name} ${formatPrice(previous)} → ${formatPrice(price)} — sending to backend…`);
      try {
        await fakeApi.modifyLeg(order, leg, price);
        setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, [leg]: price } : o)));
        write(`${orderId} ${name} updated to ${formatPrice(price)}`, "ok");
      } catch (err) {
        chartRef.current?.getTradeLine(lineId(orderId, leg))?.setPrice(previous);
        write(`${orderId} ${name} rejected: ${(err as Error).message}`, "error");
      }
    },
    [write],
  );

  const removeLeg = useCallback(
    async (orderId: string, leg: Leg) => {
      const order = findOrder(orderId);
      if (!order) return;
      await fakeApi.removeLeg(order, leg);
      chartRef.current?.getTradeLine(lineId(orderId, leg))?.remove();
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, [leg]: null } : o)));
      write(`${orderId} ${leg.toUpperCase()} removed`, "ok");
    },
    [write],
  );

  const closeOrder = useCallback(
    async (orderId: string) => {
      const order = findOrder(orderId);
      if (!order) return;
      await fakeApi.closeOrder(order);
      for (const part of ["entry", "tp", "sl"] as const) {
        chartRef.current?.getTradeLine(lineId(orderId, part))?.remove();
      }
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
      const exit = chartRef.current?.engine.bars.at(-1)?.close;
      const result = exit ? ` · result ${formatSigned(pnlOf(order.side, order.entry, exit, order.quantity))} ${quoteCurrency(order.symbol)}` : "";
      if (exit) addExecution(executionNow(order, "exit", exit, `${orderId} · closed${result}`));
      write(`${orderId} closed${result}`, "ok");
    },
    [addExecution, write],
  );

  /* ------------------------------------------------------- chart drawing */

  /** Draws an order's entry, TP and SL lines and wires their callbacks. */
  const drawOrder = useCallback(
    (chart: TradingChart, order: Order) => {
      const currency = quoteCurrency(order.symbol);
      const entry = chart.createTradeLine({
        id: lineId(order.id, "entry"),
        kind: "entry",
        label: order.side === "long" ? "Long" : "Short",
        price: order.entry,
        side: order.side,
        quantity: order.quantity,
        currency,
        cancellable: true,
      });
      entry.onCancelClick(() => void closeOrder(order.id));

      for (const leg of ["tp", "sl"] as const) {
        const price = order[leg];
        if (price === null) continue;
        const line = chart.createTradeLine({
          id: lineId(order.id, leg),
          kind: leg,
          label: leg.toUpperCase(),
          price,
          entry,
          cancellable: true,
        });
        line.onDragEnd((next, previous) => void modifyLeg(order.id, leg, next, previous));
        line.onCancelClick(() => void removeLeg(order.id, leg));
      }
    },
    [closeOrder, modifyLeg, removeLeg],
  );

  const placeOrder = useCallback(
    async (input: NewOrder) => {
      write(`Placing ${input.side} ${input.quantity} ${input.symbol} @ ${formatPrice(input.entry)}…`);
      const order = await fakeApi.placeOrder(input); // throws → shown under the form
      setOrders((prev) => [...prev, order]);
      if (chartRef.current && order.symbol === symbolRef.current) drawOrder(chartRef.current, order);
      addExecution(executionNow(order, "entry", order.entry, `${order.id} · opened ${order.side}`));
      write(`${order.id} opened: ${order.side} ${order.quantity} @ ${formatPrice(order.entry)}`, "ok");
    },
    [addExecution, drawOrder, write],
  );

  /** The terminal recreates the chart on symbol / timeframe changes: redraw this symbol's orders. */
  const handleReady = useCallback(
    (chart: TradingChart) => {
      chartRef.current = chart;
      for (const order of ordersRef.current) {
        if (order.symbol === symbolRef.current) drawOrder(chart, order);
      }
      for (const exec of executionsRef.current) {
        if (exec.symbol === symbolRef.current) drawExecution(chart, exec);
      }
    },
    [drawExecution, drawOrder],
  );

  // Keep the sidebar's market price fresh.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const close = chartRef.current?.engine.bars.at(-1)?.close;
      setLastPrice((prev) => (close !== undefined && close !== prev ? close : prev));
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  const handleSymbolChange = useCallback((next: string) => {
    symbolRef.current = next;
    setSymbol(next);
    setLastPrice(null);
  }, []);

  const changeFeed = useCallback(
    (next: FeedSource) => {
      const url = new URL(window.location.href);
      if (next === "custom") url.searchParams.set("feed", "custom");
      else url.searchParams.delete("feed");
      window.history.replaceState(null, "", url);
      chartRef.current = null;
      symbolRef.current = START_SYMBOL[next];
      setSymbol(START_SYMBOL[next]);
      setLastPrice(null);
      setFeed(next);
      write(next === "custom" ? "Switched to the custom datafeed (Reliance, simulated NSE data)" : "Switched to live Binance data", "ok");
    },
    [write],
  );

  return (
    <div className="app-shell">
      <Navbar feed={feed} onFeedChange={changeFeed} />
      <div className="page">
        <div className="chart-area">
          <TradingTerminal
            // Remount on switch: the terminal picks its data source when it starts.
            key={feed}
            symbol={START_SYMBOL[feed]}
            resolution="15"
            logoUrl="/logo.png"
            // Custom datafeed: any object implementing IDatafeed (see src/datafeeds/relianceDatafeed.ts).
            {...(feed === "custom"
              ? { datafeed: customDatafeed, symbols: NSE_SYMBOLS, resolutions: NSE_RESOLUTIONS, datafeedLabel: "NSE" }
              : {})}
            licenseKey={import.meta.env.VITE_BETURTL_LICENSE_KEY}
            onReady={handleReady}
            onSymbolChange={handleSymbolChange}
          />
        </div>
        <OrderSidebar
          symbol={symbol}
          lastPrice={lastPrice}
          orders={orders.filter((o) => o.symbol === symbol)}
          log={log}
          onPlace={placeOrder}
          onClose={(id) => void closeOrder(id)}
          onRemoveLeg={(id, leg) => void removeLeg(id, leg)}
          executionCount={executions.filter((e) => e.symbol === symbol).length}
          onLoadHistory={() => void loadHistory()}
        />
      </div>
    </div>
  );
}

export default App;
