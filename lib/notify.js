// Outgoing messages. By default nothing leaves the app automatically: each message is
// written to the "Messages" sheet as "Ready to send", and the outbox page gives a
// one-tap WhatsApp / SMS button so a coordinator sends it from their own phone.
//
// To send SMS automatically instead, set SMS_PROVIDER=twilio plus TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN and TWILIO_FROM. Nothing is sent unless those are set.
const { nowStamp, digits } = require('./logic');

async function sendTwilio(phone, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: '+' + digits(phone), From: process.env.TWILIO_FROM, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}`);
}

function autoSendEnabled() {
  return process.env.SMS_PROVIDER === 'twilio' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM;
}

// msgs: [{ref, to, phone, body}]. Must be called inside store.mutate with the workbook `db`.
async function queue(db, msgs, by) {
  for (const m of msgs) {
    if (!m.phone || !m.body) continue;
    let status = 'Ready to send';
    if (autoSendEnabled()) {
      try { await sendTwilio(m.phone, m.body); status = 'Sent'; } catch { status = 'Failed'; }
    }
    db.Messages.push({ Time: nowStamp(), Ref: m.ref || '', To: m.to || '', Phone: m.phone, Body: m.body, Status: status, By: by || '' });
  }
}

module.exports = { queue, autoSendEnabled };
