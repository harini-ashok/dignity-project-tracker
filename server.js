process.env.TZ = process.env.TZ || 'America/Phoenix';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { Store, STATUS, nextId } = require('./lib/store');
const L = require('./lib/logic');
const notify = require('./lib/notify');
const { geocode, fullAddress } = require('./lib/geo');
const { parseFormExport } = require('./lib/importer');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = new Store(process.env.WORKBOOK || path.join(DATA_DIR, 'tracker.xlsx'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.session-secret');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(f, 'utf8');
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.use(session({
  secret: sessionSecret(), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 },
}));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const flash = (req, msg, kind = 'ok') => { req.session.flash = { msg, kind }; };
const isAdmin = (u) => u && u.Role === 'admin';
const sameUser = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const clean = (s) => String(s ?? '').trim();
// Stops a value typed into the site from being run as a formula when opened in Excel.
const safe = (s) => { const t = clean(s); return /^[=+\-@]/.test(t) && !/^[-+]?\d/.test(t) ? "'" + t : t; };

app.use(wrap(async (req, res, next) => {
  res.locals.flash = req.session.flash; delete req.session.flash;
  res.locals.L = L;
  res.locals.path = req.path;
  res.locals.settings = await store.settings();
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.session.uid) {
    const vols = await store.all('Volunteers');
    const u = vols.find((v) => v.ID === req.session.uid && v.Status === 'Active');
    if (u) req.user = u; else delete req.session.uid;
  }
  res.locals.user = req.user;
  res.locals.admin = isAdmin(req.user);
  if (req.method === 'POST' && !req.is('multipart/form-data') && req.body._csrf !== req.session.csrf) {
    return res.status(403).send('Form expired. Go back, refresh the page and try again.');
  }
  next();
}));

const needLogin = (req, res, next) => (req.user ? next() : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)));
const needAdmin = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).render('message', { title: 'Coordinators only', text: 'Only coordinators can open this page.' }));
const checkUploadCsrf = (req, res, next) => (req.body._csrf === req.session.csrf ? next() : res.status(403).send('Form expired. Refresh and try again.'));

async function locate(id) {
  const p = (await store.all('Care Packages')).find((x) => x.ID === id);
  if (!p || (p.Lat && p.Lng)) return;
  const hit = await geocode(fullAddress(p));
  if (hit) await store.mutate((db) => { const r = db['Care Packages'].find((x) => x.ID === id); if (r && !r.Lat) { r.Lat = hit.lat; r.Lng = hit.lng; } });
}

// ---------- auth ----------
app.get('/login', (req, res) => res.render('login', { title: 'Sign in', next: req.query.next || '/' }));
app.post('/login', wrap(async (req, res) => {
  const who = clean(req.body.who);
  const vols = await store.all('Volunteers');
  const u = vols.find((v) => (L.digits(v.Phone) && L.digits(v.Phone) === L.digits(who)) || sameUser(v.Name, who));
  if (!u || !u['PIN Hash'] || !bcrypt.compareSync(clean(req.body.pin), u['PIN Hash'])) {
    flash(req, 'That name/phone and PIN did not match.', 'err');
    return res.redirect('/login');
  }
  if (u.Status !== 'Active') {
    flash(req, 'Your account is waiting for a coordinator to approve it.', 'err');
    return res.redirect('/login');
  }
  req.session.regenerate(() => {
    req.session.uid = u.ID;
    const next = String(req.body.next || '/');
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  });
}));
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/join', (req, res) => res.render('join', { title: 'Volunteer sign up' }));
app.post('/join', wrap(async (req, res) => {
  const { name, phone, email, pin } = req.body;
  if (!clean(name) || L.digits(phone).length < 10 || clean(pin).length < 4) {
    flash(req, 'Please give your name, a phone number, and a PIN of at least 4 digits.', 'err');
    return res.redirect('/join');
  }
  const dup = await store.mutate((db) => {
    if (db.Volunteers.some((v) => L.digits(v.Phone) === L.digits(phone))) return true;
    db.Volunteers.push({ ID: nextId(db.Volunteers, 'Volunteers'), Name: safe(name), Phone: safe(phone), Email: safe(email), Role: 'volunteer', Status: 'Pending', 'PIN Hash': bcrypt.hashSync(clean(pin), 10), Created: L.today() });
    return false;
  });
  if (dup) { flash(req, 'That phone number is already registered. Try signing in.', 'err'); return res.redirect('/login'); }
  res.render('message', { title: 'Thanks for signing up!', text: 'A coordinator will approve your account, then you can sign in with your phone number and PIN.' });
}));

