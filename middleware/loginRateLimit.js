const rateLimit = require('express-rate-limit');
const { isIP } = require('node:net');

function loginClientKey(req) {
  // Railway's public ingress supplies the client IP; the socket peer is its proxy.
  // https://docs.railway.com/networking/public-networking/specs-and-limits
  const railwayIp = process.env.RAILWAY_ENVIRONMENT_ID ? req.get('x-real-ip') : null;
  const ip = railwayIp && isIP(railwayIp) ? railwayIp : req.ip;
  return rateLimit.ipKeyGenerator(ip);
}

const loginRateLimit = rateLimit({
  windowMs: 900000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: loginClientKey,
  message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
});

module.exports = { loginRateLimit, loginClientKey };
