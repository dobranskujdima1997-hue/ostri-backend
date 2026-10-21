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
const DAYS_AHEAD = 30; // на скільки днів уперед відкритий запис
const STEP_MIN = 15; // крок запису, хвилин

// Шаблон за замовчуванням: пн-сб 08:00-20:00, неділя вихідний (days[0] = неділя)
const DEFAULT_TEMPLATE = {
  days: [false, true, true, true, true, true, true],
  start: '08:00',
  end: '20:00',
};
const WEEKDAYS = [
  { idx: 1, label: 'Пн' },
  { idx: 2, label: 'Вт' },
  { idx: 3, label: 'Ср' },
  { idx: 4, label: 'Чт' },
  { idx: 5, label: 'Пт' },
  { idx: 6, label: 'Сб' },
  { idx: 0, label: 'Нд' },
];

if (!BOT_TOKEN || !MONGODB_URI) {
  console.error('Потрібні змінні середовища BOT_TOKEN та MONGODB_URI');
  process.exit(1);
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

// polling запускаємо лише після підключення до бази
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
bot.on('polling_error', (err) => console.error('polling_error:', err.code, err.message));

let settings; //  { _id:'template', days:[7 x bool], start, end }
let overrides; // { _id:'YYYY-MM-DD', closed:bool, times:[...] }  - зміни окремих днів
let bookings; //  { date, time, clientName, clientPhone, service, createdAt }

// тимчасовий стан редагування дня (не критичний, може жити в пам'яті)
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

const weekdayOf = (date) => new Date(date + 'T12:00:00Z').getUTCDay(); // 0 = неділя

const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const fromMin = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// усі слоти від start до end (останній слот починається за STEP_MIN до закриття)
function slotsBetween(start, end) {
  const out = [];
  for (let m = toMin(start); m + STEP_MIN <= toMin(end); m += STEP_MIN) out.push(fromMin(m));
  return out;
}

// ['08:00','08:15',...] -> "08:00–12:00, 13:00–20:00"
function rangesText(times) {
  if (!times.length) return '—';
  const sorted = [...times].sort();
  const out = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (toMin(sorted[i]) - toMin(prev) === STEP_MIN) {
      prev = sorted[i];
      continue;
    }
    out.push(`${start}–${fromMin(toMin(prev) + STEP_MIN)}`);
    start = prev = sorted[i];
  }
  out.push(`${start}–${fromMin(toMin(prev) + STEP_MIN)}`);
  return out.join(', ');
}

