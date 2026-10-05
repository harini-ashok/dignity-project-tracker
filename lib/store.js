// The Excel workbook is the single source of truth.
// Every read loads the sheet into plain objects (one per row, keyed by header);
// every write goes through a queue so two people saving at once never clobber each other.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const STATUS = {
  // Matches the STATUS column the coordinator already uses in the Pending sheet.
  care: ['New', 'Texted - No Response', 'Ready for Volunteer', 'Too Early to Pack', 'Volunteer Assigned',
    'Packed & Ready', 'Picked Up', 'Delivered', 'On Hold', 'Cancelled'],
  booth: ['Requested', 'Bought', 'At Booth', 'Picked Up', 'Cancelled'],
  volunteer: ['Active', 'Pending', 'Inactive'],
  message: ['Ready to send', 'Sent', 'Failed', 'Skipped'],
};

const SCHEMA = {
  'Care Packages': {
    columns: ['ID', 'Submitted', 'Status', 'Name', 'Phone', 'Language', 'Receive By', 'Address', 'Zip', 'Lat', 'Lng',
      'Household', 'Housing', 'Needs', 'Items Requested', 'Clothing & Sizes', 'Allergies', 'Food Dislikes',
      'Restrictions', 'Pets', 'Notes', 'Filled By',
      'Delivery Volunteer', 'Pickup Time', 'Est. Delivery', 'Printed', 'Connected',
      'Packing Shift', 'Packer', 'Packed Items', 'Delivered On', 'Admin Notes', 'Updated'],
    validations: { Status: STATUS.care, Printed: ['Yes', 'No'], Connected: ['Yes', 'No'] },
    widths: { Address: 34, Household: 26, Housing: 22, Needs: 34, 'Items Requested': 50, 'Clothing & Sizes': 40, Notes: 50, Restrictions: 24, Status: 20 },
  },
  // Every answer from the Google Form, one row per question, so nothing is lost
  // even though the form has ~70 questions and has changed over time.
  'Form Answers': {
    columns: ['ID', 'Question', 'Answer'],
    widths: { Question: 60, Answer: 70 },
  },
  'Booth Requests': {
    columns: ['ID', 'Date', 'Name', 'Phone', 'Item', 'Details', 'Status', 'Bring On', 'Handled By', 'Notes', 'Updated'],
    validations: { Status: STATUS.booth },
    widths: { Item: 28, Details: 30, Notes: 30 },
  },
  Inventory: {
    columns: ['Item', 'Category', 'On Hand', 'Low At', 'Has Aerosol', 'Has Alcohol', 'Allergens', 'Notes'],
    validations: { Category: ['Essential', 'Food', 'Other'], 'Has Aerosol': ['Yes', 'No'], 'Has Alcohol': ['Yes', 'No'] },
    widths: { Item: 28, Allergens: 24, Notes: 30 },
  },
  Volunteers: {
    columns: ['ID', 'Name', 'Phone', 'Email', 'Role', 'Status', 'PIN Hash', 'Notes', 'Created'],
    validations: { Role: ['admin', 'volunteer'], Status: STATUS.volunteer },
    widths: { Name: 22, Email: 26, 'PIN Hash': 16, Notes: 30 },
  },
  'Packing Shifts': {
    columns: ['ID', 'Date', 'Start', 'End', 'Location', 'Capacity', 'Volunteers', 'Notes'],
    widths: { Location: 28, Volunteers: 36, Notes: 30 },
  },
  Messages: {
    columns: ['Time', 'Ref', 'To', 'Phone', 'Body', 'Status', 'By'],
    validations: { Status: STATUS.message },
    widths: { Body: 70, To: 20 },
  },
  Settings: {
    columns: ['Key', 'Value', 'What it does'],
    widths: { Key: 24, Value: 60, 'What it does': 50 },
  },
};

const DEFAULT_SETTINGS = [
  ['org_name', 'Phoenix Dignity Project', 'Shown on the site and in messages'],
  ['hq_address', '', 'Where volunteers pick up packed care packages (only shown to the assigned volunteer)'],
  ['hq_lat', '33.4255', 'Map center latitude (Tempe)'],
  ['hq_lng', '-111.9400', 'Map center longitude (Tempe)'],
  ['booth_day', '2', 'Day of the week Tempe Feed happens (0=Sun, 1=Mon, 2=Tue ...)'],
  ['msg_claimed_requester', 'Hi {name}, this is {org}. {volunteer} will be delivering your care package around {eta}. They may reach out from {volunteerPhone}.', 'Sent to the requester when a volunteer claims their delivery'],
  ['msg_claimed_volunteer', 'Thank you {volunteer}! You are delivering care package {id} to {name}. Pickup: {pickup} at {hq}. Drop-off: {address}. Their phone: {phone}.', 'Sent to the volunteer when they claim a delivery'],
  ['msg_intro', 'Hi {name} and {volunteer}! Connecting you both for care package {id}. {volunteer} will deliver around {eta}. {name}, please reply here if anything changes.', 'Group introduction between requester and volunteer'],
  ['msg_delivered', 'Hi {name}, we hope your care package arrived safely. Thank you for letting {org} support you!', 'Sent to the requester when a package is marked delivered'],
  ['msg_claimed_requester_es', 'Hola {name}, le saluda {org}. {volunteer} le entregará su paquete de ayuda alrededor de {eta}. Es posible que le escriba desde {volunteerPhone}.', 'Spanish version, used when Language is Español'],
  ['msg_delivered_es', 'Hola {name}, esperamos que su paquete haya llegado bien. ¡Gracias por permitir que {org} le apoye!', 'Spanish version, used when Language is Español'],
  ['msg_booth_ready', 'Hi {name}, the {item} you asked for at Tempe Feed will be at the {org} booth on {date}.', 'Sent when a booth item is bought'],
];