// ---------- public request form (works alongside or instead of the Google Form) ----------
app.get('/request', (req, res) => res.render('request', { title: 'Request a care package' }));
app.post('/request', wrap(async (req, res) => {
  const b = req.body;
  if (!clean(b.name) || !clean(b.phone) || !clean(b.address)) {
    flash(req, 'Name, phone and address are needed so we can deliver.', 'err');
    return res.redirect('/request');
  }
  const pick = (v) => [].concat(v || []).map(clean).filter(Boolean);
  const id = await store.mutate((db) => {
    const ID = nextId(db['Care Packages'], 'Care Packages');
    const restrictions = [...pick(b.restrictions), L.suggestedRestrictions(b.housing)].filter(Boolean);
    db['Care Packages'].push({
      ID, Submitted: L.nowStamp(), Status: 'New',
      Name: safe(b.name), Phone: safe(b.phone), Language: safe(b.language), 'Receive By': safe(b.receive_by),
      Address: safe(b.address), Zip: L.zipOf(b.address),
      Household: safe(`Total household size: ${clean(b.household) || '?'}; Number of children/teens: ${clean(b.children) || '0'}`),
      Housing: safe(b.housing),
      Needs: safe(['Hygiene Items', 'Cleaning Supplies', 'Food', 'Clothing'].map((k) => (b['need_' + k] ? `${k}: ${b['need_' + k]}` : '')).filter(Boolean).join('; ')),
      'Items Requested': safe([...pick(b.items), clean(b.items_other)].filter(Boolean).join(', ')),
      'Clothing & Sizes': safe(b.clothing), Allergies: safe(b.allergies), 'Food Dislikes': safe(b.dislikes),
      Restrictions: safe([...new Set(restrictions.join(', ').split(', ').filter(Boolean))].join(', ')),
      Notes: safe(b.story), 'Filled By': b.filled_by === 'Volunteer' ? safe(`On behalf of someone else: ${clean(b.referral)}`) : 'Myself',
      Updated: L.nowStamp(),
    });
    return ID;
  });
  locate(id).catch(() => {});
  res.render('message', { title: 'Request received', text: `Thank you, ${clean(b.name).split(' ')[0]}. Your request number is ${id}. A Phoenix Dignity Project coordinator will text you when a volunteer is on the way.` });
}));

// ---------- dashboard ----------
app.get('/', needLogin, wrap(async (req, res) => {
  const [pk, booth, inv, shifts] = await Promise.all([store.all('Care Packages'), store.all('Booth Requests'), store.all('Inventory'), store.all('Packing Shifts')]);
  const count = (s) => pk.filter((p) => p.Status === s).length;
  const counts = Object.fromEntries(STATUS.care.map((s) => [s, count(s)]));
  const mine = pk.filter((p) => sameUser(p['Delivery Volunteer'], req.user.Name) && !['Delivered', 'Cancelled'].includes(p.Status));
  const myPacking = pk.filter((p) => sameUser(p.Packer, req.user.Name) && L.OPEN.includes(p.Status));
  const myShifts = shifts.filter((s) => s.Date >= L.today() && s.Volunteers.split(',').some((n) => sameUser(n, req.user.Name)));
  const boothDay = L.nextBoothDay(L.today(), res.locals.settings.booth_day);
  const boothDue = booth.filter((b) => b.Status === 'Bought' || (b.Status === 'At Booth')).length;
  const boothOpen = booth.filter((b) => b.Status === 'Requested').length;
  const short = L.shortages(pk, inv).filter((s) => s.short > 0).slice(0, 8);
  res.render('dashboard', { title: 'Dashboard', counts, mine, myPacking, myShifts, boothDay, boothDue, boothOpen, short, openForVolunteers: pk.filter((p) => p.Status === L.CLAIMABLE).length });
}));

// ---------- map: volunteers pick deliveries ----------
app.get('/map', needLogin, wrap(async (req, res) => {
  const pk = await store.all('Care Packages');
  const s = res.locals.settings;
  const admin = isAdmin(req.user);
  const shown = ['Ready for Volunteer', 'Volunteer Assigned', 'Packed & Ready', 'Picked Up'];
  const visible = pk.filter((p) => !/^pickup/i.test(p['Receive By']) && (shown.includes(p.Status) || (admin && ['New', 'Texted - No Response', 'Too Early to Pack'].includes(p.Status))));
  // Number open deliveries 1, 2, 3... like the weekly WhatsApp map. Same street address = same pin.
  const pins = new Map();
  for (const p of visible) {
    const mineOrAdmin = admin || sameUser(p['Delivery Volunteer'], req.user.Name);
    const key = p.Lat && p.Lng ? `${L.fuzz(p.Lat)},${L.fuzz(p.Lng)}|${L.streetOnly(p.Address).toLowerCase()}` : 'nopos|' + p.ID;
    if (!pins.has(key)) pins.set(key, { lat: null, lng: null, street: L.streetOnly(p.Address) || p.Zip || 'Address not given', zip: p.Zip, packages: [] });
    const pin = pins.get(key);
    if (p.Lat && p.Lng) { pin.lat = mineOrAdmin ? Number(p.Lat) : L.fuzz(p.Lat); pin.lng = mineOrAdmin ? Number(p.Lng) : L.fuzz(p.Lng); }
    pin.packages.push({
      id: p.ID, status: p.Status, open: p.Status === L.CLAIMABLE,
      name: mineOrAdmin ? p.Name : L.english(p.Name).split(' ')[0],
      address: mineOrAdmin ? p.Address : '',
      household: p.Household.match(/household size:\s*(\d+)/i)?.[1] || '',
      language: p.Language, items: L.packageItems(p).length,
      restrictions: [p.Restrictions, p.Allergies].filter(Boolean).join('; '),
      volunteer: p['Delivery Volunteer'], mine: sameUser(p['Delivery Volunteer'], req.user.Name),
    });
  }
  const list = [...pins.values()].sort((a, b) => Number(b.packages.some((x) => x.open)) - Number(a.packages.some((x) => x.open)) || (a.zip || '').localeCompare(b.zip || ''));
  list.forEach((p, i) => { p.n = i + 1; });
  const week = req.query.week || L.today();
  res.render('map', { title: 'Delivery map', pins: list, week, center: [Number(s.hq_lat) || 33.4255, Number(s.hq_lng) || -111.94] });
}));

