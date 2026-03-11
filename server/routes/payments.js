import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { CreditTransaction } from '../models/CreditTransaction.js';
import { addCredits } from '../middleware/credits.js';
import { ValidationError } from '../errors.js';

const router = Router();

function getStripe() {
  if (!config.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(config.stripe.secretKey);
}

const CREDIT_PACKAGES = [
  { id: 'credits_50',  credits: 50,  priceUsd: 4.99  },
  { id: 'credits_150', credits: 150, priceUsd: 12.99 },
  { id: 'credits_400', credits: 400, priceUsd: 29.99 },
];

// GET /api/payments/packages
router.get('/packages', (req, res) => res.json({ packages: CREDIT_PACKAGES }));

// GET /api/payments/balance
router.get('/balance', (req, res) => res.json({ credits: req.user.credits, plan: req.user.plan }));

// GET /api/payments/transactions
router.get('/transactions', async (req, res, next) => {
  try {
    const txns = await CreditTransaction.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(50);
    res.json({ transactions: txns });
  } catch (e) { next(e); }
});

// POST /api/payments/create-checkout
router.post('/create-checkout', async (req, res, next) => {
  try {
    const { packageId, successUrl, cancelUrl } = req.body;
    if (!packageId) throw new ValidationError('packageId is required');

    const pkg = CREDIT_PACKAGES.find(p => p.id === packageId);
    if (!pkg) throw new ValidationError('Invalid package ID');

    const stripe = getStripe();

    let customerId = req.user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email, name: req.user.name });
      customerId = customer.id;
      await User.findByIdAndUpdate(req.user._id, { stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `NoorStudio ${pkg.credits} Credits`, description: `${pkg.credits} AI generation credits` },
          unit_amount: Math.round(pkg.priceUsd * 100),
        },
        quantity: 1,
      }],
      metadata: { userId: req.user._id.toString(), packageId, credits: pkg.credits.toString() },
      success_url: successUrl || `${process.env.CLIENT_ORIGIN}/dashboard?payment=success`,
      cancel_url:  cancelUrl  || `${process.env.CLIENT_ORIGIN}/dashboard?payment=cancelled`,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (e) { next(e); }
});

// POST /api/payments/create-subscription
router.post('/create-subscription', async (req, res, next) => {
  try {
    const { planId, successUrl, cancelUrl } = req.body;
    const priceId = config.stripe.priceIds[planId];
    if (!priceId) throw new ValidationError('Invalid plan ID');

    const stripe = getStripe();

    let customerId = req.user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email, name: req.user.name });
      customerId = customer.id;
      await User.findByIdAndUpdate(req.user._id, { stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId: req.user._id.toString(), planId },
      success_url: successUrl || `${process.env.CLIENT_ORIGIN}/dashboard?subscription=success`,
      cancel_url:  cancelUrl  || `${process.env.CLIENT_ORIGIN}/dashboard?subscription=cancelled`,
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

export default router;
