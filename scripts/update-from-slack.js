#!/usr/bin/env node
/*
 * Greening India dashboard — cloud updater.
 *
 * Runs in GitHub Actions (no browser, no laptop). It:
 *   1. Reads the latest 8 PM "Daily Plantation & Sapling Payment" reports from
 *      Slack channel #greeningindiainternal via the Slack Web API. The report
 *      numbers live in Block Kit `table` blocks, which conversations.history
 *      returns in full (the Slack MCP connector strips them; the raw API does not).
 *   2. Parses both the Daily Plantation table (planted acres/saplings) and the
 *      Daily Sapling Payment table (token-paid acres) for all 5 districts.
 *   3. Updates DATA in index.html (append a new day, or replace if same date).
 *   4. Prints a summary. The workflow commits & pushes if index.html changed,
 *      which triggers the GitHub Pages build.
 *
 * Idempotent + self-healing:
 *   - If the newest report cluster's IST date <= the last history entry, it does
 *     nothing (already applied, or the report for today isn't posted yet).
 *   - If a day was missed, the next run catches up to the newest report.
 *
 * Env:
 *   SLACK_TOKEN  (required)  Slack token with channels:history / groups:history
 *                            for C07NEJX81B7. Bot token (xoxb-) works if the app
 *                            is a member of the channel; user token (xoxp-) works
 *                            if the user is a member.
 *   CHANNEL_ID   (optional)  defaults to C07NEJX81B7
 *   INDEX_PATH   (optional)  defaults to ./index.html
 */

const fs = require('fs');

const SLACK_TOKEN = process.env.SLACK_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || 'C07NEJX81B7';
const INDEX_PATH = process.env.INDEX_PATH || 'index.html';

const KEYS = ['nagarkurnool', 'wanaparthy', 'anantapur', 'khargone', 'barwani'];
const NAME = {
  Nagarkurnool: 'nagarkurnool',
  Wanaparthy: 'wanaparthy',
  Ananthapuram: 'anantapur',
  Anantapur: 'anantapur',
  Khargone: 'khargone',
  Barwani: 'barwani',
};

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
const num = (s) => +String(s == null ? '' : s).replace(/,/g, '');
const istDate = (ts) =>
  new Date(Number(ts) * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

async function slack(method, params) {
  const body = new URLSearchParams(params);
  const r = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + SLACK_TOKEN,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body,
  });
  const j = await r.json();
  if (!j.ok) throw new Error('Slack ' + method + ' failed: ' + j.error);
  return j;
}

// Extract {district: {row label: value}} from a Block Kit table block.
function parseTable(block) {
  const rows = (block.rows || []).map((r) => r.map((c) => (c && c.text != null ? c.text : '')));
  if (!rows.length) return {};
  const cols = rows[0].slice(1); // district names (skip "Parameter")
  const out = {};
  cols.forEach((col, ci) => {
    const key = NAME[String(col).trim()];
    if (!key) return; // ignore districts we don't track (e.g. Dhar)
    const rec = {};
    for (let r = 1; r < rows.length; r++) rec[rows[r][0].trim()] = rows[r][ci + 1];
    out[key] = rec;
  });
  return out;
}

async function readLatestReport() {
  const hist = await slack('conversations.history', { channel: CHANNEL_ID, limit: '40' });
  // Report messages have >=1 table block and mention Daily Plantation.
  const reports = (hist.messages || []).filter(
    (m) => (m.blocks || []).some((b) => b.type === 'table') && /Daily Plantation/.test(m.text || '')
  );
  if (!reports.length) throw new Error('no plantation report messages found in last 40 messages');

  // Newest cluster = all report messages sharing the newest IST date.
  const newestDate = istDate(reports[0].ts);
  const cluster = reports.filter((m) => istDate(m.ts) === newestDate);

  const plant = {}, pay = {};
  for (const msg of cluster) {
    let lastSection = '';
    for (const b of msg.blocks || []) {
      if (b.type === 'section') lastSection = (b.text && b.text.text) || '';
      else if (b.type === 'header') lastSection = (b.text && b.text.text) || '';
      else if (b.type === 'table') {
        const isPay = /Payment/i.test(lastSection);
        const t = parseTable(b);
        for (const key in t) {
          const rec = t[key];
          if (isPay) {
            const a = num(rec['Acres (Till Date)']);
            if (!isNaN(a)) pay[key] = { payAcres: a, payDAcres: num(rec['Acres (Past 24hr)']) };
          } else {
            const a = num(rec['Acres (Till Date)']);
            if (!isNaN(a))
              plant[key] = {
                dAcres: num(rec['Acres (Past 24hr)']),
                acres: a,
                dSaplings: num(rec['Saplings (Past 24hr)']),
                saplings: num(rec['Saplings (Till Date)']),
              };
          }
        }
      }
    }
  }
  return { date: newestDate, plant, pay };
}

