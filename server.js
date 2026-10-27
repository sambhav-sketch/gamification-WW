/**
 * Wonderwoods Sales Gamification — Relay Server v2
 *
 * - Receives manual triggers from admin panel → broadcasts tiered animations
 * - Receives Bitrix24 webhooks → broadcasts deal won / big deal animations
 * - Polls Bitrix24 REST API every 5 min → serves live ticker data to display
 * - Stores and serves leaderboard data (Manish updates every Monday)
 *
 * Deploy on Railway.app: railway up
 * Env vars: GOOGLE_CLIENT_ID, BITRIX_WEBHOOK_URL, PORT
 */

const express  = require('express');
const WebSocket = require('ws');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { OAuth2Client } = require('google-auth-library');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files from public/ (admin.html lives here)
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT    = process.env.PORT || 3000;
// ── ADMIN ACCESS (Google Sign-In) ─────────────────────────────────────────────
// Only these Google Workspace accounts can use the admin panel.
// perms = celebration types allowed · lb = can push the weekly leaderboard
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '562668480557-l07d7pdhpj7gob088ngveltduonr7b0b.apps.googleusercontent.com';
const ALLOWED_DOMAIN   = 'uniqueflooring.in';
const ADMIN_USERS = {
  'sambhav@uniqueflooring.in':  { name:'Sambhav', init:'SK', role:'Founder & MD',   perms:['order','delivery','win'], lb:true  },
  'surmeet@uniqueflooring.in':  { name:'Surmeet', init:'SU', role:'Assistant',      perms:['order','delivery','win'], lb:true  },
  'accounts2@uniqueflooring.in':{ name:'Ankush',  init:'AN', role:'Accounts & Ops', perms:['order','delivery'],       lb:true  },
  'miraj@uniqueflooring.in':    { name:'Miraj',   init:'MI', role:'Billing',        perms:['order','delivery'],       lb:false },
};
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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

// ── GOOGLE SHEET STORAGE ──────────────────────────────────────────────────────
// Render's free plan wipes local files on restart, so the leaderboard, monthly and
// today's totals are kept in a Google Sheet (via an Apps Script web app).
// Env vars on Render: SHEET_URL (the web app /exec link) and SHEET_KEY (shared secret).
const SHEET_URL = process.env.SHEET_URL || '';
const SHEET_KEY = process.env.SHEET_KEY || '';
const sheetTimers = {};

