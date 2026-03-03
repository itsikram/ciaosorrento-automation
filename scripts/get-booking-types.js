/**
 * Fetch LimoExpress booking types and print their IDs.
 * Run: node scripts/get-booking-types.js
 * Use one of the IDs as LIMOEXPRESS_BOOKING_TYPE_ID in .env
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const baseUrl = (process.env.LIMOEXPRESS_API_URL || '').replace(/\/$/, '');
const rawKey = (process.env.LIMOEXPRESS_API_KEY || '').trim();

if (!baseUrl || !rawKey) {
  console.error('Set LIMOEXPRESS_API_URL and LIMOEXPRESS_API_KEY in .env');
  process.exit(1);
}

const token = rawKey.toLowerCase().startsWith('bearer ') ? rawKey.slice(7).trim() : rawKey;
const authHeader = `Bearer ${token}`;

async function fetchBookingTypes(url, headers) {
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function main() {
  let { res, data } = await fetchBookingTypes(`${baseUrl}/api/integration/booking-types`, {
    Authorization: authHeader,
    Accept: 'application/json',
  });

  if (res.status === 401) {
    console.error('401 Unauthenticated. Trying alternate auth and base URL...\n');
    const attempts = [
      { url: baseUrl, headers: { Authorization: token, Accept: 'application/json' } },
      { url: baseUrl.replace('api.limoexpress', 'app.limoexpress'), headers: { Authorization: authHeader, Accept: 'application/json' } },
      { url: baseUrl.replace('app.limoexpress', 'api.limoexpress'), headers: { Authorization: authHeader, Accept: 'application/json' } },
    ];
    for (const { url, headers } of attempts) {
      const { res: r, data: d } = await fetchBookingTypes(`${url}/api/integration/booking-types`, headers);
      if (r.ok) {
        res = r;
        data = d;
        break;
      }
    }
    if (!res.ok) {
      console.error('Error:', res.status, data);
      console.error('\nTips:');
      console.error('1. In LimoExpress go to Advanced settings and copy the API token again (no extra spaces).');
      console.error('2. Set LIMOEXPRESS_API_URL to the exact base URL from LimoExpress (e.g. https://app.limoexpress.app).');
      console.error('3. Ensure the token is the one shown in Advanced settings (Bearer <token> format is sent automatically).');
      process.exit(1);
    }
  }

  if (!res.ok) {
    console.error('Error:', res.status, data);
    process.exit(1);
  }

  const list = Array.isArray(data) ? data : data.data || [];
  console.log('Booking types (use one id as LIMOEXPRESS_BOOKING_TYPE_ID in .env):\n');
  if (list.length === 0) {
    console.log('  (none returned)');
    return;
  }
  list.forEach((t) => {
    console.log(`  id: ${t.id}  name: ${t.name || t.title || '-'}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
