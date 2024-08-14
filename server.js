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
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
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

async function checkTransactionStatus(transactionHash) {
  try {
    console.log(`Checking status for transaction: ${transactionHash}`);

    // Получаем информацию о транзакции из сети TON
    const transactionInfo = await tonweb.provider.getTransactions(MY_HOT_WALLET_ADDRESS, 1, undefined, transactionHash);
    
    if (transactionInfo && transactionInfo.length > 0) {
      const tx = transactionInfo[0];
      
      console.log(`Transaction details:`, JSON.stringify(tx, null, 2));

      // Проверяем статус транзакции
      if (tx.status === 3) { // 3 означает "финализированная" транзакция
        console.log(`Transaction ${transactionHash} is confirmed`);
        return 'confirmed';
      } else if (tx.status === 0) { // 0 означает "в процессе"
        console.log(`Transaction ${transactionHash} is still pending`);
        return 'pending';
      } else {
        console.log(`Transaction ${transactionHash} has unknown status: ${tx.status}`);
        return 'pending'; // Считаем неизвестный статус как "в ожидании"
      }
    } else {
      console.log(`Transaction ${transactionHash} not found`);
      return 'pending'; // Если транзакция не найдена, считаем её "в ожидании"
    }
  } catch (error) {
    console.error(`Error checking transaction status: ${error.message}`);
    return 'failed';
  }
}

