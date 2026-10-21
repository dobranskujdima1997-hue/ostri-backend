const express = require('express');
const cors = require('cors');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MASTER_CHAT_ID = process.env.MASTER_CHAT_ID ? String(process.env.MASTER_CHAT_ID) : null;
const TZ = 'Europe/Kyiv';
const DATA_FILE = process.env.DATA_FILE || './schedule.json';
const MENU_BUTTON = '🚀 ГОЛОВНЕ МЕНЮ';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN не задано');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (err) => {
  // 409 = десь запущений ще один екземпляр бота з тим самим токеном
  console.error('polling_error:', err.code, err.message);
});

// ---------- ДАНІ ----------
let schedule = {};
let masterSetup = {};

try {
  if (fs.existsSync(DATA_FILE)) schedule = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('Не вдалося прочитати розклад:', e.message);
}

function saveSchedule() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(schedule));
  } catch (e) {
    console.error('Не вдалося зберегти розклад:', e.message);
  }
}

// ---------- ДОПОМІЖНІ ----------
const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Дата/час за Києвом (а не UTC), щоб "сьогодні" не зсувалось
const todayKyiv = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const nowTimeKyiv = () =>
  new Date().toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

function cleanOldDates() {
  const today = todayKyiv();
  let changed = false;
  for (const date of Object.keys(schedule)) {
    if (date < today) {
      delete schedule[date];
      changed = true;
    }
  }
  if (changed) saveSchedule();
}

const isMaster = (chatId) => !MASTER_CHAT_ID || String(chatId) === MASTER_CHAT_ID;

// ---------- API САЙТУ ----------
app.get('/', (req, res) => res.send('OK')); // для пінгу, щоб Render не засинав

app.get('/api/schedule', (req, res) => {
  cleanOldDates();
  res.json(schedule);
});

app.post('/api/book', (req, res) => {
  const { date, time, clientName, clientPhone, service } = req.body || {};

  if (!date || !time || !clientName || !clientPhone) {
    return res.status(400).json({ success: false, message: 'Заповніть усі поля.' });
  }

  if (schedule[date] && schedule[date].includes(time)) {
    schedule[date] = schedule[date].filter((t) => t !== time);
    if (schedule[date].length === 0) delete schedule[date];
    saveSchedule();

    if (MASTER_CHAT_ID) {
      bot
        .sendMessage(
          MASTER_CHAT_ID,
          `🚨 <b>НОВИЙ ЗАПИС НА САЙТІ!</b>\n\n` +
            `👤 <b>Клієнт:</b> ${escapeHtml(clientName)}\n` +
            `📞 <b>Тел:</b> ${escapeHtml(clientPhone)}\n` +
            `✂️ <b>Послуга:</b> ${escapeHtml(service)}\n` +
            `📅 <b>Дата:</b> ${escapeHtml(date)}\n` +
            `⏰ <b>Час:</b> ${escapeHtml(time)}`,
          { parse_mode: 'HTML' }
        )
        .catch((e) => console.error('sendMessage error:', e.message));
    }
    return res.json({ success: true });
  }
  return res.status(400).json({ success: false, message: 'Цей час уже зайнятий.' });
});

