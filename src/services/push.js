// ══════════════════════════════════════════════════════════
// services/push.js — Envio de push via Expo
// ══════════════════════════════════════════════════════════
const axios = require('axios');

async function sendPush(token, { title, body, data = {}, channelId = 'default' }) {
  if (!token) return;
  try {
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: token, title, body, data,
      channelId,
      sound: 'default',
      priority: 'high',
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch(e) {
    console.error('Push error:', e.message);
  }
}

module.exports = { sendPush };
