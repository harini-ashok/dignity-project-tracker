/**
 * Phoenix Dignity Project tracker: two-way Google Sheet sync.
 *
 * Form → website: every new form response shows up in the tracker within a
 *   minute of being submitted (and every 5 minutes as a safety net).
 * Website → sheet: each response gets "Tracker ..." columns at the right
 *   (ID, Status, Volunteer, Pickup, Delivered, Updated) that show where the
 *   request stands on the website. Requests made on the website's own form are
 *   added to the bottom of the sheet.
 * Sheet → website: change Tracker Status, Tracker Volunteer, Tracker Pickup or
 *   Tracker Delivered in the sheet and the website picks it up on the next sync.
 *
 * Re-sending is safe: rows are matched by Tracker ID, or by phone number +
 * request date, and are never duplicated.
 *
 * Setup (once, by someone who owns the response sheet):
 *  1. Open the Google Sheet the form writes to → Extensions → Apps Script.
 *  2. Replace everything in Code.gs with this file and press Save.
 *  3. Project Settings (gear) → Script properties → add:
 *       TRACKER_URL  = the tracker's address, e.g. https://tracker.citrixtek.com
 *       SYNC_SECRET  = the same value as FORM_SYNC_SECRET on the tracker
 *       SHEET_NAME   = (optional) tab to sync; defaults to the form's responses tab
 *  4. Back in the editor choose the "setup" function and press Run.
 *     Approve the permissions Google asks for.
 * After that the sheet has a "Tracker" menu with "Sync now".
 *
 * Trying it out first? In an empty Google Sheet, do steps 1-3, then run
 * "createSampleForm". It makes a sample request form linked to this sheet,
 * fills it with made-up people, and turns the sync on.
 */

var TRACKER_COLUMNS = ['Tracker ID', 'Tracker Status', 'Tracker Volunteer', 'Tracker Pickup', 'Tracker Delivered', 'Tracker Updated', 'Tracker Edited'];
var EDITABLE = { 'Tracker Status': 'Status', 'Tracker Volunteer': 'Volunteer', 'Tracker Pickup': 'Pickup', 'Tracker Delivered': 'Delivered' };

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('syncNow').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(5).create();
  syncNow();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tracker')
    .addItem('Sync now', 'syncNowWithAlert')
    .addItem('Create sample form with mock data', 'createSampleForm')
    .addToUi();
}

function syncNowWithAlert() {
  var r = syncNow();
  if (!r.rows) {
    SpreadsheetApp.getUi().alert('No responses found on the tab "' + targetSheet().getName() + '". Set SHEET_NAME in Project Settings → Script properties to the tab with the form responses.');
    return;
  }
  SpreadsheetApp.getUi().alert('Synced ' + r.rows + ' responses: ' + r.added + ' new on the website, ' +
    r.applied + ' changes from this sheet applied, ' + r.append.length + ' website requests added here.');
}

function targetSheet() {
  var name = PropertiesService.getScriptProperties().getProperty('SHEET_NAME');
  var ss = SpreadsheetApp.getActive();
  var sheet = name ? ss.getSheetByName(name)
    : ss.getSheets().filter(function (s) { return s.getFormUrl(); })[0] || ss.getSheets()[0];
  if (!sheet) throw new Error('No tab named ' + name);
  return sheet;
}

// Marks which tracker columns a person changed, so only those go back to the website.
function onEdit(e) {
  var sheet = e.range.getSheet();
  if (sheet.getSheetId() !== targetSheet().getSheetId() || e.range.getRow() === 1) return;
  var head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var editedCol = head.indexOf('Tracker Edited') + 1;
  if (!editedCol) return;
  var fields = [];
  for (var c = e.range.getColumn(); c <= e.range.getLastColumn(); c++) {
    if (EDITABLE[head[c - 1]]) fields.push(EDITABLE[head[c - 1]]);
  }
  if (!fields.length) return;
  for (var r = e.range.getRow(); r <= e.range.getLastRow(); r++) {
    var cell = sheet.getRange(r, editedCol);
    var have = cell.getDisplayValue() ? cell.getDisplayValue().split(/\s*,\s*/) : [];
    fields.forEach(function (f) { if (have.indexOf(f) < 0) have.push(f); });
    cell.setValue(have.join(', '));
  }
}

