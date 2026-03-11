import { Router } from 'express';
import Stripe from 'stripe';
import { config } from '../config.js';
import { User } from '../models/User.js';
import { addCredits } from '../middleware/credits.js';

const router = Router();

const PLAN_MONTHLY_CREDITS = { starter: 100, pro: 300 };

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
      // ── One-time payment completed ──────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'payment' && session.payment_status === 'paid') {
          const { userId, credits } = session.metadata || {};
          if (userId && credits) {
            const amount = parseInt(credits, 10);
            await addCredits(userId, amount, `Credit purchase: ${amount} credits`, 'purchase', session.id);
            console.log(`[Webhook] Added ${amount} credits to user ${userId}`);
          }
        }
        if (session.mode === 'subscription' && session.subscription) {
          const { userId, planId } = session.metadata || {};
          if (userId) {
            await User.findByIdAndUpdate(userId, {
              stripeSubscriptionId: session.subscription,
              subscriptionStatus: 'active',
              plan: planId || 'starter',
            });
          }
        }
        break;
      }

      // ── Subscription renewed ────────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription && invoice.billing_reason === 'subscription_cycle') {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId = subscription.metadata?.userId;
          if (userId) {
            const plan = subscription.metadata?.planId || 'starter';
            const monthlyCredits = PLAN_MONTHLY_CREDITS[plan] || 100;
            await addCredits(userId, monthlyCredits, `Monthly credits: ${plan} plan`, 'purchase', invoice.id);
            console.log(`[Webhook] Renewal: added ${monthlyCredits} credits to ${userId}`);
          }
        }
        break;
      }

      // ── Subscription status changes ─────────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const user = await User.findOne({ stripeCustomerId: customer.id });
        if (user) {
          user.subscriptionStatus = sub.status;
          if (sub.cancel_at_period_end) user.subscriptionStatus = 'canceled';
          await user.save();
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const user = await User.findOne({ stripeCustomerId: customer.id });
        if (user) {
          user.subscriptionStatus = 'inactive';
          user.plan = 'free';
          user.stripeSubscriptionId = undefined;
          await user.save();
        }
        break;
      }

      default:
        // Ignore unhandled events
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] Handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;
