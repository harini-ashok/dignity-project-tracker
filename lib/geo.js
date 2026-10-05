// Turns an address into map coordinates using OpenStreetMap's free geocoder.
// Its usage policy allows about one lookup per second, so lookups are queued.
// Set GEOCODER=off to disable (coordinates can also be typed into the Lat/Lng columns).
let last = 0;
let chain = Promise.resolve();

function geocode(address) {
  if (process.env.GEOCODER === 'off' || !address) return Promise.resolve(null);
  const job = chain.then(async () => {
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'PhoenixDignityProjectTracker/1.0 (care package coordination)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const [hit] = await res.json();
      return hit ? { lat: Number(hit.lat).toFixed(5), lng: Number(hit.lon).toFixed(5) } : null;
    } catch {
      return null;
    }
  });
  chain = job.catch(() => {});
  return job;
}

function fullAddress(p) {
  let a = String(p.Address || '').replace(/\s*\b(apt|unit|suite|ste|bldg|building|space|lot)\b\.?\s*#?\s*[\w-]+/gi, '').replace(/\s*#\s*[\w-]+/g, '');
  if (a && !/\b(az|arizona)\b/i.test(a)) a += ', AZ';
  return a;
}

module.exports = { geocode, fullAddress };