// ---------- TELEGRAM БОТ ----------
const mainKeyboard = {
  keyboard: [[{ text: MENU_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

const panelText = '✂️ <b>ПАНЕЛЬ КЕРУВАННЯ OSTRI</b>\n\nОберіть потрібну дію нижче:';
const panelMarkup = {
  inline_keyboard: [
    [{ text: '📅 Переглянути поточний розклад', callback_data: 'view_schedule' }],
    [{ text: '➕ Налаштувати години на день', callback_data: 'step_7_days' }],
    [{ text: '🗑️ Очистити весь розклад', callback_data: 'clear_schedule' }],
  ],
};

// Одна панель: або нове повідомлення, або редагування існуючого
function showMainMenu(chatId, messageId = null) {
  if (messageId) {
    return bot
      .editMessageText(panelText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: panelMarkup,
      })
      .catch(() =>
        bot.sendMessage(chatId, panelText, { parse_mode: 'HTML', reply_markup: panelMarkup })
      );
  }
  return bot.sendMessage(chatId, panelText, { parse_mode: 'HTML', reply_markup: panelMarkup });
}

// /start: ставимо постійну кнопку (один раз) + одна панель
bot.onText(/^\/start(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isMaster(chatId)) return bot.sendMessage(chatId, '⛔ У вас немає доступу.');
  await bot.sendMessage(chatId, '👋', { reply_markup: mainKeyboard });
  await showMainMenu(chatId);
});

// Постійна кнопка "ГОЛОВНЕ МЕНЮ": тільки одна панель, нічого зайвого
bot.on('message', (msg) => {
  if (msg.text !== MENU_BUTTON) return;
  const chatId = msg.chat.id;
  if (!isMaster(chatId)) return bot.sendMessage(chatId, '⛔ У вас немає доступу.');
  showMainMenu(chatId);
});

function getNext7Days() {
  const base = new Date(todayKyiv() + 'T12:00:00Z');
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    let label = dateStr;
    if (i === 0) label = `Сьогодні (${dateStr})`;
    else if (i === 1) label = `Завтра (${dateStr})`;
    days.push({ text: label, date: dateStr });
  }
  return days;
}

function generateTimeSlots(date) {
  const slots = [];
  const isToday = date === todayKyiv();
  const now = nowTimeKyiv();
  for (let hour = 9; hour <= 20; hour++) {
    for (let min = 0; min < 60; min += 15) {
      if (hour === 20 && min > 0) break;
      const slot = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      if (isToday && slot <= now) continue; // не показуємо години, що вже минули
      slots.push(slot);
    }
  }
  return slots;
}

const backToMenu = { inline_keyboard: [[{ text: '« Головне меню', callback_data: 'main_menu' }]] };

function editOrIgnore(text, chatId, messageId, reply_markup) {
  return bot
    .editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup })
    .catch(() => {});
}

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data || '';

  // Закриваємо "годинник" на кнопці (за замовчуванням, без alert)
  const answer = (opts) => bot.answerCallbackQuery(query.id, opts).catch(() => {});

  if (!isMaster(chatId)) return answer({ text: '⛔ Немає доступу', show_alert: true });

  if (data === 'view_schedule') {
    answer();
    cleanOldDates();
    let msg = '📅 <b>Поточний розклад:</b>\n\n';
    const dates = Object.keys(schedule).sort();
    if (dates.length === 0) {
      msg += '❌ Немає відкритих дат.';
    } else {
      for (const date of dates) msg += `📌 <b>${date}</b>: ${schedule[date].join(', ')}\n`;
    }
    return editOrIgnore(msg, chatId, messageId, backToMenu);
  }

  if (data === 'clear_schedule') {
    answer();
    schedule = {};
    saveSchedule();
    return editOrIgnore('🗑️ <b>Весь розклад успішно очищено!</b>', chatId, messageId, backToMenu);
  }

  if (data === 'step_7_days') {
    answer();
    const keyboard = getNext7Days().map((item) => [
      { text: item.text, callback_data: `pickday_${item.date}` },
    ]);
    keyboard.push([{ text: '« Головне меню', callback_data: 'main_menu' }]);
    return editOrIgnore('📅 <b>Оберіть день для налаштування:</b>', chatId, messageId, {
      inline_keyboard: keyboard,
    });
  }

  if (data === 'main_menu') {
    answer();
    return showMainMenu(chatId, messageId);
  }

  if (data.startsWith('pickday_')) {
    answer();
    const date = data.replace('pickday_', '');
    masterSetup[chatId] = { date, times: schedule[date] ? [...schedule[date]] : [] };
    return renderTimeGrid(chatId, messageId);
  }

  if (data.startsWith('time_')) {
    answer();
    const time = data.replace('time_', '');
    const setup = masterSetup[chatId];
    if (!setup) return;
    if (setup.times.includes(time)) {
      setup.times = setup.times.filter((t) => t !== time);
    } else {
      setup.times.push(time);
      setup.times.sort();
    }
    return renderTimeGrid(chatId, messageId);
  }

  if (data === 'save_day_schedule') {
    const setup = masterSetup[chatId];
    if (!setup || setup.times.length === 0) {
      return answer({ text: '⚠️ Оберіть хоча б одну годину!', show_alert: true });
    }
    answer();
    schedule[setup.date] = [...setup.times].sort();
    saveSchedule();
    delete masterSetup[chatId];
    return editOrIgnore(
      `✅ <b>Розклад на ${setup.date} успішно збережено!</b>\n\n⏰ Доступні години: ${schedule[setup.date].join(', ')}`,
      chatId,
      messageId,
      backToMenu
    );
  }

  answer();
});

function renderTimeGrid(chatId, messageId) {
  const setup = masterSetup[chatId];
  if (!setup) return;

  const selected = setup.times;
  const rows = [];
  let row = [];

  generateTimeSlots(setup.date).forEach((slot) => {
    row.push({
      text: selected.includes(slot) ? `✅ ${slot}` : `⏳ ${slot}`,
      callback_data: `time_${slot}`,
    });
    if (row.length === 4) {
      rows.push(row);
      row = [];
    }
  });
  if (row.length > 0) rows.push(row);

  rows.push([{ text: '💾 ЗБЕРЕГТИ ДЕНЬ', callback_data: 'save_day_schedule' }]);
  rows.push([{ text: '« Назад до днів', callback_data: 'step_7_days' }]);

  return editOrIgnore(
    `📅 День: <b>${setup.date}</b>\n\n` +
      `Натискайте на години, щоб увімкнути/вимкнути їх:\n` +
      `Обрано: <i>${selected.length > 0 ? selected.join(', ') : 'жодної'}</i>`,
    chatId,
    messageId,
    { inline_keyboard: rows }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
