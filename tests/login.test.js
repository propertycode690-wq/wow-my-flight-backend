const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'login-regression-test-secret';
let account;
let databaseUnavailable = false;
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { prisma: { user: {
    findFirst: async ({ where }) => {
      if (databaseUnavailable) throw new Error('Database unavailable');
      return account.status === where.status && account.email.toLowerCase() === where.email.equals.toLowerCase() ? account : null;
    },
    findUnique: async ({ where, select }) => where.id === account.id
      ? Object.fromEntries(Object.keys(select).map(key => [key, account[key]])) : null,
  } } },
};
const { requireAuth } = require('../middleware/auth');
const users = require('../routes/users');
let server;
let base;

before(async () => {
  account = { id: 'test-user', name: 'Test User', email: 'test@example.test', role: 'super_admin', status: 'active', passwordHash: await bcrypt.hash('123456', 4) };
  const app = express();
  app.use(express.json());
  app.use('/api/users', (req, res, next) => req.path === '/login' ? next() : requireAuth(req, res, next), users);
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));

async function login(password, email = account.email, headers = {}) {
  const response = await fetch(base + '/api/users/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: await response.json() };
}

test('bcrypt login accepts the real password and returns a usable JWT session', async () => {
  const result = await login('123456', ' TEST@EXAMPLE.TEST ');
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.user.passwordHash, undefined);
  assert.equal(jwt.verify(result.body.token, process.env.JWT_SECRET).id, account.id);
  const response = await fetch(base + '/api/users/me', { headers: { Authorization: `Bearer ${result.body.token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.id, account.id);
});

test('wrong passwords, the old master password, and stored hashes cannot log in', async () => {
  for (const password of ['wrong-password', 'password123', account.passwordHash]) {
    const result = await login(password);
    assert.equal(result.status, 401);
    assert.equal(result.body.token, undefined);
  }
});

test('inactive and unknown accounts cannot log in', async () => {
  assert.equal((await login('123456', 'unknown@example.test')).status, 401);
  account.status = 'inactive';
  try {
    assert.equal((await login('123456')).status, 401);
  } finally {
    account.status = 'active';
  }
});

test('missing credentials are rejected and database failure is not an invalid-password error', async () => {
  assert.equal((await login('')).status, 400);
  databaseUnavailable = true;
  try {
    const result = await login('123456');
    assert.equal(result.status, 503);
    assert.equal(result.body.token, undefined);
  } finally {
    databaseUnavailable = false;
  }
});

test('Railway clients have separate login limits behind the same proxy', async () => {
  const previousEnvironment = process.env.RAILWAY_ENVIRONMENT_ID;
  process.env.RAILWAY_ENVIRONMENT_ID = 'test-environment';
  try {
    const headers = { 'x-real-ip': '192.0.2.10', 'x-forwarded-for': '198.51.100.1' };
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.equal((await login('wrong-password', account.email, headers)).status, 401);
    }
    const limited = await login('wrong-password', account.email, headers);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.success, false);
    assert.match(limited.body.error, /Too many login attempts/);
    assert.equal((await login('wrong-password', account.email, { ...headers, 'x-real-ip': '192.0.2.11' })).status, 401);
  } finally {
    if (previousEnvironment === undefined) delete process.env.RAILWAY_ENVIRONMENT_ID;
    else process.env.RAILWAY_ENVIRONMENT_ID = previousEnvironment;
  }
});

test('client IP headers are ignored outside Railway and invalid values fall back safely', () => {
  const { loginClientKey } = require('../middleware/loginRateLimit');
  const previousEnvironment = process.env.RAILWAY_ENVIRONMENT_ID;
  try {
    delete process.env.RAILWAY_ENVIRONMENT_ID;
    assert.equal(loginClientKey({ ip: '127.0.0.1', get: () => '192.0.2.10' }), '127.0.0.1');
    process.env.RAILWAY_ENVIRONMENT_ID = 'test-environment';
    assert.equal(loginClientKey({ ip: '127.0.0.1', get: () => 'not-an-ip' }), '127.0.0.1');
    assert.equal(loginClientKey({ ip: '127.0.0.1', get: () => '2001:db8::1' }), loginClientKey({ ip: '127.0.0.1', get: () => '2001:db8::2' }));
  } finally {
    if (previousEnvironment === undefined) delete process.env.RAILWAY_ENVIRONMENT_ID;
    else process.env.RAILWAY_ENVIRONMENT_ID = previousEnvironment;
  }
});
