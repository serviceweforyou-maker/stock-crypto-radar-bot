# TradePulse - Stock Market & Crypto Breakout Radar ⚡

Algorithmic technical scanner Telegram bot tracking Indian Equities (NSE/BSE), 24/7 Global Crypto Momentum (Binance), and Upcoming IPO Grey Market Premiums (GMP).

## Core Modules
- **📈 Indian Equities (NSE):** Scans 52-week high breakout zones and volume surges using real-time market feeds.
- **🪙 Crypto 24/7 Momentum:** Scans Binance top tickers for sudden breakouts, high-volume accumulation, and volatility dips.
- **📑 IPO & GMP Tracker:** Displays Grey Market Premiums, issue prices, and expected listing gains.
- **🎯 Custom Watchlist:** Interactive watchlist with `/watch` and `/unwatch`.
- **💎 VIP Monetization:** Automated Razorpay dynamic checkout for ₹99 (Starter) and ₹399 (Pro VIP) plans.
- **⚖️ SEBI Educational Compliance:** Compliant algorithmic technical scanner disclaimer.

## Setup & Deployment
1. Set environment variables in `.env`:
   ```env
   BOT_TOKEN=your_telegram_bot_token
   RAZORPAY_KEY_ID=your_razorpay_key_id
   RAZORPAY_KEY_SECRET=your_razorpay_key_secret
   PORT=3001
   ```
2. Run locally:
   ```bash
   npm install
   npm start
   ```
3. Deploy on Render as a Web Service (Node environment, `npm start`).
