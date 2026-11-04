// Explicit provisioning only: never create accounts or demo data during a read request.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const team = require('../config/team.json');
const prisma = new PrismaClient();

async function main() {
  const accounts = [];
  const operations = [];
  for (const member of team) {
    const existing = await prisma.user.findUnique({ where: { email: member.email } });
    const { id, ...profile } = member;
    const data = { ...profile, avatar: null };
    if (!existing?.passwordHash) {
      const password = crypto.randomBytes(18).toString('base64url');
      data.passwordHash = await bcrypt.hash(password, 12);
      accounts.push({ name: member.name, email: member.email, role: member.role, phone: member.phone, password });
    }
    operations.push(prisma.user.upsert({ where: { email: member.email }, update: data, create: { id, ...data } }));
  }
  // Save generated credentials before the transaction, so a terminal interruption cannot lose them.
  if (accounts.length) {
    const directory = path.resolve(__dirname, '../../db-backups.local');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `team-logins-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(accounts, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(`Private login handover file: ${file}`);
  }
  await prisma.$transaction(operations);
  console.log(`Provisioned ${team.length} client accounts; existing passwords retained.`);
}
main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; }).finally(() => prisma.$disconnect());
