/* ==========================================================================
   POST /api/notify — «тебя простили»

   Serverless-функция Vercel. Шлёт уведомление туда, что настроено
   переменными окружения (можно сразу в оба места):

     TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   — телеграм
     DISCORD_WEBHOOK_URL                     — дискорд

   Необязательные:
     NOTIFY_TZ    — часовой пояс для времени в сообщении (по умолчанию Asia/Almaty)
     ALLOW_ORIGIN — хост, с которого разрешены запросы (по умолчанию — свой же)

   Секреты живут только в Vercel → Settings → Environment Variables.
   В код их не класть никогда.
   ========================================================================== */

'use strict';

var RATE_LIMIT_MS = 10 * 1000; // не чаще одного уведомления в 10 секунд с IP
var recent = new Map();        // best-effort, живёт в пределах одного инстанса

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Метод не поддерживается' });
  }

  if (!isSameSite(req)) {
    return res.status(403).json({ error: 'Запрос с чужого домена' });
  }

  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'Слишком часто, подожди немного' });
  }

  var payload = parseBody(req.body);
  var text = buildMessage(payload, req);

  var targets = [];
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) targets.push('telegram');
  if (process.env.DISCORD_WEBHOOK_URL) targets.push('discord');

  if (targets.length === 0) {
    console.error('notify: не задана ни одна переменная окружения для отправки');
    return res.status(501).json({ error: 'Уведомления не настроены' });
  }

  var results = await Promise.all(targets.map(function (target) {
    return send(target, text).then(
      function () { return { target: target, ok: true }; },
      function (err) {
        console.error('notify: ' + target + ' — ' + err.message);
        return { target: target, ok: false };
      }
    );
  }));

  var delivered = results.filter(function (r) { return r.ok; });

  if (delivered.length === 0) {
    return res.status(502).json({ error: 'Не удалось отправить уведомление' });
  }

  return res.status(200).json({
    ok: true,
    sent: delivered.map(function (r) { return r.target; })
  });
};

/* --- отправка ------------------------------------------------------------- */

async function send(target, text) {
  if (target === 'telegram') return sendTelegram(text);
  if (target === 'discord') return sendDiscord(text);
  throw new Error('Неизвестный получатель: ' + target);
}

async function sendTelegram(text) {
  var url = 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage';

  var response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    var detail = await response.text();
    throw new Error('telegram ' + response.status + ': ' + detail.slice(0, 200));
  }
}

async function sendDiscord(text) {
  var response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: stripTags(text) })
  });

  if (!response.ok) {
    throw new Error('discord ' + response.status);
  }
}

/* --- сообщение ------------------------------------------------------------ */

function buildMessage(payload, req) {
  var tz = process.env.NOTIFY_TZ || 'Asia/Almaty';
  var when;

  try {
    when = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      dateStyle: 'short',
      timeStyle: 'medium'
    }).format(new Date());
  } catch (err) {
    when = new Date().toISOString();
  }

  var lines = [
    '<b>ТЕБЯ ПРОСТИЛИ</b>',
    'Кнопку «Прощаю» нажали.',
    '',
    'Отказов до этого: <b>' + payload.refusals + '</b>',
    'Время: ' + escapeHtml(when) + ' (' + escapeHtml(tz) + ')',
    'Устройство: ' + escapeHtml(deviceOf(req))
  ];

  return lines.join('\n');
}

function deviceOf(req) {
  var ua = String(req.headers['user-agent'] || '').slice(0, 160);
  if (!ua) return 'неизвестно';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iPhone / iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/windows/i.test(ua)) return 'Windows';
  if (/macintosh/i.test(ua)) return 'Mac';
  return ua;
}

/* --- защита и утилиты ------------------------------------------------------ */

function parseBody(raw) {
  var data = raw;

  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (err) { data = {}; }
  }
  if (!data || typeof data !== 'object') data = {};

  var refusals = Number(data.refusals);
  if (!Number.isFinite(refusals) || refusals < 0) refusals = 0;

  return { refusals: Math.min(Math.floor(refusals), 9999) };
}

/* запрос должен прийти с нашей же страницы, а не откуда попало */
function isSameSite(req) {
  var origin = req.headers.origin;
  if (!origin) return true; // некоторые браузеры не шлют Origin на same-origin POST

  var allowed = process.env.ALLOW_ORIGIN;
  if (allowed) return origin === allowed;

  var host = req.headers['x-forwarded-host'] || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch (err) {
    return false;
  }
}

function clientIp(req) {
  var forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function isRateLimited(ip) {
  var now = Date.now();

  // подчищаем старое, чтобы Map не пухла
  for (var entry of recent) {
    if (now - entry[1] > RATE_LIMIT_MS) recent.delete(entry[0]);
  }

  var last = recent.get(ip);
  if (last && now - last < RATE_LIMIT_MS) return true;

  recent.set(ip, now);
  return false;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, '');
}