const PREFIX = { 'Care Packages': 'CP-', 'Booth Requests': 'BR-', Volunteers: 'V-', 'Packing Shifts': 'SH-' };

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // Excel dates have no timezone; ExcelJS gives them as UTC.
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    if (v.hyperlink) return v.hyperlink;
    return String(v);
  }
  return String(v).trim();
}

class Store {
  constructor(file) {
    this.file = file;
    this.backupDir = path.join(path.dirname(file), 'backups');
    this.cache = null;
    this.cacheMtime = 0;
    this.queue = Promise.resolve();
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      const db = {};
      for (const name of Object.keys(SCHEMA)) db[name] = [];
      db.Settings = DEFAULT_SETTINGS.map(([Key, Value, w]) => ({ Key, Value, 'What it does': w }));
      await this._write(db);
    }
    // Add any sheets, columns or settings that a newer version of the app expects.
    await this.mutate((db) => {
      const have = new Set(db.Settings.map((s) => s.Key));
      for (const [Key, Value, w] of DEFAULT_SETTINGS) {
        if (!have.has(Key)) db.Settings.push({ Key, Value, 'What it does': w });
      }
    });
  }

  async _read() {
    const stat = fs.statSync(this.file);
    if (this.cache && stat.mtimeMs === this.cacheMtime) return this.cache;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(this.file);
    const db = {};
    const headers = {};
    for (const name of Object.keys(SCHEMA)) {
      const ws = wb.getWorksheet(name);
      db[name] = [];
      headers[name] = [...SCHEMA[name].columns];
      if (!ws) continue;
      const head = [];
      ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { head[i] = cellText(c.value); });
      // Keep any extra columns people added by hand in Excel.
      for (const h of head) if (h && !headers[name].includes(h)) headers[name].push(h);
      ws.eachRow((row, r) => {
        if (r === 1) return;
        const obj = {};
        let any = false;
        head.forEach((h, i) => {
          if (!h) return;
          const t = cellText(row.getCell(i).value);
          obj[h] = t;
          if (t) any = true;
        });
        if (any) {
          for (const h of headers[name]) if (obj[h] === undefined) obj[h] = '';
          db[name].push(obj);
        }
      });
    }
    this.headers = headers;
    this.cache = db;
    this.cacheMtime = stat.mtimeMs;
    return db;
  }

  async _write(db) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Dignity Tracker';
    for (const [name, spec] of Object.entries(SCHEMA)) {
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
      const cols = (this.headers && this.headers[name]) || spec.columns;
      ws.columns = cols.map((c) => ({ header: c, key: c, width: (spec.widths && spec.widths[c]) || Math.max(12, c.length + 2) }));
      for (const row of db[name] || []) {
        const out = {};
        for (const c of cols) {
          const v = row[c] ?? '';
          out[c] = (c === 'On Hand' || c === 'Low At' || c === 'Capacity' || c === 'Lat' || c === 'Lng') && v !== '' && !isNaN(Number(v)) ? Number(v) : v;
        }
        ws.addRow(out);
      }
      const header = ws.getRow(1);
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5233' } };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
      // Dropdowns so people editing in Excel pick valid values.
      for (const [col, list] of Object.entries(spec.validations || {})) {
        const idx = cols.indexOf(col) + 1;
        if (!idx) continue;
        const letter = ws.getColumn(idx).letter;
        ws.dataValidations.add(`${letter}2:${letter}2000`, {
          type: 'list', allowBlank: true, formulae: [`"${list.join(',')}"`],
        });
      }
    }
    const tmp = this.file + '.tmp';
    await wb.xlsx.writeFile(tmp);
    this._backup();
    fs.renameSync(tmp, this.file);
    this.cache = null;
  }

  _backup() {
    if (!fs.existsSync(this.file)) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    // One backup per hour, keep the most recent 72.
    const stamp = new Date().toISOString().slice(0, 13).replace(/[:T]/g, '-');
    const dest = path.join(this.backupDir, `tracker-${stamp}.xlsx`);
    if (!fs.existsSync(dest)) fs.copyFileSync(this.file, dest);
    const all = fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.xlsx')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 72))) fs.unlinkSync(path.join(this.backupDir, f));
  }

  // Read-only snapshot. Callers get copies so they can't accidentally edit the cache.
  async all(sheet) {
    const db = await this._read();
    return db[sheet].map((r) => ({ ...r }));
  }

  async settings() {
    const rows = await this.all('Settings');
    return Object.fromEntries(rows.map((r) => [r.Key, r.Value]));
  }

  // Serialized read-modify-write. fn receives the whole workbook as arrays of row objects.
  mutate(fn) {
    const run = this.queue.then(async () => {
      this.cache = null;
      const db = structuredClone(await this._read());
      const result = await fn(db);
      await this._write(db);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async replaceFile(buffer) {
    // Validate before swapping in an uploaded workbook.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    if (!wb.getWorksheet('Care Packages')) throw new Error('That file has no "Care Packages" sheet, so it does not look like a tracker workbook.');
    await (this.queue = this.queue.then(() => {
      this._backup();
      fs.writeFileSync(this.file, buffer);
      this.cache = null;
    }));
    await this.init();
  }
}

function nextId(rows, sheet) {
  const prefix = PREFIX[sheet];
  let max = 0;
  for (const r of rows) {
    const m = String(r.ID || '').match(/(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return prefix + String(max + 1).padStart(4, '0');
}

module.exports = { Store, SCHEMA, STATUS, nextId };
