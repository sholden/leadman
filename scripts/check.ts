import { matchKey, similarity, normalizeUrl, factKey } from '../src/server/lib/text.js';
import { distanceMiles, boundingBox } from '../src/server/lib/geo.js';
import { estimateCost } from '../src/server/ai/budget.js';

const eq = (label: string, got: unknown, want: unknown) =>
  console.log(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}  → ${JSON.stringify(got)}`);

// Dedupe: the same project named two different ways should collapse.
eq('matchKey collapses noise words',
   matchKey('New Central Fire Station Project'), matchKey('Central Fire Station'));
eq('matchKey is order-insensitive',
   matchKey('Fire Station Central'), matchKey('Central Fire Station'));
console.log(`      similarity("New Central Fire Station","Fire Station No. 3 Replacement") = ${similarity('New Central Fire Station','Fire Station No. 3 Replacement').toFixed(2)}`);
console.log(`      similarity("Zachary High School Addition","Zachary High School Gymnasium") = ${similarity('Zachary High School Addition','Zachary High School Gymnasium').toFixed(2)}`);
console.log(`      similarity("Zachary High School","Central Library Renovation") = ${similarity('Zachary High School','Central Library Renovation').toFixed(2)}`);

eq('normalizeUrl strips tracking + trailing slash',
   normalizeUrl('https://ex.com/agendas/?utm_source=x#top'), 'https://ex.com/agendas');
eq('factKey is stable', factKey('timeline', 'Bid Opening'), 'timeline:bid-opening');

// Geo
const d = distanceMiles(30.4515, -91.1871, 30.2385, -90.9201); // Baton Rouge -> Gonzales
console.log(`${d > 18 && d < 26 ? 'PASS' : 'FAIL'}  Baton Rouge→Gonzales ≈ ${d.toFixed(1)} mi (expect ~21)`);
const box = boundingBox(30.4515, -91.1871, 60);
console.log(`${box.north > box.south && box.east > box.west ? 'PASS' : 'FAIL'}  bounding box well-formed`);

// Cost estimation drives the hard caps, so it needs to be right.
const cost = estimateCost('claude-opus-5', {
  input_tokens: 1_000_000, output_tokens: 1_000_000,
  server_tool_use: { web_search_requests: 100 },
});
console.log(`${Math.abs(cost - 31) < 0.001 ? 'PASS' : 'FAIL'}  1M in + 1M out + 100 searches = $${cost.toFixed(2)} (expect $31.00)`);
