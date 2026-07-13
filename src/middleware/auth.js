const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Decodes a bearer token into req.user if present, but never rejects — for routes usable by both signed-in and guest requests. */
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // invalid/expired token on an optional-auth route — proceed as a guest rather than rejecting
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

function requireRider(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Rider authentication required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'rider') return res.status(403).json({ error: 'Rider access required' });
    req.rider = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Blocks everything but password setup until a first-time (PIN-login) rider sets a password. */
function requireRiderPasswordSet(req, res, next) {
  if (req.rider?.mustSetPassword) {
    return res.status(403).json({ error: 'Set a password before continuing', code: 'PASSWORD_SETUP_REQUIRED' });
  }
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin, requireRider, requireRiderPasswordSet };
