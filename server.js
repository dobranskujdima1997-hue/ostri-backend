const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MASTER_CHAT_ID = process.env.MASTER_CHAT_ID;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Збереження розкладу: { "YYYY-MM-DD": ["10:00", "10:15", ...] }
let schedule = {};

// Тимчасовий вибір Колі під час налаштування дня: { chatId: { date: '2026-10-21', times: ['10:00', '12:15'] } }
let masterSetup = {};

// API для сайту
app.get('/api/schedule', (req, res) => {
  res.json(schedule);
});

app.post('/api/book', (req, res) => {
  const { date, time, clientName, clientPhone, service } = req.body;

  if (schedule[date] && schedule[date].includes(time)) {
    schedule[date] = schedule[date].filter(t => t !== time);
    if (schedule[date].length === 0) delete schedule[date];

    if (MASTER_CHAT_ID) {
      bot.sendMessage(
        MASTER_CHAT_ID,
        `🔔 **НОВИЙ ЗАПИС!**\n\n` +
        `👤 **Клієнт:** ${clientName}\n` +
        `📞 **Тел:** ${clientPhone}\n` +
        `✂️ **Послуга:** ${service}\n` +
        `📅 **Дата:** ${date}\n` +
        `⏰ **Час:** ${time}`,
        { parse_mode: 'Markdown' }
      );
    }
    return res.json({ success: true });
  } else {
    return res.status(400).json({ success: false, message: 'Цей час уже зайнятий.' });
  }
});

// --- TELEGRAM БОТ ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (MASTER_CHAT_ID && chatId.toString() !== MASTER_CHAT_ID.toString()) {
    return bot.sendMessage(chatId, "⛔ У вас немає доступу.");
  }
  showMainMenu(chatId);
});

function showMainMenu(chatId) {
  bot.sendMessage(chatId, "✂️ **Панель керування OSTRI**\n\nОберіть дію:", {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Переглянути розклад", callback_data: "view_schedule" }],
        [{ text: "➕ Налаштувати вільні години на день", callback_data: "step_7_days" }],
        [{ text: "🗑️ Очистити весь розклад", callback_data: "clear_schedule" }]
      ]
    }
  });
}

// Генерація 7 днів уперед
function getNext7Days() {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    
    let label = dateStr;
    if (i === 0) label = `Сьогодні (${dateStr})`;
    else if (i === 1) label = `Завтра (${dateStr})`;

    days.push({ text: label, date: dateStr });
  }
  return days;
}

// Генерація слотів з кроком 15 хв від 09:00 до 20:00
function generateTimeSlots() {
  const slots = [];
  for (let hour = 9; hour <= 20; hour++) {
    for (let min = 0; min < 60; min += 15) {
      // Зупиняємось о 20:00
      if (hour === 20 && min > 0) break;
      const hStr = hour.toString().padStart(2, '0');
      const mStr = min.toString().padStart(2, '0');
      slots.push(`${hStr}:${mStr}`);
    }
  }
  return slots;
}

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;

  if (data === "view_schedule") {
    let msg = "📅 **Поточний розклад:**\n\n";
    if (Object.keys(schedule).length === 0) {
      msg += "❌ Немає відкритих дат.";
    } else {
      for (const [date, times] of Object.entries(schedule)) {
        msg += `📌 **${date}**: ${times.join(', ')}\n`;
      }
    }
    bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    return;
  }

  if (data === "clear_schedule") {
    schedule = {};
    bot.sendMessage(chatId, "🗑️ Весь розклад успішно очищено!");
    showMainMenu(chatId);
    return;
  }

  // Показуємо 7 днів на вибір
  if (data === "step_7_days") {
    const days = getNext7Days();
    const keyboard = days.map(item => [{ text: item.text, callback_data: `pickday_${item.date}` }]);
    keyboard.push([{ text: "« Головне меню", callback_data: "main_menu" }]);

    bot.editMessageText("📅 **Оберіть день (на 7 днів уперед):**", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  if (data === "main_menu") {
    bot.deleteMessage(chatId, messageId).catch(() => {});
    showMainMenu(chatId);
    return;
  }

  // Коли день обрано — відкриваємо сітку часу з кроком 15 хв
  if (data.startsWith("pickday_")) {
    const date = data.replace("pickday_", "");
    // Ініціалізуємо поточний вибір для цього дня (якщо вже щось було — підтягуємо)
    masterSetup[chatId] = {
      date: date,
      times: schedule[date] ? [...schedule[date]] : []
    };
    renderTimeGrid(chatId, messageId);
    return;
  }

  // Клік по конкретній годині (вмикає/вимикає її)
  if (data.startsWith("time_")) {
    const time = data.replace("time_", "");
    if (!masterSetup[chatId]) return;

    const timesArr = masterSetup[chatId].times;
    if (timesArr.includes(time)) {
      // Видаляємо, якщо вже була
      masterSetup[chatId].times = timesArr.filter(t => t !== time);
    } else {
      // Додаємо
      timesArr.push(time);
      timesArr.sort();
    }

    renderTimeGrid(chatId, messageId);
    return;
  }

  // Збереження обраних годин для цього дня
  if (data === "save_day_schedule") {
    const setup = masterSetup[chatId];
    if (!setup || setup.times.length === 0) {
      bot.answerCallbackQuery(query.id, { text: "⚠️ Оберіть хоча б одну годину!", show_alert: true });
      return;
    }

    schedule[setup.date] = [...setup.times].sort();
    delete masterSetup[chatId];

    bot.editMessageText(`✅ **Розклад на ${setup.date} успішно збережено!**\n\n⏰ Доступні години: ${schedule[setup.date].join(', ')}`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown'
    });

    setTimeout(() => showMainMenu(chatId), 2000);
    return;
  }
});

// Функція малювання сітки годин (по 4 в рядок для зручності)
function renderTimeGrid(chatId, messageId) {
  const setup = masterSetup[chatId];
  if (!setup) return;

  const allSlots = generateTimeSlots();
  const selectedTimes = setup.times;

  let keyboardRows = [];
  let currentRow = [];

  allSlots.forEach(slot => {
    const isSelected = selectedTimes.includes(slot);
    // Якщо година обрана — ставимо галочку, якщо ні — просто час
    const text = isSelected ? `✅ ${slot}` : `⏳ ${slot}`;

    currentRow.push({ text: text, callback_data: `time_${slot}` });

    if (currentRow.length === 4) {
      keyboardRows.push(currentRow);
      currentRow = [];
    }
  });

  if (currentRow.length > 0) {
    keyboardRows.push(currentRow);
  }

  // Додаємо кнопки збереження та повернення
  keyboardRows.push([
    { text: "💾 ЗБЕРЕГТИ ЦЕЙ ДЕНЬ", callback_data: "save_day_schedule" }
  ]);
  keyboardRows.push([
    { text: "« Змінити день", callback_data: "step_7_days" }
  ]);

  bot.editMessageText(
    `📅 День: **${setup.date}**\n\n` +
    `Натискайте на години, щоб **увімкнути/вимкнути** їх (крок 15 хв):\n` +
    `Обрано: *${selectedTimes.length > 0 ? selectedTimes.join(', ') : 'жодної'}*`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboardRows }
    }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
