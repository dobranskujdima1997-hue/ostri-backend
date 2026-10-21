const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MASTER_CHAT_ID = process.env.MASTER_CHAT_ID;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Збереження розкладу: { "YYYY-MM-DD": ["10:00", "11:00", ...] }
let schedule = {};

// Тимчасова пам'ять для збереження вибору Колі під час кліків по кнопках
let masterFlow = {};

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
  bot.sendMessage(chatId, "✂️ **Керування розкладом OSTRI**\n\nОберіть дію:", {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "📅 Переглянути розклад", callback_data: "view_schedule" }],
        [{ text: "➕ Додати робочий день / години", callback_data: "step_select_date" }],
        [{ text: "🗑️ Очистити весь розклад", callback_data: "clear_schedule" }]
      ]
    }
  });
}

// Допоміжна функція для отримання дат (Сьогодні, Завтра, післязавтра)
function getQuickDates() {
  const dates = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateString = d.toISOString().split('T')[0];
    
    let label = dateString;
    if (i === 0) label = `Сьогодні (${dateString})`;
    else if (i === 1) label = `Завтра (${dateString})`;
    
    dates.push({ text: label, date: dateString });
  }
  return dates;
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

  // Крок 1: Вибір дати кнопками
  if (data === "step_select_date") {
    const quickDates = getQuickDates();
    const keyboard = quickDates.map(item => [{ text: item.text, callback_data: `date_${item.date}` }]);
    keyboard.push([{ text: "« Головне меню", callback_data: "main_menu" }]);

    bot.editMessageText("📅 **Оберіть день для роботи:**", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // Повернення в головне меню
  if (data === "main_menu") {
    bot.deleteMessage(chatId, messageId).catch(() => {});
    showMainMenu(chatId);
    return;
  }

  // Крок 2: Дата обрана, пропонуємо готові набори годин або повний день
  if (data.startsWith("date_")) {
    const selectedDate = data.replace("date_", "");
    masterFlow[chatId] = { date: selectedDate };

    bot.editMessageText(`📅 Обрана дата: **${selectedDate}**\n\nОберіть готові години або стандартний повний день:`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚡ Повний день (09:00 - 19:00)", callback_data: "set_full_day" }],
          [{ text: "🌅 Тільки перша половина (09:00 - 14:00)", callback_data: "set_morning" }],
          [{ text: "🌇 Тільки друга половина (14:00 - 19:00)", callback_data: "set_evening" }],
          [{ text: "« Назад до вибору дат", callback_data: "step_select_date" }]
        ]
      }
    });
    return;
  }

  // Швидке додавання повного дня (з інтервалом в 1 годину)
  if (data === "set_full_day" || data === "set_morning" || data === "set_evening") {
    const selectedDate = masterFlow[chatId] ? masterFlow[chatId].date : null;
    if (!selectedDate) {
      bot.sendMessage(chatId, "⚠️ Сталася помилка. Почніть спочатку з /start");
      return;
    }

    let times = [];
    if (data === "set_full_day") {
      times = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
    } else if (data === "set_morning") {
      times = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"];
    } else if (data === "set_evening") {
      times = ["14:00", "15:00", "16:00", "17:00", "18:00", "19:00"];
    }

    if (!schedule[selectedDate]) schedule[selectedDate] = [];
    times.forEach(t => {
      if (!schedule[selectedDate].includes(t)) schedule[selectedDate].push(t);
    });
    schedule[selectedDate].sort();

    delete masterFlow[chatId];

    bot.editMessageText(`✅ **Успішно додано!**\n\n📅 **${selectedDate}**\n⏰ Години: ${times.join(', ')}`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown'
    });

    setTimeout(() => showMainMenu(chatId), 2000);
    return;
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
