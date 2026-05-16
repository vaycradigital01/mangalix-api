// ══════════════════════════════════════════════════════════
// webhook-infinitepay.js
// ══════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { sendPush } = require('../services/push');

router.post('/', express.json(), async (req, res) => {
  const { order_nsu, paid, capture_method } = req.body;
  if (!paid || capture_method !== 'pix') return res.json({ ok: true });

  try {
    const { data: pending } = await supabaseAdmin
      .from('pix_payments')
      .select('user_id, plan, days')
      .eq('order_nsu', order_nsu)
      .eq('status', 'pending')
      .single();

    if (!pending) return res.json({ ok: true });

    // Ativar plano
    const expires = new Date();
    expires.setDate(expires.getDate() + pending.days);

    await supabaseAdmin.from('users').update({
      plan: pending.plan,
      plan_expires_at: expires.toISOString(),
      updated_at: new Date()
    }).eq('id', pending.user_id);

    await supabaseAdmin.from('pix_payments').update({
      status: 'paid', paid_at: new Date()
    }).eq('order_nsu', order_nsu);

    await supabaseAdmin.from('payments').insert({
      user_id: pending.user_id, plan: pending.plan,
      status: 'paid', method: 'infinitepay',
    });

    const { data: user } = await supabaseAdmin
      .from('users').select('push_token').eq('id', pending.user_id).single();

    if (user?.push_token) {
      await sendPush(user.push_token, {
        title: '✅ Pagamento confirmado!',
        body:  `Plano ${pending.plan} ativo. Boas leituras!`,
      });
    }

    res.json({ ok: true });
  } catch(e) {
    console.error('InfiniPay webhook error:', e.message);
    res.status(400).json({ error: 'Erro ao processar' });
  }
});

module.exports = router;
