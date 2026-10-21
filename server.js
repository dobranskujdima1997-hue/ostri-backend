const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

// НАЛАШТУВАННЯ
const BOT_TOKEN = process.env.BOT_TOKEN || 'ТВІЙ_TELEGRAM_BOT_TOKEN';
const MASTER_CHAT_ID = process.env.MASTER_CHAT_ID; // Chat ID Колі

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Збереження розкладу в пам’яті (або у файлі/базі)
// Формат: { "YYYY-MM-DD": ["10:00", "11:00", "14:00"] }
let schedule = {};

// === API ДЛЯ САЙТУ ===

// Сайт запитує вільний розклад
app.get('/api/schedule', (req, res) => {
  res.json(schedule);
});

// Запис клієнта (коли клієнт забронював час на сайті)
app.post('/api/book', (req, res) => {
  const { date, time, clientName, clientPhone, service } = req.body;

  if (schedule[date] && schedule[date].includes(time)) {
    // Видаляємо заброньований час
    schedule[date] = schedule[date].filter(t => t !== time);

    // Сповіщаємо Колю в Telegram
    if (MASTER_CHAT_ID) {
      bot.sendMessage(
        MASTER_CHAT_ID,
        `🔔 **НОВИЙ ЗАПИС!**\n\n` +
        `👤 **Клієнт:** ${clientName}\n` +
        `📞 **Тел:** ${clientPhone}\n` +
        `✂️ **Послуга:** ${service}\n` +
        `📅 **Дата:** ${date}\n` +
        `⏰ **Час:** ${time}`
      );
    }
    return res.json({ success: true });
  } else {
    return res.status(400).json({ success: false, message: 'Цей час уже зайнятий або недоступний.' });
  }
});

// === TELEGRAM БОТ ДЛЯ КОЛІ ===

const STANDARD_TIMES = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  
  // Авторизація майстра
  if (MASTER_CHAT_ID && chatId.toString() !== MASTER_CHAT_ID.toString()) {
    return bot.sendMessage(chatId, "Ви не маєте доступу до керування цим ботом.");
  }

  bot.sendMessage(chatId, "👋 Привіт, Коля! Обери дію в меню нижче:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Переглянути розклад", callback_data: "view_schedule" }],
        [{ text: "➕ Додати час", callback_data: "add_time" }],
        [{ text: "❌ Видалити час", callback_data: "remove_time" }]
      ]
    }
  });
});

// Обробка кнопок
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "view_schedule") {
    let msg = "📅 **Поточний розклад:**\n\n";
    if (Object.keys(schedule).length === 0) {
      msg += "Немає відкритих дат.";
    } else {
      for (const [date, times] of Object.entries(schedule)) {
        msg += `• **${date}**: ${times.join(', ') || 'немає вільного часу'}\n`;
      }
    }
    bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  }

  if (data === "add_time") {
    // Пропонуємо вибір дати (наприклад, сьогодні/завтра)
    const today = new Date().toISOString().split('T')[0];
    bot.sendMessage(chatId, `Обери або вкажи дату у форматі YYYY-MM-DD (наприклад, ${today}):`, {
      reply_markup: {
        force_reply: true
      }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
