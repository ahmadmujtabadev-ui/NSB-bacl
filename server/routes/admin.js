import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { Project } from '../models/Project.js';
import { AIUsage } from '../services/ai/ai.telemetry.js';
import { addCredits, deductCredits } from '../middleware/credits.js';
import { ValidationError, NotFoundError } from '../errors.js';

const router = Router();
router.use(requireAdmin);

// GET /api/admin/stats
router.get('/stats', async (req, res, next) => {
  try {
    const [totalUsers, totalProjects, recentAI] = await Promise.all([
      User.countDocuments(),
      Project.countDocuments(),
      AIUsage.aggregate([
        { $group: {
          _id: null,
          totalRequests: { $sum: 1 },
          totalInputTokens:  { $sum: '$tokensIn'  },
          totalOutputTokens: { $sum: '$tokensOut' },
          successRate: { $avg: { $cond: ['$success', 1, 0] } },
        }},
      ]),
    ]);
    res.json({ totalUsers, totalProjects, aiUsage: recentAI[0] || {} });
  } catch (e) { next(e); }
});

// GET /api/admin/users
router.get('/users', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const users = await User.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    const total = await User.countDocuments();
    res.json({ users, total, page, totalPages: Math.ceil(total / limit) });
  } catch (e) { next(e); }
});

// POST /api/admin/users/:id/credits
router.post('/users/:id/credits', async (req, res, next) => {
  try {
    const { amount, description } = req.body;
    if (!amount || !description) throw new ValidationError('amount and description are required');

    const user = await User.findById(req.params.id);
    if (!user) throw new NotFoundError('User not found');

    const fn = amount > 0 ? addCredits : deductCredits;
    const updated = await fn(user._id, Math.abs(amount), description, 'admin');
    res.json({ user: updated });
  } catch (e) { next(e); }
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', async (req, res, next) => {
  try {
    const { plan, role, credits } = req.body;
    const update = {};
    if (plan  !== undefined) update.plan  = plan;
    if (role  !== undefined) update.role  = role;
    if (credits !== undefined) update.credits = credits;
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!user) throw new NotFoundError('User not found');
    res.json({ user });
  } catch (e) { next(e); }
});

// GET /api/admin/ai-usage
router.get('/ai-usage', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const since = new Date(Date.now() - days * 86400000);
    const usage = await AIUsage.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 }).limit(500);
    res.json({ usage });
  } catch (e) { next(e); }
});

export default router;
