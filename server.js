const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MASTER_CHAT_ID = process.env.MASTER_CHAT_ID ? String(process.env.MASTER_CHAT_ID) : null;
const MONGODB_URI = process.env.MONGODB_URI;
const TZ = 'Europe/Kyiv';
const MENU_BUTTON = '🚀 ГОЛОВНЕ МЕНЮ';

if (!BOT_TOKEN || !MONGODB_URI) {
  console.error('Потрібні змінні середовища BOT_TOKEN та MONGODB_URI');
  process.exit(1);
}

// polling запускаємо лише після підключення до бази
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
bot.on('polling_error', (err) => console.error('polling_error:', err.code, err.message));

let schedules; // { _id: 'YYYY-MM-DD', times: ['10:00', ...] }  - вільні години
let bookings; //  { date, time, clientName, clientPhone, service, createdAt }

// тимчасовий стан налаштування дня (не критичний, може жити в пам'яті)
const masterSetup = {};

// ---------- ДОПОМІЖНІ ----------
const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const todayKyiv = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const nowTimeKyiv = () =>
  new Date().toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

const isMaster = (chatId) => !MASTER_CHAT_ID || String(chatId) === MASTER_CHAT_ID;

const prettyDate = (date) =>
  new Date(date + 'T12:00:00Z').toLocaleDateString('uk-UA', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  });

async function cleanOldDates() {
  await schedules.deleteMany({ _id: { $lt: todayKyiv() } });
}

async function getSchedule() {
  await cleanOldDates();
  const docs = await schedules.find({}).sort({ _id: 1 }).toArray();
  const result = {};
  docs.forEach((d) => {
    if (d.times && d.times.length) result[d._id] = d.times;
  });
  return result;
}

// Майбутні записи: або після сьогоднішньої дати, або сьогодні, але ще не минулі
function upcomingFilter() {
  return {
    $or: [{ date: { $gt: todayKyiv() } }, { date: todayKyiv(), time: { $gte: nowTimeKyiv() } }],
  };
}

const countUpcoming = () => bookings.countDocuments(upcomingFilter());

const getUpcoming = (limit = 20) =>
  bookings.find(upcomingFilter()).sort({ date: 1, time: 1 }).limit(limit).toArray();

async function addFreeTime(date, time) {
  const doc = await schedules.findOne({ _id: date });
  const times = [...new Set([...(doc?.times || []), time])].sort();
  await schedules.updateOne({ _id: date }, { $set: { times } }, { upsert: true });
}

// ---------- API САЙТУ ----------
app.get('/', (req, res) => res.send('OK')); // для пінгу, щоб Render не засинав

app.get('/api/schedule', async (req, res) => {
  try {
    const schedule = await getSchedule();
    // для сьогодні не віддаємо години, що вже минули
    const today = todayKyiv();
    if (schedule[today]) {
      const now = nowTimeKyiv();
      schedule[today] = schedule[today].filter((t) => t > now);
      if (schedule[today].length === 0) delete schedule[today];
    }
    res.json(schedule);
  } catch (e) {
    console.error('GET /api/schedule:', e.message);
    res.status(500).json({});
  }
});

app.post('/api/book', async (req, res) => {
  const { date, time, clientName, clientPhone, service } = req.body || {};

  const valid =
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    typeof time === 'string' && /^\d{2}:\d{2}$/.test(time) &&
    typeof clientName === 'string' && clientName.trim() && clientName.length <= 100 &&
    typeof clientPhone === 'string' && clientPhone.trim() && clientPhone.length <= 30 &&
    (service === undefined || (typeof service === 'string' && service.length <= 100));

  if (!valid) {
    return res.status(400).json({ success: false, message: 'Перевірте введені дані.' });
  }

  try {
    // Атомарно забираємо годину: двоє людей не зможуть записатись на один слот
    const r = await schedules.updateOne({ _id: date, times: time }, { $pull: { times: time } });
    if (r.modifiedCount !== 1) {
      return res.status(400).json({ success: false, message: 'Цей час уже зайнятий.' });
    }

    try {
      await bookings.insertOne({
        date,
        time,
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
        service: (service || '').trim(),
        createdAt: new Date(),
      });
    } catch (e) {
      await addFreeTime(date, time); // відкат, якщо запис не вдався
      throw e;
    }

    await schedules.deleteOne({ _id: date, times: { $size: 0 } });

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
  } catch (e) {
    console.error('POST /api/book:', e.message);
    return res.status(500).json({ success: false, message: 'Помилка сервера. Спробуйте ще раз.' });
  }
});

