#!/usr/bin/env node
/**
 * build-mp-data.js
 *
 * Fetches all 650 MPs from the UK Parliament API, merges stance data
 * from the Google Sheet, and writes a single mp-data.json file.
 *
 * Run manually:   node scripts/build-mp-data.js
 * Run via Action:  triggered by .github/workflows/update-mp-data.yml
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const GOOGLE_SHEETS_API_KEY = 'AIzaSyC52PrXrCwA-1tLaVtCtMlkeGHJvKbKmjw';
const GOOGLE_SHEET_ID = '1GKgMwE6Tdq5hBBB-S3h-U8HWg2QU4FZOq62VXtKVHP0';
const SHEET_NAME = 'UK MPs';
const PARLIAMENT_API = 'https://members-api.parliament.uk/api/Members/Search?House=1&IsCurrentMember=true';
const PAGE_SIZE = 20;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function normaliseName(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s-]+/g, ' ').trim();
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchAllMPs() {
  const members = [];
  let skip = 0;

  while (true) {
    const url = `${PARLIAMENT_API}&skip=${skip}&take=${PAGE_SIZE}`;
    const json = await fetchJSON(url);
    const items = json.items || [];
    if (items.length === 0) break;

    for (const item of items) {
      const v = item.value;
      if (!v) continue;
      const constName = (v.latestHouseMembership && v.latestHouseMembership.membershipFrom) || '';
      if (!constName) continue;

      members.push({
        mp_name: v.nameDisplayAs || 'Unknown MP',
        party: (v.latestParty && v.latestParty.name) || '',
        party_abbr: (v.latestParty && v.latestParty.abbreviation) || '',
        mp_id: v.id,
        thumbnail: v.thumbnailUrl || `https://members-api.parliament.uk/api/Members/${v.id}/Thumbnail`,
        constituency_name: constName,
        stance: 'unknown',
        mp_email: '',
      });
    }

    skip += PAGE_SIZE;
    process.stdout.write(`\r  Fetched ${members.length} MPs...`);

    if (items.length === PAGE_SIZE) await delay(60);
  }

  process.stdout.write(`\r  Fetched ${members.length} MPs — done.\n`);
  return members;
}

async function fetchStances() {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}?key=${GOOGLE_SHEETS_API_KEY}`;
  const json = await fetchJSON(url);
  const rows = (json.values || []).slice(1); // skip header

  const overrides = {};
  for (const row of rows) {
    const constName = (row[0] || '').trim();
    const supportRaw = (row[2] || '').trim().toUpperCase();
    const email = (row[3] || '').trim();
    if (!constName) continue;

    let stance = 'unknown';
    if (supportRaw === 'Y') stance = 'supports';
    else if (supportRaw === 'N') stance = 'opposes';

    overrides[constName] = { stance, mp_email: email };
  }

  return overrides;
}

async function main() {
  console.log('Building mp-data.json...\n');

  // Step 1: Fetch all MPs
  console.log('1. Fetching MPs from Parliament API...');
  const members = await fetchAllMPs();

  // Step 2: Fetch stances from Google Sheet
  console.log('2. Fetching stances from Google Sheet...');
  const overrides = await fetchStances();
  console.log(`  ${Object.keys(overrides).length} stance rows loaded.`);

  // Step 3: Merge — normalised matching for diacritics/case
  console.log('3. Merging data...');
  const built = {};
  for (const m of members) built[m.constituency_name] = m;

  const builtNorm = {};
  for (const key of Object.keys(built)) builtNorm[normaliseName(key)] = built[key];

  let matched = 0;
  for (const [constName, override] of Object.entries(overrides)) {
    const target = built[constName] || builtNorm[normaliseName(constName)];
    if (target) {
      target.stance = override.stance;
      if (override.mp_email) target.mp_email = override.mp_email;
      matched++;
    }
  }
  console.log(`  ${matched} / ${Object.keys(overrides).length} stances matched.`);

  // Step 4: Write JSON
  const output = {
    generated: new Date().toISOString(),
    count: Object.keys(built).length,
    members: built,
  };

  const outPath = path.join(__dirname, '..', 'mp-data.json');
  fs.writeFileSync(outPath, JSON.stringify(output));
  const sizeKB = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`\n  Written ${outPath} (${sizeKB} KB, ${output.count} MPs)`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
