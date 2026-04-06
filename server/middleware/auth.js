import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { config } from '../config.js';
import { AuthError } from '../errors.js';

/**
 * Verifies JWT, loads user from MongoDB, attaches to req.user.
 */
export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AuthError();

    const token = header.slice(7);
    const payload = jwt.verify(token, config.jwt.secret);

    const user = await User.findById(payload.sub).select('+passwordHash');
    if (!user) throw new AuthError('User not found');

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return next(new AuthError('Invalid or expired token'));
    }
    next(err);
  }
}

/**
 * Like authenticate but does NOT block unauthenticated requests.
 * Sets req.user if a valid token is present, otherwise continues as guest.
 */
export async function optionalAuthenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next();

    const token = header.slice(7);
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await User.findById(payload.sub).select('+passwordHash');
    if (user) req.user = user;
    next();
  } catch {
    next(); // invalid token → continue as guest
  }
}

/**
 * Require admin role.
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return next(new AuthError('Admin access required'));
  }
  next();
}

/**
 * Generate a signed JWT for a user.
 */
export function signToken(userId) {
  return jwt.sign({ sub: userId.toString() }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}
