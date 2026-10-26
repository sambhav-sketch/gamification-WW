/**
 * Wonderwoods Sales Gamification — Relay Server v2
 *
 * - Receives manual triggers from admin panel → broadcasts tiered animations
 * - Receives Bitrix24 webhooks → broadcasts deal won / big deal animations
 * - Polls Bitrix24 REST API every 5 min → serves live ticker data to display
 * - Stores and serves leaderboard data (Manish updates every Monday)
 *
 * Deploy on Railway.app: railway up
 * Env vars: API_KEY, BITRIX_WEBHOOK_URL, PORT
 */

const express  = require('express');
const WebSocket = require('ws');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files from public/ (admin.html lives here)
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'ww-secret-2024';

// Your Bitrix24 inbound webhook URL — set in Railway env as BITRIX_WEBHOOK_URL
// Format: https://YOUR-DOMAIN.bitrix24.com/rest/1/YOUR-WEBHOOK-TOKEN/
const BITRIX_URL = process.env.BITRIX_WEBHOOK_URL || '';

const BITRIX_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const LEADERBOARD_FILE     = path.join(__dirname, 'leaderboard.json');

// ── BITRIX USER MAP (verified from SALES_TEAM_with_Bitrix_ID.xlsx) ───────────
const USER_MAP = {
  // Management / Accounts
  '1':    'Sambhav Khandelwal',
  '3':    'Manish Panwar',
  '101':  'Md Miraj',
  '2079': 'Surmeet Saini',
  '2045': 'Nancy Khandelwal',

  // B2C — Geet's team
  '593':  'Geet Rawat',
  '2901': 'Pooja',
  '2827': 'Ritu Dhuper',
  '2953': 'Rishabh',
  '2895': 'Prashant',

  // B2B West & Central — Vishal Poddar's team
  '137':  'Vishal Poddar',
  '2891': 'Somender',
  '2513': 'Kishan',
  '2867': 'Umesh',
  '697':  'Shubham',
  '2527': 'Priyanshi',

  // B2B Delhi — Abhishek Wilson's team
  '2501': 'Abhishek Wilson',
  '537':  'Ashwani Kumar',
  '2499': 'Janak',
  '2851': 'Sooraj',
  '2815': 'Aarif',

  // B2B North & South — Samarth's team
  '15':   'Samarth Khandelwal',
  '2943': 'Mansi',
  '2037': 'Hemant',
  '2857': 'Waseem',
  '741':  'Abhishek Sharma',
  '2899': 'Ayush',

  // Perscape — Anurag's team
  '487':  'Anurag Khandelwal',
  '2881': 'Divya',
  '2947': 'Krishna',
  '1287': 'Sampada',
  '2841': 'Vishal Choudhary',
  '2883': 'Prachi',
  '2893': 'Rahul',
};

// ── WON STAGES ────────────────────────────────────────────────────────────────
const WON_STAGES = new Set(['WON', 'C9:WON']);

// Bitrix user IDs per salesperson (for ticker attribution)
const PERSON_USER_IDS = {
  'Samarth Khandelwal': '15',
  'Abhishek Sharma':    '741',
  'Vishal Poddar':      '137',
  'Geet Rawat':         '593',
  'Anurag Khandelwal':  '487',
};

// ── TIER SYSTEM ───────────────────────────────────────────────────────────────
function getTier(amountRaw) {
  const val = parseFloat(String(amountRaw).replace(/[^0-9.]/g, '')) || 0;
  // If already formatted (e.g. "₹12.5L"), convert back to raw
  const raw = String(amountRaw).includes('L')
    ? parseFloat(String(amountRaw).replace(/[^0-9.]/g, '')) * 100000
    : val;

  if (raw >= 1000000) return { tier: 4, name: 'SUPER DEAL',  cls: 'tier-super', icon: '🚀', color: '#E8C878' };
  if (raw >= 500000)  return { tier: 3, name: 'DEAL BOMB',   cls: 'tier-bomb',  icon: '💥', color: '#C9A84C' };
  if (raw >= 100000)  return { tier: 2, name: 'DEAL DONE',   cls: 'tier-done',  icon: '🔥', color: '#C07B3E' };
  return                     { tier: 1, name: 'SPARK',        cls: 'tier-spark', icon: '⚡', color: '#8AA8C8' };
}

