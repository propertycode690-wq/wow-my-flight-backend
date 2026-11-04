const http = require('http');

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING AUTH VERIFICATION TESTS ---');

  // Test 1: Hit protected endpoint without token
  try {
    const res1 = await request({
      hostname: 'localhost',
      port: 3001,
      path: '/api/leads',
      method: 'GET'
    });
    console.log('1. GET /api/leads without token: Status =', res1.status, '(Expected: 401)');
    console.log('   Response Code:', res1.body?.code, res1.body?.error);
  } catch (err) {
    console.error('Test 1 failed to connect:', err.message);
  }

  // Test 2: Hit protected endpoint with invalid token
  try {
    const res2 = await request({
      hostname: 'localhost',
      port: 3001,
      path: '/api/leads',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer invalid_garbage_token_12345'
      }
    });
    console.log('2. GET /api/leads with bad token: Status =', res2.status, '(Expected: 401)');
    console.log('   Response Code:', res2.body?.code, res2.body?.error);
  } catch (err) {
    console.error('Test 2 failed to connect:', err.message);
  }

  // Test 3: Login to obtain real JWT
  let token = null;
  try {
    const res3 = await request({
      hostname: 'localhost',
      port: 3001,
      path: '/api/users/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, {
      email: 'parminder@wowmyflight.com',
      password: 'password123'
    });
    console.log('3. POST /api/users/login: Status =', res3.status, '(Expected: 200)');
    if (res3.body?.token) {
      token = res3.body.token;
      console.log('   JWT received (prefix):', token.slice(0, 25) + '...');
    } else {
      console.log('   Login body:', res3.body);
    }
  } catch (err) {
    console.error('Test 3 failed:', err.message);
  }

  // Test 4: Hit protected endpoint with valid JWT
  if (token) {
    try {
      const res4 = await request({
        hostname: 'localhost',
        port: 3001,
        path: '/api/leads',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      console.log('4. GET /api/leads with valid JWT: Status =', res4.status, '(Expected: 200)');
      console.log('   Success:', res4.body?.success !== false);
    } catch (err) {
      console.error('Test 4 failed:', err.message);
    }
  }

  console.log('--- COMPLETED ---');
}

runTests();
