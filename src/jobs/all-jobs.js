// ══════════════════════════════════════════════════════════
// jobs/chapterNotifier.js
// ══════════════════════════════════════════════════════════
const axios = require('axios');
const { supabaseAdmin } = require('../config/supabase');
const { sendPush } = require('../services/push');

const MDX = 'https://api.mangadex.org';
const LANG_FLAG = { 'pt-br': '🇧🇷', 'pt': '🇵🇹', 'en': '🇺🇸' };

async function checkNewChapters() {
  const { data: favorites } = await supabaseAdmin
    .from('user_favorites')
    .select('manga_id, mdx_id, title, last_checked, users!inner(id, plan, push_token, plan_expires_at)')
    .in('users.plan', ['starter', 'pro'])
    .gt('users.plan_expires_at', new Date().toISOString());

  if (!favorites?.length) return;

  // Agrupar por manga
  const byManga = new Map();
  for (const fav of favorites) {
    if (!byManga.has(fav.manga_id)) {
      byManga.set(fav.manga_id, { mdxId: fav.mdx_id, title: fav.title, lastChecked: fav.last_checked, users: [] });
    }
    byManga.get(fav.manga_id).users.push(fav.users);
  }

  const entries = Array.from(byManga.entries());

  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    await Promise.all(batch.map(async ([mangaId, data]) => {
      try {
        const since = data.lastChecked || new Date(Date.now() - 30*60*1000).toISOString();
        const params = new URLSearchParams({
          'order[chapter]': 'desc', 'limit': '5',
          'createdAtSince': since.replace(/\.\d{3}Z$/, 'Z'),
        });
        ['pt-br','pt','en'].forEach(l => params.append('translatedLanguage[]', l));

        const { data: res } = await axios.get(`${MDX}/manga/${data.mdxId}/feed?${params}`, { timeout: 8000 });
        const newChaps = res?.data || [];
        if (!newChaps.length) return;

        const newest = newChaps[0];
        const chNum = newest.attributes?.chapter || '?';
        const lang  = newest.attributes?.translatedLanguage;

        await Promise.all(data.users.map(async (user) => {
          if (!user.push_token) return;
          await sendPush(user.push_token, {
            title: `📖 ${data.title}`,
            body:  `${LANG_FLAG[lang]||''} Capítulo ${chNum} disponível!`,
            data:  { type: 'new_chapter', mangaId, chapterId: newest.id },
            channelId: 'new-chapters',
          });
        }));

        await supabaseAdmin.from('user_favorites')
          .update({ last_checked: new Date().toISOString() })
          .eq('manga_id', mangaId);
      } catch(e) {
        console.error(`Notifier error manga ${mangaId}:`, e.message);
      }
    }));
    if (i + 5 < entries.length) await new Promise(r => setTimeout(r, 1200));
  }
}

module.exports = { checkNewChapters };


// ══════════════════════════════════════════════════════════
// jobs/coins.js
// ══════════════════════════════════════════════════════════
const { supabaseAdmin: sb } = require('../config/supabase');
const { sendPush: push } = require('../services/push');

const MAX_DAY = 5, COINS_FOR_PREMIUM = 50;

async function awardCoinsForReading(userId, pagesRead, completedChapter) {
  const today = new Date().toISOString().split('T')[0];
  const { data: earned } = await sb.from('coin_transactions')
    .select('amount').eq('user_id', userId)
    .gte('created_at', `${today}T00:00:00Z`)
    .in('reason', ['page_read','chapter_complete']);

  const todayTotal = (earned||[]).reduce((s,t) => s+t.amount, 0);
  if (todayTotal >= MAX_DAY) return 0;

  let coins = Math.floor(pagesRead/10) + (completedChapter ? 2 : 0);
  coins = Math.min(coins, MAX_DAY - todayTotal);
  if (coins <= 0) return 0;

  await sb.rpc('add_coins', { p_user_id: userId, p_amount: coins });
  await sb.from('coin_transactions').insert({
    user_id: userId, amount: coins,
    reason: completedChapter ? 'chapter_complete' : 'page_read'
  });

  const { data: user } = await sb.from('users')
    .select('coins, push_token').eq('id', userId).single();

  if (user && user.coins >= COINS_FOR_PREMIUM) {
    const expires = new Date();
    expires.setDate(expires.getDate() + 7);
    await sb.rpc('redeem_coins_for_premium', {
      p_user_id: userId, p_coins_cost: COINS_FOR_PREMIUM,
      p_expires_at: expires.toISOString()
    });
    if (user.push_token) {
      await push(user.push_token, {
        title: '🎉 7 dias Premium desbloqueados!',
        body:  'Você acumulou 50 moedas e ganhou 7 dias de plano Premium!',
      });
    }
  }
  return coins;
}

async function resetDailyCoins() {
  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];

  const { data: sessions } = await sb.from('user_reading_sessions')
    .select('user_id').gte('created_at', `${today}T00:00:00Z`);
  const readToday = new Set((sessions||[]).map(s => s.user_id));

  const { data: streaks } = await sb.from('user_streaks')
    .select('user_id, current_streak, last_read_date');

  for (const streak of (streaks||[])) {
    if (readToday.has(streak.user_id)) {
      const wasYesterday = streak.last_read_date === yesterday;
      const newStreak = wasYesterday ? streak.current_streak + 1 : 1;
      await sb.from('user_streaks').update({
        current_streak: newStreak, last_read_date: today,
        longest_streak: Math.max(newStreak, streak.current_streak||0)
      }).eq('user_id', streak.user_id);

      if (newStreak === 3 || newStreak === 7 || newStreak % 30 === 0) {
        const bonus = newStreak >= 7 ? 10 : 3;
        await sb.rpc('add_coins', { p_user_id: streak.user_id, p_amount: bonus });
        await sb.from('coin_transactions').insert({
          user_id: streak.user_id, amount: bonus, reason: 'streak_bonus'
        });
      }
    } else if (streak.current_streak > 0) {
      await sb.from('user_streaks')
        .update({ current_streak: 0 }).eq('user_id', streak.user_id);
    }
  }
  console.log('[COINS] Reset diário concluído.');
}

module.exports = { awardCoinsForReading, resetDailyCoins };


// ══════════════════════════════════════════════════════════
// jobs/pixRenewal.js
// ══════════════════════════════════════════════════════════
const { supabaseAdmin: sba } = require('../config/supabase');
const { sendPush: pushMsg } = require('../services/push');

async function processPixRenewals() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const { data: expiring } = await sba.from('users')
    .select('id, push_token, plan')
    .gte('plan_expires_at', `${tomorrowStr}T00:00:00Z`)
    .lte('plan_expires_at', `${tomorrowStr}T23:59:59Z`)
    .in('plan', ['starter','pro']);

  for (const user of (expiring||[])) {
    if (user.push_token) {
      await pushMsg(user.push_token, {
        title: '⚠️ Sua assinatura vence amanhã',
        body:  'Renove via Pix em mangalix.com.br/planos para não perder o acesso.',
        data:  { type: 'renewal_reminder', url: 'https://mangalix.com.br/planos' },
      });
    }
  }
  console.log(`[PIX] Avisos enviados para ${(expiring||[]).length} usuários.`);
}

module.exports = { processPixRenewals };