app.post('/packages/:id/claim', needLogin, wrap(async (req, res) => {
  const s = res.locals.settings;
  const result = await store.mutate(async (db) => {
    const p = db['Care Packages'].find((x) => x.ID === req.params.id);
    if (!p) return 'missing';
    if (p.Status !== L.CLAIMABLE || p['Delivery Volunteer']) return 'taken';
    p['Delivery Volunteer'] = req.user.Name;
    p.Status = 'Volunteer Assigned';
    p['Pickup Time'] = safe(req.body.pickup);
    p['Est. Delivery'] = safe(req.body.eta);
    p.Updated = L.nowStamp();
    const v = L.packageVars(p, s, req.user);
    await notify.queue(db, [
      { ref: p.ID, to: p.Name, phone: p.Phone, body: L.fill(L.template(s, 'msg_claimed_requester', p), v) },
      { ref: p.ID, to: req.user.Name, phone: req.user.Phone, body: L.fill(s.msg_claimed_volunteer, v) },
    ], req.user.Name);
    return 'ok';
  });
  if (result === 'taken') flash(req, 'Someone else just picked that delivery. Please choose another.', 'err');
  else if (result === 'ok') flash(req, `Thank you! ${req.params.id} is yours. The coordinator has been notified.`);
  res.redirect(result === 'ok' ? `/packages/${req.params.id}` : '/map');
}));

app.post('/packages/:id/release', needLogin, wrap(async (req, res) => {
  await store.mutate((db) => {
    const p = db['Care Packages'].find((x) => x.ID === req.params.id);
    if (!p || !(isAdmin(req.user) || sameUser(p['Delivery Volunteer'], req.user.Name))) return;
    p['Delivery Volunteer'] = ''; p['Pickup Time'] = ''; p['Est. Delivery'] = '';
    if (p.Status === 'Volunteer Assigned') p.Status = L.CLAIMABLE;
    p.Updated = L.nowStamp();
  });
  flash(req, `${req.params.id} is back on the map for another volunteer.`);
  res.redirect('/map');
}));

// ---------- care packages ----------
app.get('/packages', needLogin, needAdmin, wrap(async (req, res) => {
  let pk = await store.all('Care Packages');
  const status = req.query.status || '';
  const q = clean(req.query.q).toLowerCase();
  if (status) pk = pk.filter((p) => p.Status === status);
  if (q) pk = pk.filter((p) => Object.values(p).join(' ').toLowerCase().includes(q));
  pk.sort((a, b) => STATUS.care.indexOf(a.Status) - STATUS.care.indexOf(b.Status) || a.ID.localeCompare(b.ID));
  res.render('packages', { title: 'Care packages', pk, status, q, statuses: STATUS.care });
}));

async function loadPackage(req, res) {
  const p = (await store.all('Care Packages')).find((x) => x.ID === req.params.id);
  if (!p) { res.status(404).render('message', { title: 'Not found', text: 'No care package with that number.' }); return null; }
  const allowed = isAdmin(req.user) || sameUser(p['Delivery Volunteer'], req.user.Name) || sameUser(p.Packer, req.user.Name);
  if (!allowed) { res.status(403).render('message', { title: 'Not assigned to you', text: 'You can see a package once you have claimed it from the map or signed up to pack it.' }); return null; }
  return p;
}

app.get('/packages/:id', needLogin, wrap(async (req, res) => {
  const p = await loadPackage(req, res); if (!p) return;
  const [inv, vols, shifts, answers] = await Promise.all([store.all('Inventory'), store.all('Volunteers'), store.all('Packing Shifts'), store.all('Form Answers')]);
  const s = res.locals.settings;
  const vol = vols.find((v) => sameUser(v.Name, p['Delivery Volunteer']));
  const vars = L.packageVars(p, s, vol);
  const texts = {
    requester: L.fill(L.template(s, 'msg_claimed_requester', p), vars), volunteer: L.fill(s.msg_claimed_volunteer, vars),
    intro: L.fill(s.msg_intro, vars), delivered: L.fill(L.template(s, 'msg_delivered', p), vars),
  };
  res.render('package', {
    title: p.ID, p, list: L.packingList(p, inv), vol, texts, statuses: STATUS.care,
    volunteers: vols.filter((v) => v.Status === 'Active'), shifts: shifts.filter((x) => x.Date >= L.today()),
    answers: answers.filter((a) => a.ID === p.ID),
  });
}));

