require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { Telegraf, Markup } = require('telegraf');
const TonWeb = require('tonweb');
const { tonweb, createWallet, generateKeyPair, IS_TESTNET, TONCENTER_API_KEY, INDEX_API_URL, NODE_API_URL } = require('./common.js');
const BlockSubscriptionIndex = require('./block/BlockSubscriptionIndex');
const BN = TonWeb.utils.BN;
const { Cell, Transaction } = TonWeb.boc;
   const cors = require('cors');


const MY_HOT_WALLET_ADDRESS = 'UQA1vA2bxiZinSSAVLXObmjWiDwMlkZx7kDmHQdypYMUqquT';

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.json());
// В начале файла, после создания приложения express
app.use(cors({
  origin: 'https://method-e6c6c.web.app',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

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

app.get('/getTonWebConfig', (req, res) => {
  res.json({
      IS_TESTNET,
      NODE_API_URL,
      INDEX_API_URL
  });
});

async function generateDepositAddress(telegramId) {
  console.log('Generating deposit address for Telegram ID:', telegramId);
  try {
    const keyPair = await createKeyPair();
    console.log('Key pair generated');
    const { wallet, address } = await createWallet(keyPair);
    console.log('Wallet created, address:', address);
    
    // Сохраняем keyPair и address в базу данных, связав с telegramId
    await database.ref('users/' + telegramId).update({
      wallet: {
        publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
        secretKey: Buffer.from(keyPair.secretKey).toString('hex'),
        address: address
      }
    });
    console.log('Wallet info saved to database');
    return address;
  } catch (error) {
    console.error('Error generating deposit address:', error);
    throw error;
  }
}

async function checkTransactionStatus(transaction) {
  try {
    // Получаем хэш транзакции
    const transactionHash = transaction.hash().toString('hex');
    
    // Получаем информацию о транзакции из сети TON
    const transactionInfo = await tonweb.provider.getTransactions(transaction.inMessage.source, 1, transactionHash);
    
    if (transactionInfo && transactionInfo.length > 0) {
      const tx = transactionInfo[0];
      
      // Проверяем, что транзакция соответствует ожидаемой
      if (tx.in_msg.source === transaction.inMessage.source.toFriendly() &&
          tx.in_msg.destination === transaction.inMessage.destination.toFriendly() &&
          tx.in_msg.value === transaction.inMessage.value.toString()) {
        
        // Проверяем статус транзакции
        if (tx.status === 3) { // 3 означает "финализированная" транзакция
          console.log(`Transaction ${transactionHash} is confirmed`);
          return 'confirmed';
        } else {
          console.log(`Transaction ${transactionHash} is still pending`);
          return 'pending';
        }
      } else {
        console.log(`Transaction ${transactionHash} does not match expected details`);
        return 'pending';
      }
    } else {
      console.log(`Transaction ${transactionHash} not found`);
      return 'pending';
    }
  } catch (error) {
    console.error(`Error checking transaction status: ${error.message}`);
    return 'pending';
  }
}

async function updateTicketBalance(telegramId, ticketAmount) {
  const userRef = database.ref('users/' + telegramId);
  const newBalance = await userRef.child('ticketBalance').transaction(currentBalance => {
    return (currentBalance || 0) + ticketAmount;
  });
  console.log(`Updated ticket balance for user ${telegramId}: added ${ticketAmount} tickets`);
  return newBalance;
}

app.get('/getDepositAddress', async (req, res) => {
  const telegramId = req.query.telegramId;
  console.log('Received request for deposit address. Telegram ID:', telegramId);
  
  if (!telegramId) {
    console.log('Telegram ID is missing');
    return res.status(400).json({ error: 'Telegram ID is required' });
  }

  try {
    const userRef = database.ref('users/' + telegramId);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    if (userData && userData.wallet && userData.wallet.address) {
      console.log('Existing deposit address found:', userData.wallet.address);
      return res.json({ address: userData.wallet.address });
    }

    const address = await generateDepositAddress(telegramId);
    console.log('New deposit address generated:', address);
    res.json({ address });
  } catch (error) {
    console.error('Error in /getDepositAddress:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.get('/checkPaymentStatus', async (req, res) => {
  const telegramId = req.query.telegramId;
  const userRef = database.ref('users/' + telegramId);
  const snapshot = await userRef.once('value');
  const userData = snapshot.val();
  
  if (userData && userData.pendingPayment) {
      res.json({ status: 'pending' });
  } else if (userData && userData.lastPayment) {
      res.json({ status: 'completed', amount: userData.lastPayment.amount });
  } else {
      res.json({ status: 'no_payment' });
  }
});

// Эндпоинт для проверки статуса транзакции
app.get('/checkTransactionStatus', async (req, res) => {
  const { transactionHash, telegramId, ticketAmount } = req.query;
  
  console.log(`Received request: telegramId=${telegramId}, ticketAmount=${ticketAmount}, transactionHash=${transactionHash}`);
  
  if (!telegramId || isNaN(ticketAmount) || !transactionHash) {
    return res.status(400).json({ error: 'Telegram ID, ticket amount, and transaction hash are required' });
  }

  try {
    // Проверяем статус транзакции в блокчейне TON
    const transactionInfo = await tonweb.provider.getTransactions(MY_HOT_WALLET_ADDRESS, 1, undefined, transactionHash);
    
    if (transactionInfo && transactionInfo.length > 0) {
      const tx = transactionInfo[0];
      if (tx.status === 3) { // 3 означает "финализированная" транзакция
        // Обновляем баланс билетов пользователя
        const newBalance = await updateTicketBalance(telegramId, parseInt(ticketAmount, 10));
        console.log(`Transaction processed successfully. New balance for user ${telegramId}: ${newBalance}`);
        res.json({ status: 'confirmed', newBalance });
      } else {
        res.json({ status: 'pending' });
      }
    } else {
      res.json({ status: 'pending' });
    }
  } catch (error) {
    console.error('Error in check_transaction_status:', error);
    res.status(500).json({ status: 'failed', error: error.message });
  }
});



// Эндпоинт для обновления баланса билетов пользователя
app.post('/updateTicketBalance', async (req, res) => {
  const { telegramId, amount, transactionId } = req.body;
  if (!telegramId || !amount || !transactionId) {
    return res.status(400).json({ error: 'telegramId, amount, and transactionId are required' });
  }

  try {
    // Проверяем, не была ли эта транзакция уже обработана
    const transactionRef = database.ref(`processedTransactions/${transactionId}`);
    const transactionSnapshot = await transactionRef.once('value');
    if (transactionSnapshot.exists()) {
      return res.status(400).json({ error: 'Transaction already processed' });
    }

    // Обновляем баланс билетов пользователя
    const userRef = database.ref(`users/${telegramId}`);
    await userRef.transaction((userData) => {
      if (userData) {
        userData.ticketBalance = (userData.ticketBalance || 0) + amount;
      }
      return userData;
    });

    // Отмечаем транзакцию как обработанную
    await transactionRef.set(true);

    // Получаем обновленный баланс
    const updatedUserSnapshot = await userRef.once('value');
    const newBalance = updatedUserSnapshot.val().ticketBalance;

    res.json({ newBalance });
  } catch (error) {
    console.error('Error updating ticket balance:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function processDeposit(tx) {
  console.log('processDeposit called with transaction:', JSON.stringify(tx, null, 2));

  if (!tx || !tx.in_msg || !tx.in_msg.value) {
    console.log('Invalid transaction structure in processDeposit');
    return;
  }

  const minDepositAmount = TonWeb.utils.toNano('0.01'); // Минимальная сумма депозита
  const depositAmount = new TonWeb.utils.BN(tx.in_msg.value);

  if (depositAmount.lt(minDepositAmount)) {
    console.log(`Deposit amount too small: ${TonWeb.utils.fromNano(depositAmount)} TON`);
    return;
  }

  try {
    const userRef = database.ref('users').orderByChild('wallet/address').equalTo(tx.account);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    if (userData) {
      console.log('User data found:', userData);
      const telegramId = Object.keys(userData)[0];
      const amount = depositAmount;
      
      // Обновляем баланс пользователя
      await database.ref('users/' + telegramId + '/balance').transaction(currentBalance => {
        return (currentBalance || 0) + amount.toNumber();
      });

      console.log('User balance updated');

      try {
        // Получаем текущий баланс кошелька
        const balance = new TonWeb.utils.BN(await tonweb.provider.getBalance(tx.account));
        console.log('Current balance of temporary wallet:', balance.toString());

        const minTransferAmount = TonWeb.utils.toNano('0.001'); // Минимальная сумма для перевода
        const feeReserve = TonWeb.utils.toNano('0.01'); // Резерв для комиссии

        if (balance.gt(feeReserve)) {
          const amountToTransfer = balance.sub(feeReserve);
          if (amountToTransfer.gte(minTransferAmount)) {
            if (userData[telegramId] && userData[telegramId].wallet) {
              const keyPair = {
                publicKey: Buffer.from(userData[telegramId].wallet.publicKey, 'hex'),
                secretKey: Buffer.from(userData[telegramId].wallet.secretKey, 'hex')
              };

              console.log('Using public key:', keyPair.publicKey.toString('hex'));
              console.log('Secret key length:', keyPair.secretKey.length);

              const depositWallet = await tonweb.wallet.load({publicKey: keyPair.publicKey});
              const seqno = await depositWallet.methods.seqno().call();

              console.log('Attempting to transfer funds to hot wallet');
              const transfer = await depositWallet.methods.transfer({
                secretKey: keyPair.secretKey,
                toAddress: MY_HOT_WALLET_ADDRESS,
                amount: amountToTransfer,
                seqno: seqno,
                payload: `Deposit from user ${telegramId}`,
                sendMode: 3,
              });

              try {
                const transferPromise = transfer.send();
                const transferResult = await Promise.race([
                  transferPromise,
                  new Promise((_, reject) => setTimeout(() => reject(new Error('Transfer timeout')), 30000))
                ]);
                console.log('Transfer result:', transferResult);
                
                // Обновляем статус в базе данных
                await database.ref('users/' + telegramId + '/wallet/lastTransfer').set({
                  timestamp: Date.now(),
                  status: 'completed',
                  result: transferResult,
                  amount: amountToTransfer.toString()
                });
              } catch (error) {
                console.error('Error transferring from deposit wallet to hot wallet:', error);
                console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
                
                // Обновляем статус в базе данных
                await database.ref('users/' + telegramId + '/wallet/lastTransfer').set({
                  timestamp: Date.now(),
                  status: 'failed',
                  error: error.message
                });
              }
            } else {
              console.error('Invalid user data structure for telegramId:', telegramId);
            }
          } else {
            console.log('Total amount too small to transfer after fee deduction');
          }
        } else {
          console.log('Insufficient total balance to cover fee');
        }
      } catch (balanceError) {
        console.error('Error getting wallet balance:', balanceError);
      }
    } else {
      console.log('No user data found for account:', tx.account);
    }
  } catch (dbError) {
    console.error('Error accessing database:', dbError);
  }
}

const depositAddressCache = new Set();

async function isDepositAddress(address) {
  // Проверяем кэш
  if (depositAddressCache.has(address)) return true;
  
  const userRef = database.ref('users').orderByChild('wallet/address').equalTo(address);
  const snapshot = await userRef.once('value');
  const isDeposit = snapshot.exists();
  
  // Если это адрес депозита, добавляем его в кэш
  if (isDeposit) {
    depositAddressCache.add(address);
  }
  
  return isDeposit;
}

async function onTransaction(tx) {
  // Пропускаем исходящие транзакции
  if (tx.out_msgs.length > 0) {
    return; // Убираем лог для пропуска исходящих транзакций
  }

  // Проверяем, что tx.in_msg существует и имеет свойство value
  if (!tx.in_msg || tx.in_msg.value === undefined) {
    return; // Убираем лог для недействительных структур транзакций
  }

  // Пропускаем транзакции с нулевой стоимостью
  if (tx.in_msg.value === '0') {
    return; // Убираем лог для транзакций с нулевой стоимостью
  }

  // Логируем только важные транзакции
  console.log('Processing important transaction:', JSON.stringify({
    account: tx.account,
    lt: tx.lt,
    value: tx.in_msg.value
  }, null, 2));

  try {
    if (await isDepositAddress(tx.account)) {
      console.log('Deposit address detected:', tx.account);
      const txFromNode = await tonweb.provider.getTransactions(tx.account, 1, tx.lt, tx.hash);
      if (txFromNode.length > 0) {
        console.log('Calling processDeposit');
        await processDeposit(txFromNode[0]);
      } else {
        console.log('No transactions found from node');
      }
    }
    // Убираем лог для не депозитных адресов
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
}
// Добавьте эту функцию в конец файла
async function initBlockSubscription() {
  const masterchainInfo = await tonweb.provider.getMasterchainInfo();
  const lastMasterchainBlockNumber = masterchainInfo.last.seqno;
  console.log(`Starts from ${lastMasterchainBlockNumber} masterchain block`);

  const blockSubscription = new BlockSubscriptionIndex(tonweb, lastMasterchainBlockNumber, onTransaction, INDEX_API_URL, TONCENTER_API_KEY);
  await blockSubscription.start();
}

// Добавьте эту строку в конец файла, после всех остальных инициализаций
initBlockSubscription().catch(console.error);

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
      database.ref('users/' + telegramData.id).set(token);
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


  