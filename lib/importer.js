// Imports Google Form responses (downloaded from Google Sheets as .xlsx or .csv).
//
// Built around the real "Care Package Intake Form": bilingual questions, ~70 columns,
// and a coordinator sheet that has tracking columns on the left (DATE OF REQUEST,
// DELIVERY ASSIGNED TO, PICK UP DAY & TIME, PRINTED, CONNECTED, STATUS).
// Questions are matched by keywords, so rewording the form doesn't break the import.
// If the sheet has several pasted blocks, each new "Timestamp" header row is re-read.
// Every non-empty answer is also returned as {question, answer} so nothing is lost.
const ExcelJS = require('exceljs');
const { english, zipOf, splitList, suggestedRestrictions } = require('./logic');

// [field, pattern, how]. how: 'one' = first match wins, 'list' = merge answers,
// 'label' = merge as "Question label: answer", 'choice' = keep the English part only.
const RULES = [
  ['Submitted', /^timestamp$/i, 'one'],
  ['Date Of Request', /^date of request/i, 'one'],
  ['Status', /^status$/i, 'one'],
  ['Delivery Volunteer', /delivery assigned to|^volunteer$/i, 'one'],
  ['Pickup Time', /pick ?up day|pickup time/i, 'one'],
  ['Printed', /^printed$/i, 'one'],
  ['Connected', /^connected$/i, 'one'],
  ['Name', /primary contact|client name|^name$/i, 'one'],
  ['Phone', /phone number \(of recipient|^phone/i, 'one'],
  ['Language', /preferred language/i, 'choice'],
  ['Receive By', /how would you like to receive/i, 'one'],
  ['Address', /full address|^address$/i, 'one'],
  ['Household', /household size|number of adults|number of children|number of babies|ages? (&|and) genders?/i, 'label'],
  ['Housing', /housing situation/i, 'choice'],
  ['Clothing & Sizes', /notes about the clothing/i, 'label'],
  ['Notes', /^notes|^any specific notes|^any other specific notes/i, 'label'],
  ['Food Dislikes', /foods? that you dislike|will not eat/i, 'list'],
  ['Allergies', /allerg/i, 'list'],
  ['Needs', /what items do you need most\?.*\[/i, 'label'],
  ['Items Requested', /pantry|check all that apply|what items are needed|check the items|interested in receiving|pet supplies needed|what items are you most in need/i, 'list'],
  ['Clothing & Sizes', /cloth|adult \d|child \d|baby \d|shoes|sizes?\b|diapers|bed sheets|bed size/i, 'label'],
  ['Pets', /\bpets?\b/i, 'label'],
  ['Filled By', /on behalf of|filled out by|referral/i, 'label'],
  ['Notes', /notes|in your own words|other needs|fresh item|anything we should know|first care package|books|appliances|experienced/i, 'label'],
];

const ADMIN_STATUS = [
  [/no response/i, 'Texted - No Response'],
  [/ready for volunteer|responded/i, 'Ready for Volunteer'],
  [/too early/i, 'Too Early to Pack'],
  [/volunteer assigned|ready to pack/i, 'Volunteer Assigned'],
  [/packed/i, 'Packed & Ready'],
  [/picked/i, 'Picked Up'],
  [/deliver/i, 'Delivered'],
  [/cancel/i, 'Cancelled'],
  [/hold/i, 'On Hold'],
];

function parseCsv(text) {
  const delim = text.split('\n')[0].includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readTable(buffer, filename) {
  if (/\.(csv|tsv|txt)$/i.test(filename)) return parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (r) => {
    const vals = [];
    r.eachCell({ includeEmpty: true }, (c, i) => {
      let v = c.value;
      if (v instanceof Date) v = v.toISOString().slice(0, 16).replace('T', ' ');
      else if (v && typeof v === 'object') v = v.text || v.result || (v.richText ? v.richText.map((x) => x.text).join('') : '');
      vals[i - 1] = v == null ? '' : String(v);
    });
    rows.push(vals);
  });
  return rows;
}

const firstLine = (h) => String(h || '').split('\n')[0].trim();
// "What items do you need most? ... [Hygiene Items / Artículos de higiene]" -> "Hygiene Items"
function shortLabel(h) {
  const br = h.match(/\[([^\]]+)\]\s*$/);
  if (br) return english(br[1]);
  return english(firstLine(h)).replace(/[:?]+$/, '').replace(/\s+--.*$/, '').slice(0, 60).trim();
}

function isHeaderRow(r) {
  const a = String(r[0] || '').trim();
  return /^(timestamp|date of request)$/i.test(a) || r.some((c) => /^primary contact first name/i.test(String(c || '').trim()));
}

// Columns the tracker writes back into the Google Sheet (status, volunteer...).
// They are read separately and never treated as form answers.
const TRACKER_COLUMNS = ['Tracker ID', 'Tracker Status', 'Tracker Volunteer', 'Tracker Pickup', 'Tracker Delivered', 'Tracker Updated', 'Tracker Edited'];
const isTrackerColumn = (h) => /^tracker /i.test(String(h || '').trim());

function mapHeaders(headers) {
  return headers.map((h) => {
    const line = firstLine(h);
    if (!line) return null;
    if (isTrackerColumn(line)) return { tracker: line.trim().replace(/^tracker /i, ''), label: line.trim() };
    for (const [field, re, how] of RULES) if (re.test(line) || re.test(h)) return { field, how, label: shortLabel(h) };
    return { field: null, label: shortLabel(h) };
  });
}

function receiveBy(v) {
  const d = /deliver|entrega/i.test(v || ''), p = /pick ?up|recolec/i.test(v || '');
  return d && p ? 'Delivery or Pickup' : d ? 'Delivery' : p ? 'Pickup at Tempe Feed' : english(v);
}

function priority(v) {
  const e = english(v);
  return /do not need/i.test(e) ? '' : e.replace(/\s*priority/i, '');
}

function buildRow(headers, cols, r) {
  const out = {};
  const answers = [];
  const add = (field, val) => { out[field] = out[field] ? `${out[field]}${field === 'Items Requested' || field === 'Allergies' || field === 'Food Dislikes' ? ', ' : '; '}${val}` : val; };
  cols.forEach((m, i) => {
    let v = String(r[i] ?? '').trim();
    if (!m || !v || m.tracker) return;
    if (v === headers[i] || firstLine(v) === firstLine(headers[i])) return; // header text bled into a data row
    answers.push({ question: firstLine(headers[i]).slice(0, 250), answer: v });
    if (!m.field) return;
    if (m.how === 'one') { if (!out[m.field]) out[m.field] = v; return; }
    if (m.how === 'choice') { if (!out[m.field]) out[m.field] = english(v); return; }
    if (m.field === 'Needs') { const p = priority(v); if (p) add('Needs', `${m.label}: ${p}`); return; }
    if (m.how === 'list') {
      if (/^(no|none|n\/a|nada|no known allergies.*)$/i.test(english(v))) return;
      add(m.field, /\s\/\s/.test(v) ? splitList(v).map(english).join(', ') : v);
      return;
    }
    if (/^(no|none|n\/a|0)$/i.test(english(v)) && m.field !== 'Household') return;
    add(m.field, `${m.label}: ${m.field === 'Household' ? v : english(v) === 'Yes' ? 'Yes' : v}`);
  });
  return { out, answers };
}

// Returns {rows: [care package objects with .answers], mapping: {field: [labels]}, unmatched: [labels]}
async function parseFormExport(buffer, filename) {
  return parseRows(await readTable(buffer, filename));
}

// Same as parseFormExport but for rows already in memory (e.g. sent by the Google Sheet sync).
function parseRows(table) {
  table = table.map((r) => (r || []).map((c) => (c == null ? '' : String(c))));
  let headers = null, cols = null;
  const rows = [];
  const mapping = {}, unmatched = new Set();
  for (const [index, r] of table.entries()) {
    if (!r || !r.some((c) => String(c || '').trim())) continue;
    if (!headers || isHeaderRow(r)) {
      headers = r.map((h) => String(h || '').trim());
      cols = mapHeaders(headers);
      cols.forEach((m) => {
        if (!m || m.tracker) return;
        if (m.field) (mapping[m.field] = mapping[m.field] || new Set()).add(m.label);
        else unmatched.add(m.label);
      });
      continue;
    }
    const { out, answers } = buildRow(headers, cols, r);
    if (!out.Name && !out.Phone) continue;
    const status = ADMIN_STATUS.find(([re]) => re.test(out.Status || ''));
    const tracker = {};
    cols.forEach((m, i) => { if (m && m.tracker) tracker[m.tracker] = String(r[i] ?? '').trim(); });
    rows.push({
      sheetRow: index + 1, tracker, raw: r, cols, questions: headers.map((h) => firstLine(h).slice(0, 250)),
      Submitted: out.Submitted || out['Date Of Request'] || '',
      Status: status ? status[1] : 'New',
      Name: out.Name || '', Phone: out.Phone || '', Language: out.Language || '',
      'Receive By': receiveBy(out['Receive By']),
      Address: out.Address || '', Zip: zipOf(out.Address),
      Household: out.Household || '', Housing: out.Housing || '', Needs: out.Needs || '',
      'Items Requested': out['Items Requested'] || '', 'Clothing & Sizes': out['Clothing & Sizes'] || '',
      Allergies: out.Allergies || '', 'Food Dislikes': out['Food Dislikes'] || '',
      Restrictions: suggestedRestrictions(out.Housing), Pets: out.Pets || '', Notes: out.Notes || '',
      'Filled By': out['Filled By'] || '',
      'Delivery Volunteer': out['Delivery Volunteer'] || '', 'Pickup Time': out['Pickup Time'] || '',
      Printed: /^y/i.test(out.Printed || '') ? 'Yes' : (out.Printed ? 'No' : ''),
      Connected: /^y/i.test(out.Connected || '') ? 'Yes' : (out.Connected ? 'No' : ''),
      answers,
    });
  }
  return {
    rows, headers, cols,
    mapping: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, [...v]])),
    unmatched: [...unmatched],
  };
}

module.exports = { parseFormExport, parseRows, parseCsv, TRACKER_COLUMNS };