app.get('/packages/:id/label', needLogin, wrap(async (req, res) => {
  const p = await loadPackage(req, res); if (!p) return;
  res.render('label', { title: `Label ${p.ID}`, ps: [p], inv: await store.all('Inventory'), layout: false });
}));
app.get('/labels', needLogin, needAdmin, wrap(async (req, res) => {
  const ids = [].concat(req.query.id || []);
  const ps = (await store.all('Care Packages')).filter((p) => (ids.length ? ids.includes(p.ID) : ['Volunteer Assigned', 'Packed & Ready'].includes(p.Status)));
  res.render('label', { title: 'Labels', ps, inv: await store.all('Inventory') });
}));

app.post('/packages/:id', needLogin, needAdmin, wrap(async (req, res) => {
  const fields = ['Name', 'Phone', 'Language', 'Receive By', 'Address', 'Zip', 'Lat', 'Lng', 'Household', 'Housing', 'Needs',
    'Items Requested', 'Clothing & Sizes', 'Allergies', 'Food Dislikes', 'Restrictions', 'Pets', 'Notes',
    'Status', 'Delivery Volunteer', 'Pickup Time', 'Est. Delivery', 'Printed', 'Connected', 'Packing Shift', 'Packer', 'Admin Notes'];
  const s = res.locals.settings;
  let moved = false;
  await store.mutate(async (db) => {
    const p = db['Care Packages'].find((x) => x.ID === req.params.id);
    if (!p) return;
    const before = { ...p };
    for (const f of fields) if (req.body[f] !== undefined) p[f] = safe(req.body[f]);
    if (before.Address !== p.Address) {
      if (req.body.Lat === before.Lat) { p.Lat = ''; p.Lng = ''; moved = true; }
    }
    if (before.Address !== p.Address && !req.body.Zip) p.Zip = L.zipOf(p.Address);
    if (p['Delivery Volunteer'] && ['New', 'Texted - No Response', 'Ready for Volunteer'].includes(p.Status)) p.Status = 'Volunteer Assigned';
    if (p.Status === 'Delivered' && before.Status !== 'Delivered') {
      p['Delivered On'] = L.today();
      await notify.queue(db, [{ ref: p.ID, to: p.Name, phone: p.Phone, body: L.fill(L.template(s, 'msg_delivered', p), L.packageVars(p, s)) }], req.user.Name);
    }
    if (p['Delivery Volunteer'] && !sameUser(before['Delivery Volunteer'], p['Delivery Volunteer'])) {
      const vol = db.Volunteers.find((v) => sameUser(v.Name, p['Delivery Volunteer']));
      const v = L.packageVars(p, s, vol);
      await notify.queue(db, [
        { ref: p.ID, to: p.Name, phone: p.Phone, body: L.fill(L.template(s, 'msg_claimed_requester', p), v) },
        vol && { ref: p.ID, to: vol.Name, phone: vol.Phone, body: L.fill(s.msg_claimed_volunteer, v) },
      ].filter(Boolean), req.user.Name);
    }
    p.Updated = L.nowStamp();
  });
  if (moved) locate(req.params.id).catch(() => {});
  flash(req, 'Saved.');
  res.redirect(`/packages/${req.params.id}`);
}));

// Quick toggles from the package page: label printed, group chat connected.
app.post('/packages/:id/flag', needLogin, needAdmin, wrap(async (req, res) => {
  const f = req.body.flag;
  if (['Printed', 'Connected'].includes(f)) {
    await store.mutate((db) => { const p = db['Care Packages'].find((x) => x.ID === req.params.id); if (p) { p[f] = p[f] === 'Yes' ? 'No' : 'Yes'; p.Updated = L.nowStamp(); } });
  }
  res.redirect(`/packages/${req.params.id}`);
}));

// Volunteer-facing status steps: picked up / delivered.
app.post('/packages/:id/step', needLogin, wrap(async (req, res) => {
  const s = res.locals.settings;
  const to = req.body.to;
  const ok = await store.mutate(async (db) => {
    const p = db['Care Packages'].find((x) => x.ID === req.params.id);
    if (!p || !(isAdmin(req.user) || sameUser(p['Delivery Volunteer'], req.user.Name))) return false;
    if (!['Picked Up', 'Delivered'].includes(to)) return false;
    p.Status = to;
    if (to === 'Delivered') {
      p['Delivered On'] = L.today();
      await notify.queue(db, [{ ref: p.ID, to: p.Name, phone: p.Phone, body: L.fill(L.template(s, 'msg_delivered', p), L.packageVars(p, s)) }], req.user.Name);
    }
    p.Updated = L.nowStamp();
    return true;
  });
  flash(req, ok ? `${req.params.id} marked ${to}.` : 'Could not update that package.', ok ? 'ok' : 'err');
  res.redirect(`/packages/${req.params.id}`);
}));