function ensureTrackerColumns(sheet) {
  var width = Math.max(sheet.getLastColumn(), 1);
  var head = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  var missing = TRACKER_COLUMNS.filter(function (h) { return head.indexOf(h) < 0; });
  if (missing.length) {
    sheet.getRange(1, width + 1, 1, missing.length).setValues([missing])
      .setBackground('#ecebfb').setFontWeight('bold');
    head = head.concat(missing);
  }
  var cols = {};
  TRACKER_COLUMNS.forEach(function (h) { cols[h] = head.indexOf(h) + 1; });
  return cols;
}

function syncNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { rows: 0, added: 0, applied: 0, append: [] };
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('TRACKER_URL');
    var secret = props.getProperty('SYNC_SECRET');
    if (!url || !secret) throw new Error('Set TRACKER_URL and SYNC_SECRET in Project Settings → Script properties first.');
    var sheet = targetSheet();
    var cols = ensureTrackerColumns(sheet);
    var rows = sheet.getDataRange().getDisplayValues();
    var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/api/form-sync', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secret },
      payload: JSON.stringify({ rows: rows }),
      muteHttpExceptions: true,
    });
    var body = res.getContentText();
    if (res.getResponseCode() !== 200) throw new Error('Tracker sync failed (' + res.getResponseCode() + '): ' + body);
    var r = JSON.parse(body);
    writeBack(sheet, cols, r);
    return r;
  } finally {
    lock.releaseLock();
  }
}

