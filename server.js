require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { Telegraf, Markup } = require('telegraf');


const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://method-e6c6c-default-rtdb.firebaseio.com"
});

const database = admin.database();
const token = process.env.TELEGRAM_TOKEN;
const webAppUrl = 'https://method-e6c6c.web.app';
const bot = new Telegraf(token);

const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 5000 // ограничение каждого IP до 100 запросов за windowMs
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 100 // ограничение каждого IP до 25 запросов на аутентификацию за час
});

// Применяем этот лимитер только к маршрутам, начинающимся с /auth
app.use('/auth', authLimiter);

// Применяем ограничение ко всем запросам
app.use(limiter);

const updateBalanceLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 500 // ограничение каждого IP до 10 запросов на обновление баланса за час
});

// Функция защиты
function verifyTelegramData(telegramData) {
    const secret = crypto.createHash('sha256')
        .update(token)
        .digest();
    const dataCheckString = Object.keys(telegramData)
        .filter(key => key !== 'hash')
        .sort()
        .map(key => `${key}=${telegramData[key]}`)
        .join('\n');
    const hmac = crypto.createHmac('sha256', secret)
        .update(dataCheckString)
        .digest('hex');
    return hmac === telegramData.hash;
}

// Роут аутентификации
app.post('/auth', (req, res) => {
    const telegramData = req.body;
    if (verifyTelegramData(telegramData)) {
        const token = crypto.randomBytes(64).toString('hex');
        // Сохраняем токен в Firebase
        database.ref(`users/${telegramData.id}`).set(token);
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
});

// Добавляем новые функции для работы с базой данных
async function getUserData(telegramId) {
  const snapshot = await database.ref(`users/${telegramId}`).once('value');
  return snapshot.exists() ? snapshot.val() : null;
}

async function createUser(telegramId, telegramUsername) {
  const userData = {
    telegramId: telegramId,
    telegramUsername: telegramUsername,
    totalFarmed: 0,
    mthtotalfarmed: 0,
    ticketBalance: 1,
    clickCount: 0,
    lastClickTime: 0,
    friendsCount: 0,
    bonusEndTime: 0,
    farmingState: {
      isActive: false,
      startTime: null,
      endTime: null
    }
  };

  await database.ref(`users/${telegramId}`).set(userData);
}

async function getUserReferralLink(telegramId) {
  const userSnapshot = await database.ref(`users/${telegramId}`).once('value');
  
  if (userSnapshot.exists() && userSnapshot.val().referralCode) {
    return `https://t.me/${bot.botInfo.username}?start=${userSnapshot.val().referralCode}`;
  } else {
    const referralCode = Math.random().toString(36).substring(2, 15);
    await database.ref(`users/${telegramId}/referralCode`).set(referralCode);
    await database.ref(`inviteCodes/${referralCode}`).set({
      telegramId: telegramId,
      createdAt: Date.now()
    });
    return `https://t.me/${bot.botInfo.username}?start=${referralCode}`;
  }
}

// Обработчики команд бота
bot.command('start', async (ctx) => {
  try {
    console.log('/start command called');
    const user = ctx.message.from;
    const telegramId = user.id.toString();
    const telegramUsername = user.username;
    const startPayload = ctx.message.text.split(' ')[1];

    console.log('Payload:', startPayload);

    let userData = await getUserData(telegramId);
    console.log('User data from Firebase:', userData);

    // Обновляем username, если он изменился
    if (userData && userData.telegramUsername !== telegramUsername) {
      await database.ref(`users/${telegramId}`).update({ telegramUsername: telegramUsername });
    }

    if (!userData) {
      await createUser(telegramId, telegramUsername);
      userData = await getUserData(telegramId);

      if (startPayload) {
        const inviterSnapshot = await database.ref(`inviteCodes/${startPayload}`).once('value');
        if (inviterSnapshot.exists()) {
          const inviterId = inviterSnapshot.val().telegramId;
          await database.ref(`users/${inviterId}/friendsCount`).transaction(count => (count || 0) + 1);
          await database.ref(`users/${telegramId}/invitedBy`).set(inviterId);
          console.log(`User ${telegramId} was invited by ${inviterId}`);
        }
      }
    }

    const enterButton = Markup.button.webApp('Join to Method', `${webAppUrl}?telegramId=${telegramId}`);
    const referralButton = Markup.button.callback('Invite Friends', 'generate_referral');

    await ctx.reply(
      'Добро пожаловать в Method! ☑️\n\n' +
      'Вот что вы можете сделать с Method прямо сейчас:\n\n' +
      '📊 Farm $MTHC: Начинайте фармить $MTHC, чтобы в будущем обменять валюту на наш токен $MTH или же $TON\n' +
      '🤖 Приглашайте друзей: Приведите своих друзей и родственников, чтобы получить больше $MTHC! Больше друзей = больше $MTHC\n' +
      '✅ Выполняйте задания: Завершайте задачи и зарабатывайте еще больше $MTHC!\n\n' +
      'Начните зарабатывать $MTHC уже сейчас, и, возможно, в будущем вас ждут удивительные награды! 🚀\n\n' +
      'Оставайтесь с METHOD!💎', 
      Markup.inlineKeyboard([
        [enterButton],
        [referralButton]
      ])
    );
  } catch (error) {
    console.error('Error with /start command:', error);
    ctx.reply('An error occurred while processing your request. Please try again later.');
  }
});

bot.action('generate_referral', async (ctx) => {
  try {
    const user = ctx.from;
    const telegramId = user.id.toString();
    const referralLink = await getUserReferralLink(telegramId);

    const shareText = encodeURIComponent(`Join the METHOD with me and earn $MTHC -`);
    const shareUrl = `https://t.me/share/url?text=${shareText}&url=${referralLink}`;

    await ctx.answerCbQuery();
    await ctx.reply(`Your referral link: ${referralLink}`, Markup.inlineKeyboard([
      [Markup.button.url('Share a link', shareUrl)]
    ]));
  } catch (error) {
    console.error('Error when generating a referral link:', error);
    ctx.answerCbQuery('An error occurred while generating the referral link.');
  }
});

// Запуск бота
bot.launch().then(() => {
  console.log('The bot has been successfully launched');
}).catch((err) => {
  console.error('Error when launching the bot', err);
});

// Обработка ошибок бота
bot.catch((err) => {
  console.log('Oops, there was an error in the bot:', err);
});

app.post('/botWebhook', (req, res) => {
    bot.handleUpdate(req.body, res);
  });
  
  app.get('/getUserData', async (req, res) => {
    const telegramId = req.query.telegramId || (req.user && req.user.telegramId);
    if (!telegramId) {
        return res.status(400).json({ error: 'Telegram ID не предоставлен' });
    }
    try {
        const userData = await getUserData(telegramId);
        if (userData) {
            res.json(userData);
        } else {
            res.status(404).json({ error: 'Пользователь не найден' });
        }
    } catch (error) {
        console.error('Ошибка при получении данных пользователя:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

app.post('/createUser', async (req, res) => {
    const { telegramId, telegramUsername } = req.body;
    if (!telegramId || !telegramUsername) {
        return res.status(400).json({ error: 'Не предоставлены telegramId или telegramUsername' });
    }
    try {
        await createUser(telegramId, telegramUsername);
        res.sendStatus(200);
    } catch (error) {
        console.error('Ошибка при создании пользователя:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

app.get('/getUserReferralLink', async (req, res) => {
    const telegramId = req.query.telegramId || (req.user && req.user.telegramId);
    if (!telegramId) {
        return res.status(400).json({ error: 'Telegram ID не предоставлен' });
    }
    try {
        const referralLink = await getUserReferralLink(telegramId);
        res.json({ referralLink });
    } catch (error) {
        console.error('Ошибка при получении реферальной ссылки:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});
  
//логирование для отладки
  app.get('/', (req, res) => {
    res.status(200).send('Server is running');
  });
  console.log('Starting server...');

 const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', (err) => {
  if (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
  console.log(`Server running on port ${port}`);
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});


  