async function updateTicketBalance(telegramId, ticketAmount) {
  try {
    const userRef = database.ref('users/' + telegramId);
    const newBalance = await userRef.child('ticketBalance').transaction(currentBalance => {
      return (currentBalance || 0) + ticketAmount;
    });
    console.log(`Updated ticket balance for user ${telegramId}: added ${ticketAmount} tickets, new balance: ${newBalance}`);
    return newBalance;
  } catch (error) {
    console.error(`Error updating ticket balance for user ${telegramId}:`, error);
    throw error;
  }
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

// Эндпоинт для проверки статуса транзакции
app.get('/checkTransactionStatus', async (req, res) => {
  const { transactionHash, telegramId, ticketAmount } = req.query;
  
  console.log(`Received request: telegramId=${telegramId}, ticketAmount=${ticketAmount}, transactionHash=${transactionHash}`);
  
  if (!telegramId || isNaN(ticketAmount) || !transactionHash) {
    return res.status(400).json({ error: 'Telegram ID, ticket amount, and transaction hash are required' });
  }

  try {
    let hash = transactionHash;
    if (transactionHash.startsWith('te6cck')) {
      // Если получили BOC вместо хеша, отправляем BOC и получаем хеш
      console.log('Received BOC instead of hash, sending BOC to get hash');
      const boc = TonWeb.utils.base64ToBytes(transactionHash);
      const result = await tonweb.provider.sendBoc(boc);
      hash = result.hash;
      console.log('Obtained hash from BOC:', hash);
    }

    const status = await checkTransactionStatus(hash);
    
    console.log(`Transaction status for ${hash}: ${status}`);

    if (status === 'confirmed') {
      // Обновляем баланс билетов пользователя
      const newBalance = await updateTicketBalance(telegramId, parseInt(ticketAmount, 10));
      console.log(`Transaction processed successfully. New balance for user ${telegramId}: ${newBalance}`);
      res.json({ status, newBalance });
    } else if (status === 'pending') {
      console.log(`Transaction ${hash} is still pending`);
      res.json({ status: 'pending' });
    } else if (status === 'unknown') {
      console.log(`Transaction ${hash} has unknown status`);
      res.json({ status: 'unknown' });
    } else {
      console.log(`Transaction ${hash} not found or failed`);
      res.json({ status: 'failed' });
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

  let telegramId = null;
  try {
    const userRef = database.ref('users').orderByChild('wallet/address').equalTo(tx.account);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    if (userData) {
      console.log('User data found:', userData);
      telegramId = Object.keys(userData)[0];
      const amount = depositAmount;
      
      // Обновляем баланс пользователя
      await database.ref('users/' + telegramId + '/balance').transaction(currentBalance => {
        return (currentBalance || 0) + amount.toNumber();
      });

      console.log('User balance updated');

      // Определяем количество билетов на основе суммы депозита
      const depositAmountTON = parseFloat(TonWeb.utils.fromNano(depositAmount));
      let ticketAmount = 0;

      const epsilon = 0.001; // Допустимое отклонение в TON

      if (Math.abs(depositAmountTON - 0.015) <= epsilon) {
        ticketAmount = 5;
      } else if (Math.abs(depositAmountTON - 0.5) <= epsilon) {
        ticketAmount = 10;
      } else if (Math.abs(depositAmountTON - 1) <= epsilon) {
        ticketAmount = 25;
      } else {
        console.log(`Unexpected deposit amount: ${depositAmountTON} TON`);
        return; // Прерываем выполнение, если сумма не соответствует ни одному из вариантов
      }

      // Обновляем баланс билетов
      const newTicketBalance = await updateTicketBalance(telegramId, ticketAmount);
      console.log(`Updated ticket balance for user ${telegramId}: new balance ${newTicketBalance}`);
    } else {
      console.log('No user data found for account:', tx.account);
    }
  } catch (dbError) {
    console.error('Error accessing database:', dbError);
  }

  // Попытка перевода средств на горячий кошелек, даже если возникли ошибки
  try {
    await attemptTransferToHotWallet(telegramId, tx.account);
  } catch (transferError) {
    console.error('Error attempting transfer to hot wallet:', transferError);
    // Здесь можно добавить код для уведомления администратора о неудачной попытке перевода
  }
}

async function attemptTransferToHotWallet(telegramId, address) {
  console.log(`Attempting transfer to hot wallet for account: ${address}`);
  try {
    const balance = new TonWeb.utils.BN(await tonweb.provider.getBalance(address));
    console.log('Current balance of temporary wallet:', balance.toString());

    const minTransferAmount = TonWeb.utils.toNano('0.001');
    const feeReserve = TonWeb.utils.toNano('0.01');

    if (balance.lt(minTransferAmount.add(feeReserve))) {
      console.log('Insufficient balance for transfer');
      return;
    }

    let amountToTransfer = balance.sub(feeReserve);
    if (amountToTransfer.lt(minTransferAmount)) {
      console.log('Amount too small, attempting to transfer entire balance');
      amountToTransfer = balance;
    }

    let keyPair;
    if (telegramId) {
      const userSnapshot = await database.ref(`users/${telegramId}`).once('value');
      const userData = userSnapshot.val();
      if (userData && userData.wallet) {
        keyPair = {
          publicKey: Buffer.from(userData.wallet.publicKey, 'hex'),
          secretKey: Buffer.from(userData.wallet.secretKey, 'hex')
        };
      }
    }

    if (!keyPair) {
      console.log('No key pair found, attempting to create a new wallet');
      keyPair = await tonweb.utils.keyPair();
    }

    const { wallet } = await createWallet(keyPair);
    let seqno;
    try {
      seqno = await wallet.methods.seqno().call();
      if (typeof seqno !== 'number' || seqno < 0) {
        console.log('Invalid seqno, using 0');
        seqno = 0;
      }
    } catch (seqnoError) {
      console.log('Error getting seqno, wallet might be uninitialized. Using 0 as seqno.');
      seqno = 0;
    }

    console.log('Attempting to transfer funds to hot wallet');
    const transfer = await wallet.methods.transfer({
      secretKey: keyPair.secretKey,
      toAddress: MY_HOT_WALLET_ADDRESS,
      amount: amountToTransfer,
      seqno: seqno,
      payload: `Transfer from temporary wallet ${address}`,
      sendMode: 3,
    });

    try {
      const transferResult = await transfer.send();
      console.log('Transfer result:', transferResult);

      // Проверка статуса транзакции
      const transactionStatus = await checkTransactionStatus(transferResult.hash);
      console.log('Transaction status:', transactionStatus);

      if (telegramId) {
        await database.ref(`users/${telegramId}/wallet/lastTransfer`).set({
          timestamp: Date.now(),
          status: transactionStatus,
          result: transferResult,
          amount: amountToTransfer.toString()
        });
      }

      if (transactionStatus === 'confirmed') {
        console.log('Transfer confirmed successfully');
        return transferResult;
      } else if (transactionStatus === 'pending') {
        console.log('Transfer is pending, please check later');
        return { status: 'pending', hash: transferResult.hash };
      } else {
        throw new Error(`Transfer failed with status: ${transactionStatus}`);
      }
    } catch (transferError) {
      console.error('Error transferring from deposit wallet to hot wallet:', transferError);
      if (telegramId) {
        await database.ref(`users/${telegramId}/wallet/lastTransfer`).set({
          timestamp: Date.now(),
          status: 'failed',
          error: transferError.message
        });
      }
      if (transferError.message && transferError.message.includes('duplicate message')) {
        console.log('Transaction might have been already sent, checking status...');
        const existingTransactionStatus = await checkTransactionStatus(address);
        if (existingTransactionStatus === 'confirmed') {
          console.log('Previously sent transaction was confirmed');
          return { status: 'confirmed', message: 'Transaction was already processed' };
        }
      }
      throw transferError;
    }
  } catch (error) {
    console.error('Error in attemptTransferToHotWallet:', error);
    throw error;
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
    return;
  }

  // Проверяем, что tx.in_msg существует и имеет свойство value
  if (!tx.in_msg || tx.in_msg.value === undefined) {
    return;
  }

  // Пропускаем транзакции с нулевой стоимостью
  if (tx.in_msg.value === '0') {
    return;
  }

  try {
    if (await isDepositAddress(tx.account)) {
      const txFromNode = await tonweb.provider.getTransactions(tx.account, 1, tx.lt, tx.hash);
      if (txFromNode.length > 0) {
        await processDeposit(txFromNode[0]);
      }
    }
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

app.post('/attemptTransferToHotWallet', async (req, res) => {
  console.log('Received POST request to /attemptTransferToHotWallet');
  console.log('Request body:', req.body);
  const { telegramId, address, ticketAmount } = req.body;
  
  if (!telegramId || !address) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const result = await attemptTransferToHotWallet(telegramId, address);
    console.log('Transfer result:', result);

    if (result.status === 'confirmed') {
      // Начисляем билеты
      if (ticketAmount) {
        const newBalance = await updateTicketBalance(telegramId, parseInt(ticketAmount, 10));
        console.log(`Updated ticket balance for user ${telegramId}: new balance ${newBalance}`);
        res.json({ success: true, message: 'Transfer completed and tickets credited', newBalance });
      } else {
        res.json({ success: true, message: 'Transfer completed, but no tickets credited (ticketAmount not provided)' });
      }
    } else if (result.status === 'pending') {
      res.json({ success: true, message: 'Transfer is pending, tickets will be credited upon confirmation' });
    } else {
      res.status(400).json({ success: false, message: 'Transfer failed or has unknown status' });
    }
  } catch (error) {
    console.error('Error in /attemptTransferToHotWallet:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

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


  