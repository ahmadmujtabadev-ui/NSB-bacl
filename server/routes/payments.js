import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { Character } from '../models/Character.js';
import { KnowledgeBase } from '../models/KnowledgeBase.js';
import { Project } from '../models/Project.js';
import { CreditTransaction } from '../models/CreditTransaction.js';
import { addCredits } from '../middleware/credits.js';
import { ValidationError } from '../errors.js';

const router = Router();

function getStripe() {
  if (!config.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(config.stripe.secretKey);
}

// One-time credit top-up packages
const CREDIT_PACKAGES = [
  { id: 'credits_50',  name: '50 Credits',  credits: 50,  price: 4.99,  currency: 'usd' },
  { id: 'credits_150', name: '150 Credits', credits: 150, price: 12.99, currency: 'usd', popular: true },
  { id: 'credits_400', name: '400 Credits', credits: 400, price: 29.99, currency: 'usd' },
];

// Subscription plan definitions (mirrors frontend PLAN_FEATURES)
// -1 means unlimited
export const PLAN_LIMITS = {
  free:    { credits: 50,   booksPerMonth: 1,  characters: 3,   knowledgeBases: 1,  kdpExport: false, commercial: false, teamCollab: false, bulkExport: false, apiAccess: false },
  creator: { credits: 100,  booksPerMonth: 50,  characters: 50,  knowledgeBases: 10,  kdpExport: false, commercial: false, teamCollab: false, bulkExport: false, apiAccess: false },
  author:  { credits: 300,  booksPerMonth: -1, characters: -1,  knowledgeBases: -1, kdpExport: true,  commercial: true,  teamCollab: false, bulkExport: false, apiAccess: false },
  studio:  { credits: 1000, booksPerMonth: -1, characters: -1,  knowledgeBases: -1, kdpExport: true,  commercial: true,  teamCollab: true,  bulkExport: true,  apiAccess: true  },
};

// GET /api/payments/packages
router.get('/packages', (req, res) => res.json({ packages: CREDIT_PACKAGES }));

// GET /api/payments/balance
router.get('/balance', (req, res) => res.json({ credits: req.user.credits, plan: req.user.plan }));

// GET /api/payments/plan-limits — returns plan limits + current usage counts
router.get('/plan-limits', async (req, res, next) => {
  try {
    const user = req.user;
    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;

    // Get current month's book count for booksPerMonth limit
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [characterCount, kbCount, bookThisMonthCount] = await Promise.all([
      Character.countDocuments({ userId: user._id }),
      KnowledgeBase.countDocuments({ userId: user._id }),
      Project.countDocuments({ userId: user._id, createdAt: { $gte: monthStart } }),
    ]);

    res.json({
      plan: user.plan,
      subscriptionStatus: user.subscriptionStatus,
      limits,
      usage: {
        characters: characterCount,
        knowledgeBases: kbCount,
        booksThisMonth: bookThisMonthCount,
      },
    });
  } catch (e) { next(e); }
});

// GET /api/payments/transactions
router.get('/transactions', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const txns = await CreditTransaction.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(limit);
    res.json({ transactions: txns });
  } catch (e) { next(e); }
});

// GET /api/payments/subscription — current subscription details
router.get('/subscription', async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.stripeSubscriptionId) {
      return res.json({ subscription: null });
    }
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
    res.json({
      subscription: {
        id: sub.id,
        status: sub.status,
        plan: user.plan,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
      },
    });
  } catch (e) { next(e); }
});

// POST /api/payments/create-checkout — one-time credit purchase
router.post('/create-checkout', async (req, res, next) => {
  try {
    const { packageId, successUrl, cancelUrl } = req.body;
    if (!packageId) throw new ValidationError('packageId is required');

    const pkg = CREDIT_PACKAGES.find(p => p.id === packageId);
    if (!pkg) throw new ValidationError('Invalid package ID');

    const stripe = getStripe();
    const customerId = await ensureStripeCustomer(stripe, req.user);

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `NoorStudio ${pkg.credits} Credits`, description: `${pkg.credits} AI generation credits` },
          unit_amount: Math.round(pkg.price * 100),
        },
        quantity: 1,
      }],
      metadata: { userId: req.user._id.toString(), packageId, credits: pkg.credits.toString() },
      success_url: successUrl || `${process.env.CLIENT_ORIGIN}/app/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancelUrl  || `${process.env.CLIENT_ORIGIN}/app/billing/cancel`,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (e) { next(e); }
});

// POST /api/payments/create-subscription — recurring plan
router.post('/create-subscription', async (req, res, next) => {
  try {
    const { planId, successUrl, cancelUrl } = req.body;
    if (!planId) throw new ValidationError('planId is required');

    const priceId = config.stripe.priceIds[planId];
    if (!priceId) throw new ValidationError(`No Stripe price configured for plan: ${planId}`);

    const stripe = getStripe();
    const customerId = await ensureStripeCustomer(stripe, req.user);

    // Cancel existing subscription if switching plans
    if (req.user.stripeSubscriptionId) {
      await stripe.subscriptions.update(req.user.stripeSubscriptionId, { cancel_at_period_end: false });
      await stripe.subscriptions.cancel(req.user.stripeSubscriptionId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { userId: req.user._id.toString(), planId },
        trial_period_days: req.user.plan === 'free' ? 7 : undefined,
      },
      metadata: { userId: req.user._id.toString(), planId },
      success_url: successUrl || `${process.env.CLIENT_ORIGIN}/app/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancelUrl  || `${process.env.CLIENT_ORIGIN}/app/billing/cancel`,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (e) { next(e); }
});

// POST /api/payments/cancel-subscription
router.post('/cancel-subscription', async (req, res, next) => {
  try {
    if (!req.user.stripeSubscriptionId) throw new ValidationError('No active subscription');
    const stripe = getStripe();
    await stripe.subscriptions.update(req.user.stripeSubscriptionId, { cancel_at_period_end: true });
    res.json({ message: 'Subscription will cancel at period end' });
  } catch (e) { next(e); }
});

// POST /api/payments/portal-session — Stripe Customer Portal
router.post('/portal-session', async (req, res, next) => {
  try {
    if (!req.user.stripeCustomerId) throw new ValidationError('No billing account found');
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url: `${process.env.CLIENT_ORIGIN}/app/billing`,
    });
    res.json({ url: session.url });
  } catch (e) { next(e); }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureStripeCustomer(stripe, user) {
  if (user.stripeCustomerId) {
    // Verify the customer still exists in this Stripe account/mode
    try {
      await stripe.customers.retrieve(user.stripeCustomerId);
      return user.stripeCustomerId;
    } catch (err) {
      // Customer not found (wrong mode, deleted, etc.) — create a fresh one
      console.warn(`[Stripe] Stale customerId ${user.stripeCustomerId}, creating new customer`);
      await User.findByIdAndUpdate(user._id, { stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: 'inactive', plan: 'free' });
    }
  }
  const customer = await stripe.customers.create({ email: user.email, name: user.name });
  await User.findByIdAndUpdate(user._id, { stripeCustomerId: customer.id });
  return customer.id;
}

export default router;