function sheetRequest(method, url, body, redirects = 4) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();   // Apps Script answers via a redirect that must be fetched with GET
        return resolve(sheetRequest('GET', new URL(res.headers.location, url).toString(), null, redirects - 1));
      }
      let txt = ''; res.on('data', c => txt += c);
      res.on('end', () => { try { resolve(JSON.parse(txt)); } catch (e) { reject(new Error('Sheet replied: ' + txt.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Sheet timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function sheetPost(action, name, value) {
  if (!SHEET_URL || !SHEET_KEY) return Promise.resolve();
  return sheetRequest('POST', SHEET_URL, { key: SHEET_KEY, action, name, value })
    .then(r => { if (r && r.error) console.log('[SHEET]', action, r.error); })
    .catch(e => console.log('[SHEET] write failed:', e.message));
}

// Coalesce rapid changes (e.g. several triggers in a row) into one write per item
function sheetSaveState(name, valueFn) {
  clearTimeout(sheetTimers[name]);
  sheetTimers[name] = setTimeout(() => sheetPost('state', name, valueFn()), 2000);
}

async function sheetLoadState() {
  if (!SHEET_URL || !SHEET_KEY) { console.log('[SHEET] Not configured — using local files only'); checkDealEvents(); return; }
  try {
    const r = await sheetRequest('GET', `${SHEET_URL}?key=${encodeURIComponent(SHEET_KEY)}`);
    if (!r || !r.ok) throw new Error((r && r.error) || 'bad reply');
    const st = r.state || {};
    if (st.weeks && typeof st.weeks === 'object') lbWeeks = st.weeks;
    rebuildLeaderboard();
    if (st.monthly && st.monthly.monthKey === currentMonthKey()) monthlyData = st.monthly;
    if (st.today && st.today.dateKey === todayDateKey()) todayStats = st.today;
    if (st.watch && +st.watch.lastDealId > 0) { lastDealId = +st.watch.lastDealId; console.log('[WATCH] Resuming after deal #' + lastDealId); }
    console.log('[SHEET] State restored from Google Sheet');
    broadcast({ type: 'leaderboard', data: leaderboardData });
    broadcast({ type: 'monthly', data: monthlyData, countdown: getCountdown() });
    broadcast({ type: 'today', data: todayStats });
  } catch (e) {
    console.log('[SHEET] Could not load state:', e.message);
  }
  checkDealEvents();
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

// ── WEEKLY ENTRIES → MONTH-TO-DATE LEADERBOARD ───────────────────────────────
// Surmeet / Ankush enter ONLY one week's sales per person (keyed by week-ending date).
// The board shows the sum of all weeks whose week-ending date falls in the current
// month (IST) — so it resets to zero by itself on the 1st. Re-saving a week edits it.
const WEEKS_FILE = path.join(__dirname, 'leaderboard-weeks.json');
let lbWeeks = {};   // 'YYYY-MM-DD' → { weekEnding, updatedBy, updatedAt, people:[{name,role,group,revenue,wins,orders}] }
if (fs.existsSync(WEEKS_FILE)) {
  try { lbWeeks = JSON.parse(fs.readFileSync(WEEKS_FILE, 'utf8')); console.log('[LB] Loaded weekly entries'); }
  catch (e) { console.log('[LB] Could not load weekly entries:', e.message); }
}

function istMonthKey() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7); }
function weekLabelOf(d) {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function rebuildLeaderboard() {
  const mk = istMonthKey();
  const weeks = Object.values(lbWeeks).filter(w => w.weekEnding.slice(0, 7) === mk)
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
  const sum = {};
  for (const w of weeks) for (const p of (w.people || [])) {
    const t = sum[p.name] || (sum[p.name] = { name: p.name, role: p.role, group: p.group, revenue: 0, wins: 0, orders: 0 });
    t.revenue += +p.revenue || 0; t.wins += +p.wins || 0; t.orders += +p.orders || 0;
  }
  const lastEntry = weeks[weeks.length - 1];
  const lastEdit  = weeks.reduce((a, w) => (!a || w.updatedAt > a.updatedAt ? w : a), null);
  leaderboardData = {
    monthKey:   mk,
    weeksCount: weeks.length,
    weekLabel:  lastEntry ? weekLabelOf(lastEntry.weekEnding) : '',
    updatedBy:  lastEdit ? lastEdit.updatedBy : '',
    updatedAt:  lastEdit ? lastEdit.updatedAt : '',
    teams:      Object.values(sum),
  };
  return leaderboardData;
}

function saveLeaderboard(changedWeek) {
  // keep ~4 months of weekly entries
  const cutoff = new Date(Date.now() - 120 * 86400 * 1000).toISOString().slice(0, 10);
  for (const k of Object.keys(lbWeeks)) if (k < cutoff) delete lbWeeks[k];
  try { fs.writeFileSync(WEEKS_FILE, JSON.stringify(lbWeeks, null, 2)); } catch (e) {}
  sheetSaveState('weeks', () => lbWeeks);
  if (changedWeek) sheetPost('leaderboard', 'history', changedWeek);
}
rebuildLeaderboard();

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
  sheetSaveState('monthly', () => monthlyData);
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
  sheetSaveState('today', () => todayStats);
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
    if (leaderboardData.monthKey !== istMonthKey()) {          // 1st of the month → board back to zero
      rebuildLeaderboard();
      broadcast({ type: 'leaderboard', data: leaderboardData });
      console.log('[LB] New month — leaderboard reset');
    }
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
    const usp    = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) (Array.isArray(v) ? v : [v]).forEach(x => usp.append(k, x));
    const qs     = usp.toString();
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
      'filter[STAGE_SEMANTIC_ID]': 'S',   // S = success (won); CLOSED=Y would also count lost deals
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

// ── LIVE DEAL WATCHER (deal created / deal won) ───────────────────────────────
// Checks Bitrix every 60s (and instantly when Bitrix calls /bitrix/deal).
// New deal = ID higher than the last one seen. Won deal = success stage, closed today.
// On server start it only records what already exists, so nothing old is replayed.
const WATCH_INTERVAL = 60 * 1000;
let lastDealId   = null;          // highest deal ID seen
const wonSeen    = new Set();     // won deal IDs already celebrated
let watchBusy    = false;

function istDateStr() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Product category for a deal: the UF_CRM_PRODUCT field (list IDs resolved to names), else pipeline name
let productItems = null, pipelineNames = null;
async function loadDealMeta() {
  if (productItems && pipelineNames) return;
  try {
    const f = await bitrixFetch('crm.deal.fields', {});
    const fld = f?.result?.UF_CRM_PRODUCT;
    productItems = {};
    (fld?.items || []).forEach(it => { productItems[String(it.ID)] = it.VALUE; });
  } catch (e) { productItems = {}; }
  try {
    const c = await bitrixFetch('crm.dealcategory.list', {});
    pipelineNames = { '0': 'General' };
    (c?.result || []).forEach(x => { pipelineNames[String(x.ID)] = x.NAME; });
  } catch (e) { pipelineNames = {}; }
}
function productCategory(d) {
  let v = d.UF_CRM_PRODUCT;
  if (Array.isArray(v)) v = v.map(x => (productItems && productItems[String(x)]) || x).filter(Boolean).join(', ');
  else if (v !== undefined && v !== null && v !== '' && productItems && productItems[String(v)]) v = productItems[String(v)];
  if (v && String(v).trim() && !/^\d+$/.test(String(v))) return String(v).trim();
  return '';
}

async function checkDealEvents() {
  if (!BITRIX_URL || watchBusy) return;
  watchBusy = true;
  try {
    const first = lastDealId === null;

    // NEW DEALS
    const created = await bitrixFetch('crm.deal.list', {
      'filter[>ID]': first ? 0 : lastDealId,
      'select[]': ['ID','TITLE','OPPORTUNITY','ASSIGNED_BY_ID','COMPANY_ID','CATEGORY_ID','DATE_CREATE','UF_CRM_PRODUCT'],
      'order[ID]': first ? 'DESC' : 'ASC',
      'start': 0,
    });
    const newDeals = created?.result || [];
    if (first) {
      lastDealId = newDeals.length ? Math.max(...newDeals.map(d => +d.ID)) : 0;
      sheetSaveState('watch', () => ({ lastDealId }));
    } else if (newDeals.length) {
      await loadDealMeta();
      for (const d of newDeals) {
        lastDealId = Math.max(lastDealId, +d.ID);
        const created = Date.parse(d.DATE_CREATE || '') || Date.now();
        if (Date.now() - created > 3 * 3600 * 1000) continue;     // old deal found after a long sleep — don't announce
        const amount   = parseFloat(d.OPPORTUNITY || 0);
        const person   = USER_MAP[d.ASSIGNED_BY_ID] || 'Sales Team';
        const category = productCategory(d) || (pipelineNames && pipelineNames[String(d.CATEGORY_ID || 0)]) || '';
        console.log(`[WATCH] New deal #${d.ID} ${d.TITLE} ${amount} [${category}] by ${person}`);
        broadcast({
          type: 'celebration', triggerType: 'deal', tier: getTier(amount),
          headline: 'NEW DEAL ALERT', subtext: 'New deal created in CRM',
          person, product: category || d.TITLE || 'New Deal', category, client: d.TITLE || '', location: '',
          amount: amount ? formatAmount(amount) : '—', eventType: 'Deal Created',
        });
      }
      sheetSaveState('watch', () => ({ lastDealId }));
    }

    // WON DEALS (closed today, success stage)
    const won = await bitrixFetch('crm.deal.list', {
      'filter[STAGE_SEMANTIC_ID]': 'S',
      'filter[>=CLOSEDATE]': istDateStr(),
      'select[]': ['ID','TITLE','OPPORTUNITY','ASSIGNED_BY_ID'],
      'start': 0,
    });
    for (const d of (won?.result || [])) {
      if (wonSeen.has(d.ID)) continue;
      wonSeen.add(d.ID);
      if (first) continue;
      const amount = parseFloat(d.OPPORTUNITY || 0);
      const person = USER_MAP[d.ASSIGNED_BY_ID] || 'Sales Team';
      const tier   = getTier(amount);
      console.log(`[WATCH] Deal won #${d.ID} ${d.TITLE} ${amount} by ${person}`);
      addToToday({ wins: 1 });
      addToMonthly({ wins: 1 });
      broadcast({
        type: 'celebration', triggerType: 'win', tier,
        headline: tier.tier >= 3 ? 'MASSIVE WIN! 🏆' : 'DEAL WON!', subtext: 'Deal Closed · CRM Updated',
        person, product: d.TITLE || 'Deal', client: d.TITLE || '', location: '',
        amount: formatAmount(amount), eventType: 'Deal Won',
      });
      broadcast({ type: 'today', data: todayStats });
      broadcast({ type: 'monthly', data: monthlyData, countdown: getCountdown() });
    }
  } catch (e) {
    console.log('[WATCH] error:', e.message);
  } finally {
    watchBusy = false;
  }
}
// first check runs after the Sheet state is loaded (see sheetLoadState)
setInterval(checkDealEvents, WATCH_INTERVAL);

// ── SALESPERSON PHOTOS ────────────────────────────────────────────────────────
// GET /photo/<name>  —  priority order:
//   1. Google Drive folder "WW Sales Photos" (via the Sheet script)  e.g. "Geet Rawat.jpg"
//      (a file in public/photos/ in the repo also counts as a folder photo)
//   2. the person's Bitrix24 profile photo
//   3. 404 → the display shows initials
const PHOTO_DIR   = path.join(__dirname, 'public', 'photos');
const photoCache  = new Map();   // name → { buf, type, at } | { none:true, at }
const PHOTO_TTL      = 6 * 3600 * 1000;   // found photos: refresh every 6 h
const PHOTO_MISS_TTL = 30 * 60 * 1000;    // not found: re-check every 30 min (new Drive uploads show up)

async function drivePhoto(name) {
  if (!SHEET_URL || !SHEET_KEY) return null;
  try {
    const r = await sheetRequest('GET', `${SHEET_URL}?key=${encodeURIComponent(SHEET_KEY)}&photo=${encodeURIComponent(name)}`);
    if (r && r.ok && r.data) return { buf: Buffer.from(r.data, 'base64'), type: r.type || 'image/jpeg' };
  } catch (e) { console.log('[PHOTO] Drive lookup failed:', e.message); }
  return null;
}

function slug(name) { return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function bitrixIdForName(name) {
  const n = String(name).toLowerCase().trim();
  const entries = Object.entries(USER_MAP);
  let hit = entries.find(([, v]) => v.toLowerCase() === n);
  if (!hit) hit = entries.find(([, v]) => v.toLowerCase().split(' ')[0] === n.split(' ')[0] && (v.split(' ').length === 1 || n.split(' ').length === 1));
  return hit ? hit[0] : null;
}

function httpsGetBuffer(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpsGetBuffer(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || 'image/jpeg' }));
    }).on('error', reject).setTimeout(10000, function () { this.destroy(new Error('timeout')); });
  });
}

