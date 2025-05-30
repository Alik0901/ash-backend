// src/middleware/auth.js
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('⚠️ JWT_SECRET is not set in .env');
}

export function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { tg_id, name, iat, exp }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
