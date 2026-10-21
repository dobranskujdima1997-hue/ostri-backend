const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MASTER_CHAT_ID = process.env.MASTER_CHAT_ID;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Збереження розкладу
let schedule = {};

// Стан користувача для очікування тексту
let userStates = {};

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

// Керування ботом
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  if (MASTER_CHAT_ID && chatId.toString() !== MASTER_CHAT_ID.toString()) {
    return bot.sendMessage(chatId, "⛔ У вас немає доступу до керування OSTRI.");
  }

  showMainMenu(chatId);
});

function showMainMenu(chatId) {
  bot.sendMessage(chatId, "👋 **Панель керування розкладом OSTRI**\n\nОберіть дію:", {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Переглянути розклад", callback_data: "view_schedule" }],
        [{ text: "➕ Додати час", callback_data: "add_time_prompt" }],
        [{ text: "❌ Очистити весь розклад", callback_data: "clear_schedule" }]
      ]
    }
  });
}

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "view_schedule") {
    let msg = "📅 **Поточний відкритий розклад:**\n\n";
    if (Object.keys(schedule).length === 0) {
      msg += "❌ Немає відкритих дат.";
    } else {
      for (const [date, times] of Object.entries(schedule)) {
        msg += `📌 **${date}**: ${times.join(', ')}\n`;
      }
    }
    bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  }

  if (data === "add_time_prompt") {
    userStates[chatId] = 'awaiting_add';
    const today = new Date().toISOString().split('T')[0];
    bot.sendMessage(
      chatId,
      `Надішліть дату і години у форматі:\n\`${today} 10:00, 11:00, 14:00, 16:00\`\n\n(або декілька годин через кому):`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data === "clear_schedule") {
    schedule = {};
    bot.sendMessage(chatId, "🗑️ Всі дати й години успішно видалено!");
  }
});

// Обробка звичайного тексту від Колі
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  if (text.startsWith('/')) return;

  if (userStates[chatId] === 'awaiting_add' || text.match(/^\d{4}-\d{2}-\d{2}/)) {
    // Приклад тексту: "2026-10-21 10:00, 11:00, 14:00"
    const parts = text.split(' ');
    const date = parts[0];
    const timesRaw = parts.slice(1).join(' ');

    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return bot.sendMessage(chatId, "⚠️ Невірний формат дати. Вкажіть у форматі YYYY-MM-DD (наприклад, 2026-10-21).");
    }

    const times = timesRaw.split(',').map(t => t.trim()).filter(t => t.length > 0);

    if (times.length === 0) {
      return bot.sendMessage(chatId, "⚠️ Вкажіть хоча б одну годину! Наприклад:\n`2026-10-21 11:00, 12:00, 15:00`", { parse_mode: 'Markdown' });
    }

    if (!schedule[date]) schedule[date] = [];
    times.forEach(t => {
      if (!schedule[date].includes(t)) schedule[date].push(t);
    });
    schedule[date].sort();

    delete userStates[chatId];

    bot.sendMessage(chatId, `✅ **Успішно додано!**\n\n📅 **${date}**: ${schedule[date].join(', ')}`, { parse_mode: 'Markdown' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
