# Dignity Project Tracker

A small website for **Phoenix Dignity Project** that takes the coordinating work off one person's phone:
care package requests from the Google Form, the weekly delivery map volunteers pick from,
packing shifts, inventory, and the Tempe Feed booth board.

**All the data lives in one Excel file.** There is no database. Coordinators can download the
workbook at any time, open it in Excel, and every sheet looks like the spreadsheets they already use.

## What each person does with it

| Who | What they do |
| --- | --- |
| **Coordinator** | Imports Google Form responses, reviews new requests and sets them to *Ready for Volunteer*, prints labels, sends the pre-written WhatsApp messages, sees the shopping list. |
| **Delivery volunteer** | Opens the numbered delivery map (like the weekly WhatsApp map), taps **I'll deliver this**, enters pickup and delivery times. It's assigned to them in the workbook instantly. Then sees the full address, directions, and one-tap WhatsApp buttons; marks *Picked Up* and *Delivered*. |
| **Packing volunteer** | Signs up for a packing shift at HQ and ticks which packages they'll pack. Uses the packing checklist, which flags items that clash with someone's restrictions (no alcohol / no aerosol at sober-living homes, allergies, foods they won't eat). Marking packed takes the items out of inventory. |
| **Booth volunteer at Tempe Feed** | Enters name, phone and items (with sizes) on their phone. The board tracks *Requested → Bought → At Booth → Picked Up* for each Tuesday. Pressing *Bought* drafts a text to the person. |

## How the care package flow maps to statuses

The statuses match the STATUS column already used in the coordinator's Pending sheet:

`New` → `Texted - No Response` → `Ready for Volunteer` (shows on the map) → `Volunteer Assigned` → `Packed & Ready` → `Picked Up` → `Delivered`
(plus `Too Early to Pack`, `On Hold`, `Cancelled`). The PRINTED and CONNECTED columns are kept too.

## The workbook

`data/tracker.xlsx` has these sheets:

- **Care Packages** – one row per request, with the key details pulled out of the form (name, phone, language, address, household, housing, priorities, items, clothing sizes, allergies, food dislikes, restrictions, pets) and the tracking columns (status, volunteer, pickup time, printed, connected, packer, packed items, delivered on).
- **Form Answers** – every answer from the Google Form, one row per question, so nothing in the 70-question form is lost.
- **Booth Requests** – the Tempe Feed board.
- **Inventory** – what's on the shelf, with *Low At* warnings and *Has Aerosol / Has Alcohol / Allergens* flags used for the packing checks.
- **Volunteers** – names, phones, role (admin = coordinator), status. PINs are stored hashed.
- **Packing Shifts**, **Messages** (outbox of drafted texts), **Settings** (org name, HQ address, message wording in English and Spanish).

Status columns have dropdowns in Excel. A backup copy is saved every hour in `data/backups/`.
Editing in Excel: download from the **Excel** page, edit, upload it back (do it at a quiet time, because changes made on the site in between are replaced).

## Importing the Google Form

In Google Sheets: **File → Download → .xlsx or .csv**, then upload on **Care packages → Import Google Form**.
Questions are matched by keywords (so rewording the form doesn't break it), sheets with several pasted blocks and repeated header rows are handled, and re-importing is safe: the same phone number + request date updates the existing row instead of duplicating it.

## Messages to requesters and volunteers

By default **nothing is sent automatically**. When a volunteer claims a delivery, a package is delivered, or a booth item is bought, the app drafts the message (in Spanish for Spanish speakers) into the **Messages** outbox. Each one has a WhatsApp and a Text button that opens the coordinator's phone with the message filled in. Group intros (requester + volunteer + coordinator) have a ready-to-paste message, and *Mark group chat connected* fills the CONNECTED column.

Optional automatic SMS: set `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. (WhatsApp groups can't be created automatically by any official API, so the intro stays one tap.)

## Running it

Needs Node.js 20 or newer.

```bash
npm install
npm start            # http://localhost:3000
```

On first start it creates a coordinator account named **Coordinator** with PIN **changeme** (or set `ADMIN_NAME`, `ADMIN_PHONE`, `ADMIN_PIN`). Sign in and change the PIN under your name in the menu. Volunteers can sign up at `/join` and you approve them on the Volunteers page.

Try it with made-up data: `npm run demo` (coordinator "Demo Coordinator" / 1234, volunteer "Vic Volunteer" / 1111).

Tests: `npm test`.

### Settings (environment variables)

| Variable | Default | |
| --- | --- | --- |
| `PORT` | 3000 | |
| `DATA_DIR` | `./data` | Where the workbook and backups live. Must be on a persistent disk. |
| `SESSION_SECRET` | generated into `DATA_DIR` | |
| `GEOCODER` | on | Addresses are placed on the map with OpenStreetMap's free geocoder. `off` to disable; Lat/Lng can also be typed in. |
| `TZ` | America/Phoenix | |

### Hosting

Any small Node host with a persistent disk works, for example Render (web service + 1 GB disk mounted at `DATA_DIR`) or Railway (service + volume), roughly $5–10/month. The workbook must sit on the persistent disk or it is lost on redeploy. Put the site behind HTTPS (both hosts do this automatically), since it holds people's addresses and phone numbers.

## Privacy

- Volunteers browsing open deliveries see the street and zip only (no house number, phone or last name) and map pins rounded to about 1 km. Full details appear once a delivery is theirs.
- Only coordinators see the full list, Form Answers, and the workbook download.
- Keep real response sheets out of this repository. The test fixture uses invented people.

## Code map

- `server.js` – all pages and actions
- `lib/store.js` – reads/writes the workbook (one write at a time, atomic save, hourly backups)
- `lib/importer.js` – Google Form import
- `lib/logic.js` – item lists, restriction checks, shopping list, message templates
- `lib/notify.js` – message outbox / optional Twilio
- `lib/geo.js` – address → map coordinates
- `views/` – EJS page templates, `public/style.css`
