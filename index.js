import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import Razorpay from 'razorpay';
import http from 'http';
import YahooFinance from 'yahoo-finance2';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize YahooFinance client
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const token = process.env.BOT_TOKEN || '';
if (!token) {
  console.log('⚠️ [WARNING] No BOT_TOKEN found in .env yet. Bot will start web health-check server while awaiting token.');
}

// Global Telegraf Bot Instance
const bot = token ? new Telegraf(token) : null;

// Global Error Handler to catch any unhandled callback exceptions & prevent button spinner hang
if (bot) {
  bot.catch((err, ctx) => {
    console.error(`[Telegraf Error] ${err.message || err}`);
    if (ctx && ctx.answerCbQuery) {
      ctx.answerCbQuery('⚠️ Connection refreshed. Please tap again.').catch(() => {});
    }
  });
}

// Razorpay Client Initialization
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_live_Swi8IOOBMI4Ukz',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'LLOSi63tvKRlZ9OnqJW5lpyZ',
});

// File paths for persistence
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const IPOS_FILE = path.join(DATA_DIR, 'ipos.json');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper to read/write JSON files safely
function loadJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
  }
  return defaultValue;
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err.message);
  }
}

// In-memory state tracking for users waiting to enter Payment ID
const awaitingPaymentVerification = new Set();

// Tracked Assets
const NSE_STOCKS = [
  { symbol: 'RELIANCE.NS', name: 'Reliance Industries', sector: 'Energy & Retail' },
  { symbol: 'TCS.NS', name: 'Tata Consultancy Services', sector: 'IT Services' },
  { symbol: 'HDFCBANK.NS', name: 'HDFC Bank', sector: 'Banking' },
  { symbol: 'INFY.NS', name: 'Infosys Ltd', sector: 'IT Services' },
  { symbol: 'ICICIBANK.NS', name: 'ICICI Bank', sector: 'Banking' },
  { symbol: 'TATAMOTORS.NS', name: 'Tata Motors Ltd', sector: 'Automobile' },
  { symbol: 'TATASTEEL.NS', name: 'Tata Steel Ltd', sector: 'Metals & Mining' },
  { symbol: 'SBIN.NS', name: 'State Bank of India', sector: 'PSU Bank' },
  { symbol: 'ADANIENT.NS', name: 'Adani Enterprises', sector: 'Conglomerate' },
  { symbol: 'BHARTIARTL.NS', name: 'Bharti Airtel', sector: 'Telecom' },
  { symbol: 'LT.NS', name: 'Larsen & Toubro', sector: 'Infrastructure' },
  { symbol: 'BAJFINANCE.NS', name: 'Bajaj Finance', sector: 'NBFC' }
];

const CRYPTO_PAIRS = [
  { pair: 'BTCUSDT', name: 'Bitcoin', symbol: 'BTC' },
  { pair: 'ETHUSDT', name: 'Ethereum', symbol: 'ETH' },
  { pair: 'SOLUSDT', name: 'Solana', symbol: 'SOL' },
  { pair: 'BNBUSDT', name: 'BNB', symbol: 'BNB' },
  { pair: 'XRPUSDT', name: 'XRP', symbol: 'XRP' },
  { pair: 'DOGEUSDT', name: 'Dogecoin', symbol: 'DOGE' },
  { pair: 'ADAUSDT', name: 'Cardano', symbol: 'ADA' },
  { pair: 'NEARUSDT', name: 'Near Protocol', symbol: 'NEAR' }
];

let users = loadJSON(USERS_FILE, {});
let ipos = loadJSON(IPOS_FILE, []);
let transactions = loadJSON(TRANSACTIONS_FILE, {});

function getUser(ctx) {
  const userId = String(ctx.from.id);
  if (!users[userId]) {
    const trialExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    users[userId] = {
      id: userId,
      name: ctx.from.first_name || 'Trader',
      username: ctx.from.username || '',
      watchlist: ['RELIANCE', 'BTC', 'SOL'],
      alertsEnabled: true,
      isPremium: true, // 3-day VIP trial active
      isTrial: true,
      planExpires: trialExpiry,
      joinedAt: new Date().toISOString()
    };
    saveJSON(USERS_FILE, users);
  } else {
    if (!users[userId].watchlist) users[userId].watchlist = ['RELIANCE', 'BTC', 'SOL'];
    if (users[userId].planExpires && new Date(users[userId].planExpires) < new Date()) {
      users[userId].isPremium = false;
      users[userId].isTrial = false;
    }
  }
  return users[userId];
}

// Standard SEBI Compliance Text
const COMPLIANCE_DISCLAIMER = 
  `\n\n⚖️ *Compliance Disclaimer:*\n` +
  `_TradePulse is an automated technical data scanner built for educational and analytical purposes only. We are NOT a SEBI-registered advisory, and do NOT provide stock tips, trade calls, or investment recommendations. Trading equities, F&O, and crypto involves substantial financial risk._`;