app.get('/photo/:name', async (req, res) => {
  const name = req.params.name;
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const f = path.join(PHOTO_DIR, slug(name) + '.' + ext);
    if (fs.existsSync(f)) { res.set('Cache-Control', 'public, max-age=3600'); return res.sendFile(f); }
  }
  const cached = photoCache.get(name);
  if (cached && Date.now() - cached.at < (cached.none ? PHOTO_MISS_TTL : PHOTO_TTL)) {
    if (cached.none) return res.sendStatus(404);
    res.set('Content-Type', cached.type).set('Cache-Control', 'public, max-age=3600');
    return res.send(cached.buf);
  }
  const fromDrive = await drivePhoto(name);
  if (fromDrive) {
    photoCache.set(name, { ...fromDrive, at: Date.now() });
    res.set('Content-Type', fromDrive.type).set('Cache-Control', 'public, max-age=3600');
    return res.send(fromDrive.buf);
  }
  try {
    const id = bitrixIdForName(name);
    if (!id) throw new Error('no bitrix id');
    const u = await bitrixFetch('user.get', { ID: id });
    const photoUrl = u?.result?.[0]?.PERSONAL_PHOTO;
    if (!photoUrl) throw new Error('no photo');
    const img = await httpsGetBuffer(photoUrl);
    photoCache.set(name, { ...img, at: Date.now() });
    res.set('Content-Type', img.type).set('Cache-Control', 'public, max-age=3600');
    return res.send(img.buf);
  } catch (e) {
    photoCache.set(name, { none: true, at: Date.now() });
    return res.sendStatus(404);
  }
});

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
  if (payload.type === 'celebration') sheetPost('log', 'activity', payload);
  const msg = JSON.stringify(payload);
  console.log('[BROADCAST]', msg.substring(0, 200));
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// Restore saved state from the Google Sheet once the server is up
setTimeout(sheetLoadState, 500);