// ---------- TELEGRAM БОТ ----------
const mainKeyboard = {
  keyboard: [[{ text: MENU_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

const panelText = '✂️ <b>ПАНЕЛЬ КЕРУВАННЯ OSTRI</b>\n\nОберіть потрібну дію нижче:';

async function panelMarkup() {
  const count = await countUpcoming();
  return {
    inline_keyboard: [
      [{ text: `📋 Записи клієнтів (${count})`, callback_data: 'view_bookings' }],
      [{ text: '📅 Переглянути поточний розклад', callback_data: 'view_schedule' }],
      [{ text: '➕ Налаштувати години на день', callback_data: 'step_7_days' }],
      [{ text: '🗑️ Очистити вільні години', callback_data: 'clear_schedule' }],
    ],
  };
}

async function showMainMenu(chatId, messageId = null) {
  const reply_markup = await panelMarkup();
  if (messageId) {
    return bot
      .editMessageText(panelText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup,
      })
      .catch(() => bot.sendMessage(chatId, panelText, { parse_mode: 'HTML', reply_markup }));
  }
  return bot.sendMessage(chatId, panelText, { parse_mode: 'HTML', reply_markup });
}

bot.onText(/^\/start(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    if (!isMaster(chatId)) return await bot.sendMessage(chatId, '⛔ У вас немає доступу.');
    await bot.sendMessage(chatId, '👋', { reply_markup: mainKeyboard });
    await showMainMenu(chatId);
  } catch (e) {
    console.error('/start:', e.message);
  }
});

bot.on('message', async (msg) => {
  if (msg.text !== MENU_BUTTON) return;
  const chatId = msg.chat.id;
  try {
    if (!isMaster(chatId)) return await bot.sendMessage(chatId, '⛔ У вас немає доступу.');
    await showMainMenu(chatId);
  } catch (e) {
    console.error('menu button:', e.message);
  }
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
      if (isToday && slot <= now) continue;
      slots.push(slot);
    }
  }
  return slots;
}

const backToMenu = { inline_keyboard: [[{ text: '« Головне меню', callback_data: 'main_menu' }]] };

const editOrIgnore = (text, chatId, messageId, reply_markup) =>
  bot
    .editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup })
    .catch(() => {});

// ----- записи клієнтів -----
async function showBookings(chatId, messageId) {
  const list = await getUpcoming(20);
  const total = await countUpcoming();

  if (list.length === 0) {
    return editOrIgnore('📋 <b>Записи клієнтів</b>\n\n❌ Майбутніх записів немає.', chatId, messageId, backToMenu);
  }

  let text = `📋 <b>Записи клієнтів</b> (${total})\n`;
  const keyboard = [];
  let lastDate = null;

  list.forEach((b, i) => {
    if (b.date !== lastDate) {
      text += `\n📌 <b>${prettyDate(b.date)}</b>\n`;
      lastDate = b.date;
    }
    text += `${i + 1}. ⏰ <b>${b.time}</b> — ${escapeHtml(b.clientName)}\n`;
    text += `    📞 ${escapeHtml(b.clientPhone)}${b.service ? ' · ✂️ ' + escapeHtml(b.service) : ''}\n`;
    keyboard.push([
      { text: `❌ ${i + 1} · ${prettyDate(b.date)} ${b.time}`, callback_data: `cancelask_${b._id}` },
    ]);
  });

  if (total > list.length) text += `\n… показано перші ${list.length} з ${total}`;
  keyboard.push([{ text: '« Головне меню', callback_data: 'main_menu' }]);

  return editOrIgnore(text, chatId, messageId, { inline_keyboard: keyboard });
}