// ── FORMAT HELPERS ────────────────────────────────────────────────────────────
function formatAmount(raw) {
  const val = parseFloat(raw) || 0;
  if (val >= 10000000) return '₹' + (val / 10000000).toFixed(1) + 'Cr';
  if (val >= 100000)   return '₹' + (val / 100000).toFixed(1) + 'L';
  if (val >= 1000)     return '₹' + (val / 1000).toFixed(0) + 'K';
  return '₹' + val;
}

function today() {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d;
}

function bitrixDate(dt) {
  // Bitrix expects YYYY-MM-DD
  return dt.toISOString().split('T')[0];
}

// ── LEADERBOARD STORE ─────────────────────────────────────────────────────────
let leaderboardData = {
  updatedBy:   '',
  updatedAt:   '',
  weekLabel:   '',
  teams: [
    { name:'Samarth Khandelwal', role:'South & North',  wins:0, revenue:0, orders:0 },
    { name:'Abhishek Sharma',    role:'Delhi B2B',       wins:0, revenue:0, orders:0 },
    { name:'Vishal Poddar',      role:'West B2B',        wins:0, revenue:0, orders:0 },
    { name:'Geet Rawat',         role:'Retail',          wins:0, revenue:0, orders:0 },
    { name:'Anurag Khandelwal',  role:'Perscape (A&D)',  wins:0, revenue:0, orders:0 },
  ]
};

// Load persisted leaderboard if it exists
if (fs.existsSync(LEADERBOARD_FILE)) {
  try {
    leaderboardData = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    console.log('[LB] Loaded persisted leaderboard');
  } catch(e) { console.log('[LB] Could not load leaderboard file:', e.message); }
}

function saveLeaderboard() {
  try { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboardData, null, 2)); }
  catch(e) { console.log('[LB] Could not save leaderboard:', e.message); }
}

// ── MONTHLY STATS STORE ───────────────────────────────────────────────────────
// Monthly revenue totals reset on the 1st of each month.
// Server broadcasts month stats + countdown on connect and after each poll.
const MONTHLY_FILE = path.join(__dirname, 'monthly.json');

function currentMonthKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
}

let monthlyData = { monthKey: currentMonthKey(), totalRevenue: 0, totalOrders: 0, totalWins: 0 };
if (fs.existsSync(MONTHLY_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(MONTHLY_FILE, 'utf8'));
    if (saved.monthKey === currentMonthKey()) {
      monthlyData = saved;
      console.log('[MONTHLY] Loaded persisted monthly data for', saved.monthKey);
    } else {
      console.log('[MONTHLY] New month — resetting counters');
    }
  } catch(e) { console.log('[MONTHLY] Could not load monthly file:', e.message); }
}

function saveMonthly() {
  try { fs.writeFileSync(MONTHLY_FILE, JSON.stringify(monthlyData, null, 2)); }
  catch(e) { console.log('[MONTHLY] Could not save:', e.message); }
}

function addToMonthly({ revenue = 0, orders = 0, wins = 0 }) {
  // Reset if month rolled over
  if (monthlyData.monthKey !== currentMonthKey()) {
    monthlyData = { monthKey: currentMonthKey(), totalRevenue: 0, totalOrders: 0, totalWins: 0 };
  }
  monthlyData.totalRevenue += revenue;
  monthlyData.totalOrders  += orders;
  monthlyData.totalWins    += wins;
  saveMonthly();
}

// Countdown: last 5 days of month
function getCountdown() {
  const now     = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const today   = now.getDate();
  const daysLeft = lastDay - today;
  if (daysLeft <= 0)  return { active: true,  daysLeft: 0, message: 'LAST DAY OF THE MONTH! 🔥' };
  if (daysLeft <= 5)  return { active: true,  daysLeft, message: `${daysLeft} DAY${daysLeft === 1 ? '' : 'S'} TO GO — MAKE IT COUNT! 🚀` };
  return { active: false, daysLeft: null, message: null };
}