// ── HTTP SERVER with WS upgrade ───────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`[HTTP] Listening on port ${PORT}`));

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request);
  });
});

// ── AUTH ──────────────────────────────────────────────────────────────────────
// Every admin request carries a Google ID token: "Authorization: Bearer <token>"
async function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in required' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const p      = ticket.getPayload();
    const email  = String(p.email || '').toLowerCase();
    if (!p.email_verified || p.hd !== ALLOWED_DOMAIN || !email.endsWith('@' + ALLOWED_DOMAIN)) {
      return res.status(403).json({ error: 'Only ' + ALLOWED_DOMAIN + ' accounts are allowed' });
    }
    const user = ADMIN_USERS[email];
    if (!user) return res.status(403).json({ error: email + ' is not on the admin list' });
    req.user = { email, ...user };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — sign in again' });
  }
}

// Admin page reads the Client ID from here, and confirms who is signed in
app.get('/auth/config', (req, res) => res.json({ clientId: GOOGLE_CLIENT_ID }));
app.get('/auth/me', requireUser, (req, res) => res.json(req.user));

// ── BITRIX INBOUND WEBHOOK ────────────────────────────────────────────────────
app.post('/bitrix/deal', (req, res) => {
  res.sendStatus(200);
  // Bitrix outbound webhooks (ONCRMDEALADD / ONCRMDEALUPDATE) only carry the deal ID,
  // so we just run the watcher now instead of waiting for the next 60s check.
  setTimeout(checkDealEvents, 1500);
});