// Packing checklist: marks package Packed and takes the packed items out of inventory (once).
app.post('/packages/:id/pack', needLogin, wrap(async (req, res) => {
  const packed = [].concat(req.body.item || []);
  const ok = await store.mutate((db) => {
    const p = db['Care Packages'].find((x) => x.ID === req.params.id);
    if (!p || !(isAdmin(req.user) || sameUser(p.Packer, req.user.Name) || sameUser(p['Delivery Volunteer'], req.user.Name))) return false;
    const list = L.packingList(p, db.Inventory);
    const chosen = list.filter((it) => packed.includes(it.name));
    if (!p['Packed Items']) {
      for (const it of chosen) {
        const inv = L.findInventory(db.Inventory, it.name);
        if (inv) inv['On Hand'] = Math.max(0, Number(inv['On Hand'] || 0) - it.qty);
      }
    }
    p['Packed Items'] = chosen.map((it) => (it.qty > 1 ? `${it.name} x${it.qty}` : it.name)).join(', ') || '(none)';
    if (!p.Packer) p.Packer = req.user.Name;
    if (L.OPEN.includes(p.Status)) p.Status = 'Packed & Ready';
    p.Updated = L.nowStamp();
    return true;
  });
  flash(req, ok ? `${req.params.id} is packed and inventory was updated.` : 'Could not update that package.', ok ? 'ok' : 'err');
  res.redirect(`/packages/${req.params.id}`);
}));

app.post('/packages-bulk', needLogin, needAdmin, wrap(async (req, res) => {
  const ids = [].concat(req.body.id || []);
  const to = req.body.to;
  if (to === 'labels') return res.redirect('/labels?' + ids.map((i) => 'id=' + encodeURIComponent(i)).join('&'));
  if (to === 'printed') {
    await store.mutate((db) => { for (const p of db['Care Packages']) if (ids.includes(p.ID)) p.Printed = 'Yes'; });
    flash(req, `${ids.length} package(s) marked printed.`);
    return res.redirect('/packages');
  }
  if (!STATUS.care.includes(to)) return res.redirect('/packages');
  await store.mutate((db) => {
    for (const p of db['Care Packages']) if (ids.includes(p.ID)) { p.Status = to; p.Updated = L.nowStamp(); }
  });
  flash(req, `${ids.length} package(s) set to ${to}.`);
  res.redirect('/packages');
}));

app.post('/geocode-missing', needLogin, needAdmin, wrap(async (req, res) => {
  const missing = (await store.all('Care Packages')).filter((p) => !p.Lat && p.Address && !['Delivered', 'Cancelled'].includes(p.Status));
  let found = 0;
  for (const p of missing.slice(0, 40)) {
    const hit = await geocode(fullAddress(p));
    if (hit) {
      found++;
      await store.mutate((db) => { const r = db['Care Packages'].find((x) => x.ID === p.ID); if (r) { r.Lat = hit.lat; r.Lng = hit.lng; } });
    }
  }
  flash(req, `Placed ${found} of ${Math.min(missing.length, 40)} addresses on the map.${found < missing.length ? ' Any left can have Lat/Lng typed in on the package page.' : ''}`, found ? 'ok' : 'err');
  res.redirect('/packages');
}));

// ---------- Google Form import ----------
app.get('/import', needLogin, needAdmin, (req, res) => res.render('import', { title: 'Import Google Form responses', result: null }));
app.post('/import', needLogin, needAdmin, upload.single('file'), checkUploadCsrf, wrap(async (req, res) => {
  if (!req.file) { flash(req, 'Choose a file first.', 'err'); return res.redirect('/import'); }
  let parsed;
  try { parsed = await parseFormExport(req.file.buffer, req.file.originalname); } catch (e) {
    flash(req, 'Could not read that file. Download the responses as .xlsx or .csv and try again.', 'err');
    return res.redirect('/import');
  }
  // Re-importing is safe: the same phone + request date updates the existing row
  // (filling blanks only) instead of adding a duplicate.
  const { added, updated } = await store.mutate((db) => {
    const added = [];
    let updated = 0;
    const key = (r) => `${L.digits(r.Phone)}|${clean(r.Submitted).split(/[ T]/)[0]}`;
    const byKey = new Map(db['Care Packages'].map((p) => [key(p), p]));
    const seenAnswers = new Set(db['Form Answers'].map((a) => `${a.ID}|${a.Question}|${a.Answer}`));
    for (const { answers, ...r } of parsed.rows) {
      const row = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, safe(v)]));
      let p = byKey.get(key(r));
      if (p) {
        let changed = false;
        for (const [k, v] of Object.entries(row)) if (v && !p[k]) { p[k] = v; changed = true; }
        if (changed) { p.Updated = L.nowStamp(); updated++; }
      } else {
        p = { ID: nextId(db['Care Packages'], 'Care Packages'), ...row, Submitted: row.Submitted || L.nowStamp(), Updated: L.nowStamp() };
        db['Care Packages'].push(p);
        byKey.set(key(r), p);
        added.push(p.ID);
      }
      for (const a of answers) {
        const k = `${p.ID}|${safe(a.question)}|${safe(a.answer)}`;
        if (!seenAnswers.has(k)) { seenAnswers.add(k); db['Form Answers'].push({ ID: p.ID, Question: safe(a.question), Answer: safe(a.answer) }); }
      }
    }
    return { added, updated };
  });
  (async () => { for (const id of added) await locate(id); })().catch(() => {});
  res.render('import', { title: 'Import Google Form responses', result: { mapping: parsed.mapping, unmatched: parsed.unmatched, rows: parsed.rows.length, added: added.length, updated } });
}));

