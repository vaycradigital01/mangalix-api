// ── webhook-stripe.js ──────────────────────────────────────
const express = require('express');
const router  = express.Router();
const Stripe  = require('stripe');
const { supabaseAdmin } = require('../config/supabase');
const { sendPush } = require('../services/push');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function activatePlan(userId, plan, days) {
  const expires = new Date();
  expires.setDate(expires.getDate() + days);

  await supabaseAdmin.from('users').update({
    plan, plan_expires_at: expires.toISOString(), updated_at: new Date()
  }).eq('id', userId);

  await supabaseAdmin.from('payments').insert({
    user_id: userId, plan, status: 'paid', method: 'stripe',
    activated_at: new Date()
  });

  const { data: user } = await supabaseAdmin
    .from('users').select('push_token, nick').eq('id', userId).single();

  if (user?.push_token) {
    await sendPush(user.push_token, {
      title: '✅ Assinatura ativada!',
      body:  `Plano ${plan} ativo até ${expires.toLocaleDateString('pt-BR')}. Boas leituras!`,
    });
  }
}

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch(e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if (event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      if (sub.status !== 'active') return res.json({ received: true });

      const { data: user } = await supabaseAdmin
        .from('users').select('id').eq('stripe_customer_id', sub.customer).single();
      if (!user) return res.json({ received: true });

      const priceId = sub.items.data[0]?.price?.id;
      const isAnnual = priceId === process.env.STRIPE_PRICE_STARTER_ANNUAL ||
                       priceId === process.env.STRIPE_PRICE_PRO_ANNUAL;
      const isPro = priceId === process.env.STRIPE_PRICE_PRO ||
                    priceId === process.env.STRIPE_PRICE_PRO_ANNUAL;

      await activatePlan(user.id, isPro ? 'pro' : 'starter', isAnnual ? 365 : 30);
      await supabaseAdmin.from('users')
        .update({ stripe_subscription_id: sub.id }).eq('id', user.id);
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const { data: user } = await supabaseAdmin
        .from('users').select('id, push_token').eq('stripe_customer_id', sub.customer).single();
      if (!user) return res.json({ received: true });

      await supabaseAdmin.from('users').update({
        plan: 'free', plan_expires_at: null, stripe_subscription_id: null
      }).eq('id', user.id);

      if (user.push_token) {
        await sendPush(user.push_token, {
          title: '📖 Assinatura cancelada',
          body:  'Você ainda pode ler com o plano gratuito.',
        });
      }
    }
  } catch(e) {
    console.error('Stripe webhook error:', e.message);
    return res.status(500).json({ error: 'Erro interno' });
  }

  res.json({ received: true });
});

module.exports = router;