// Brace-match the single-line `const DATA = {...}` object in index.html.
function readData(html) {
  const s = html.indexOf('const DATA = ');
  if (s < 0) throw new Error('const DATA not found in ' + INDEX_PATH);
  const objStart = html.indexOf('{', s);
  let depth = 0, i = objStart, instr = false, esc = false, q = '';
  for (; i < html.length; i++) {
    const c = html[i];
    if (instr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) instr = false; }
    else { if (c === '"' || c === "'") { instr = true; q = c; } else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; } }
  }
  return { start: s, objStart, closeIdx: i, data: eval('(' + html.slice(objStart, i + 1) + ')') };
}

async function main() {
  if (!SLACK_TOKEN) die('SLACK_TOKEN env var is required');

  const report = await readLatestReport();
  if (!Object.keys(report.plant).length)
    die('parsed zero plantation districts from newest cluster (' + report.date + ')');

  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  const { start, objStart, closeIdx, data: DATA } = readData(html);

  const prev = DATA.history[DATA.history.length - 1];
  if (report.date <= prev.date) {
    console.log(
      'NO-OP: newest report is ' + report.date + ', dashboard already at ' + prev.date +
      ' (nothing to apply).'
    );
    process.exit(0);
  }

  // Build the new plantation entry (carry missing districts forward with 0 daily add).
  const sites = {};
  for (const k of KEYS) {
    const p = report.plant[k];
    if (p && typeof p.acres === 'number' && !isNaN(p.acres)) {
      sites[k] = { acres: p.acres, saplings: p.saplings, dAcres: p.dAcres, dSaplings: p.dSaplings };
    } else {
      const pv = prev.sites[k] || { acres: 0, saplings: 0 };
      sites[k] = { acres: pv.acres, saplings: pv.saplings, dAcres: 0, dSaplings: 0 };
    }
  }
  const entry = { date: report.date, sites };
  if (prev.date === report.date) DATA.history[DATA.history.length - 1] = entry;
  else DATA.history.push(entry);

  // Token-payment map (carry missing districts forward).
  const prevPay = (DATA.payments && DATA.payments.sites) || {};
  const paySites = {};
  for (const k of KEYS) {
    const q = report.pay[k];
    if (q && typeof q.payAcres === 'number' && !isNaN(q.payAcres)) {
      paySites[k] = { acres: q.payAcres, dAcres: q.payDAcres };
    } else {
      const pv = prevPay[k] || { acres: 0 };
      paySites[k] = { acres: pv.acres, dAcres: 0 };
    }
  }
  DATA.payments = { date: report.date, sites: paySites };
  DATA.updatedAt = report.date + 'T20:00:00+05:30';

  html = html.slice(0, start) + 'const DATA = ' + JSON.stringify(DATA) + html.slice(closeIdx + 1);
  fs.writeFileSync(INDEX_PATH, html);

  let tot = 0, ptot = 0;
  KEYS.forEach((k) => { tot += sites[k].acres; ptot += paySites[k].acres; });
  console.log(
    'UPDATED: date=' + report.date + ' history=' + DATA.history.length +
    ' plantedAcres=' + tot.toFixed(2) + ' tokenPaidAcres=' + ptot.toFixed(2)
  );
}

main().catch((e) => die(e.message));
