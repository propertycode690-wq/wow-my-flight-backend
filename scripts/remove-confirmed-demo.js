require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();
async function main() {
  // These identifiers and filenames come from the original seed script.
  // Unidentified records are preserved until the owner classifies them.
  const filters = {
    client: { OR: [{ id: 'CL-102', email: 'amina.m@example.ae' }, { id: 'CL-103', email: 'liam.oc@example.ie' }] },
    consultation: { OR: [{ clientName: 'Marcus Vance', clientEmail: 'marcus.vance@example.com' }, { clientName: 'Dr. Rahul Mehta', clientEmail: 'rahul.m@example.in' }] },
    document: { fileUrl: { in: ['https://storage.wowmyflight.com/docs/us_pass_mv.pdf', 'https://storage.wowmyflight.com/docs/schengen_amina.pdf', 'https://storage.wowmyflight.com/docs/irish_pass_liam.pdf'] } },
    user: { id: { in: ['usr-super-admin', 'usr-admin', 'usr-consultant'] }, email: { in: ['wael.madi@wowmyflight.com', 'admin@wowmyflight.com', 'sales@wowmyflight.com'] } }
  };
  const archive = {};
  for (const [model, where] of Object.entries(filters)) archive[model] = await prisma[model].findMany({ where });
  const directory = path.resolve(__dirname, '../../db-backups.local');
  fs.writeFileSync(path.join(directory, `removed-demo-${Date.now()}.json`), JSON.stringify(archive, null, 2), { mode: 0o600 });
  await prisma.$transaction(async tx => {
    for (const user of archive.user) {
      const replacement = user.role === 'super_admin' ? 'usr-parminder' : user.role === 'admin' ? 'usr-xavier' : 'usr-issac';
      await tx.lead.updateMany({ where: { assignedAgentId: user.id }, data: { assignedAgentId: replacement } });
      for (const model of ['callLog', 'callDisposition', 'chatSession']) await tx[model].updateMany({ where: { agentId: user.id }, data: { agentId: replacement } });
    }
    for (const [model, where] of Object.entries(filters)) await tx[model].deleteMany({ where });
  }, { timeout: 60000 });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(archive).map(([m, rows]) => [m, rows.length]))));
}
main().catch(e => { console.error(e.code || e.name); process.exitCode = 1; }).finally(() => prisma.$disconnect());
