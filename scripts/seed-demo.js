// Fills a workbook with made-up people so you can click around safely.
// Usage: DATA_DIR=demo-data node scripts/seed-demo.js   (then: DATA_DIR=demo-data npm start)
const path = require('path');
const bcrypt = require('bcryptjs');
const { Store } = require('../lib/store');
const L = require('../lib/logic');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'demo-data');
const store = new Store(path.join(dir, 'tracker.xlsx'));

const people = [
  ['Ana Demo', '480-555-0101', 'English', '4400 W Demo Dr, Phoenix, AZ 85031', 33.4995, -112.1530, 'House/apartment', 'Toothpaste, Shampoo, Rice x2, Beans', 'Ready for Volunteer'],
  ['Ben Sample', '480-555-0102', 'English', '7200 S Sample Ln, Laveen, AZ 85339', 33.3820, -112.1420, 'Shelter', 'Deodorant, Body spray, Socks, Canned vegetables', 'Ready for Volunteer'],
  ['Carla Ejemplo', '602-555-0103', 'Español', '4400 S Example St, Phoenix, AZ 85040', 33.4010, -112.0310, 'House/apartment', 'Diapers, Wipes, Rice, Pasta', 'Ready for Volunteer'],
  ['Dev Placeholder', '602-555-0104', 'English', '1400 E Test Ave, Phoenix, AZ 85020', 33.5810, -112.0480, 'Recovery or sober living home', 'Shampoo, Mouthwash, Cereal', 'Ready for Volunteer'],
  ['Eva Muestra', '602-555-0105', 'Español', '3600 N Mock Ave, Phoenix, AZ 85033', 33.4910, -112.2120, 'House/apartment', 'Laundry soap, Peanut butter, Snacks', 'Ready for Volunteer'],
  ['Finn Fixture', '480-555-0106', 'English', '2100 E Sample Rd, Phoenix, AZ 85040', 33.4070, -112.0360, 'Unhoused/street', 'Socks, Toothbrush, Toothpaste, Snacks', 'Volunteer Assigned'],
  ['Gia Example', '480-555-0107', 'English', '2400 S Demo St, Phoenix, AZ 85034', 33.4240, -112.0300, 'House/apartment', 'Rice, Beans, Canned meat', 'New'],
  ['Hal Test', '480-555-0108', 'English', '16 E Fake Dr, Avondale, AZ 85323', 33.4350, -112.3490, 'Shelter', 'Razors, Soap, Pads/Tampons', 'Texted - No Response'],
];
const inventory = [
  ['Toothpaste', 'Essential', 6, 3, 'No', 'No', ''], ['Toothbrush', 'Essential', 10, 3, 'No', 'No', ''],
  ['Shampoo', 'Essential', 2, 2, 'No', 'No', ''], ['Mouthwash', 'Essential', 4, 1, 'No', 'Yes', ''],
  ['Body spray', 'Essential', 3, 1, 'Yes', 'Yes', ''], ['Deodorant', 'Essential', 5, 2, 'No', 'No', ''],
  ['Socks', 'Essential', 12, 4, 'No', 'No', ''], ['Diapers', 'Essential', 0, 2, 'No', 'No', ''],
  ['Rice', 'Food', 2, 2, 'No', 'No', ''], ['Beans', 'Food', 6, 2, 'No', 'No', ''],
  ['Peanut butter', 'Food', 4, 1, 'No', 'No', 'peanut'], ['Snacks', 'Food', 8, 3, 'No', 'No', 'peanut, gluten'],
];

(async () => {
  await store.init();
  await store.mutate((db) => {
    if (!db.Volunteers.some((v) => v.Role === 'admin')) {
      db.Volunteers.push({ ID: 'V-0001', Name: 'Demo Coordinator', Phone: '480-555-0000', Role: 'admin', Status: 'Active', 'PIN Hash': bcrypt.hashSync('1234', 10), Created: L.today() });
    }
    db.Volunteers.push({ ID: 'V-0002', Name: 'Vic Volunteer', Phone: '480-555-0111', Role: 'volunteer', Status: 'Active', 'PIN Hash': bcrypt.hashSync('1111', 10), Created: L.today() });
    people.forEach(([Name, Phone, Language, Address, Lat, Lng, Housing, items, Status], i) => {
      db['Care Packages'].push({
        ID: `CP-${String(i + 1).padStart(4, '0')}`, Submitted: L.today(), Status, Name, Phone, Language, 'Receive By': 'Delivery',
        Address, Zip: L.zipOf(Address), Lat, Lng, Household: `Total household size: ${1 + (i % 4)}`, Housing,
        Needs: 'Hygiene Items: High; Food: Medium', 'Items Requested': items, Restrictions: L.suggestedRestrictions(Housing),
        Allergies: i === 4 ? 'Peanuts' : '', 'Delivery Volunteer': Status === 'Volunteer Assigned' ? 'Vic Volunteer' : '',
        'Pickup Time': Status === 'Volunteer Assigned' ? 'Sat 10am' : '', Updated: L.nowStamp(),
      });
    });
    for (const [Item, Category, onHand, low, a, al, Allergens] of inventory) {
      db.Inventory.push({ Item, Category, 'On Hand': onHand, 'Low At': low, 'Has Aerosol': a, 'Has Alcohol': al, Allergens, Notes: '' });
    }
    const tue = L.nextBoothDay(L.today(), 2);
    [['Rosa Demo', 'Shoes', "women's 8"], ['Tom Sample', 'Jacket', 'XL'], ['Lee Test', 'Backpack', '']].forEach(([Name, Item, Details], i) => {
      db['Booth Requests'].push({ ID: `BR-000${i + 1}`, Date: L.today(), Name, Phone: `480-555-02${i}0`, Item, Details, Status: i === 1 ? 'Bought' : 'Requested', 'Bring On': tue, Updated: L.nowStamp() });
    });
    db['Packing Shifts'].push({ ID: 'SH-0001', Date: L.nextBoothDay(L.today(), 6), Start: '10:00', End: '12:00', Location: 'HQ', Capacity: 4, Volunteers: '', Notes: 'Park on the street please' });
  });
  console.log(`Demo workbook ready in ${dir}. Coordinator: "Demo Coordinator" PIN 1234. Volunteer: "Vic Volunteer" PIN 1111.`);
})();
