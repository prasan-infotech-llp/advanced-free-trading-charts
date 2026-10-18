import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'
import { proxyRoutes } from '@trading/datafeed'

/**
 * Some exchanges (KuCoin, Bitfinex, CoinDCX, Kraken Futures) don't allow API calls straight from a
 * browser. The charts call them through same-origin paths like /api/ex/kucoin/…, and this forwards
 * those to the exchange. In production, add the same rewrites to your host (see README).
 */
const exchangeProxy: Record<string, ProxyOptions> = Object.fromEntries(
  proxyRoutes().map(({ path, target }) => {
    const ws = target.startsWith('wss://')
    return [
      // Trailing slash so "/api/ex/kucoin" doesn't also catch "/api/ex/kucoin-futures".
      `${path}/`,
      {
        target: ws ? target.replace(/^wss:/, 'https:') : target,
        changeOrigin: true,
        ws,
        rewrite: (p: string) => p.replace(new RegExp(`^${path}`), ''),
        // CoinDCX's candle stream rejects WebSockets that send an Origin header (every browser does).
        configure: ws ? (proxy) => proxy.on('proxyReqWs', (req) => req.removeHeader('origin')) : undefined,
      },
    ]
  }),
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: exchangeProxy },
  preview: { proxy: exchangeProxy },
})