// ── TODAY STATS STORE ─────────────────────────────────────────────────────────
// Tracks orders / deliveries / revenue / wins fired today via manual triggers.
// Resets automatically at midnight IST. Sent to every display on WS connect.
function todayDateKey() {
  // IST = UTC+5:30
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

let todayStats = { dateKey: todayDateKey(), orders: 0, deliveries: 0, revenue: 0, wins: 0 };

function addToToday({ orders = 0, deliveries = 0, revenue = 0, wins = 0 }) {
  // Reset if day has rolled over
  if (todayStats.dateKey !== todayDateKey()) {
    todayStats = { dateKey: todayDateKey(), orders: 0, deliveries: 0, revenue: 0, wins: 0 };
  }
  todayStats.orders     += orders;
  todayStats.deliveries += deliveries;
  todayStats.revenue    += revenue;
  todayStats.wins       += wins;
}

// Schedule midnight IST reset (also handled in addToToday, this just keeps it clean)
function schedMidnightReset() {
  const now     = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const nextMid = new Date(now);
  nextMid.setUTCHours(18, 30, 5, 0); // 00:00:05 IST = 18:30:05 UTC
  if (nextMid <= now) nextMid.setUTCDate(nextMid.getUTCDate() + 1);
  const ms = nextMid - now;
  setTimeout(() => {
    todayStats = { dateKey: todayDateKey(), orders: 0, deliveries: 0, revenue: 0, wins: 0 };
    broadcast({ type: 'today', data: todayStats });
    console.log('[TODAY] Midnight IST reset — stats cleared');
    schedMidnightReset();
  }, ms);
  console.log(`[TODAY] Next reset in ${Math.round(ms/60000)} min`);
}
schedMidnightReset();

// ── TICKER CACHE ──────────────────────────────────────────────────────────────
let tickerCache = {
  dealsCreated: { count:0, value:0, top4:[] },
  dealsWon:     { count:0, value:0, top4:[] },
  pipelineTotal: 0,
  fetchedAt: null,
};

// ── BITRIX REST FETCH HELPER ──────────────────────────────────────────────────
function bitrixFetch(method, params) {
  return new Promise((resolve, reject) => {
    if (!BITRIX_URL) return resolve(null);
    const qs     = new URLSearchParams(params).toString();
    const url    = `${BITRIX_URL}${method}?${qs}`;
    const req    = https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Bitrix timeout')); });
  });
}

// ── POLL BITRIX FOR TODAY'S DATA ───────────────────────────────────────────────
async function pollBitrix() {
  if (!BITRIX_URL) {
    console.log('[BITRIX] No webhook URL configured — ticker will use demo data');
    return;
  }
  try {
    const todayStr = bitrixDate(today());

    // Deals CREATED today
    const created = await bitrixFetch('crm.deal.list', {
      'filter[>=DATE_CREATE]': todayStr,
      'select[]': ['ID','TITLE','OPPORTUNITY','ASSIGNED_BY_ID','STAGE_ID','UF_CRM_PRODUCT'],
      'order[OPPORTUNITY]': 'DESC',
      'start': 0
    });

    // Deals WON today (stage changed to WON)
    // Bitrix doesn't have a "won_date" filter natively; we filter by CLOSEDATE = today
    const won = await bitrixFetch('crm.deal.list', {
      'filter[CLOSED]':         'Y',
      'filter[>=CLOSEDATE]':    todayStr,
      'select[]': ['ID','TITLE','OPPORTUNITY','ASSIGNED_BY_ID','STAGE_ID','UF_CRM_PRODUCT'],
      'order[OPPORTUNITY]': 'DESC',
      'start': 0
    });

    // Pipeline total (all open deals)
    const pipeline = await bitrixFetch('crm.deal.list', {
      'filter[CLOSED]': 'N',
      'select[]': ['OPPORTUNITY'],
      'start': 0
    });

    const mapDeals = (items) => {
      if (!items?.result) return { count:0, value:0, top4:[] };
      const list = items.result;
      const totalVal = list.reduce((s,d) => s + parseFloat(d.OPPORTUNITY||0), 0);
      const top4 = list.slice(0,4).map(d => ({
        person:  USER_MAP[d.ASSIGNED_BY_ID] || `User #${d.ASSIGNED_BY_ID}`,
        product: d.TITLE || 'Deal',
        amount:  formatAmount(parseFloat(d.OPPORTUNITY||0)),
      }));
      return { count: list.length, value: totalVal, top4 };
    };

    const pipelineVal = (pipeline?.result || []).reduce((s,d) => s + parseFloat(d.OPPORTUNITY||0), 0);

    tickerCache = {
      dealsCreated:  mapDeals(created),
      dealsWon:      mapDeals(won),
      pipelineTotal: pipelineVal,
      fetchedAt:     new Date().toISOString(),
    };

    console.log('[BITRIX] Ticker updated:', JSON.stringify(tickerCache, null, 2));
  } catch(e) {
    console.log('[BITRIX] Poll error:', e.message);
  }
}

// Start polling
pollBitrix();
setInterval(pollBitrix, BITRIX_POLL_INTERVAL);

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });
let connectedScreens = 0;

