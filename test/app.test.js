// End-to-end test: starts the app on a throwaway workbook and walks through
// import -> volunteer claims on the map -> packing -> delivery -> booth -> shifts.
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dignity-test-'));
process.env.DATA_DIR = dir;
process.env.GEOCODER = 'off';
process.env.ADMIN_NAME = 'Sam Coordinator';
process.env.ADMIN_PIN = '4321';
process.env.FORM_SYNC_SECRET = 'test-sync-secret-0123456789';
delete process.env.SMS_PROVIDER;

const { start, store } = require('../server');
const ExcelJS = require('exceljs');
let server, base;

function client() {
  let cookie = '';
  let csrf = '';
  const req = async (method, url, body, extra = {}) => {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { cookie, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body instanceof FormData ? body : body ? new URLSearchParams(Object.entries(body).flatMap(([k, v]) => [].concat(v).map((x) => [k, x]))) : undefined, ...extra,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = res.status === 200 && /html/.test(res.headers.get('content-type') || '') ? await res.text() : '';
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, res };
  };
  return {
    get: (url) => req('GET', url),
    post: (url, body = {}) => req('POST', url, body instanceof FormData ? (body.append('_csrf', csrf), body) : { _csrf: csrf, ...body }),
    async login(who, pin) { await req('GET', '/login'); return req('POST', '/login', { _csrf: csrf, who, pin, next: '/' }); },
  };
}
const pkg = async (id) => (await store.all('Care Packages')).find((p) => p.ID === id);