// ── MANUAL TRIGGER ────────────────────────────────────────────────────────────
// triggerType: 'order' (advance received) | 'delivery' (material dispatched)
app.post('/trigger', requireUser, (req, res) => {
  const { triggerType, person, product, client, location, amount } = req.body;
  if (!req.user.perms.includes(triggerType)) {
    return res.status(403).json({ error: 'You are not allowed to fire ' + triggerType });
  }
  console.log(`[TRIGGER] ${triggerType} ${amount} for ${person} by ${req.user.email}`);

  if (!['order','delivery','win'].includes(triggerType)) {
    return res.status(400).json({ error: 'triggerType must be order, delivery or win' });
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
    win:      { 'SPARK': 'WIN!', 'DEAL DONE': 'DEAL WON!', 'DEAL BOMB': 'DEAL WON! 🏆', 'SUPER DEAL': 'MASSIVE WIN! 🚀' },
  };

  const subtexts = {
    order:    'Advance Received · Order Confirmed',
    delivery: 'Material Dispatched',
    win:      'Deal Closed · CRM Updated',
  };

  // Accumulate into today's and monthly totals
  const isOrder    = triggerType === 'order';
  const isDelivery = triggerType === 'delivery';
  const isWin      = triggerType === 'win';
  addToToday({
    orders:     isOrder    ? 1 : 0,
    deliveries: isDelivery ? 1 : 0,
    revenue:    isOrder    ? raw : 0,   // revenue counted on order, not delivery
    wins:       isWin      ? 1 : 0,
  });
  addToMonthly({
    revenue: isOrder ? raw : 0,
    orders:  isOrder ? 1  : 0,
    wins:    isWin   ? 1  : 0,
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
    eventType:   isOrder ? 'Order Confirmed' : isWin ? 'Deal Won' : 'Delivery',
    by:          req.user.name,
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
app.post('/ticker/refresh', requireUser, async (req, res) => {
  await pollBitrix();
  broadcast({ type: 'ticker', data: tickerCache });
  res.json({ ok: true, data: tickerCache });
});

// ── LEADERBOARD ENDPOINTS ─────────────────────────────────────────────────────
app.get('/leaderboard', (req, res) => {
  if (leaderboardData.monthKey !== istMonthKey()) rebuildLeaderboard();
  res.json(leaderboardData);
});

// Weekly entries of this month and last month (for the admin "edit a week" list)
app.get('/leaderboard/weeks', requireUser, (req, res) => {
  if (!req.user.lb) return res.status(403).json({ error: 'You are not allowed to update the leaderboard' });
  const from = new Date(Date.now() + 5.5 * 3600 * 1000); from.setUTCDate(1); from.setUTCMonth(from.getUTCMonth() - 1);
  const fromKey = from.toISOString().slice(0, 10);
  res.json(Object.values(lbWeeks).filter(w => w.weekEnding >= fromKey).sort((a, b) => b.weekEnding.localeCompare(a.weekEnding)));
});

// Save (or correct) ONE week's numbers. Body: { weekEnding:'YYYY-MM-DD', teams:[{name,role,group,revenue,wins,orders}] }
app.post('/leaderboard', requireUser, (req, res) => {
  if (!req.user.lb) return res.status(403).json({ error: 'You are not allowed to update the leaderboard' });
  const { teams, weekEnding } = req.body;
  if (!Array.isArray(teams)) return res.status(400).json({ error: 'teams must be array' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekEnding || ''))) return res.status(400).json({ error: 'Pick the week-ending date' });
  const isEdit = !!lbWeeks[weekEnding];
  lbWeeks[weekEnding] = {
    weekEnding,
    updatedBy: req.user.name,
    updatedAt: new Date().toISOString(),
    people: teams.map(p => ({ name: p.name, role: p.role, group: p.group, revenue: +p.revenue || 0, wins: +p.wins || 0, orders: +p.orders || 0 }))
                 .filter(p => p.revenue || p.wins || p.orders),
  };
  console.log(`[LEADERBOARD] week ${weekEnding} ${isEdit ? 'corrected' : 'saved'} by ${req.user.email}`);
  saveLeaderboard({ weekLabel: weekLabelOf(weekEnding) + (isEdit ? ' (corrected)' : ''), updatedBy: req.user.name, teams: lbWeeks[weekEnding].people });
  rebuildLeaderboard();
  broadcast({ type: 'leaderboard', data: leaderboardData });
  res.json({ ok: true, edited: isEdit, monthToDate: leaderboardData });
});

// Remove a week entered by mistake
app.post('/leaderboard/delete', requireUser, (req, res) => {
  if (!req.user.lb) return res.status(403).json({ error: 'You are not allowed to update the leaderboard' });
  const { weekEnding } = req.body;
  if (!lbWeeks[weekEnding]) return res.status(404).json({ error: 'No entry for that week' });
  delete lbWeeks[weekEnding];
  console.log(`[LEADERBOARD] week ${weekEnding} deleted by ${req.user.email}`);
  saveLeaderboard({ weekLabel: weekLabelOf(weekEnding) + ' (deleted)', updatedBy: req.user.name, teams: [] });
  rebuildLeaderboard();
  broadcast({ type: 'leaderboard', data: leaderboardData });
  res.json({ ok: true });
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, screens: connectedScreens, uptime: process.uptime(), tickerAge: tickerCache.fetchedAt });
});