wss.on('connection', (ws) => {
  connectedScreens++;
  console.log(`[WS] Screen connected. Total: ${connectedScreens}`);

  // Send current state immediately on connect — display rebuilds from this
  ws.send(JSON.stringify({ type: 'ticker',      data: tickerCache }));
  ws.send(JSON.stringify({ type: 'leaderboard', data: leaderboardData }));
  ws.send(JSON.stringify({ type: 'monthly',     data: monthlyData, countdown: getCountdown() }));
  ws.send(JSON.stringify({ type: 'today',       data: todayStats }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 30000);

  ws.on('close', () => { connectedScreens--; clearInterval(heartbeat); });
  ws.on('error', () => {});
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  console.log('[BROADCAST]', msg.substring(0, 200));
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── HTTP SERVER with WS upgrade ───────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`[HTTP] Listening on port ${PORT}`));

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request);
  });
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
function requireKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── BITRIX INBOUND WEBHOOK ────────────────────────────────────────────────────
app.post('/bitrix/deal', (req, res) => {
  res.sendStatus(200);

  const data   = req.body;
  const event  = data.event || '';
  const deal   = data.data?.FIELDS || {};
  const stageId   = deal.STAGE_ID || '';
  const amount    = parseFloat(deal.OPPORTUNITY || 0);
  const userId    = deal.ASSIGNED_BY_ID || '';
  const title     = deal.TITLE || 'New Deal';
  const company   = deal.COMPANY_TITLE || deal.CONTACT_FULL_NAME || '';
  const person    = USER_MAP[userId] || `User #${userId}`;
  const formatted = formatAmount(amount);
  const tier      = getTier(amount);

  if (WON_STAGES.has(stageId)) {
    if (amount >= 25000) {
      addToToday({ wins: 1 });
      addToMonthly({ wins: 1 });
      broadcast({ type: 'today', data: todayStats });
      broadcast({
        type:        'celebration',
        triggerType: 'win',
        tier,
        headline:    tier.name,
        subtext:     'Deal Won',
        person,
        product:     title,
        client:      company || title,
        location:    '',
        amount:      formatted,
        eventType:   'Deal Won',
      });
      broadcast({ type: 'monthly', data: monthlyData, countdown: getCountdown() });
    }
    // Refresh tickers after a win
    setTimeout(pollBitrix, 3000);
    return;
  }

  if (event === 'ONCRMDEALADD' && amount >= 25000) { // min ₹25K threshold
    broadcast({
      type:        'celebration',
      triggerType: 'deal',
      tier,
      headline:    'BIG DEAL IN!',
      subtext:     'Significant pipeline entry',
      person,
      product:     title,
      client:      company || title,
      location:    '',
      amount:      formatted,
      eventType:   'Major Deal Created',
    });
  }
});

