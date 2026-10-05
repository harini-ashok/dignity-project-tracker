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
  assert.doesNotMatch(map.text, /602/, 'phone hidden before claiming');
  assert.match(map.text, /"lat":33.5/, 'coordinates rounded before claiming');
  assert.strictEqual((await vol.get('/packages/' + maria.ID)).status, 403);

  const r = await vol.post(`/packages/${maria.ID}/claim`, { pickup: 'Sat 10am', eta: 'Sat 11am' });
  assert.strictEqual(r.location, '/packages/' + maria.ID);
  const p = await pkg(maria.ID);
  assert.strictEqual(p.Status, 'Volunteer Assigned');
  assert.strictEqual(p['Delivery Volunteer'], 'Vera Volunteer');
  const page = await vol.get('/packages/' + maria.ID);
  assert.match(page.text, /200 W Sample Rd/);
  assert.match(page.text, /wa\.me\/16025550123/);

  const msgs = await store.all('Messages');
  assert.strictEqual(msgs.length, 2);
  assert.match(msgs[0].Body, /^Hola María, le saluda Phoenix Dignity Project\. Vera Volunteer/, 'Spanish template for Spanish speakers');
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