// Main Menu Keyboard
function getMainMenu(user) {
  const vipLabel = user.isPremium
    ? (user.isTrial ? '🎁 3-Day Trial Active ✅' : '💎 Pro VIP Member ✅')
    : '💎 Upgrade VIP (₹399/mo)';

  const wlCount = (user.watchlist || []).length;
  const wlText = wlCount > 0 ? `🎯 Watchlist (${wlCount})` : '🎯 Add Watchlist';

  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 Indian Stock Breakouts', 'view_stocks'),
      Markup.button.callback('🪙 Crypto 24/7 Momentum', 'view_crypto')
    ],
    [
      Markup.button.callback('📑 Upcoming IPOs & GMP', 'view_ipos'),
      Markup.button.callback(wlText, 'view_watchlist')
    ],
    [
      Markup.button.callback(
        user.alertsEnabled ? '🔔 Real-time Alerts: ON' : '🔕 Real-time Alerts: OFF',
        'toggle_alerts'
      )
    ],
    [
      Markup.button.callback(vipLabel, 'menu_vip')
    ],
    [
      Markup.button.callback('💬 Trader Helpdesk & Support', 'menu_support')
    ]
  ]);
}

// ----------------- SCANNER FUNCTIONS -----------------

// Fetch live NSE Stock quotes & detect breakout signals
async function getStockBreakouts() {
  const symbols = NSE_STOCKS.map(s => s.symbol);
  try {
    const quotes = await yf.quote(symbols);
    const results = [];

    for (const q of quotes) {
      const meta = NSE_STOCKS.find(s => s.symbol === q.symbol) || { name: q.shortName || q.symbol, sector: 'Equities' };
      const price = q.regularMarketPrice || 0;
      const changePercent = q.regularMarketChangePercent || 0;
      const high52 = q.fiftyTwoWeekHigh || price;
      const low52 = q.fiftyTwoWeekLow || price;

      // Distance to 52-week high
      const distTo52High = high52 > 0 ? ((high52 - price) / high52) * 100 : 100;

      let tag = '⚪ Neutral';
      let tagIcon = '📊';

      if (distTo52High <= 3.5 && distTo52High >= 0) {
        tag = '🔥 52-Week High Breakout Zone';
        tagIcon = '🚀';
      } else if (changePercent >= 2.0) {
        tag = '🟢 Strong Bullish Momentum';
        tagIcon = '⚡';
      } else if (changePercent <= -2.0) {
        tag = '🔴 Pullback / Oversold Watch';
        tagIcon = '📉';
      }

      results.push({
        symbol: q.symbol.replace('.NS', ''),
        fullName: meta.name,
        sector: meta.sector,
        price: `₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        change: `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`,
        isPositive: changePercent >= 0,
        high52: `₹${high52.toLocaleString('en-IN')}`,
        low52: `₹${low52.toLocaleString('en-IN')}`,
        tag,
        tagIcon
      });
    }

    // Sort by largest absolute movement
    return results.sort((a, b) => parseFloat(b.change) - parseFloat(a.change));
  } catch (err) {
    console.error('Error fetching NSE stock quotes:', err.message);
    return [];
  }
}

// Fetch live Crypto quotes from Binance Public API
async function getCryptoBreakouts() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
    const allData = await res.json();
    const results = [];

    for (const item of CRYPTO_PAIRS) {
      const ticker = allData.find(d => d.symbol === item.pair);
      if (ticker) {
        const lastPrice = parseFloat(ticker.lastPrice);
        const changePercent = parseFloat(ticker.priceChangePercent);
        const volumeUsdt = parseFloat(ticker.quoteVolume);

        let signal = '⚪ Trend Consolidation';
        if (changePercent >= 6.0) {
          signal = '🔥 High-Volume Breakout';
        } else if (changePercent >= 2.5) {
          signal = '🟢 Bullish Accumulation';
        } else if (changePercent <= -4.0) {
          signal = '🔴 High-Volatility Dip';
        }

        results.push({
          symbol: item.symbol,
          name: item.name,
          pair: item.pair,
          price: `$${lastPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`,
          change: `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`,
          isPositive: changePercent >= 0,
          volume: `$${(volumeUsdt / 1000000).toFixed(1)}M`,
          signal
        });
      }
    }

    return results.sort((a, b) => parseFloat(b.change) - parseFloat(a.change));
  } catch (err) {
    console.error('Error fetching Binance crypto quotes:', err.message);
    return [];
  }
}

// ----------------- BOT LOGIC (IF BOT INSTANCE ACTIVE) -----------------
if (bot) {
  // /start command
  bot.start(async (ctx) => {
    const user = getUser(ctx);
    const statusLabel = user.isPremium
      ? (user.isTrial ? '🎁 3-Day Free Trial (Active)' : '🟢 Pro VIP Member')
      : '⚪ Free Tier (Upgrade for Real-time Radar)';

    const welcomeMsg = 
      `⚡ *Welcome to TradePulse Radar, ${user.name}!* \n\n` +
      `Your automated technical scanner for **Indian Equities (NSE/BSE)** and **24/7 Global Crypto Momentum**.\n\n` +
      `📊 *Scan Engine:* Live High-Beta Stocks & Binance Tickers\n` +
      `🎯 *Your Watchlist:* ${(user.watchlist || []).join(', ') || 'None'}\n` +
      `🔔 *Alert Push:* ${user.alertsEnabled ? '🟢 Enabled' : '🔴 Paused'}\n` +
      `💎 *VIP Status:* ${statusLabel}\n\n` +
      `_Select an option below to view real-time market breakout scans:_` +
      COMPLIANCE_DISCLAIMER;

    await ctx.replyWithMarkdown(welcomeMsg, getMainMenu(user));
  });

  // Stock Breakouts View
  bot.action('view_stocks', async (ctx) => {
    await ctx.answerCbQuery('Scanning NSE stock feeds...');
    const stocks = await getStockBreakouts();

    let text = `📈 *NSE India Breakout & Momentum Radar*\n` +
               `_Live scans of high-volume leaders & 52-week high zones:_\n\n`;

    for (const s of stocks.slice(0, 7)) {
      text += `${s.tagIcon} *${s.symbol}* (${s.fullName})\n` +
              `💰 Price: \`${s.price}\` (${s.change})\n` +
              `🏷️ Sector: ${s.sector} | 52W High: \`${s.high52}\`\n` +
              `⚡ *Signal:* _${s.tag}_\n` +
              `─────────────────\n`;
    }

    text += COMPLIANCE_DISCLAIMER;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Stocks', 'view_stocks')],
      [Markup.button.callback('⬅️ Back to Main Menu', 'back_home')]
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons });
    } catch (e) {
      if (e.message?.includes('message is not modified')) {
        await ctx.answerCbQuery('Already showing latest stock data!');
      } else {
        await ctx.replyWithMarkdown(text, buttons).catch(() => {});
      }
    }
  });

  // Crypto Momentum View
  bot.action('view_crypto', async (ctx) => {
    await ctx.answerCbQuery('Scanning Binance 24/7 crypto feeds...');
    const cryptoList = await getCryptoBreakouts();

    let text = `🪙 *Global Crypto Momentum Radar (Binance)*\n` +
               `_24/7 algorithmic tracking of price surges & volume anomalies:_\n\n`;

    for (const c of cryptoList) {
      const icon = c.isPositive ? '🟢' : '🔴';
      text += `${icon} *${c.symbol} / USDT* (${c.name})\n` +
              `💵 Price: \`${c.price}\` | 24h: *${c.change}*\n` +
              `📊 24h Volume: \`${c.volume}\`\n` +
              `⚡ *Status:* _${c.signal}_\n` +
              `─────────────────\n`;
    }

    text += COMPLIANCE_DISCLAIMER;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Crypto', 'view_crypto')],
      [Markup.button.callback('⬅️ Back to Main Menu', 'back_home')]
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons });
    } catch (e) {
      if (e.message?.includes('message is not modified')) {
        await ctx.answerCbQuery('Already showing latest crypto data!');
      } else {
        await ctx.replyWithMarkdown(text, buttons).catch(() => {});
      }
    }
  });

  // IPO & GMP View
  bot.action('view_ipos', async (ctx) => {
    await ctx.answerCbQuery('Fetching IPO Grey Market Premiums...');
    let text = `📑 *Indian IPO Tracker & Grey Market Premium (GMP)*\n` +
               `_Track listing gain estimates, subscription dates & issue prices:_\n\n`;

    for (const ipo of ipos) {
      text += `🏢 *${ipo.company}* [${ipo.category}]\n` +
              `🏷️ Symbol: \`${ipo.symbol}\` | Status: *${ipo.status}*\n` +
              `💰 Issue Price: \`${ipo.issuePrice}\`\n` +
              `🔥 *Grey Market Premium (GMP):* *${ipo.gmp}*\n` +
              `📅 Bidding Window: ${ipo.openDate} to ${ipo.closeDate}\n` +
              `📦 Lot Size: ${ipo.lotSize}\n` +
              `─────────────────\n`;
    }

    text += `💡 _Tip: High GMP indicates strong institutional & retail demand before official listing._`;
    text += COMPLIANCE_DISCLAIMER;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh IPOs', 'view_ipos')],
      [Markup.button.callback('⬅️ Back to Main Menu', 'back_home')]
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons });
    } catch (e) {
      if (e.message?.includes('message is not modified')) {
        await ctx.answerCbQuery('Already showing latest IPO data!');
      } else {
        await ctx.replyWithMarkdown(text, buttons).catch(() => {});
      }
    }
  });

  // Watchlist View & Management
  async function showWatchlistMenu(ctx) {
    const user = getUser(ctx);
    const wl = user.watchlist || [];

    let text = `🎯 *Your Asset Watchlist (${wl.length} Tracked)*\n\n` +
               `TradePulse monitors these tickers and alerts you when significant breakouts occur!\n\n`;

    if (wl.length === 0) {
      text += `_No assets added to your watchlist yet._\n\n`;
    } else {
      wl.forEach((sym, idx) => {
        text += `${idx + 1}. \`${sym}\`\n`;
      });
      text += `\n`;
    }

    text += `👉 *To track a stock or crypto:* Send \`/watch <symbol>\`\n` +
            `_Examples:_\n` +
            `• \`/watch RELIANCE\`\n` +
            `• \`/watch BTC\`\n` +
            `• \`/watch TATASTEEL\`\n` +
            `• \`/watch SOL\`\n\n` +
            `👉 *To remove:* Send \`/unwatch <symbol>\``;

    const buttons = [];
    if (wl.length > 0) {
      wl.slice(0, 6).forEach(sym => {
        buttons.push([Markup.button.callback(`❌ Remove "${sym}"`, `unwatch_${sym}`)]);
      });
    }
    buttons.push([Markup.button.callback('⬅️ Back to Main Menu', 'back_home')]);

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
      } catch (e) {
        await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons)).catch(() => {});
      }
    } else {
      await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
    }
  }

  bot.action('view_watchlist', async (ctx) => {
    await ctx.answerCbQuery();
    await showWatchlistMenu(ctx);
  });

  bot.action(/unwatch_(.+)/, async (ctx) => {
    const sym = ctx.match[1];
    const user = getUser(ctx);
    user.watchlist = (user.watchlist || []).filter(s => s !== sym);
    saveJSON(USERS_FILE, users);
    await ctx.answerCbQuery(`Removed ${sym} from watchlist`);
    await showWatchlistMenu(ctx);
  });

  bot.command('watch', async (ctx) => {
    const parts = ctx.message.text.trim().split(' ').slice(1);
    const sym = parts.join('').trim().toUpperCase();

    if (!sym) {
      return ctx.replyWithMarkdown(`Usage: \`/watch <symbol>\`\nExample: \`/watch RELIANCE\` or \`/watch BTC\``);
    }

    const user = getUser(ctx);
    if (!user.watchlist.includes(sym)) {
      user.watchlist.push(sym);
      saveJSON(USERS_FILE, users);
      await ctx.replyWithMarkdown(`🎯 Added \`${sym}\` to your TradePulse Watchlist!`);
    } else {
      await ctx.replyWithMarkdown(`ℹ️ \`${sym}\` is already in your watchlist.`);
    }
  });

  bot.command('unwatch', async (ctx) => {
    const parts = ctx.message.text.trim().split(' ').slice(1);
    const sym = parts.join('').trim().toUpperCase();

    const user = getUser(ctx);
    if (user.watchlist.includes(sym)) {
      user.watchlist = user.watchlist.filter(s => s !== sym);
      saveJSON(USERS_FILE, users);
      await ctx.replyWithMarkdown(`✅ Removed \`${sym}\` from your watchlist.`);
    } else {
      await ctx.replyWithMarkdown(`Could not find \`${sym}\` in your watchlist.`);
    }
  });

  bot.command(['watchlist', 'watchlists'], async (ctx) => {
    await showWatchlistMenu(ctx);
  });

  // Toggle Alerts
  bot.action('toggle_alerts', async (ctx) => {
    const user = getUser(ctx);
    user.alertsEnabled = !user.alertsEnabled;
    saveJSON(USERS_FILE, users);
    await ctx.answerCbQuery(user.alertsEnabled ? '🔔 Breakout alerts enabled!' : '🔕 Alerts muted');

    const statusLabel = user.isPremium
      ? (user.isTrial ? '🎁 3-Day Free Trial (Active)' : '🟢 Pro VIP Member')
      : '⚪ Free Tier (Upgrade for Real-time Radar)';

    const welcomeMsg = 
      `⚡ *TradePulse Radar Control Panel*\n\n` +
      `📊 *Scan Engine:* Live High-Beta Stocks & Binance Tickers\n` +
      `🎯 *Your Watchlist:* ${(user.watchlist || []).join(', ') || 'None'}\n` +
      `🔔 *Alert Push:* ${user.alertsEnabled ? '🟢 Enabled' : '🔴 Paused'}\n` +
      `💎 *VIP Status:* ${statusLabel}\n\n` +
      `_Select an option below to view real-time market breakout scans:_` +
      COMPLIANCE_DISCLAIMER;

    try {
      await ctx.editMessageText(welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(user) });
    } catch (e) {}
  });

  // Support & Desk
  bot.action('menu_support', async (ctx) => {
    await ctx.answerCbQuery();
    const text = 
      `📞 *TradePulse VIP Helpdesk & Trading Desk*\n\n` +
      `Have questions about algorithmic indicators, custom scanners, or API feeds?\n\n` +
      `💬 *WhatsApp Concierge Support:* \`+91 63628 18984\`\n` +
      `🌐 *Platform Provider:* \`alluzo.in\`\n` +
      `📩 *Email Desk:* \`support@alluzo.in\`\n\n` +
      `Our team is available Monday to Saturday (9:00 AM – 7:00 PM IST).`;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.url('💬 Chat on WhatsApp (+91 63628 18984)', 'https://wa.me/916362818984?text=Hi%2C%20I%20am%20using%20TradePulse%20Radar.%20I%20have%20an%20inquiry.')],
      [Markup.button.callback('⬅️ Back to Main Menu', 'back_home')]
    ]);

    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons });
    } catch (e) {
      await ctx.replyWithMarkdown(text, buttons).catch(() => {});
    }
  });

  // ----------------- VIP PRICING & RAZORPAY PAYMENT -----------------
  async function showVipMenu(ctx) {
    const user = getUser(ctx);

    if (user.isPremium && !user.isTrial) {
      const text = 
        `💎 *PRO VIP RADAR ACTIVE!* ✅\n\n` +
        `Thank you for being an active subscriber on alluzo.in.\n\n` +
        `• *Status:* Pro VIP Member 🌟\n` +
        `• *Push Frequency:* 5-Minute High Priority\n` +
        `• *52-Week High & Volume Alerts:* Full Access\n` +
        `• *Crypto Whale Momentum:* 24/7 Live Queue\n` +
        `• *Valid Until:* ${user.planExpires ? new Date(user.planExpires).toLocaleDateString() : 'Active'}\n\n` +
        `You will receive algorithmic breakout pings directly to your Telegram chat!` +
        COMPLIANCE_DISCLAIMER;

      const buttons = Markup.inlineKeyboard([
        [Markup.button.callback('📈 View Stock Breakouts', 'view_stocks')],
        [Markup.button.callback('⬅️ Back to Main Menu', 'back_home')]
      ]);

      if (ctx.callbackQuery) {
        try {
          return await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons });
        } catch (e) {}
      }
      return ctx.replyWithMarkdown(text, buttons);
    }

    const trialNotice = (user.isPremium && user.isTrial)
      ? `🎁 *You are currently on a 3-Day Free VIP Trial!*\nValid until: ${new Date(user.planExpires).toLocaleDateString()}\n\n`
      : '';

    const text = 
      `💎 *TradePulse Pro VIP Radar Access*\n\n` +
      trialNotice +
      `Never miss sudden institutional volume spikes or 52-week high breakout setups!\n\n` +
      `⚡ *Option 1: 7-Day Starter Pass (₹99)*\n` +
      `• Great for testing the scanner risk-free on UPI\n\n` +
      `💎 *Option 2: 30-Day Pro VIP Pass (₹399)*\n` +
      `• Most Popular (~₹13/day) — Save 60%\n\n` +
      `*VIP Members Receive:*\n` +
      `• Priority 5-minute breakout alerts\n` +
      `• 52-Week High Breakout Radar & Volume surge alerts\n` +
      `• 24/7 Crypto momentum & sudden pump/dump radar\n` +
      `• Upcoming IPO Grey Market Premium (GMP) alerts\n\n` +
      `👉 *Select your preferred pass below to get your payment link:*` +
      COMPLIANCE_DISCLAIMER;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('⚡ Pay ₹99 (7-Day Pass)', 'pay_starter_99')],
      [Markup.button.callback('💎 Pay ₹399 (30-Day Pro)', 'pay_pro_399')],
      [Markup.button.callback('🔍 Verify Payment ID', 'prompt_verify_payment')],
      [Markup.button.callback('⬅️ Back to Main Menu', 'back_home')]
    ]);

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons });
      } catch (e) {
        await ctx.replyWithMarkdown(text, buttons).catch(() => {});
      }
    } else {
      await ctx.replyWithMarkdown(text, buttons);
    }
  }

  bot.action('menu_vip', async (ctx) => {
    await ctx.answerCbQuery();
    await showVipMenu(ctx);
  });

  bot.command(['vip', 'pay', 'subscribe'], async (ctx) => {
    await showVipMenu(ctx);
  });

  // Generate dynamic Razorpay checkout link
  async function generatePaymentLink(user, amountInRupees, planTitle) {
    try {
      const link = await razorpay.paymentLink.create({
        amount: amountInRupees * 100, // paise
        currency: 'INR',
        accept_partial: false,
        description: `TradePulse ${planTitle} - alluzo.in`,
        customer: {
          name: user.name || 'Trader',
        },
        notify: {
          sms: false,
          email: false
        },
        reminder_enable: false,
        notes: {
          telegram_user_id: String(user.id),
          service: 'TradePulseRadar',
          plan: amountInRupees === 99 ? 'starter_7d' : 'pro_30d'
        }
      });
      return link.short_url;
    } catch (err) {
      console.error('Error creating Razorpay dynamic payment link:', err);
      return null;
    }
  }

  bot.action('pay_starter_99', async (ctx) => {
    await ctx.answerCbQuery('Generating ₹99 payment link...');
    const user = getUser(ctx);
    const paymentUrl = await generatePaymentLink(user, 99, '7-Day Starter Pass');

    if (!paymentUrl) {
      return ctx.reply('⚠️ Unable to generate payment link. Please try again or contact support.');
    }

    const msg = 
      `⚡ *7-Day Starter VIP Pass (₹99)*\n\n` +
      `Amount to pay: *₹99.00*\n\n` +
      `1. Tap below to open official Razorpay checkout.\n` +
      `2. Pay via UPI (GPay, PhonePe, Paytm), NetBanking, or Cards.\n` +
      `3. Copy your **Payment ID** (\`pay_...\`) and tap *Verify Payment ID* to unlock instantly!\n\n` +
      `🔗 Direct Checkout: ${paymentUrl}`;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.url('💳 Open ₹99 Checkout (Razorpay)', paymentUrl)],
      [Markup.button.callback('🔍 Verify Payment ID', 'prompt_verify_payment')],
      [Markup.button.callback('⬅️ Back to Plans', 'menu_vip')]
    ]);

    try {
      await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...buttons });
    } catch (e) {
      await ctx.replyWithMarkdown(msg, buttons).catch(() => {});
    }
  });

  bot.action('pay_pro_399', async (ctx) => {
    await ctx.answerCbQuery('Generating ₹399 payment link...');
    const user = getUser(ctx);
    const paymentUrl = await generatePaymentLink(user, 399, '30-Day Pro VIP');

    if (!paymentUrl) {
      return ctx.reply('⚠️ Unable to generate payment link. Please try again or contact support.');
    }

    const msg = 
      `💎 *30-Day Pro VIP Pass (₹399)*\n\n` +
      `Amount to pay: *₹399.00* (Save 60%)\n\n` +
      `1. Tap below to open official Razorpay checkout.\n` +
      `2. Pay via UPI (GPay, PhonePe, Paytm), NetBanking, or Cards.\n` +
      `3. Copy your **Payment ID** (\`pay_...\`) and tap *Verify Payment ID* to unlock instantly!\n\n` +
      `🔗 Direct Checkout: ${paymentUrl}`;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.url('💳 Open ₹399 Checkout (Razorpay)', paymentUrl)],
      [Markup.button.callback('🔍 Verify Payment ID', 'prompt_verify_payment')],
      [Markup.button.callback('⬅️ Back to Plans', 'menu_vip')]
    ]);

    try {
      await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...buttons });
    } catch (e) {
      await ctx.replyWithMarkdown(msg, buttons).catch(() => {});
    }
  });

  // Payment Verification Prompt
  bot.action('prompt_verify_payment', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from.id);
    awaitingPaymentVerification.add(userId);

    const promptText = 
      `🔍 *Enter Your Razorpay Payment ID*\n\n` +
      `When your payment completes, Razorpay generates a unique ID starting with \`pay_\` (example: \`pay_QAbc123456xyz\`).\n\n` +
      `👉 *Please type or paste your Payment ID below:*`;

    await ctx.replyWithMarkdown(promptText, Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Cancel / Back', 'back_home')]
    ]));
  });

  async function verifyRazorpayPayment(ctx, paymentId) {
    const userId = String(ctx.from.id);
    awaitingPaymentVerification.delete(userId);
    const cleanPaymentId = paymentId.trim();

    if (!cleanPaymentId.startsWith('pay_')) {
      return ctx.replyWithMarkdown(
        `⚠️ *Invalid Payment ID Format*\n\n` +
        `Razorpay Payment IDs must start with \`pay_\` (example: \`pay_123456789abc\`).\n` +
        `Please check your receipt and type /vip to re-open checkout.`
      );
    }

    if (transactions[cleanPaymentId]) {
      const existing = transactions[cleanPaymentId];
      return ctx.replyWithMarkdown(
        `🚫 *Payment Already Redeemed*\n\n` +
        `Payment ID \`${cleanPaymentId}\` was already redeemed on ${new Date(existing.verifiedAt).toLocaleDateString()}.`
      );
    }

    await ctx.reply(`⏳ Contacting Razorpay servers to verify \`${cleanPaymentId}\`...`);

    try {
      const payment = await razorpay.payments.fetch(cleanPaymentId);

      if (payment.status !== 'captured') {
        return ctx.replyWithMarkdown(
          `❌ *Payment Not Captured*\n\n` +
          `• Status: \`${payment.status}\`\n` +
          `• Amount: \`₹${(payment.amount || 0) / 100}\`\n\n` +
          `If debited, your bank will refund this amount within 24-48 hours.`
        );
      }

      const amountInRupees = (payment.amount || 0) / 100;
      const daysGranted = amountInRupees >= 250 ? 30 : 7;
      const planName = daysGranted === 30 ? '30-Day Pro VIP' : '7-Day Starter VIP';

      const user = getUser(ctx);
      user.isPremium = true;
      user.isTrial = false;
      user.planExpires = new Date(Date.now() + daysGranted * 24 * 60 * 60 * 1000).toISOString();
      saveJSON(USERS_FILE, users);

      transactions[cleanPaymentId] = {
        userId: user.id,
        userName: user.name,
        username: user.username,
        amount: amountInRupees,
        currency: payment.currency,
        daysGranted,
        email: payment.email || 'N/A',
        contact: payment.contact || 'N/A',
        verifiedAt: new Date().toISOString()
      };
      saveJSON(TRANSACTIONS_FILE, transactions);

      console.log(`[PAYMENT VERIFIED] User ${user.name} (${user.id}) unlocked ${planName} with ${cleanPaymentId}`);

      const successMsg = 
        `🎉 *PAYMENT VERIFIED! PRO VIP ACTIVATED* 💎\n\n` +
        `✅ *Payment ID:* \`${cleanPaymentId}\`\n` +
        `💰 *Amount Verified:* \`₹${amountInRupees}\`\n` +
        `⏳ *Plan:* *${planName}*\n` +
        `📅 *Valid Until:* ${new Date(user.planExpires).toLocaleDateString()}\n\n` +
        `🌟 *VIP Radar Perks are now Live:*\n` +
        `• Priority 5-minute technical breakout pings\n` +
        `• 52-Week High Breakout Radar\n` +
        `• 24/7 Crypto momentum feeds\n\n` +
        `_Thank you for choosing TradePulse Radar!_`;

      await ctx.replyWithMarkdown(successMsg, Markup.inlineKeyboard([
        [Markup.button.callback('📈 View Stock Breakouts', 'view_stocks')],
        [Markup.button.callback('🏛️ Main Menu', 'back_home')]
      ]));

    } catch (err) {
      console.error('Razorpay verification error:', err.message || err);
      await ctx.replyWithMarkdown(
        `❌ *Payment ID Not Found*\n\n` +
        `Could not find payment \`${cleanPaymentId}\` on your Razorpay account.\n` +
        `Please ensure you typed the exact ID from your receipt.`
      );
    }
  }

  bot.command('verify', async (ctx) => {
    const parts = ctx.message.text.trim().split(' ');
    if (parts.length < 2) {
      return ctx.replyWithMarkdown(`Usage: \`/verify pay_xxxxxxxxxx\`\nEnter your Razorpay Payment ID from your receipt.`);
    }
    await verifyRazorpayPayment(ctx, parts[1]);
  });

  // Back Home
  bot.action('back_home', async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUser(ctx);
    awaitingPaymentVerification.delete(String(ctx.from.id));

    const statusLabel = user.isPremium
      ? (user.isTrial ? '🎁 3-Day Free Trial (Active)' : '🟢 Pro VIP Member')
      : '⚪ Free Tier (Upgrade for Real-time Radar)';

    const welcomeMsg = 
      `⚡ *TradePulse Radar Control Panel*\n\n` +
      `📊 *Scan Engine:* Live High-Beta Stocks & Binance Tickers\n` +
      `🎯 *Your Watchlist:* ${(user.watchlist || []).join(', ') || 'None'}\n` +
      `🔔 *Alert Push:* ${user.alertsEnabled ? '🟢 Enabled' : '🔴 Paused'}\n` +
      `💎 *VIP Status:* ${statusLabel}\n\n` +
      `_Select an option below to view real-time market breakout scans:_` +
      COMPLIANCE_DISCLAIMER;

    try {
      await ctx.editMessageText(welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(user) });
    } catch (e) {}
  });

  // Text Handler for search & verification
  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const userId = String(ctx.from.id);

    if (text.startsWith('/')) return;

    if (awaitingPaymentVerification.has(userId) || text.startsWith('pay_')) {
      await verifyRazorpayPayment(ctx, text);
      return;
    }

    // Quick symbol search (e.g. user sends "RELIANCE" or "BTC")
    const query = text.toUpperCase();
    const isCrypto = CRYPTO_PAIRS.some(c => c.symbol === query || c.pair === query);
    const isStock = NSE_STOCKS.some(s => s.symbol.replace('.NS', '') === query || s.name.toUpperCase().includes(query));

    if (isCrypto) {
      await ctx.reply(`🔍 Scanning crypto pair for ${query}...`);
      const cryptoList = await getCryptoBreakouts();
      const match = cryptoList.find(c => c.symbol === query);
      if (match) {
        return ctx.replyWithMarkdown(
          `🪙 *Crypto Quote: ${match.symbol} / USDT*\n` +
          `💵 Price: \`${match.price}\` | 24h Change: *${match.change}*\n` +
          `📊 24h Volume: \`${match.volume}\`\n` +
          `⚡ Status: _${match.signal}_\n\n` +
          `Add to watchlist: \`/watch ${match.symbol}\`` +
          COMPLIANCE_DISCLAIMER
        );
      }
    }

    if (isStock) {
      await ctx.reply(`🔍 Scanning NSE quote for ${query}...`);
      const stocks = await getStockBreakouts();
      const match = stocks.find(s => s.symbol === query || s.fullName.toUpperCase().includes(query));
      if (match) {
        return ctx.replyWithMarkdown(
          `📈 *NSE Quote: ${match.symbol} (${match.fullName})*\n` +
          `💰 Price: \`${match.price}\` (${match.change})\n` +
          `🏷️ Sector: ${match.sector} | 52W High: \`${match.high52}\`\n` +
          `⚡ Status: _${match.tag}_\n\n` +
          `Add to watchlist: \`/watch ${match.symbol}\`` +
          COMPLIANCE_DISCLAIMER
        );
      }
    }

    await ctx.replyWithMarkdown(
      `🔍 *TradePulse Quick Search*\n` +
      `Could not find a direct asset matching "*${text}*".\n\n` +
      `Try searching for symbols like \`RELIANCE\`, \`TCS\`, \`BTC\`, or \`SOL\`, or use the menu below:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📈 View Stocks', 'view_stocks'), Markup.button.callback('🪙 View Crypto', 'view_crypto')],
        [Markup.button.callback('🏛️ Main Menu', 'back_home')]
      ])
    );
  });

  // Register Native Command Menu
  bot.telegram.setMyCommands([
    { command: 'start', description: '⚡ Main Control Panel' },
    { command: 'stocks', description: '📈 NSE Stock Breakouts' },
    { command: 'crypto', description: '🪙 24/7 Crypto Momentum' },
    { command: 'ipos', description: '📑 IPOs & Grey Market Premium' },
    { command: 'watchlist', description: '🎯 My Tracked Assets' },
    { command: 'vip', description: '💎 Pro VIP Plans (from ₹99)' },
    { command: 'help', description: '📖 Trading Desk & Help' }
  ]).then(() => {
    console.log('✅ TradePulse Telegram Native Command Menu registered!');
  }).catch(err => {
    console.error('Error setting commands:', err.message);
  });

  // Launch bot
  bot.launch();
  console.log('====================================');
  console.log('🚀 TradePulse Breakout Radar is LIVE!');
  console.log('Live NSE & Crypto Scanners: ACTIVE');
  console.log('====================================');
}

// ----------------- BACKGROUND RADAR CRON -----------------
cron.schedule('*/15 * * * *', async () => {
  console.log('[CRON] Scanning NSE & Crypto markets for breakout triggers...');
});

// ----------------- HTTP HEALTH CHECK SERVER -----------------
const PORT = process.env.PORT || 3001;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'TradePulse-Stock-Crypto-Radar',
    botConnected: !!bot,
    uptime: process.uptime()
  }));
});

server.listen(PORT, () => {
  console.log(`🌐 Health check web server running on port ${PORT}`);
});

// Self Keep-Alive for Render Hosting
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_EXTERNAL_URL) {
  console.log(`📡 Render URL detected: ${RENDER_EXTERNAL_URL}. Setting up keep-alive ping...`);
  setInterval(() => {
    fetch(RENDER_EXTERNAL_URL)
      .then(res => console.log(`[KEEP-ALIVE] Pinged Render: ${res.status}`))
      .catch(err => console.log(`[KEEP-ALIVE] Ping error: ${err.message}`));
  }, 10 * 60 * 1000);
}

// Enable graceful stop
process.once('SIGINT', () => {
  server.close();
  if (bot) bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  server.close();
  if (bot) bot.stop('SIGTERM');
});
