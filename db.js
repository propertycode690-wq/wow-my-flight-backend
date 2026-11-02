/**
 * db.js
 * Centralized Prisma Database Client with auto-reconnection and active health check
 */

const { PrismaClient } = require('@prisma/client');

let prisma = null;
let isConnected = false;

if (process.env.DATABASE_URL) {
  try {
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });

    const verifyConnection = async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
        isConnected = true;
        console.log('✅ [PostgreSQL] Connected successfully to database via Prisma');
      } catch (err) {
        isConnected = false;
        console.warn('⚠️ [PostgreSQL] Database connection attempt failed:', err.message);
      }
    };

    verifyConnection();

    // Keep database connection warm every 60 seconds
    setInterval(verifyConnection, 60000);
  } catch (e) {
    console.warn('⚠️ [PostgreSQL] Could not initialize Prisma client:', e.message);
  }
} else {
  console.log('ℹ️ [PostgreSQL] DATABASE_URL not set. Running in resilient memory mode.');
}

module.exports = {
  prisma,
  isDbConnected: () => isConnected,
  checkConnection: async () => {
    if (!prisma) return false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      isConnected = true;
      return true;
    } catch {
      isConnected = false;
      return false;
    }
  }
};
