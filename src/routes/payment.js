const express = require('express');
const router  = express.Router();
const Stripe  = require('stripe');
const axios   = require('axios');
const { v4: uuid } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  starter:        { stripe: process.env.STRIPE_PRICE_STARTER,        amount: 990,   days: 30  },
  pro:            { stripe: process.env.STRIPE_PRICE_PRO,            amount: 2490,  days: 30  },
  starter_annual: { stripe: process.env.STRIPE_PRICE_STARTER_ANNUAL, amount: 8900,  days: 365 },
  pro_annual:     { stripe: process.env.STRIPE_PRICE_PRO_ANNUAL,     amount: 21900, days: 365 },
};

// GET /subscription/status
router.get('/status', async (req, res) => {
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('plan, plan_expires_at, pages_translated_this_month, coins')
    .eq('id', req.userId).single();

  const pageLimits = { free: 0, starter: 150, pro: 500 };
  const isActive = user?.plan === 'free' ||
    (user?.plan_expires_at && new Date(user.plan_expires_at) > new Date());

  res.json({
    plan:            user?.plan || 'free',
    active:          isActive,
    expiresAt:       user?.plan_expires_at,
    pagesTranslated: user?.pages_translated_this_month || 0,
    pagesLimit:      pageLimits[user?.plan || 'free'],
    coins:           user?.coins || 0,
  });
});

// POST /payment/pix — Gerar QR Code InfiniPay
router.post('/pix', async (req, res) => {
  const { plan } = req.body;
  const planData = PLANS[plan];
  if (!planData) return res.status(400).json({ error: 'Plano inválido.' });

  const orderNsu = uuid();

  try {
    const { data } = await axios.post(
      'https://api.checkout.infinitepay.io/links',
      {
        handle:       process.env.INFINITEPAY_HANDLE,
        redirect_url: `https://mangalix.com.br/obrigado?plan=${plan}`,
        webhook_url:  `${process.env.API_URL}/webhook/infinitepay`,
        order_nsu:    orderNsu,
        customer:     { email: req.userEmail },
        items: [{
          quantity:    1,
          price:       planData.amount,
          description: `Mangalix ${plan}`,
        }],
      },
      { headers: { Authorization: `Bearer ${process.env.INFINITEPAY_API_KEY}` } }
    );

    await supabaseAdmin.from('pix_payments').insert({
      user_id: req.userId, order_nsu: orderNsu,
      plan, days: planData.days, amount: planData.amount, status: 'pending',
    });

    res.json({ checkoutUrl: data.url, orderNsu });
  } catch(e) {
    console.error('InfiniPay error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Erro ao gerar cobrança Pix.' });
  }
});

// POST /payment/card — Criar sessão Stripe
router.post('/card', async (req, res) => {
  const { plan } = req.body;
  const planData = PLANS[plan];
  if (!planData?.stripe) return res.status(400).json({ error: 'Plano inválido.' });

  try {
    // Buscar ou criar customer Stripe
    let { data: user } = await supabaseAdmin
      .from('users').select('stripe_customer_id').eq('id', req.userId).single();

    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.userEmail,
        metadata: { userId: req.userId }
      });
      customerId = customer.id;
      await supabaseAdmin.from('users')
        .update({ stripe_customer_id: customerId }).eq('id', req.userId);
    }

    const session = await stripe.checkout.sessions.create({
      customer:    customerId,
      mode:        'subscription',
      line_items:  [{ price: planData.stripe, quantity: 1 }],
      success_url: `https://mangalix.com.br/obrigado?plan=${plan}`,
      cancel_url:  `https://mangalix.com.br/planos`,
      metadata:    { userId: req.userId, plan },
    });

    res.json({ checkoutUrl: session.url });
  } catch(e) {
    console.error('Stripe error:', e.message);
    res.status(500).json({ error: 'Erro ao criar sessão de pagamento.' });
  }
});

module.exports = router;
