require('dotenv').config();
const { execFileSync } = require('child_process');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Refusing to start without persistent storage.');
  process.exit(1);
}
try {
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate'], { stdio: 'inherit', timeout: 120000 });
  console.log('Database schema is ready.');
} catch {
  console.error('Database initialization failed. Fix the connection or schema before starting the backend.');
  process.exit(1);
}
