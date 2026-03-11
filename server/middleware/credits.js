import { STAGE_CREDIT_COSTS } from '../services/ai/ai.billing.js';
import { InsufficientCreditsError } from '../errors.js';
import { User } from '../models/User.js';
import { CreditTransaction } from '../models/CreditTransaction.js';

/**
 * Middleware factory: checks the user has enough credits for a given stage.
 * Attaches req.creditCost to the request.
 *
 * Usage:
 *   router.post('/text', requireCredits('outline'), handler)
 *   router.post('/image', requireCredits('illustrations'), handler)
 */
export function requireCredits(stage) {
  return async (req, res, next) => {
    try {
      const cost = STAGE_CREDIT_COSTS[stage] ?? 1;
      const user = req.user;

      if (user.credits < cost) {
        throw new InsufficientCreditsError(cost, user.credits);
      }

      req.creditCost = cost;
      req.creditStage = stage;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Deduct credits from a user and record a transaction.
 * Call this AFTER the AI call succeeds.
 */
export async function deductCredits(userId, cost, description, refType = 'project', refId = null) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { credits: -cost } },
    { new: true }
  );

  await CreditTransaction.create({
    userId,
    amount: -cost,
    type: 'debit',
    description,
    refType,
    refId,
  });

  return user;
}

/**
 * Add credits to a user (purchase / bonus).
 */
export async function addCredits(userId, amount, description, refType = 'purchase', refId = null) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { credits: amount } },
    { new: true }
  );

  await CreditTransaction.create({
    userId,
    amount,
    type: 'credit',
    description,
    refType,
    refId,
  });

  return user;
}
