import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { addCredits } from '../middleware/credits.js';

const router = Router();

// Monthly credits granted on renewal per plan
const PLAN_MONTHLY_CREDITS = {
  creator: 100,
  author:  300,
  studio:  1000,
};

// POST /api/webhooks/stripe
// Note: body is raw Buffer — mounted before express.json() in index.js
router.post('/stripe', async (req, res) => {
  if (!config.stripe.secretKey || !config.stripe.webhookSecret) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const stripe = new Stripe(config.stripe.secretKey);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  console.log(`[Webhook] Event: ${event.type}`);

  try {
    switch (event.type) {

      // ── One-time payment OR subscription start ──────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;

        // One-time credit purchase
        if (session.mode === 'payment' && session.payment_status === 'paid') {
          const { userId, credits } = session.metadata || {};
          if (userId && credits) {
            const amount = parseInt(credits, 10);
            await addCredits(userId, amount, `Credit purchase: ${amount} credits`, 'purchase', session.id);
            console.log(`[Webhook] Added ${amount} credits to user ${userId}`);
          }
        }

        // New subscription activated
        if (session.mode === 'subscription' && session.subscription) {
          const { userId, planId } = session.metadata || {};
          if (userId) {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            const monthlyCredits = PLAN_MONTHLY_CREDITS[planId] || 100;
            await User.findByIdAndUpdate(userId, {
              stripeSubscriptionId: session.subscription,
              subscriptionStatus: sub.status,
              plan: planId || 'creator',
              subscriptionCurrentPeriodEnd: new Date(sub.current_period_end * 1000),
            });
            // Grant first-month credits immediately
            await addCredits(userId, monthlyCredits, `${planId} plan activated: ${monthlyCredits} credits`, 'purchase', session.id);
            console.log(`[Webhook] Subscription activated: plan=${planId}, credits=${monthlyCredits}, user=${userId}`);
          }
        }
        break;
      }

      // ── Subscription renewed ────────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription && invoice.billing_reason === 'subscription_cycle') {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId = sub.metadata?.userId;
          if (userId) {
            const plan = sub.metadata?.planId || 'creator';
            const monthlyCredits = PLAN_MONTHLY_CREDITS[plan] || 100;
            await addCredits(userId, monthlyCredits, `Monthly credits: ${plan} plan`, 'purchase', invoice.id);
            await User.findByIdAndUpdate(userId, {
              subscriptionStatus: 'active',
              subscriptionCurrentPeriodEnd: new Date(sub.current_period_end * 1000),
            });
            console.log(`[Webhook] Renewal: added ${monthlyCredits} credits to ${userId} (${plan})`);
          }
        }
        break;
      }

      // ── Payment failed ──────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const user = await User.findOne({ stripeSubscriptionId: sub.id });
          if (user) {
            user.subscriptionStatus = 'past_due';
            await user.save();
            console.log(`[Webhook] Payment failed for user ${user._id}`);
          }
        }
        break;
      }

      // ── Subscription status changes ─────────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await User.findOne({ stripeSubscriptionId: sub.id });
        if (user) {
          user.subscriptionStatus = sub.cancel_at_period_end ? 'canceled' : sub.status;
          user.subscriptionCurrentPeriodEnd = new Date(sub.current_period_end * 1000);
          await user.save();
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = await User.findOne({ stripeSubscriptionId: sub.id });
        if (user) {
          user.subscriptionStatus = 'inactive';
          user.plan = 'free';
          user.stripeSubscriptionId = undefined;
          user.subscriptionCurrentPeriodEnd = undefined;
          await user.save();
          console.log(`[Webhook] Subscription deleted for user ${user._id}, reverted to free`);
        }
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] Handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;