function windowDates() {
  const base = new Date(todayKyiv() + 'T12:00:00Z');
  const dates = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

// ---------- РОЗКЛАД: шаблон + винятки - записи ----------
async function getTemplate() {
  const doc = await settings.findOne({ _id: 'template' });
  return {
    days: doc?.days?.length === 7 ? doc.days : DEFAULT_TEMPLATE.days,
    start: doc?.start || DEFAULT_TEMPLATE.start,
    end: doc?.end || DEFAULT_TEMPLATE.end,
  };
}

// усі години дня до віднімання записів: або з винятку, або з тижневого шаблону
function baseFor(date, template, override) {
  if (override) return override.closed ? [] : override.times || [];
  if (!template.days[weekdayOf(date)]) return [];
  return slotsBetween(template.start, template.end);
}

// для сьогодні відкидаємо години, що вже минули
function futureOnly(date, times) {
  if (date !== todayKyiv()) return times;
  const now = nowTimeKyiv();
  return times.filter((t) => t > now);
}

async function loadWindow() {
  const dates = windowDates();
  await overrides.deleteMany({ _id: { $lt: dates[0] } }).catch(() => {});

  const [template, ovs, bks] = await Promise.all([
    getTemplate(),
    overrides.find({ _id: { $in: dates } }).toArray(),
    bookings.find({ date: { $in: dates } }, { projection: { date: 1, time: 1 } }).toArray(),
  ]);

  const overrideMap = {};
  ovs.forEach((o) => (overrideMap[o._id] = o));
  const bookedMap = {};
  bks.forEach((b) => {
    if (!bookedMap[b.date]) bookedMap[b.date] = new Set();
    bookedMap[b.date].add(b.time);
  });

  return { dates, template, overrideMap, bookedMap };
}

// вільні години дня
function freeFor(date, w) {
  const booked = w.bookedMap[date] || new Set();
  return futureOnly(date, baseFor(date, w.template, w.overrideMap[date])).filter(
    (t) => !booked.has(t)
  );
}

// ---------- ЗАПИСИ ----------
function upcomingFilter() {
  return {
    $or: [{ date: { $gt: todayKyiv() } }, { date: todayKyiv(), time: { $gte: nowTimeKyiv() } }],
  };
}
const countUpcoming = () => bookings.countDocuments(upcomingFilter());
const getUpcoming = (limit = 20) =>
  bookings.find(upcomingFilter()).sort({ date: 1, time: 1 }).limit(limit).toArray();

// ---------- API САЙТУ ----------
app.get('/', (req, res) => res.send('OK')); // для пінгу, щоб Render не засинав

app.get('/api/schedule', async (req, res) => {
  try {
    const w = await loadWindow();
    const out = {};
    w.dates.forEach((d) => {
      const free = freeFor(d, w);
      if (free.length) out[d] = free;
    });
    res.json(out);
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
    const w = await loadWindow();
    if (!w.dates.includes(date) || !freeFor(date, w).includes(time)) {
      return res.status(400).json({ success: false, message: 'Цей час уже зайнятий.' });
    }

    try {
      // унікальний індекс (date + time) гарантує, що двоє не запишуться на одну годину
      await bookings.insertOne({
        date,
        time,
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim(),
        service: (service || '').trim(),
        createdAt: new Date(),
      });
    } catch (e) {
      if (e.code === 11000) {
        return res.status(400).json({ success: false, message: 'Цей час уже зайнятий.' });
      }
      throw e;
    }

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
      [{ text: `📅 Розклад на ${DAYS_AHEAD} днів`, callback_data: 'view_schedule' }],
      [{ text: '✏️ Змінити день / зробити вихідним', callback_data: 'step_days' }],
      [{ text: '⚙️ Тижневий шаблон', callback_data: 'tpl_menu' }],
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

// ----- перегляд розкладу на 30 днів -----
async function showSchedule(chatId, messageId) {
  const w = await loadWindow();
  let msg = `📅 <b>Розклад на ${DAYS_AHEAD} днів</b>\n\n`;

  w.dates.forEach((d) => {
    const free = freeFor(d, w);
    const bk = (w.bookedMap[d] || new Set()).size;
    const ov = w.overrideMap[d];
    const off = ov ? !!ov.closed : !w.template.days[weekdayOf(d)];
    const bkText = bk ? ` · записів: ${bk}` : '';

    if (off && free.length === 0) msg += `🚫 ${prettyDate(d)} — вихідний${bkText}\n`;
    else if (free.length === 0) msg += `🔴 ${prettyDate(d)} — вільних годин немає${bkText}\n`;
    else msg += `🟢 ${prettyDate(d)} — ${rangesText(free)}${bkText}${ov ? ' ✏️' : ''}\n`;
  });

  msg += '\n🟢 є вільні години · 🔴 усе зайнято · 🚫 вихідний · ✏️ змінено вручну';
  return editOrIgnore(msg, chatId, messageId, backToMenu);
}

// ----- вибір дня для редагування -----
async function renderDayPicker(chatId, messageId) {
  const w = await loadWindow();
  const buttons = w.dates.map((d) => {
    const ov = w.overrideMap[d];
    const off = ov ? !!ov.closed : !w.template.days[weekdayOf(d)];
    const mark = off ? '🚫 ' : ov ? '✏️ ' : '';
    return { text: `${mark}${prettyDate(d)}`, callback_data: `pickday_${d}` };
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  rows.push([{ text: '« Головне меню', callback_data: 'main_menu' }]);

  return editOrIgnore(
    '✏️ <b>Оберіть день</b>\n\n🚫 вихідний · ✏️ змінено вручну\n\n' +
      'Тут можна змінити години окремого дня або зробити його вихідним. Загальний графік - у «⚙️ Тижневий шаблон».',
    chatId,
    messageId,
    { inline_keyboard: rows }
  );
}

// ----- редагування одного дня -----
async function renderDay(chatId, messageId) {
  const setup = masterSetup[chatId];
  if (!setup) return;

  const [template, ov, bks] = await Promise.all([
    getTemplate(),
    overrides.findOne({ _id: setup.date }),
    bookings.find({ date: setup.date }).toArray(),
  ]);

  // години з записом клієнта блокуємо
  const booked = new Set(bks.map((b) => b.time));
  setup.times = setup.times.filter((t) => !booked.has(t));
  const selected = setup.times;

  const slots = futureOnly(
    setup.date,
    [...new Set([...slotsBetween(template.start, template.end), ...selected, ...booked])].sort()
  );

  const rows = [];
  let row = [];
  slots.forEach((slot) => {
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

  rows.push([
    { text: '✅ Обрати всі', callback_data: 'sel_all' },
    { text: '🧹 Зняти всі', callback_data: 'sel_none' },
  ]);
  rows.push([{ text: '💾 ЗБЕРЕГТИ ДЕНЬ', callback_data: 'save_day' }]);
  rows.push([
    { text: '🚫 Зробити вихідним', callback_data: 'day_off' },
    { text: '↩️ За шаблоном', callback_data: 'day_reset' },
  ]);
  rows.push([{ text: '« Назад до днів', callback_data: 'step_days' }]);

  // що зараз відкрито на сайті (для довідки, сітка при цьому порожня)
  const currentFree = futureOnly(setup.date, baseFor(setup.date, template, ov)).filter(
    (t) => !booked.has(t)
  );

  return editOrIgnore(
    `📅 <b>${prettyDate(setup.date)}</b> (${setup.date})\n` +
      `Зараз на сайті: <i>${rangesText(currentFree)}</i>\n\n` +
      `Оберіть години, коли вам зручно працювати в цей день, і натисніть «💾 ЗБЕРЕГТИ ДЕНЬ». ` +
      `Збережений вибір замінить поточні години.\n` +
      `🔒 - година вже зайнята клієнтом\n\n` +
      `Обрано: <i>${selected.length ? rangesText(selected) : 'жодної'}</i>`,
    chatId,
    messageId,
    { inline_keyboard: rows }
  );
}

// ----- тижневий шаблон -----
async function renderTemplate(chatId, messageId) {
  const t = await getTemplate();
  const working = WEEKDAYS.filter((d) => t.days[d.idx]).map((d) => d.label);
  const off = WEEKDAYS.filter((d) => !t.days[d.idx]).map((d) => d.label);

  const dayButtons = WEEKDAYS.map((d) => ({
    text: `${t.days[d.idx] ? '✅' : '🚫'} ${d.label}`,
    callback_data: `tpl_day_${d.idx}`,
  }));

  return editOrIgnore(
    `⚙️ <b>Тижневий шаблон</b>\n\n` +
      `🕗 Робочі години: <b>${t.start}–${t.end}</b> (крок ${STEP_MIN} хв)\n` +
      `✅ Робочі дні: ${working.join(', ') || '—'}\n` +
      `🚫 Вихідні: ${off.join(', ') || '—'}\n\n` +
      `Натисніть на день тижня, щоб перемкнути робочий/вихідний. ` +
      `Зміни діють на всі дні, які ви не змінювали вручну. Записи клієнтів не зачіпаються.`,
    chatId,
    messageId,
    {
      inline_keyboard: [
        dayButtons.slice(0, 4),
        dayButtons.slice(4),
        [
          { text: `🕗 Початок: ${t.start}`, callback_data: 'tpl_start' },
          { text: `🕗 Кінець: ${t.end}`, callback_data: 'tpl_end' },
        ],
        [{ text: '« Головне меню', callback_data: 'main_menu' }],
      ],
    }
  );
}

function renderHourPicker(chatId, messageId, kind) {
  const from = kind === 'start' ? 6 : 14;
  const to = kind === 'start' ? 12 : 23;
  const buttons = [];
  for (let h = from; h <= to; h++) {
    const hh = String(h).padStart(2, '0');
    buttons.push({ text: `${hh}:00`, callback_data: `tpl_set${kind}_${hh}` });
  }
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  rows.push([{ text: '« Назад', callback_data: 'tpl_menu' }]);

  return editOrIgnore(
    kind === 'start' ? '🕗 <b>Оберіть час початку роботи:</b>' : '🕗 <b>Оберіть час закінчення роботи:</b>',
    chatId,
    messageId,
    { inline_keyboard: rows }
  );
}

// ----- обробка кнопок -----
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data || '';
  const answer = (opts) => bot.answerCallbackQuery(query.id, opts).catch(() => {});

  try {
    if (!isMaster(chatId)) return answer({ text: '⛔ Немає доступу', show_alert: true });

    if (data === 'noop') return answer({ text: '🔒 На цю годину вже є запис' });

    if (data === 'main_menu') {
      answer();
      return showMainMenu(chatId, messageId);
    }

    // --- записи ---
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
      // година стає вільною автоматично: розклад = шаблон/виняток мінус записи
      const b = await bookings.findOneAndDelete({ _id: new ObjectId(id) });
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

    // --- розклад ---
    if (data === 'view_schedule') {
      answer();
      return showSchedule(chatId, messageId);
    }

    if (data === 'step_days') {
      answer();
      delete masterSetup[chatId];
      return renderDayPicker(chatId, messageId);
    }

    if (data.startsWith('pickday_')) {
      answer();
      const date = data.replace('pickday_', '');
      const w = await loadWindow();
      if (!w.dates.includes(date)) return renderDayPicker(chatId, messageId);
      // сітка починається порожньою: мастер сам обирає зручні години
      masterSetup[chatId] = { date, times: [] };
      return renderDay(chatId, messageId);
    }

    if (data === 'sel_all' || data === 'sel_none') {
      const setup = masterSetup[chatId];
      if (!setup) return answer({ text: 'Оберіть день ще раз', show_alert: true });
      answer();
      if (data === 'sel_none') setup.times = [];
      else {
        const t = await getTemplate();
        setup.times = futureOnly(setup.date, slotsBetween(t.start, t.end));
      }
      return renderDay(chatId, messageId);
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
      return renderDay(chatId, messageId);
    }

    if (data === 'save_day') {
      const setup = masterSetup[chatId];
      if (!setup) return answer({ text: 'Оберіть день ще раз', show_alert: true });
      if (setup.times.length === 0) {
        return answer({
          text: '⚠️ Оберіть хоча б одну годину або натисніть «Зробити вихідним».',
          show_alert: true,
        });
      }
      answer();

      // години з записами зберігаємо в списку, щоб після скасування запису година повернулась
      const bks = await bookings.find({ date: setup.date }).toArray();
      const bookedTimes = bks.map((b) => b.time);
      const times = [...new Set([...setup.times, ...bookedTimes])].sort();

      await overrides.updateOne(
        { _id: setup.date },
        { $set: { closed: false, times } },
        { upsert: true }
      );
      const selected = [...setup.times].sort();
      const date = setup.date;
      delete masterSetup[chatId];

      return editOrIgnore(
        `✅ <b>${prettyDate(date)} збережено!</b>\n\n⏰ Відкрито: ${rangesText(selected)}`,
        chatId,
        messageId,
        {
          inline_keyboard: [
            [{ text: '✏️ Інші дні', callback_data: 'step_days' }],
            [{ text: '« Головне меню', callback_data: 'main_menu' }],
          ],
        }
      );
    }

    if (data === 'day_off') {
      const setup = masterSetup[chatId];
      if (!setup) return answer({ text: 'Оберіть день ще раз', show_alert: true });
      answer();
      const date = setup.date;
      await overrides.updateOne(
        { _id: date },
        { $set: { closed: true }, $unset: { times: '' } },
        { upsert: true }
      );
      const bk = await bookings.countDocuments({ date });
      delete masterSetup[chatId];
      return editOrIgnore(
        `🚫 <b>${prettyDate(date)} — вихідний.</b>\n\nЗапис на сайті на цей день закрито.` +
          (bk ? `\n\n⚠️ На цей день уже є записів: <b>${bk}</b>. Вони залишились - перегляньте їх у «📋 Записи клієнтів».` : ''),
        chatId,
        messageId,
        {
          inline_keyboard: [
            [{ text: '✏️ Інші дні', callback_data: 'step_days' }],
            [{ text: '« Головне меню', callback_data: 'main_menu' }],
          ],
        }
      );
    }

    if (data === 'day_reset') {
      const setup = masterSetup[chatId];
      if (!setup) return answer({ text: 'Оберіть день ще раз', show_alert: true });
      answer();
      const date = setup.date;
      await overrides.deleteOne({ _id: date });
      delete masterSetup[chatId];
      return editOrIgnore(
        `↩️ <b>${prettyDate(date)} повернено за тижневим шаблоном.</b>`,
        chatId,
        messageId,
        {
          inline_keyboard: [
            [{ text: '✏️ Інші дні', callback_data: 'step_days' }],
            [{ text: '« Головне меню', callback_data: 'main_menu' }],
          ],
        }
      );
    }

    // --- тижневий шаблон ---
    if (data === 'tpl_menu') {
      answer();
      return renderTemplate(chatId, messageId);
    }

    if (data.startsWith('tpl_day_')) {
      answer();
      const i = Number(data.replace('tpl_day_', ''));
      if (!(i >= 0 && i <= 6)) return;
      const t = await getTemplate();
      const days = [...t.days];
      days[i] = !days[i];
      await settings.updateOne({ _id: 'template' }, { $set: { days } }, { upsert: true });
      return renderTemplate(chatId, messageId);
    }

    if (data === 'tpl_start') {
      answer();
      return renderHourPicker(chatId, messageId, 'start');
    }

    if (data === 'tpl_end') {
      answer();
      return renderHourPicker(chatId, messageId, 'end');
    }

    if (data.startsWith('tpl_setstart_')) {
      const start = `${data.replace('tpl_setstart_', '')}:00`;
      const t = await getTemplate();
      if (toMin(start) >= toMin(t.end)) {
        return answer({ text: '⚠️ Початок має бути раніше за кінець роботи', show_alert: true });
      }
      answer();
      await settings.updateOne({ _id: 'template' }, { $set: { start } }, { upsert: true });
      return renderTemplate(chatId, messageId);
    }

    if (data.startsWith('tpl_setend_')) {
      const end = `${data.replace('tpl_setend_', '')}:00`;
      const t = await getTemplate();
      if (toMin(end) <= toMin(t.start)) {
        return answer({ text: '⚠️ Кінець має бути пізніше за початок роботи', show_alert: true });
      }
      answer();
      await settings.updateOne({ _id: 'template' }, { $set: { end } }, { upsert: true });
      return renderTemplate(chatId, messageId);
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
  settings = db.collection('settings');
  overrides = db.collection('overrides');
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
