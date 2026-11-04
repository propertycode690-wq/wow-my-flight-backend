const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware: requireAuth
 * Validates the JWT Bearer token from the Authorization header.
 * Attaches decoded user payload { id, role } to req.user.
 */
async function requireAuth(req, res, next) {

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication token is required',
      code: 'TOKEN_REQUIRED'
    });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Token missing',
      code: 'TOKEN_REQUIRED'
    });
  }

  if (!JWT_SECRET) {
    console.error('❌ [Auth Middleware] Critical error: JWT_SECRET is not configured in environment!');
    return res.status(500).json({
      success: false,
      error: 'Server configuration error'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { prisma } = require('../db');
    let user;
    try { user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { id: true, role: true, status: true } }); }
    catch { return res.status(503).json({ success: false, error: 'Account verification unavailable' }); }
    if (!user || user.status !== 'active') return res.status(401).json({ success: false, error: 'Account unavailable', code: 'ACCOUNT_INACTIVE' });
    req.user = { id: user.id, role: user.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Token has expired. Please log in again.',
        code: 'TOKEN_EXPIRED'
      });
    }
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or corrupted authentication token',
      code: 'TOKEN_INVALID'
    });
  }
}

module.exports = {
  requireAuth
};
