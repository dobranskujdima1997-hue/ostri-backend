const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const MASTER_CHAT_ID = process.env.MASTER_CHAT_ID;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let schedule = {};
let masterSetup = {};

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
        `🚨 <b>НОВИЙ ЗАПИС НА САЙТІ!</b>\n\n` +
        `👤 <b>Клієнт:</b> ${clientName}\n` +
        `📞 <b>Тел:</b> ${clientPhone}\n` +
        `✂️ <b>Послуга:</b> ${service}\n` +
        `📅 <b>Дата:</b> ${date}\n` +
        `⏰ <b>Час:</b> ${time}`,
        { parse_mode: 'HTML' }
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
  showMainMenu(chatId, msg.message_id);
});

function showMainMenu(chatId, messageId = null) {
  const text = "✂️ <b>ПАНЕЛЬ КЕРУВАННЯ OSTRI</b>\n\nОберіть потрібну дію нижче:";
  const reply_markup = {
    inline_keyboard: [
      [{ text: "📅 Переглянути поточний розклад", callback_data: "view_schedule" }],
      [{ text: "➕ Налаштувати години на день", callback_data: "step_7_days" }],
      [{ text: "🗑️ Очистити весь розклад", callback_data: "clear_schedule" }]
    ]
  };

  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup }).catch(() => {
      bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
    });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
  }
}

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

function generateTimeSlots() {
  const slots = [];
  for (let hour = 9; hour <= 20; hour++) {
    for (let min = 0; min < 60; min += 15) {
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
    let msg = "📅 <b>Поточний розклад:</b>\n\n";
    if (Object.keys(schedule).length === 0) {
      msg += "❌ Немає відкритих дат.";
    } else {
      for (const [date, times] of Object.entries(schedule)) {
        msg += `📌 <b>${date}</b>: ${times.join(', ')}\n`;
      }
    }
    bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: "« Головне меню", callback_data: "main_menu" }]]
      }
    }).catch(() => {});
    return;
  }

  if (data === "clear_schedule") {
    schedule = {};
    bot.editMessageText("🗑️ <b>Весь розклад успішно очищено!</b>", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: "« Головне меню", callback_data: "main_menu" }]]
      }
    }).catch(() => {});
    return;
  }

  if (data === "step_7_days") {
    const days = getNext7Days();
    const keyboard = days.map(item => [{ text: item.text, callback_data: `pickday_${item.date}` }]);
    keyboard.push([{ text: "« Головне меню", callback_data: "main_menu" }]);

    bot.editMessageText("📅 <b>Оберіть день для налаштування:</b>", {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {});
    return;
  }

  if (data === "main_menu") {
    showMainMenu(chatId, messageId);
    return;
  }

  if (data.startsWith("pickday_")) {
    const date = data.replace("pickday_", "");
    masterSetup[chatId] = {
      date: date,
      times: schedule[date] ? [...schedule[date]] : []
    };
    renderTimeGrid(chatId, messageId);
    return;
  }

  if (data.startsWith("time_")) {
    const time = data.replace("time_", "");
    if (!masterSetup[chatId]) return;

    const timesArr = masterSetup[chatId].times;
    if (timesArr.includes(time)) {
      masterSetup[chatId].times = timesArr.filter(t => t !== time);
    } else {
      timesArr.push(time);
      timesArr.sort();
    }

    renderTimeGrid(chatId, messageId);
    return;
  }

  if (data === "save_day_schedule") {
    const setup = masterSetup[chatId];
    if (!setup || setup.times.length === 0) {
      bot.answerCallbackQuery(query.id, { text: "⚠️ Оберіть хоча б одну годину!", show_alert: true });
      return;
    }

    schedule[setup.date] = [...setup.times].sort();
    delete masterSetup[chatId];

    bot.editMessageText(`✅ <b>Розклад на ${setup.date} успішно збережено!</b>\n\n⏰ Доступні години: ${schedule[setup.date].join(', ')}`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: "« Головне меню", callback_data: "main_menu" }]]
      }
    }).catch(() => {});
    return;
  }
});

function renderTimeGrid(chatId, messageId) {
  const setup = masterSetup[chatId];
  if (!setup) return;

  const allSlots = generateTimeSlots();
  const selectedTimes = setup.times;

  let keyboardRows = [];
  let currentRow = [];

  allSlots.forEach(slot => {
    const isSelected = selectedTimes.includes(slot);
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

  keyboardRows.push([
    { text: "💾 ЗБЕРЕГТИ ДЕНЬ", callback_data: "save_day_schedule" }
  ]);
  keyboardRows.push([
    { text: "« Назад до днів", callback_data: "step_7_days" }
  ]);

  bot.editMessageText(
    `📅 День: <b>${setup.date}</b>\n\n` +
    `Натискайте на години, щоб увімкнути/вимкнути їх:\n` +
    `Обрано: <i>${selectedTimes.length > 0 ? selectedTimes.join(', ') : 'жодної'}</i>`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboardRows }
    }
  ).catch(() => {});
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
