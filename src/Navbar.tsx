import "./Navbar.css";

export type FeedSource = "binance" | "custom";

interface NavbarProps {
  feed: FeedSource;
  onFeedChange: (feed: FeedSource) => void;
}

/** Top bar: logo, and a switch between live Binance data and the custom datafeed example. */
export function Navbar({ feed, onFeedChange }: NavbarProps) {
  const custom = feed === "custom";
  return (
    <header className="navbar">
      <img className="navbar-logo" src="/logo.png" alt="be.turtl" height="22" />

      <div className="navbar-feed">
        <span className="navbar-feed-label">
          {custom ? "Custom datafeed · NSE stocks (simulated)" : "Live crypto · Binance"}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={custom}
          aria-label="Use the custom datafeed example"
          className={`navbar-switch${custom ? " is-on" : ""}`}
          onClick={() => onFeedChange(custom ? "binance" : "custom")}
        >
          <span className="navbar-switch-thumb" />
        </button>
        <span className="navbar-feed-name">Custom datafeed</span>
      </div>
    </header>
  );
}
