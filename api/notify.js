/* ==========================================================================
   POST /api/notify — «тебя простили»

   Serverless-функция Vercel. Минимум для работы — один токен бота:

     TELEGRAM_BOT_TOKEN   — токен от @BotFather

   Кому слать, функция определит сама: возьмёт чат того, кто первым написал
   боту (нажал Start). Но лучше задать явно — надёжнее:

     TELEGRAM_CHAT_ID     — твой id, узнать у @userinfobot

   Необязательные:
     DISCORD_WEBHOOK_URL  — продублировать уведомление в дискорд
     NOTIFY_TZ            — часовой пояс времени в сообщении (по умолчанию Asia/Almaty)
     ALLOW_ORIGIN         — хост, с которого разрешены запросы (по умолчанию свой же)

   Секреты живут только в Vercel → Settings → Environment Variables.
   В код их не класть никогда.
   ========================================================================== */

'use strict';

/* ==========================================================================
   ВАРИАНТ БЕЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ

   Не хочешь возиться с настройками Vercel — просто впиши токен и id сюда.
   Этот файл выполняется на сервере, в браузер он не попадает, так что для
   личной странички это нормально.

   Единственное: если выложишь репозиторий на GitHub публично — токен увидят
   все. Тогда либо репозиторий Private, либо всё-таки переменные окружения.
   В script.js токен не вставлять никогда — тот файл видно всем.

   Если переменные окружения заданы, они важнее того, что написано здесь.
   ========================================================================== */

var FALLBACK_BOT_TOKEN = '';   // например '1234567890:AAH...'
var FALLBACK_CHAT_ID   = '';   // например '123456789', можно оставить пустым

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN || FALLBACK_BOT_TOKEN;
}

function chatIdFromConfig() {
  return process.env.TELEGRAM_CHAT_ID || FALLBACK_CHAT_ID;
}

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
  if (botToken()) targets.push('telegram');
  if (process.env.DISCORD_WEBHOOK_URL) targets.push('discord');

  if (targets.length === 0) {
    console.error('notify: нет токена бота — ни в переменных окружения, ни в FALLBACK_BOT_TOKEN');
    return res.status(501).json({
      error: 'Уведомления не настроены',
      reason: 'нет токена бота: задай TELEGRAM_BOT_TOKEN в Vercel или FALLBACK_BOT_TOKEN в api/notify.js'
    });
  }

  var results = await Promise.all(targets.map(function (target) {
    return send(target, text).then(
      function () { return { target: target, ok: true }; },
      function (err) {
        console.error('notify: ' + target + ' — ' + err.message);
        return { target: target, ok: false, reason: err.message };
      }
    );
  }));

  var delivered = results.filter(function (r) { return r.ok; });

  if (delivered.length === 0) {
    return res.status(502).json({
      error: 'Не удалось отправить уведомление',
      reason: results[0].reason           // чтобы не лезть в логи при настройке
    });
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
  var chatId = await resolveChatId();

  var response = await fetch(telegramUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
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

function telegramUrl(method) {
  return 'https://api.telegram.org/bot' + botToken() + '/' + method;
}

/* Кому слать. Если TELEGRAM_CHAT_ID не задан — спрашиваем у самого телеграма,
   кто последним писал боту. Так для настройки хватает одного токена. */
var cachedChatId = null;

async function resolveChatId() {
  var configured = chatIdFromConfig();
  if (configured) return configured;
  if (cachedChatId) return cachedChatId;

  var response = await fetch(telegramUrl('getUpdates') + '?limit=100');
  if (!response.ok) throw new Error('telegram getUpdates ' + response.status);

  var data = await response.json();
  var updates = Array.isArray(data.result) ? data.result : [];

  for (var i = updates.length - 1; i >= 0; i--) {
    var message = updates[i].message || updates[i].edited_message || updates[i].channel_post;
    if (message && message.chat && message.chat.id) {
      cachedChatId = String(message.chat.id);
      return cachedChatId;
    }
  }

  throw new Error('не найден получатель: напиши боту /start или задай TELEGRAM_CHAT_ID');
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
