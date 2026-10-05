// A starting inventory list so the shopping list and packing checks work on day one.
// Names follow the care package form (baby supplies and pet supplies use the form's own
// wording); everything starts at 0 on hand. Edit freely on the Inventory page or in Excel.
// [Item, Category, Has Aerosol, Has Alcohol, Allergens]
module.exports = [
  // Hygiene
  ['Toothpaste', 'Essential'], ['Toothbrush', 'Essential'], ['Floss', 'Essential'],
  ['Mouthwash', 'Essential', 'No', 'Yes'], ['Soap', 'Essential'], ['Body wash', 'Essential'],
  ['Shampoo', 'Essential'], ['Conditioner', 'Essential'], ['Dry shampoo', 'Essential', 'Yes', 'Yes'],
  ['Deodorant', 'Essential'], ['Body spray', 'Essential', 'Yes', 'Yes'], ['Lotion', 'Essential'],
  ['Lip balm', 'Essential'], ['Razors', 'Essential'], ['Shaving cream', 'Essential', 'Yes'],
  ['Pads', 'Essential'], ['Tampons', 'Essential'], ['Hand sanitizer', 'Essential', 'No', 'Yes'],
  ['Face wash', 'Essential'], ['Hairbrush / comb', 'Essential'], ['Hair ties', 'Essential'],
  ['Tissues', 'Essential'], ['Toilet paper', 'Essential'], ['Sunscreen', 'Essential'],
  ['Pain reliever', 'Essential'], ['First aid kit', 'Essential'],
  // Cleaning / household
  ['Laundry soap', 'Essential'], ['Dish soap', 'Essential'], ['Sponges', 'Essential'],
  ['All-purpose cleaner', 'Essential'], ['Disinfecting wipes', 'Essential', 'No', 'Yes'],
  ['Trash bags', 'Essential'], ['Paper towels', 'Essential'], ['Towels', 'Essential'],
  ['Blanket', 'Essential'], ['Bed sheets', 'Essential'], ['Pillow', 'Essential'],
  // Clothing basics
  ['Socks', 'Other'], ['Underwear', 'Other'], ['T-shirt', 'Other'], ['Hoodie / jacket', 'Other'],
  ['Shoes', 'Other'], ['Hat', 'Other'], ['Backpack', 'Other'], ['Water bottle', 'Other'],
  // Baby (from the form's baby supplies question)
  ['Diapers', 'Essential'], ['Wipes', 'Essential'], ['Bottles', 'Essential'], ['Burp rags', 'Essential'],
  ['Bibs', 'Essential'], ['Baby shampoo', 'Essential'], ['Swaddlers', 'Essential'],
  ['Baby food', 'Food'], ['Formula', 'Food', 'No', 'No', 'dairy'], ['Toys/teethers', 'Other'],
  // Pets (from the form's pet supplies question)
  ['Dog food', 'Other'], ['Cat food', 'Other'], ['Cat litter', 'Other'], ['Dog toy', 'Other'], ['Cat toy', 'Other'],
  // Pantry (non-perishable)
  ['Rice', 'Food'], ['Beans', 'Food'], ['Pasta', 'Food', 'No', 'No', 'gluten'], ['Pasta sauce', 'Food'],
  ['Canned vegetables', 'Food'], ['Canned fruit', 'Food'], ['Canned soup', 'Food'],
  ['Canned tuna', 'Food', 'No', 'No', 'fish'], ['Canned chicken', 'Food'],
  ['Peanut butter', 'Food', 'No', 'No', 'peanut'], ['Jelly', 'Food'], ['Cereal', 'Food', 'No', 'No', 'gluten'],
  ['Oatmeal', 'Food'], ['Crackers', 'Food', 'No', 'No', 'gluten'], ['Granola bars', 'Food', 'No', 'No', 'nuts, gluten'],
  ['Ramen', 'Food', 'No', 'No', 'gluten'], ['Mac and cheese', 'Food', 'No', 'No', 'dairy, gluten'],
  ['Shelf-stable milk', 'Food', 'No', 'No', 'dairy'], ['Coffee', 'Food'], ['Tea', 'Food'],
  ['Cooking oil', 'Food'], ['Flour', 'Food', 'No', 'No', 'gluten'], ['Sugar', 'Food'], ['Spices', 'Food'],
  ['Snacks', 'Food'], ['Water', 'Food'],
];
