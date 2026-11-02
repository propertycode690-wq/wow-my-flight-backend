/**
 * init-db.js
 * Runs before server startup on Railway/Production to ensure PostgreSQL tables
 * are created and synchronized safely without blocking server boot on network delay.
 */

const { execSync } = require('child_process');

console.log('🚀 [Startup] Initializing WowMyFlight backend...');

if (process.env.DATABASE_URL) {
  try {
    console.log('🔄 [PostgreSQL] Detected DATABASE_URL. Synchronizing database tables with Prisma...');
    execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });
    console.log('✅ [PostgreSQL] Database tables synchronized successfully!');
  } catch (err) {
    console.warn('⚠️ [PostgreSQL] Could not push schema (server will still boot in resilient mode):', err.message);
  }
} else {
  console.log('ℹ️ [PostgreSQL] DATABASE_URL not set in this environment. Running with in-memory store.');
}
