require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const team = require('../config/team.json');
const base = process.env.PUBLIC_BACKEND_URL || 'https://wow-my-flight-backend-production-2ef6.up.railway.app';
const voice = process.env.TELNYX_CONNECTION_ID;
const credential = process.env.TELNYX_CREDENTIAL_CONNECTION_ID;
const messaging = process.env.TELNYX_MESSAGING_PROFILE_ID;
async function api(endpoint, method = 'GET', body) {
  const res = await fetch(`https://api.telnyx.com/v2/${endpoint}`, { method, headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${endpoint}: ${res.status} ${data.errors?.[0]?.detail || ''}`);
  return data.data;
}
async function main() {
  if (!voice || !credential || !messaging) throw new Error('Voice, credential and messaging profile IDs are required');
  const numbers = await api('phone_numbers?page[size]=100');
  const assignments = team.map(user => ({ user, number: numbers.find(n => n.phone_number === user.phone) }));
  if (assignments.some(a => !a.number || a.number.status !== 'active')) throw new Error('A required number is missing or inactive');
  const snapshot = { callControl: await api(`call_control_applications/${voice}`), credential: await api(`credential_connections/${credential}`), messaging: await api(`messaging_profiles/${messaging}`), numbers: [] };
  for (const a of assignments) snapshot.numbers.push({ ...a.number, messaging: await api(`phone_numbers/${a.number.id}/messaging`) });
  const directory = path.resolve(__dirname, '../../db-backups.local');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `telnyx-before-${Date.now()}.json`), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(assignments.map(a => ({ name: a.user.name, number: a.user.phone, type: a.number.phone_number_type }))));
  if (!process.argv.includes('--apply')) { console.log('Audit complete. Use --apply after the new backend is deployed.'); return; }
  // No calls, messages, number purchases or carrier registration submissions are performed here.
  await api(`call_control_applications/${voice}`, 'PATCH', { webhook_event_url: `${base}/api/telnyx/webhooks/voice`, webhook_api_version: '2' });
  await api(`credential_connections/${credential}`, 'PATCH', { sip_uri_calling_preference: 'internal', webhook_event_url: `${base}/api/telnyx/webhooks/voice`, webhook_api_version: '2' });
  await api(`messaging_profiles/${messaging}`, 'PATCH', { webhook_url: `${base}/api/telnyx/webhooks/messaging`, webhook_failover_url: '' });
  for (const { number } of assignments) {
    await api(`phone_numbers/${number.id}`, 'PATCH', { connection_id: voice });
    await api(`phone_numbers/${number.id}/messaging`, 'PATCH', { messaging_profile_id: messaging });
  }
  console.log('Configured voice routing and SMS profiles for the six assigned numbers.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
