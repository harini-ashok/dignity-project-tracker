/**
 * Phoenix Dignity Project tracker: Google Sheet sync.
 *
 * Sends the care package form's responses to the tracker website whenever
 * someone submits the form, and once an hour as a safety net. Re-sending is
 * safe: people already in the tracker are matched by phone number + request
 * date and are never duplicated.
 *
 * Setup (once, by someone who owns the response sheet):
 *  1. Open the Google Sheet the form writes to → Extensions → Apps Script.
 *  2. Replace everything in Code.gs with this file and press Save.
 *  3. Project Settings (gear) → Script properties → add:
 *       TRACKER_URL  = the tracker's address, e.g. https://tracker.citrixtek.com
 *       SYNC_SECRET  = the same value as FORM_SYNC_SECRET on the tracker
 *       SHEET_NAME   = (optional) tab to send; defaults to the first tab
 *  4. Back in the editor choose the "setup" function and press Run.
 *     Approve the permissions Google asks for.
 * After that the sheet also gets a "Tracker" menu with "Sync now".
 */

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('syncNow').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('syncNow').timeBased().everyHours(1).create();
  syncNow();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tracker').addItem('Sync now', 'syncNowWithAlert').addToUi();
}

function syncNowWithAlert() {
  var result = syncNow();
  SpreadsheetApp.getUi().alert('Sent ' + result.rows + ' responses: ' + result.added + ' new, ' + result.updated + ' updated.');
}

function syncNow() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('TRACKER_URL');
  var secret = props.getProperty('SYNC_SECRET');
  if (!url || !secret) throw new Error('Set TRACKER_URL and SYNC_SECRET in Project Settings → Script properties first.');
  var ss = SpreadsheetApp.getActive();
  var name = props.getProperty('SHEET_NAME');
  var sheet = name ? ss.getSheetByName(name) : ss.getSheets()[0];
  if (!sheet) throw new Error('No tab named ' + name);
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
  console.log(body);
  return JSON.parse(body);
}