// ---------- Tempe Feed booth requests ----------
app.get('/booth', needLogin, wrap(async (req, res) => {
  const rows = await store.all('Booth Requests');
  const s = res.locals.settings;
  const day = req.query.day || L.nextBoothDay(L.today(), s.booth_day);
  const days = [...new Set(rows.map((r) => r['Bring On']).filter(Boolean).concat(day))].sort().reverse();
  const forDay = rows.filter((r) => (r['Bring On'] || '') === day);
  const lanes = STATUS.booth.map((st) => ({ status: st, rows: forDay.filter((r) => r.Status === st) }));
  const texts = Object.fromEntries(rows.map((r) => [r.ID, L.fill(s.msg_booth_ready, { name: r.Name.split(' ')[0], item: r.Item, date: r['Bring On'], org: s.org_name })]));
  res.render('booth', { title: 'Tempe Feed booth', lanes, day, days, nextDay: L.nextBoothDay(L.today(), s.booth_day), texts });
}));
app.post('/booth', needLogin, wrap(async (req, res) => {
  const b = req.body;
  const items = [].concat(b.item || []).map(clean);
  const details = [].concat(b.details || []);
  if (!clean(b.name) || !items.some(Boolean)) { flash(req, 'Name and at least one item are needed.', 'err'); return res.redirect('/booth'); }
  const day = clean(b.bring_on) || L.nextBoothDay(L.today(), res.locals.settings.booth_day);
  await store.mutate((db) => {
    items.forEach((item, i) => {
      if (!item) return;
      db['Booth Requests'].push({
        ID: nextId(db['Booth Requests'], 'Booth Requests'), Date: L.today(), Name: safe(b.name), Phone: safe(b.phone),
        Item: safe(item), Details: safe(details[i]), Status: 'Requested', 'Bring On': day, 'Handled By': '', Notes: safe(b.notes), Updated: L.nowStamp(),
      });
    });
  });
  flash(req, `Saved for ${clean(b.name)}. Items will be brought on ${day}.`);
  res.redirect('/booth?day=' + day);
}));
app.post('/booth/:id', needLogin, wrap(async (req, res) => {
  const to = req.body.to;
  await store.mutate(async (db) => {
    const r = db['Booth Requests'].find((x) => x.ID === req.params.id);
    if (!r || !STATUS.booth.includes(to)) return;
    if (to === 'Bought' && r.Status !== 'Bought') {
      const s = Object.fromEntries(db.Settings.map((x) => [x.Key, x.Value]));
      await notify.queue(db, [{ ref: r.ID, to: r.Name, phone: r.Phone, body: L.fill(s.msg_booth_ready, { name: r.Name.split(' ')[0], item: r.Item, date: r['Bring On'], org: s.org_name }) }], req.user.Name);
      r['Handled By'] = req.user.Name;
    }
    r.Status = to;
    if (req.body.bring_on) r['Bring On'] = safe(req.body.bring_on);
    r.Updated = L.nowStamp();
  });
  res.redirect('/booth?day=' + encodeURIComponent(req.body.day || ''));
}));

// ---------- inventory ----------
app.get('/inventory', needLogin, wrap(async (req, res) => {
  const [inv, pk] = await Promise.all([store.all('Inventory'), store.all('Care Packages')]);
  inv.sort((a, b) => a.Category.localeCompare(b.Category) || a.Item.localeCompare(b.Item));
  res.render('inventory', { title: 'Inventory', inv, short: L.shortages(pk, inv) });
}));
app.post('/inventory', needLogin, needAdmin, wrap(async (req, res) => {
  const b = req.body;
  await store.mutate((db) => {
    if (b.action === 'add' && clean(b.Item)) {
      if (L.findInventory(db.Inventory, b.Item)) return;
      db.Inventory.push({ Item: safe(b.Item), Category: safe(b.Category) || 'Essential', 'On Hand': Number(b['On Hand'] || 0), 'Low At': Number(b['Low At'] || 0), 'Has Aerosol': b['Has Aerosol'] ? 'Yes' : 'No', 'Has Alcohol': b['Has Alcohol'] ? 'Yes' : 'No', Allergens: safe(b.Allergens), Notes: safe(b.Notes) });
    } else if (b.action === 'counts') {
      for (const r of db.Inventory) {
        const v = b['qty_' + r.Item];
        if (v !== undefined && v !== '' && !isNaN(Number(v))) r['On Hand'] = Number(v);
      }
    }
  });
  flash(req, 'Inventory saved.');
  res.redirect('/inventory');
}));