// ── MANUAL TRIGGER ────────────────────────────────────────────────────────────
// triggerType: 'order' (advance received) | 'delivery' (material dispatched)
app.post('/trigger', requireKey, (req, res) => {
  const { triggerType, person, product, client, location, amount } = req.body;

  if (!['order','delivery'].includes(triggerType)) {
    return res.status(400).json({ error: 'triggerType must be order or delivery' });
  }

  const amountRaw = String(amount || '0').replace(/[^0-9.LCrKk]/g, '');
  // Parse back to raw number for tier calculation
  let raw = parseFloat(amountRaw) || 0;
  if (amountRaw.toLowerCase().includes('cr')) raw = raw * 10000000;
  else if (amountRaw.toLowerCase().includes('l')) raw = raw * 100000;
  else if (amountRaw.toLowerCase().includes('k')) raw = raw * 1000;

  // Minimum threshold: ₹25,000 — no celebration below this
  if (raw < 25000) {
    return res.status(400).json({ error: 'Amount below ₹25K minimum — no celebration fired' });
  }

  const tier      = getTier(raw);
  const formatted = formatAmount(raw);

  const headlines = {
    order:    { 'SPARK': 'ORDER IN!', 'DEAL DONE': 'ORDER LOCKED!', 'DEAL BOMB': 'DEAL BOMB! 💥', 'SUPER DEAL': 'SUPER DEAL! 🚀' },
    delivery: { 'SPARK': 'OUT THE DOOR!', 'DEAL DONE': 'DELIVERED!', 'DEAL BOMB': 'BOMB AWAY! 💥', 'SUPER DEAL': 'MEGA DISPATCH! 🚀' },
  };

  const subtexts = {
    order:    'Advance Received · Order Confirmed',
    delivery: 'Material Dispatched',
  };

  // Accumulate into today's and monthly totals
  const isOrder    = triggerType === 'order';
  const isDelivery = triggerType === 'delivery';
  addToToday({
    orders:     isOrder    ? 1 : 0,
    deliveries: isDelivery ? 1 : 0,
    revenue:    isOrder    ? raw : 0,   // revenue counted on order, not delivery
  });
  addToMonthly({
    revenue: isOrder ? raw : 0,
    orders:  isOrder ? 1  : 0,
  });

  broadcast({
    type:        'celebration',
    triggerType,
    tier,
    headline:    headlines[triggerType][tier.name],
    subtext:     subtexts[triggerType],
    person:      person   || 'Sales Team',
    product:     product  || 'Product',
    client:      client   || 'Client',
    location:    location || '',
    amount:      formatted,
    eventType:   triggerType === 'order' ? 'Order Confirmed' : 'Delivery',
  });

  // Push updated stats to all screens
  broadcast({ type: 'today',   data: todayStats });
  broadcast({ type: 'monthly', data: monthlyData, countdown: getCountdown() });

  res.json({ ok: true, screens: connectedScreens, tier: tier.name, amount: formatted });
});

// ── TODAY ENDPOINT ────────────────────────────────────────────────────────────
app.get('/today', (req, res) => {
  // Reset if day rolled over
  if (todayStats.dateKey !== todayDateKey()) {
    todayStats = { dateKey: todayDateKey(), orders: 0, deliveries: 0, revenue: 0, wins: 0 };
  }
  res.json(todayStats);
});

// ── MONTHLY ENDPOINT ──────────────────────────────────────────────────────────
app.get('/monthly', (req, res) => {
  // Reset if new month (server might have been up since last month)
  if (monthlyData.monthKey !== currentMonthKey()) {
    monthlyData = { monthKey: currentMonthKey(), totalRevenue: 0, totalOrders: 0, totalWins: 0 };
    saveMonthly();
  }
  res.json({ data: monthlyData, countdown: getCountdown() });
});

// ── TICKER ENDPOINT ───────────────────────────────────────────────────────────
app.get('/ticker', (req, res) => {
  res.json(tickerCache);
});

// Force-refresh ticker (Sambhav can call this)
app.post('/ticker/refresh', requireKey, async (req, res) => {
  await pollBitrix();
  broadcast({ type: 'ticker', data: tickerCache });
  res.json({ ok: true, data: tickerCache });
});

// ── LEADERBOARD ENDPOINTS ─────────────────────────────────────────────────────
app.get('/leaderboard', (req, res) => {
  res.json(leaderboardData);
});

// Manish updates this every Monday
app.post('/leaderboard', requireKey, (req, res) => {
  const { teams, weekLabel, updatedBy } = req.body;
  if (!Array.isArray(teams)) return res.status(400).json({ error: 'teams must be array' });

  leaderboardData = {
    updatedBy: updatedBy || 'Manish',
    updatedAt: new Date().toISOString(),
    weekLabel: weekLabel || `W/e ${new Date().toLocaleDateString('en-IN')}`,
    teams,
  };
  saveLeaderboard();

  // Push updated leaderboard to all screens
  broadcast({ type: 'leaderboard', data: leaderboardData });
  res.json({ ok: true });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, screens: connectedScreens, uptime: process.uptime(), tickerAge: tickerCache.fetchedAt });
});