async function renderTimeGrid(chatId, messageId) {
  const setup = masterSetup[chatId];
  if (!setup) return;

  // години, на які вже є запис клієнта - блокуємо
  const booked = new Set(
    (await bookings.find({ date: setup.date }).toArray()).map((b) => b.time)
  );
  setup.times = setup.times.filter((t) => !booked.has(t));

  const selected = setup.times;
  const rows = [];
  let row = [];

  generateTimeSlots(setup.date).forEach((slot) => {
    let btn;
    if (booked.has(slot)) btn = { text: `🔒 ${slot}`, callback_data: 'noop' };
    else if (selected.includes(slot)) btn = { text: `✅ ${slot}`, callback_data: `time_${slot}` };
    else btn = { text: `⏳ ${slot}`, callback_data: `time_${slot}` };

    row.push(btn);
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
      `🔒 - година вже зайнята клієнтом\n` +
      `Обрано: <i>${selected.length > 0 ? selected.join(', ') : 'жодної'}</i>`,
    chatId,
    messageId,
    { inline_keyboard: rows }
  );
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data || '';
  const answer = (opts) => bot.answerCallbackQuery(query.id, opts).catch(() => {});

  try {
    if (!isMaster(chatId)) return answer({ text: '⛔ Немає доступу', show_alert: true });

    if (data === 'noop') return answer({ text: '🔒 На цю годину вже є запис', show_alert: false });

    if (data === 'main_menu') {
      answer();
      return showMainMenu(chatId, messageId);
    }

    if (data === 'view_bookings') {
      answer();
      return showBookings(chatId, messageId);
    }

    if (data.startsWith('cancelask_')) {
      answer();
      const id = data.replace('cancelask_', '');
      if (!ObjectId.isValid(id)) return;
      const b = await bookings.findOne({ _id: new ObjectId(id) });
      if (!b) return showBookings(chatId, messageId);
      return editOrIgnore(
        `❓ <b>Скасувати цей запис?</b>\n\n` +
          `👤 ${escapeHtml(b.clientName)}\n` +
          `📞 ${escapeHtml(b.clientPhone)}\n` +
          `${b.service ? '✂️ ' + escapeHtml(b.service) + '\n' : ''}` +
          `📅 ${prettyDate(b.date)} (${b.date})\n` +
          `⏰ ${b.time}\n\n` +
          `Година знову стане вільною на сайті.`,
        chatId,
        messageId,
        {
          inline_keyboard: [
            [{ text: '✅ Так, скасувати', callback_data: `cancel_${id}` }],
            [{ text: '« Назад до записів', callback_data: 'view_bookings' }],
          ],
        }
      );
    }

    if (data.startsWith('cancel_')) {
      answer();
      const id = data.replace('cancel_', '');
      if (!ObjectId.isValid(id)) return;
      const b = await bookings.findOneAndDelete({ _id: new ObjectId(id) });
      if (b) await addFreeTime(b.date, b.time);
      return editOrIgnore(
        b
          ? `✅ <b>Запис скасовано.</b>\n\n${escapeHtml(b.clientName)} · ${prettyDate(b.date)} ${b.time}\nГодина знову вільна.`
          : 'ℹ️ Цей запис уже скасовано.',
        chatId,
        messageId,
        {
          inline_keyboard: [
            [{ text: '📋 До записів', callback_data: 'view_bookings' }],
            [{ text: '« Головне меню', callback_data: 'main_menu' }],
          ],
        }
      );
    }

    if (data === 'view_schedule') {
      answer();
      const schedule = await getSchedule();
      let msg = '📅 <b>Поточний розклад (вільні години):</b>\n\n';
      const dates = Object.keys(schedule).sort();
      if (dates.length === 0) msg += '❌ Немає відкритих дат.';
      else dates.forEach((d) => (msg += `📌 <b>${d}</b>: ${schedule[d].join(', ')}\n`));
      return editOrIgnore(msg, chatId, messageId, backToMenu);
    }

    if (data === 'clear_schedule') {
      answer();
      await schedules.deleteMany({});
      return editOrIgnore(
        '🗑️ <b>Усі вільні години очищено!</b>\n\nЗаписи клієнтів збережені.',
        chatId,
        messageId,
        backToMenu
      );
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

    if (data.startsWith('pickday_')) {
      answer();
      const date = data.replace('pickday_', '');
      const doc = await schedules.findOne({ _id: date });
      masterSetup[chatId] = { date, times: doc?.times ? [...doc.times] : [] };
      return renderTimeGrid(chatId, messageId);
    }

    if (data.startsWith('time_')) {
      answer();
      const time = data.replace('time_', '');
      const setup = masterSetup[chatId];
      if (!setup) return;
      if (setup.times.includes(time)) setup.times = setup.times.filter((t) => t !== time);
      else {
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

      // ще раз відсікаємо години, які встигли забронювати
      const booked = new Set(
        (await bookings.find({ date: setup.date }).toArray()).map((b) => b.time)
      );
      const times = setup.times.filter((t) => !booked.has(t)).sort();
      if (times.length === 0) {
        return answer({ text: '⚠️ Усі обрані години вже зайняті.', show_alert: true });
      }

      await schedules.updateOne({ _id: setup.date }, { $set: { times } }, { upsert: true });
      delete masterSetup[chatId];

      return editOrIgnore(
        `✅ <b>Розклад на ${setup.date} успішно збережено!</b>\n\n⏰ Доступні години: ${times.join(', ')}`,
        chatId,
        messageId,
        backToMenu
      );
    }

    answer();
  } catch (e) {
    console.error('callback_query error:', e.message);
    answer({ text: '⚠️ Сталася помилка, спробуйте ще раз', show_alert: true });
  }
});

// ---------- СТАРТ ----------
async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.DB_NAME || 'ostri');
  schedules = db.collection('schedule');
  bookings = db.collection('bookings');

  // один запис на одну дату+годину
  await bookings.createIndex({ date: 1, time: 1 }, { unique: true });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  await bot.deleteWebHook().catch(() => {});
  await bot.startPolling();
  console.log('Bot polling started, MongoDB connected');
}

main().catch((e) => {
  console.error('Не вдалося запустити:', e);
  process.exit(1);
});