// ---------- packing shifts ----------
app.get('/shifts', needLogin, wrap(async (req, res) => {
  const [shifts, pk] = await Promise.all([store.all('Packing Shifts'), store.all('Care Packages')]);
  const upcoming = shifts.filter((s) => s.Date >= L.today()).sort((a, b) => (a.Date + a.Start).localeCompare(b.Date + b.Start));
  const toPack = pk.filter((p) => ['Ready for Volunteer', 'Too Early to Pack', 'Volunteer Assigned'].includes(p.Status));
  res.render('shifts', { title: 'Packing shifts', upcoming, toPack });
}));
app.post('/shifts', needLogin, needAdmin, wrap(async (req, res) => {
  const b = req.body;
  if (!b.Date) { flash(req, 'Pick a date.', 'err'); return res.redirect('/shifts'); }
  await store.mutate((db) => {
    db['Packing Shifts'].push({ ID: nextId(db['Packing Shifts'], 'Packing Shifts'), Date: safe(b.Date), Start: safe(b.Start), End: safe(b.End), Location: safe(b.Location) || 'HQ', Capacity: Number(b.Capacity || 4), Volunteers: '', Notes: safe(b.Notes) });
  });
  flash(req, 'Shift added.');
  res.redirect('/shifts');
}));
// Sign up for a shift and (optionally) choose which packages you'll pack there.
app.post('/shifts/:id/join', needLogin, wrap(async (req, res) => {
  const ids = [].concat(req.body.pkg || []);
  const msg = await store.mutate((db) => {
    const s = db['Packing Shifts'].find((x) => x.ID === req.params.id);
    if (!s) return 'That shift no longer exists.';
    const names = s.Volunteers.split(',').map(clean).filter(Boolean);
    if (!names.some((n) => sameUser(n, req.user.Name))) {
      if (names.length >= Number(s.Capacity || 99)) return 'Sorry, that shift is full.';
      names.push(req.user.Name);
      s.Volunteers = names.join(', ');
    }
    let n = 0;
    for (const p of db['Care Packages']) {
      if (ids.includes(p.ID) && (!p.Packer || sameUser(p.Packer, req.user.Name)) && L.OPEN.includes(p.Status)) {
        p.Packer = req.user.Name; p['Packing Shift'] = s.ID; p.Updated = L.nowStamp(); n++;
      }
    }
    return `You're signed up for ${s.Date} ${s.Start}${n ? ` and will pack ${n} package(s)` : ''}. Thank you!`;
  });
  flash(req, msg);
  res.redirect('/shifts');
}));
app.post('/shifts/:id/leave', needLogin, wrap(async (req, res) => {
  await store.mutate((db) => {
    const s = db['Packing Shifts'].find((x) => x.ID === req.params.id);
    if (!s) return;
    s.Volunteers = s.Volunteers.split(',').map(clean).filter((n) => n && !sameUser(n, req.user.Name)).join(', ');
    for (const p of db['Care Packages']) {
      if (p['Packing Shift'] === s.ID && sameUser(p.Packer, req.user.Name) && L.OPEN.includes(p.Status)) { p.Packer = ''; p['Packing Shift'] = ''; }
    }
  });
  flash(req, 'You have been removed from that shift.');
  res.redirect('/shifts');
}));