before(async () => { server = await start(0); base = `http://localhost:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const admin = client();
const vol = client();

test('coordinator signs in; wrong PIN is rejected', async () => {
  assert.strictEqual((await client().login('Sam Coordinator', '0000')).location, '/login');
  const r = await admin.login('sam coordinator', '4321');
  assert.strictEqual(r.location, '/');
  assert.match((await admin.get('/')).text, /Ready for Volunteer/);
});

test('pages require sign-in and forms require the CSRF token', async () => {
  assert.match((await client().get('/packages')).location, /^\/login/);
  const r = await fetch(base + '/booth', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x&item=y', redirect: 'manual' });
  assert.notStrictEqual(r.status, 200);
});

test('imports the Google Form sheet, merging pasted blocks and mapping statuses', async () => {
  await admin.get('/import');
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures/form-responses-sample.csv'))]), 'responses.csv');
  const r = await admin.post('/import', fd);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /<b>3<\/b> new request/);
  const all = await store.all('Care Packages');
  assert.strictEqual(all.length, 3);
  const alex = all.find((p) => p.Name === 'Alex Testcase');
  assert.strictEqual(alex.Status, 'Volunteer Assigned');
  assert.strictEqual(alex.Printed, 'Yes');
  assert.strictEqual(alex.Zip, '85281');
  assert.strictEqual(alex['Food Dislikes'], 'Mushrooms', 'second block fills blanks on the same person');
  assert.strictEqual(alex.Restrictions, 'No alcohol, No aerosol', 'sober living implies restrictions');
  assert.match(alex.Needs, /Hygiene Items: High/);
  const maria = all.find((p) => p.Name.startsWith('Mar'));
  assert.strictEqual(maria.Status, 'Ready for Volunteer');
  assert.strictEqual(maria['Receive By'], 'Delivery or Pickup');
  assert.strictEqual(maria.Allergies, '', '"No known allergies" is not an allergy');
  assert.ok((await store.all('Form Answers')).filter((a) => a.ID === alex.ID).length >= 15);
  // Re-import is idempotent.
  const fd2 = new FormData();
  fd2.append('file', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures/form-responses-sample.csv'))]), 'responses.csv');
  assert.match((await admin.post('/import', fd2)).text, /<b>0<\/b> new request/);
  assert.strictEqual((await store.all('Care Packages')).length, 3);
});

test('inventory: restricted items are flagged and shortages computed', async () => {
  await admin.get('/inventory');
  await admin.post('/inventory', { action: 'add', Item: 'Toothpaste', Category: 'Essential', 'On Hand': '5' });
  await admin.post('/inventory', { action: 'add', Item: 'Body spray', Category: 'Essential', 'On Hand': '3', 'Has Aerosol': '1' });
  await admin.post('/inventory', { action: 'add', Item: 'Rice', Category: 'Food', 'On Hand': '1' });
  // Starter items already exist, so set the counts the way a coordinator would.
  assert.ok((await store.all('Inventory')).length > 50, 'starter inventory is preloaded');
  await admin.get('/inventory');
  await admin.post('/inventory', { action: 'counts', qty_Toothpaste: '5', 'qty_Body spray': '3', qty_Rice: '1' });
  const r = await admin.get('/inventory');
  assert.match(r.text, /Rice<\/td><td>3<\/td><td>1<\/td><td><b>2<\/b>/, 'Alex wants 2 rice + Maria 1, only 1 on hand');
  const alex = (await store.all('Care Packages')).find((p) => p.Name === 'Alex Testcase');
  assert.match((await admin.get('/packages/' + alex.ID)).text, /Don't pack: aerosol/);
});

test('volunteer signs up, gets approved, claims a delivery from the map', async () => {
  await vol.get('/join');
  await vol.post('/join', { name: 'Vera Volunteer', phone: '480-555-0177', pin: '1111' });
  assert.strictEqual((await vol.login('4805550177', '1111')).location, '/login', 'pending until approved');
  const v = (await store.all('Volunteers')).find((x) => x.Name === 'Vera Volunteer');
  await admin.get('/volunteers');
  await admin.post('/volunteers', { action: 'status', id: v.ID, to: 'Active' });
  assert.strictEqual((await vol.login('(480) 555-0177', '1111')).location, '/');

  const maria = (await store.all('Care Packages')).find((p) => p.Name.startsWith('Mar'));
  await store.mutate((db) => { const p = db['Care Packages'].find((x) => x.ID === maria.ID); p.Lat = '33.49876'; p.Lng = '-112.18765'; });
  const map = await vol.get('/map');
  assert.match(map.text, /W Sample Rd, Phoenix, AZ 85031/);
  assert.doesNotMatch(map.text, /200 W Sample Rd/, 'house number hidden before claiming');
  assert.doesNotMatch(map.text, /555\D?0123/, 'phone hidden before claiming');
  assert.match(map.text, /"lat":33.5/, 'coordinates rounded before claiming');
  assert.strictEqual((await vol.get('/packages/' + maria.ID)).status, 403);

  const r = await vol.post(`/packages/${maria.ID}/claim`, { pickup: 'Sat 10am', eta: 'Sat 11am' });
  assert.strictEqual(r.location, '/packages/' + maria.ID);
  const p = await pkg(maria.ID);
  assert.strictEqual(p.Status, 'Volunteer Assigned');
  assert.strictEqual(p['Delivery Volunteer'], 'Vera Volunteer');
  const page = await vol.get('/packages/' + maria.ID);
  assert.match(page.text, /200 W Sample Rd/);
  assert.doesNotMatch(page.text, /wa\.me\//, 'only coordinators send messages');
  assert.match((await admin.get('/packages/' + maria.ID)).text, /wa\.me\/16025550123/);

  const msgs = await store.all('Messages');
  assert.strictEqual(msgs.length, 2);
  assert.match(msgs[0].Body, /^¡Hola María! Le presento a Vera Volunteer, quien le entregará su paquete :-\) Lo entregará en: 200 W Sample Rd/, 'Spanish template for Spanish speakers');
  assert.match(msgs[1].Body, /Thank you Vera Volunteer/);

  // A second volunteer can't take it.
  const other = client();
  await other.login('Sam Coordinator', '4321');
  await other.get('/map');
  await other.post(`/packages/${maria.ID}/claim`, { pickup: 'x', eta: 'y' });
  assert.strictEqual((await pkg(maria.ID))['Delivery Volunteer'], 'Vera Volunteer');
});

test('packing takes items out of inventory once; delivery drafts thank-you', async () => {
  const maria = (await store.all('Care Packages')).find((p) => p.Name.startsWith('Mar'));
  await vol.get('/packages/' + maria.ID);
  await vol.post(`/packages/${maria.ID}/pack`, { item: 'Rice' });
  await vol.get('/packages/' + maria.ID);
  await vol.post(`/packages/${maria.ID}/pack`, { item: 'Rice' });
  const rice = (await store.all('Inventory')).find((i) => i.Item === 'Rice');
  assert.strictEqual(Number(rice['On Hand']), 0);
  assert.strictEqual((await pkg(maria.ID)).Status, 'Packed & Ready');
  await vol.post(`/packages/${maria.ID}/step`, { to: 'Picked Up' });
  await vol.get('/packages/' + maria.ID);
  await vol.post(`/packages/${maria.ID}/step`, { to: 'Delivered' });
  const p = await pkg(maria.ID);
  assert.strictEqual(p.Status, 'Delivered');
  assert.ok(p['Delivered On']);
  assert.match((await store.all('Messages')).at(-1).Body, /esperamos/);
});

test('Tempe Feed booth: request, buy, board', async () => {
  await vol.get('/booth');
  await vol.post('/booth', { name: 'Booth Person', phone: '4805550144', item: ['Shoes', 'Jacket'], details: ["men's 10", 'L'], bring_on: '2026-10-13' });
  const rows = await store.all('Booth Requests');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0]['Bring On'], '2026-10-13');
  await vol.get('/booth?day=2026-10-13');
  await vol.post(`/booth/${rows[0].ID}`, { to: 'Bought', day: '2026-10-13' });
  assert.strictEqual((await store.all('Booth Requests'))[0].Status, 'Bought');
  assert.match((await store.all('Messages')).at(-1).Body, /Shoes you asked for at Tempe Feed .* on 2026-10-13/);
  assert.match((await vol.get('/booth?day=2026-10-13')).text, /Jacket/);

  // Items can move back a step and forward again without a second text.
  const texts = (await store.all('Messages')).length;
  await vol.post(`/booth/${rows[0].ID}`, { to: 'Requested', day: '2026-10-13' });
  assert.strictEqual((await store.all('Booth Requests'))[0].Status, 'Requested');
  assert.match((await vol.get('/booth?day=2026-10-13')).text, /← Bought|Bought →/);
  await vol.post(`/booth/${rows[0].ID}`, { to: 'Bought', day: '2026-10-13' });
  await vol.post(`/booth/${rows[0].ID}`, { to: 'At Booth', day: '2026-10-13' });
  assert.match((await vol.get('/booth?day=2026-10-13')).text, /← Bought/);
  await vol.post(`/booth/${rows[0].ID}`, { to: 'Bought', day: '2026-10-13' });
  assert.strictEqual((await store.all('Booth Requests'))[0].Status, 'Bought');
  assert.strictEqual((await store.all('Messages')).length, texts, 'no duplicate text');
});

test('packing shifts: sign up and choose packages', async () => {
  await admin.get('/shifts');
  await admin.post('/shifts', { Date: '2099-01-01', Start: '10:00', End: '12:00', Location: 'HQ', Capacity: '2' });
  const shift = (await store.all('Packing Shifts'))[0];
  const alex = (await store.all('Care Packages')).find((p) => p.Name === 'Alex Testcase');
  await vol.get('/shifts');
  await vol.post(`/shifts/${shift.ID}/join`, { pkg: alex.ID });
  assert.strictEqual((await store.all('Packing Shifts'))[0].Volunteers, 'Vera Volunteer');
  const p = await pkg(alex.ID);
  assert.strictEqual(p.Packer, 'Vera Volunteer');
  assert.strictEqual(p['Packing Shift'], shift.ID);
  assert.strictEqual((await vol.get('/packages/' + alex.ID)).status, 200, 'packer can open the package');
});

test('workbook downloads as a real Excel file with every sheet', async () => {
  const r = await fetch(base + '/workbook/download', { headers: { cookie: '' } });
  assert.notStrictEqual(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'not public');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(store.file);
  for (const s of ['Care Packages', 'Form Answers', 'Booth Requests', 'Inventory', 'Volunteers', 'Packing Shifts', 'Messages', 'Settings']) assert.ok(wb.getWorksheet(s), s);
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).length >= 1);
});

test('formula-looking input is stored as text', async () => {
  await vol.get('/booth');
  await vol.post('/booth', { name: '=HYPERLINK("http://x")', item: 'Socks' });
  assert.ok((await store.all('Booth Requests')).some((r) => r.Name.startsWith("'=")));
});

test('public request form creates a New package', async () => {
  const pub = client();
  await pub.get('/request');
  const r = await pub.post('/request', { name: 'Public Person', phone: '4805550155', address: '1 N Test Ave, Tempe, AZ 85281', housing: 'Shelter', items: ['Soap', 'Socks'], 'need_Food': 'High', filled_by: 'Requester' });
  assert.match(r.text, /Request received/);
  const p = (await store.all('Care Packages')).find((x) => x.Name === 'Public Person');
  assert.strictEqual(p.Status, 'New');
  assert.strictEqual(p['Items Requested'], 'Soap, Socks');
  assert.strictEqual(p.Restrictions, 'No alcohol, No aerosol');
});

test('Google Sheet sync endpoint needs the secret and imports rows without duplicates', async () => {
  const csv = fs.readFileSync(path.join(__dirname, 'fixtures/form-responses-sample.csv'), 'utf8');
  const { parseCsv } = require('../lib/importer');
  const rows = parseCsv(csv);
  const post = (auth, body) => fetch(base + '/api/form-sync', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });
  assert.strictEqual((await post(null, { rows })).status, 401);
  assert.strictEqual((await post('Bearer wrong-secret-wrong-secret', { rows })).status, 401);
  assert.strictEqual((await post('Bearer test-sync-secret-0123456789', { nope: 1 })).status, 400);
  const before = (await store.all('Care Packages')).length;
  const r = await post('Bearer test-sync-secret-0123456789', { rows: [...rows, ['9/30/2026', '', '', '', '', '', 'Sync Person', '480-555-0188']] });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.added, 1, 'only the new person is added; earlier imports are matched');
  assert.strictEqual((await store.all('Care Packages')).length, before + 1);
  assert.match((await store.settings()).last_form_sync, /1 new/);
});

test('google sheet sync is two-way', async () => {
  const { TRACKER_COLUMNS } = require('../lib/importer');
  const post = async (rows) => {
    const r = await fetch(base + '/api/form-sync', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-sync-secret-0123456789' }, body: JSON.stringify({ rows }) });
    assert.strictEqual(r.status, 200);
    return r.json();
  };
  const head = ['Timestamp', 'Primary Contact First Name / Client Name -- Nombre de contacto principal:', 'Phone Number (of recipient) / Número de teléfono:', ...TRACKER_COLUMNS];
  const blank = TRACKER_COLUMNS.map(() => '');

  // Form -> site, and the site's status comes back for the sheet's Tracker columns.
  let j = await post([head, ['10/1/2026 9:00:00', 'Two Way', '480-555-0190', ...blank]]);
  assert.strictEqual(j.added, 1);
  const w = j.write.find((x) => x.row === 2);
  const id = w.values[0];
  assert.match(id, /^CP-/);
  assert.strictEqual(w.values[1], 'New');
  assert.ok(!(await store.all('Form Answers')).some((a) => a.ID === id && /^Tracker/.test(a.Question)), 'tracker columns are not form answers');

  // The site moves on; a request also comes in through the website's own form.
  await store.mutate((db) => {
    db['Care Packages'].find((p) => p.ID === id).Status = 'Ready for Volunteer';
    db['Care Packages'].push({ ID: 'CP-9001', Submitted: '2026-10-02 10:00', Status: 'New', Name: "'=HYPERLINK(1)", Phone: '480-555-0191', Source: 'Website', Updated: '2026-10-02 10:00' });
  });

  // Sheet -> site: only the cell someone edited (Volunteer) is applied; the stale "New" in the sheet is not,
  // and assigning a volunteer moves the request along.
  const tracked = [id, 'New', 'Sheet Volunteer', '', '', '', 'Volunteer'];
  j = await post([head, ['10/1/2026 9:00:00', 'Two Way', '480-555-0190', ...tracked]]);
  assert.strictEqual(j.added, 0);
  assert.strictEqual(j.applied, 1);
  const p = await pkg(id);
  assert.strictEqual(p['Delivery Volunteer'], 'Sheet Volunteer');
  assert.strictEqual(p.Status, 'Volunteer Assigned');
  const back = j.write.find((x) => x.row === 2).values;
  assert.deepStrictEqual(back.slice(0, 3), [id, 'Volunteer Assigned', 'Sheet Volunteer']);
  assert.strictEqual(back[6], '', 'the edit marker is cleared');

  // Website requests are appended to the sheet, under the right questions, formulas defused.
  const line = j.append.find((l) => l[3] === 'CP-9001');
  assert.ok(line);
  assert.strictEqual(line[1], "'=HYPERLINK(1)");
  assert.strictEqual(line[2], '480-555-0191');
  assert.strictEqual(line[3], 'CP-9001');
  // Once it's in the sheet it isn't appended again.
  j = await post([head, ['10/1/2026 9:00:00', 'Two Way', '480-555-0190', ...tracked.slice(0, 6), ''], line]);
  assert.ok(!j.append.some((l) => l[3] === 'CP-9001'));
  assert.strictEqual(j.added, 0);

  // Answers edited in the sheet (here the address, column 4) replace the site's copy.
  const head2 = [...head.slice(0, 3), 'Address', ...TRACKER_COLUMNS];
  const t2 = [id, 'Volunteer Assigned', 'Sheet Volunteer', '', '', ''];
  await store.mutate((db) => { db['Care Packages'].find((x) => x.ID === id).Address = '5 Old Rd, Phoenix, AZ 85003'; });
  j = await post([head2, ['10/1/2026 9:00:00', 'Two Way', '480-555-0190', '1 New St, Tempe, AZ 85281', ...t2, '#4']]);
  assert.strictEqual(j.applied, 1);
  let q = await pkg(id);
  assert.strictEqual(q.Address, '1 New St, Tempe, AZ 85281');
  assert.strictEqual(q.Zip, '85281');
  assert.ok((await store.all('Form Answers')).some((a) => a.ID === id && a.Question === 'Address' && a.Answer === '1 New St, Tempe, AZ 85281'));
  assert.ok(!j.cells.some((c) => c.row === 2), 'nothing to send back for a row just edited in the sheet');

  // An address changed on the site goes back into the sheet's Address cell.
  await store.mutate((db) => { db['Care Packages'].find((x) => x.ID === id).Address = '9 Site Rd, Mesa, AZ 85201'; });
  j = await post([head2, ['10/1/2026 9:00:00', 'Two Way', '480-555-0190', '1 New St, Tempe, AZ 85281', ...t2, '']]);
  assert.strictEqual(j.applied, 0);
  assert.deepStrictEqual(j.cells.find((c) => c.row === 2), { row: 2, col: 4, edited: '', value: '9 Site Rd, Mesa, AZ 85201' });
  q = await pkg(id);
  assert.strictEqual(q.Address, '9 Site Rd, Mesa, AZ 85201', 'an unedited sheet cell does not overwrite the site');

  // An address retyped in the sheet without an edit mark (the mark can be missed) still reaches the site.
  j = await post([head2, ['10/1/2026 9:00:00', 'Two Way', '480-555-0190', '9 Site Rd, Mesa, AZ 85201', ...t2, '']]);
  assert.ok(!j.cells.some((c) => c.row === 2), 'sheet and site agree');
  j = await post([head2, ['10/1/2026 9:00:00', 'Two Way', '480-555-0190', '77 Real Ave, Tempe, AZ 85281', ...t2, '']]);
  assert.strictEqual(j.applied, 1);
  assert.ok(!j.cells.some((c) => c.row === 2), 'the sheet edit is not overwritten by the old site address');
  q = await pkg(id);
  assert.strictEqual(q.Address, '77 Real Ave, Tempe, AZ 85281');
  assert.strictEqual(q.Lat, '', 'cleared so the new address gets placed on the map');

  // Rows synced before this copy was kept: the sheet's address wins the first time.
  await store.mutate((db) => { const x = db['Care Packages'].find((y) => y.ID === id); x['Sheet Copy'] = ''; x.Address = '4400 W Demo Dr, Phoenix, AZ 85031'; });
  j = await post([head2, ['10/1/2026 9:00:00', 'Two Way', '480-555-0190', '77 Real Ave, Tempe, AZ 85281', ...t2, '']]);
  assert.ok(!j.cells.some((c) => c.row === 2));
  assert.strictEqual((await pkg(id)).Address, '77 Real Ave, Tempe, AZ 85281');
});

test('messages: per-status care texts, two groups, coordinators only', async () => {
  const maria = (await store.all('Care Packages')).find((p) => p.Name.startsWith('Mar'));
  // Picking up drafts an "on the way" text (Spanish for Spanish speakers).
  await store.mutate((db) => { const p = db['Care Packages'].find((x) => x.ID === maria.ID); p.Status = 'Packed & Ready'; p['Delivered On'] = ''; });
  await admin.get('/packages/' + maria.ID);
  await admin.post(`/packages/${maria.ID}/step`, { to: 'Picked Up' });
  const last = (await store.all('Messages')).at(-1);
  assert.strictEqual(last.Ref, maria.ID);
  assert.match(last.Body, /va en camino/);
  // The list has a Text button with the message for the current status.
  const list = (await admin.get('/packages')).text;
  assert.match(list, new RegExp('title="Hola Mar[^"]*va en camino'));
  // Messages are split into care packages and booth.
  const care = (await admin.get('/messages?tab=care&all=1')).text;
  const booth = (await admin.get('/messages?tab=booth&all=1')).text;
  assert.match(care, /va en camino/);
  assert.doesNotMatch(care, />BR-\d/);
  assert.doesNotMatch(booth, /va en camino/);
  // Volunteers can't open the outbox or see Text buttons on the booth board.
  assert.strictEqual((await vol.get('/messages')).status, 403);
  assert.doesNotMatch((await vol.get('/booth')).text, /wa\.me/);
});

test('sign-ins survive a restart', async () => {
  const file = path.join(dir, '.sessions.json');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(fs.existsSync(file));
  const { FileStore } = require('../lib/session-store');
  const reloaded = new FileStore(file);
  assert.ok(Object.values(reloaded.data).some((s) => s.uid), 'a signed-in session was written to disk');
});

test('geocoder tries the Census lookup first, then OpenStreetMap', async () => {
  const { geocode } = require('../lib/geo');
  const realFetch = global.fetch;
  const asked = [];
  process.env.GEOCODER = 'on';
  try {
    global.fetch = async (url) => {
      asked.push(new URL(url).host);
      const census = url.includes('census.gov');
      return { ok: true, json: async () => (census ? { result: { addressMatches: url.includes('Known') ? [{ coordinates: { x: -111.9, y: 33.42 } }] : [] } } : [{ lat: '33.5', lon: '-112.0' }]) };
    };
    assert.deepStrictEqual(await geocode('1 Known St, Tempe, AZ'), { lat: '33.42000', lng: '-111.90000' });
    assert.deepStrictEqual(asked, ['geocoding.geo.census.gov']);
    assert.deepStrictEqual(await geocode('2 Other St, Tempe, AZ'), { lat: '33.50000', lng: '-112.00000' });
    assert.deepStrictEqual(asked.slice(1), ['geocoding.geo.census.gov', 'nominatim.openstreetmap.org']);
  } finally {
    global.fetch = realFetch;
    process.env.GEOCODER = 'off';
  }
});
