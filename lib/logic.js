// Business rules: dates, item lists, restriction checks, shortages, message templates.

function pad(n) { return String(n).padStart(2, '0'); }

// All dates are local to Arizona (TZ is set in server.js).
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nowStamp() {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The next booth day strictly after `from` (items asked for on a Tuesday come back the following Tuesday).
function nextBoothDay(from = today(), weekday = 2) {
  const d = new Date(from + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== Number(weekday)) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Google Form checkbox answers are bilingual: "Wipes (Toallitas), Diapers/pañales".
// Keep the English part as the item name.
function english(v) {
  return String(v || '').replace(/\s*\([^)]*\)\s*$/, '').split(/\s+\/\s*/)[0].trim();
}

// Split on commas/semicolons/new lines, but not inside parentheses.
function splitList(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(text || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (!depth && /[,;\n]/.test(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// "Toothpaste, Socks x2; Rice" -> [{name:'Toothpaste',qty:1}, {name:'Socks',qty:2}, {name:'Rice',qty:1}]
function parseItems(text) {
  const seen = new Map();
  for (const raw of splitList(text)) {
    let name = raw;
    let qty = 1;
    const m = name.match(/^(.*?)\s*(?:x|×|\*)\s*(\d+)$/i) || name.match(/^(\d+)\s*x?\s+(.*)$/i);
    if (m) {
      if (/^\d+$/.test(m[1])) { qty = Number(m[1]); name = m[2]; } else { name = m[1]; qty = Number(m[2]); }
    }
    name = english(name);
    if (!name || /^(yes|no|none|n\/a|sí|si)$/i.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) seen.get(key).qty += qty; else seen.set(key, { name, qty });
  }
  return [...seen.values()];
}

function packageItems(p) {
  return parseItems(p['Items Requested']);
}

// Sober-living / recovery homes and shelters usually ban alcohol-based and aerosol products.
function suggestedRestrictions(housing) {
  return /sober|recovery|rehab|shelter|transitional|group home/i.test(housing || '') ? 'No alcohol, No aerosol' : '';
}

function findInventory(inventory, name) {
  const k = name.toLowerCase().trim();
  return inventory.find((r) => r.Item.toLowerCase().trim() === k)
    || inventory.find((r) => r.Item.toLowerCase().replace(/s$/, '') === k.replace(/s$/, ''));
}

function words(s) {
  return String(s || '').toLowerCase().split(/[,;/\n]+|\band\b/).map((w) => w.trim().replace(/s$/, '')).filter((w) => w.length >= 3);
}

// Why an item can't go in this package (aerosol / alcohol / allergen), or null if it's fine.
function conflict(p, inv) {
  if (!inv) return null;
  const rules = `${p.Restrictions || ''}`.toLowerCase();
  const reasons = [];
  if (/aerosol|spray/.test(rules) && /^y/i.test(inv['Has Aerosol'])) reasons.push('aerosol');
  if (/alcohol/.test(rules) && /^y/i.test(inv['Has Alcohol'])) reasons.push('alcohol');
  const allergies = words(`${p.Allergies || ''}, ${p['Food Dislikes'] || ''}, ${/allerg/.test(rules) ? p.Restrictions : ''}`)
    .filter((w) => !/^(no|none|n\/a|food allergie|no known allergie)/.test(w));
  for (const a of words(inv.Allergens)) {
    if (allergies.some((x) => x.includes(a) || a.includes(x))) reasons.push(`allergen: ${a}`);
  }
  return reasons.length ? reasons.join(', ') : null;
}

// The packing list for one package: each requested item, whether it's in stock, and any conflict.
function packingList(p, inventory) {
  return packageItems(p).map((it) => {
    const inv = findInventory(inventory, it.name);
    return {
      ...it,
      inventoryName: inv ? inv.Item : null,
      onHand: inv ? Number(inv['On Hand'] || 0) : null,
      conflict: conflict(p, inv),
    };
  });
}

// Packages still waiting to be packed.
const OPEN = ['New', 'Texted - No Response', 'Ready for Volunteer', 'Too Early to Pack', 'Volunteer Assigned'];
const CLAIMABLE = 'Ready for Volunteer';

// Demand from every package not yet packed vs what's on the shelf.
function shortages(packages, inventory) {
  const need = new Map();
  for (const p of packages) {
    if (!OPEN.includes(p.Status)) continue;
    for (const it of packingList(p, inventory)) {
      if (it.conflict) continue;
      const key = it.inventoryName || it.name;
      const row = need.get(key.toLowerCase()) || { item: key, known: !!it.inventoryName, needed: 0, onHand: it.onHand ?? 0, packages: [] };
      row.needed += it.qty;
      row.packages.push(p.ID);
      need.set(key.toLowerCase(), row);
    }
  }
  const out = [...need.values()].map((r) => ({ ...r, short: Math.max(0, r.needed - r.onHand) }));
  // Also anything below its "Low At" level even without current demand.
  for (const inv of inventory) {
    const low = Number(inv['Low At'] || 0);
    if (low && Number(inv['On Hand'] || 0) <= low && !need.has(inv.Item.toLowerCase())) {
      out.push({ item: inv.Item, known: true, needed: 0, onHand: Number(inv['On Hand'] || 0), packages: [], short: 0, low: true });
    }
  }
  return out.filter((r) => r.short > 0 || !r.known || r.low).sort((a, b) => b.short - a.short || a.item.localeCompare(b.item));
}

function fill(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== '' ? vars[k] : `[${k}]`));
}

function packageVars(p, settings, volunteer) {
  return {
    id: p.ID, name: english(p.Name).split(' ')[0] || p.Name, fullName: p.Name, phone: p.Phone,
    address: p.Address,
    volunteer: p['Delivery Volunteer'] || (volunteer && volunteer.Name) || '',
    volunteerPhone: (volunteer && volunteer.Phone) || 'their own number',
    eta: p['Est. Delivery'] || 'a time we will confirm', pickup: p['Pickup Time'] || 'a time we will confirm',
    hq: settings.hq_address || 'HQ', org: settings.org_name || 'Phoenix Dignity Project',
  };
}

// Spanish speakers get the "_es" version of a requester message when one exists.
function template(settings, key, p) {
  return (/espa|spanish/i.test((p && p.Language) || '') && settings[key + '_es']) || settings[key];
}

// "4443 W Mitchell Dr, Phoenix, AZ 85031" -> "W Mitchell Dr, Phoenix, AZ 85031"
// Volunteers browsing open deliveries see the street, not the house number.
function streetOnly(address) {
  return String(address || '').replace(/^\s*\d+[A-Za-z]?\s+/, '').replace(/\s*\b(apt|unit|suite|ste|bldg|building|space|lot)\b\.?\s*#?\s*[\w-]+/gi, '').replace(/\s*#\s*[\w-]+/g, '').replace(/\s+,/g, ',').trim();
}
function zipOf(address) {
  const m = String(address || '').match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/);
  return m ? m[1] : '';
}

function digits(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '1' + d; // assume US numbers
  return d;
}
function waLink(phone, text) {
  const d = digits(phone);
  return d ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : null;
}
function smsLink(phone, text) {
  const d = digits(phone);
  return d ? `sms:+${d}?&body=${encodeURIComponent(text)}` : null;
}

// Round coordinates to ~1 km so volunteers browsing the map can't see an exact home address.
function fuzz(n) { return Math.round(Number(n) * 100) / 100; }

module.exports = {
  today, nowStamp, nextBoothDay, parseItems, packageItems, packingList, conflict, shortages,
  fill, packageVars, template, streetOnly, zipOf, english, splitList, suggestedRestrictions, CLAIMABLE, waLink, smsLink, digits, fuzz, findInventory, OPEN,
};