// ---------- volunteers ----------
app.get('/volunteers', needLogin, needAdmin, wrap(async (req, res) => {
  const [vols, pk] = await Promise.all([store.all('Volunteers'), store.all('Care Packages')]);
  const load = (n) => pk.filter((p) => sameUser(p['Delivery Volunteer'], n) && !['Delivered', 'Cancelled'].includes(p.Status)).length;
  const done = (n) => pk.filter((p) => sameUser(p['Delivery Volunteer'], n) && p.Status === 'Delivered').length;
  res.render('volunteers', { title: 'Volunteers', vols: vols.map((v) => ({ ...v, load: load(v.Name), done: done(v.Name) })) });
}));
app.post('/volunteers', needLogin, needAdmin, wrap(async (req, res) => {
  const b = req.body;
  const msg = await store.mutate((db) => {
    if (b.action === 'add') {
      if (!clean(b.Name) || clean(b.pin).length < 4) return 'Name and a PIN of 4+ digits are needed.';
      if (b.Phone && db.Volunteers.some((v) => L.digits(v.Phone) && L.digits(v.Phone) === L.digits(b.Phone))) return 'That phone number is already registered.';
      db.Volunteers.push({ ID: nextId(db.Volunteers, 'Volunteers'), Name: safe(b.Name), Phone: safe(b.Phone), Email: safe(b.Email), Role: b.Role === 'admin' ? 'admin' : 'volunteer', Status: 'Active', 'PIN Hash': bcrypt.hashSync(clean(b.pin), 10), Created: L.today() });
      return `${clean(b.Name)} added. Share their PIN with them privately.`;
    }
    const v = db.Volunteers.find((x) => x.ID === b.id);
    if (!v) return 'Volunteer not found.';
    if (b.action === 'status' && STATUS.volunteer.includes(b.to)) {
      if (v.ID === req.user.ID && b.to !== 'Active') return 'You cannot deactivate yourself.';
      v.Status = b.to;
    }
    if (b.action === 'role') {
      if (v.ID === req.user.ID) return 'You cannot change your own role.';
      v.Role = v.Role === 'admin' ? 'volunteer' : 'admin';
    }
    if (b.action === 'pin') {
      if (clean(b.pin).length < 4) return 'PIN must be at least 4 digits.';
      v['PIN Hash'] = bcrypt.hashSync(clean(b.pin), 10);
    }
    return `${v.Name} updated.`;
  });
  flash(req, msg);
  res.redirect('/volunteers');
}));
app.get('/me', needLogin, (req, res) => res.render('me', { title: 'My account' }));
app.post('/me', needLogin, wrap(async (req, res) => {
  if (clean(req.body.pin).length < 4) { flash(req, 'PIN must be at least 4 digits.', 'err'); return res.redirect('/me'); }
  await store.mutate((db) => { const v = db.Volunteers.find((x) => x.ID === req.user.ID); if (v) v['PIN Hash'] = bcrypt.hashSync(clean(req.body.pin), 10); });
  flash(req, 'PIN changed.');
  res.redirect('/me');
}));

// ---------- messages outbox ----------
app.get('/messages', needLogin, needAdmin, wrap(async (req, res) => {
  const msgs = (await store.all('Messages')).map((m, i) => ({ ...m, idx: i })).reverse();
  const show = req.query.all ? msgs : msgs.filter((m) => m.Status === 'Ready to send');
  res.render('messages', { title: 'Messages', msgs: show, all: !!req.query.all, auto: notify.autoSendEnabled() });
}));
app.post('/messages/:idx', needLogin, needAdmin, wrap(async (req, res) => {
  await store.mutate((db) => { const m = db.Messages[Number(req.params.idx)]; if (m && STATUS.message.includes(req.body.to)) m.Status = req.body.to; });
  res.redirect('/messages' + (req.body.all ? '?all=1' : ''));
}));

// ---------- workbook download / upload / settings ----------
app.get('/workbook', needLogin, needAdmin, (req, res) => res.render('workbook', { title: 'Excel workbook' }));
app.get('/workbook/download', needLogin, needAdmin, wrap(async (req, res) => {
  await store.queue;
  res.download(store.file, `dignity-tracker-${L.today()}.xlsx`);
}));
app.post('/workbook/upload', needLogin, needAdmin, upload.single('file'), checkUploadCsrf, wrap(async (req, res) => {
  if (!req.file) { flash(req, 'Choose a file first.', 'err'); return res.redirect('/workbook'); }
  try { await store.replaceFile(req.file.buffer); flash(req, 'Workbook uploaded. The previous version was saved as a backup.'); } catch (e) { flash(req, e.message, 'err'); }
  res.redirect('/workbook');
}));
app.post('/settings', needLogin, needAdmin, wrap(async (req, res) => {
  await store.mutate((db) => { for (const r of db.Settings) if (req.body['s_' + r.Key] !== undefined) r.Value = safe(req.body['s_' + r.Key]); });
  flash(req, 'Settings saved.');
  res.redirect('/workbook');
}));

app.use((req, res) => res.status(404).render('message', { title: 'Page not found', text: 'That page does not exist.' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('message', { title: 'Something went wrong', text: 'The change was not saved. Please try again; if it keeps happening, tell a coordinator.' });
});

async function start(port = process.env.PORT || 3000) {
  await store.init();
  const vols = await store.all('Volunteers');
  if (!vols.some((v) => v.Role === 'admin')) {
    const pin = process.env.ADMIN_PIN || 'changeme';
    await store.mutate((db) => {
      db.Volunteers.push({ ID: nextId(db.Volunteers, 'Volunteers'), Name: process.env.ADMIN_NAME || 'Coordinator', Phone: process.env.ADMIN_PHONE || '', Role: 'admin', Status: 'Active', 'PIN Hash': bcrypt.hashSync(pin, 10), Created: L.today() });
    });
    console.log(`Created coordinator account "${process.env.ADMIN_NAME || 'Coordinator'}" with PIN "${pin}". Sign in and change it under My account.`);
  }
  return new Promise((resolve) => {
    const server = app.listen(port, () => { console.log(`Dignity tracker running on http://localhost:${server.address().port}`); resolve(server); });
  });
}

// cPanel's "Setup Node.js App" (Phusion Passenger) loads this file through its own
// loader, so require.main isn't this module there.
if (require.main === module || typeof PhusionPassenger !== 'undefined') start();
module.exports = { app, start, store };
