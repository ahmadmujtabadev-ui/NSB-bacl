import { Router } from 'express';
import { User } from '../models/User.js';
import { signToken, authenticate } from '../middleware/auth.js';
import { ValidationError, AuthError } from '../errors.js';
import { config } from '../config.js';
import { addCredits } from '../middleware/credits.js';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name?.trim() || !email?.trim() || !password) throw new ValidationError('name, email, and password are required');
    if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw new ValidationError('An account with this email already exists');

    const passwordHash = await User.hashPassword(password);
    const rawUser = await User.create({ name: name.trim(), email, passwordHash, credits: 0 });

    // addCredits updates MongoDB — use the returned doc so the response shows correct credits
    const user = await addCredits(rawUser._id, config.credits.newUserBonus, 'New user welcome bonus', 'bonus');

    const token = signToken(rawUser._id);
    res.status(201).json({ token, user });
  } catch (e) { next(e); }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new ValidationError('email and password are required');

    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    if (!user || !(await user.comparePassword(password))) throw new AuthError('Invalid email or password');

    user.lastLoginAt = new Date();
    await user.save();

    const token = signToken(user._id);
    res.json({ token, user });
  } catch (e) { next(e); }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw new ValidationError('currentPassword and newPassword are required');
    if (newPassword.length < 8) throw new ValidationError('New password must be at least 8 characters');

    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!(await user.comparePassword(currentPassword))) throw new AuthError('Current password is incorrect');

    user.passwordHash = await User.hashPassword(newPassword);
    await user.save();
    res.json({ message: 'Password changed' });
  } catch (e) { next(e); }
});

export default router;