// Writes the website's view of each request into the Tracker columns, one column at a time.
function writeBack(sheet, cols, r) {
  var last = sheet.getLastRow();
  if (last >= 2 && r.write && r.write.length) {
    var block = {};
    TRACKER_COLUMNS.forEach(function (h) {
      var range = sheet.getRange(2, cols[h], last - 1, 1);
      range.setNumberFormat('@');
      block[h] = { range: range, values: range.getDisplayValues() };
    });
    var edited = block['Tracker Edited'].values;
    r.write.forEach(function (w) {
      var i = w.row - 2;
      if (i < 0 || i >= last - 1) return;
      // Someone edited this row while the sync was running: keep their change for next time.
      if (edited[i][0] !== w.edited) return;
      TRACKER_COLUMNS.forEach(function (h, k) { block[h].values[i][0] = w.values[k]; });
    });
    TRACKER_COLUMNS.forEach(function (h) { block[h].range.setValues(block[h].values); });
  }
  if (r.statuses && r.statuses.length) {
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(r.statuses, true).setAllowInvalid(true).build();
    sheet.getRange(2, cols['Tracker Status'], Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
  }
  if (r.append && r.append.length) {
    var width = sheet.getLastColumn();
    var lines = r.append.map(function (line) {
      line = line.slice(0, width);
      while (line.length < width) line.push('');
      return line;
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, lines.length, width).setNumberFormat('@').setValues(lines);
  }
}

// ---------- Sample form with made-up people, for trying the sync ----------
function createSampleForm() {
  var ss = SpreadsheetApp.getActive();
  var form = FormApp.create('Care Package Request (SAMPLE)');
  form.setDescription('Sample of the Phoenix Dignity Project care package form, for testing the tracker. Made-up data only.');
  var q = {
    name: form.addTextItem().setTitle('Primary Contact First Name / Client Name -- Nombre de contacto principal:').setRequired(true),
    phone: form.addTextItem().setTitle('Phone Number (of recipient) / Número de teléfono:').setRequired(true),
    lang: form.addMultipleChoiceItem().setTitle('Preferred Language / Idioma preferido:').setChoiceValues(['English', 'Español']),
    how: form.addMultipleChoiceItem().setTitle('How would you like to receive your care package? / ¿Cómo le gustaría recibir su paquete de atención?')
      .setChoiceValues(['Delivery / Entrega', 'Pick up at Tempe Feed / Recoger en Tempe Feed']),
    address: form.addParagraphTextItem().setTitle('If you need the package delivered what is your FULL address? (please include city, state, and zip code)'),
    household: form.addTextItem().setTitle('Total household size / Tamaño total del hogar:'),
    housing: form.addMultipleChoiceItem().setTitle('What is your current housing situation? / ¿Cuál es su situación de vivienda actual?')
      .setChoiceValues(['House/apartment', 'Shelter', 'Recovery or sober living home', 'Unhoused/street']),
    items: form.addCheckboxItem().setTitle('What items are needed? -- Check all that apply / ¿Qué artículos se necesitan? -- Marque todas las opciones que correspondan.')
      .setChoiceValues(['Toothpaste', 'Toothbrush', 'Shampoo', 'Deodorant', 'Bar soap', 'Socks', 'Diapers / Pañales', 'Wipes (Toallitas)',
        'Rice', 'Beans', 'Pasta', 'Canned vegetables', 'Peanut butter', 'Cereal', 'Mouthwash', 'Laundry detergent']),
    allergies: form.addTextItem().setTitle('Does anyone in the house have any allergies? List them here / ¿Alguien en la casa tiene alguna alergia?'),
    story: form.addParagraphTextItem().setTitle('In your own words, how would a care package help you right now? / En sus propias palabras, ¿cómo le ayudaría un paquete?'),
  };
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Made-up people at public buildings (library, city halls) so they land on the map.
  var people = [
    ['Ana Demo', '480-555-0101', 'English', 0, '3500 S Rural Rd, Tempe, AZ 85282', '3', 'House/apartment', ['Toothpaste', 'Shampoo', 'Rice', 'Beans'], '', 'Just moved and starting over.'],
    ['Ben Sample', '480-555-0102', 'English', 0, '200 W Washington St, Phoenix, AZ 85003', '1', 'Recovery or sober living home', ['Deodorant', 'Mouthwash', 'Socks'], '', 'New job starts next week.'],
    ['Carla Ejemplo', '602-555-0103', 'Español', 0, '1 E Main St, Mesa, AZ 85201', '5', 'House/apartment', ['Diapers / Pañales', 'Wipes (Toallitas)', 'Rice', 'Pasta'], 'Peanuts', 'Tengo tres niños pequeños.'],
    ['Dev Placeholder', '602-555-0104', 'English', 1, '', '2', 'Shelter', ['Toothbrush', 'Bar soap', 'Cereal'], 'Gluten', ''],
    ['Eva Muestra', '602-555-0105', 'Español', 0, '175 S Arizona Ave, Chandler, AZ 85225', '4', 'House/apartment', ['Laundry detergent', 'Canned vegetables', 'Peanut butter'], '', 'Gracias por su ayuda.'],
  ];
  people.forEach(function (p) {
    var r = form.createResponse()
      .withItemResponse(q.name.createResponse(p[0]))
      .withItemResponse(q.phone.createResponse(p[1]))
      .withItemResponse(q.lang.createResponse(p[2]))
      .withItemResponse(q.how.createResponse(q.how.getChoices()[p[3]].getValue()))
      .withItemResponse(q.household.createResponse(p[5]))
      .withItemResponse(q.housing.createResponse(p[6]))
      .withItemResponse(q.items.createResponse(p[7]));
    if (p[4]) r.withItemResponse(q.address.createResponse(p[4]));
    if (p[8]) r.withItemResponse(q.allergies.createResponse(p[8]));
    if (p[9]) r.withItemResponse(q.story.createResponse(p[9]));
    r.submit();
  });

  // The form's answers land in a new tab; sync that one.
  SpreadsheetApp.flush();
  Utilities.sleep(3000);
  var tab = ss.getSheets().filter(function (s) {
    try { return s.getFormUrl() && FormApp.openByUrl(s.getFormUrl()).getId() === form.getId(); } catch (e) { return false; }
  })[0];
  var props = PropertiesService.getScriptProperties();
  if (tab) props.setProperty('SHEET_NAME', tab.getName());
  var msg = 'Sample form created: ' + form.getPublishedUrl() + '\n\nEdit it here: ' + form.getEditUrl();
  if (props.getProperty('TRACKER_URL') && props.getProperty('SYNC_SECRET')) {
    setup();
    msg += '\n\nSync is on. The 5 sample people are now on the tracker website.';
  } else {
    msg += '\n\nAdd TRACKER_URL and SYNC_SECRET in Project Settings → Script properties, then run "setup".';
  }
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from the editor without the sheet open */ }
}
