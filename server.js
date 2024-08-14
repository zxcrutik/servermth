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


   const MY_HOT_WALLET_ADDRESS = process.env.MY_HOT_WALLET_ADDRESS;

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

async function checkTransactionStatus(transactionHashOrBoc) {
  try {
    console.log(`Проверка статуса транзакции: ${transactionHashOrBoc}`);

    let hash = transactionHashOrBoc;

    // Обработка BOC
    if (typeof transactionHashOrBoc === 'string' && transactionHashOrBoc.startsWith('te6cck')) {
      console.log('Получен BOC:', transactionHashOrBoc);
      const boc = TonWeb.utils.base64ToBytes(transactionHashOrBoc);
      console.log('Декодированный BOC:', boc);
      try {
        // Проверка валидности BOC
        const cell = Cell.fromBoc(Buffer.from(transactionHashOrBoc, 'base64'))[0];
        console.log('BOC валиден');

        const result = await tonweb.provider.sendBoc(boc);
        hash = result.hash;
        console.log('Получен хеш из BOC:', hash);
      } catch (bocError) {
        if (bocError.message && bocError.message.includes('duplicate message')) {
          console.log('BOC уже отправлен, пытаемся получить информацию о транзакции');
          const recentTransactions = await tonweb.provider.getTransactions(MY_HOT_WALLET_ADDRESS, 10);
          console.log('Последние транзакции:', JSON.stringify(recentTransactions, null, 2));
          const matchingTx = recentTransactions.find(tx => tx.boc === transactionHashOrBoc);
          if (matchingTx) {
            hash = matchingTx.hash;
            console.log('Найдена соответствующая транзакция с хешем:', hash);
          } else {
            console.log('Не найдена соответствующая транзакция для данного BOC');
            return { status: 'unknown', error: 'No matching transaction found' };
          }
        } else {
          console.error('Ошибка обработки BOC:', bocError);
          return { status: 'failed', error: bocError.message };
        }
      }
    } else if (typeof transactionHashOrBoc !== 'string' || !transactionHashOrBoc.match(/^[0-9a-fA-F]{64}$/)) {
      console.error('Неверный формат хеша транзакции:', transactionHashOrBoc);
      return { status: 'failed', error: 'Invalid transaction hash format' };
    }

    // Получение информации о транзакции
    console.log(`Запрос информации о транзакции для хеша: ${hash}`);
    const transactionInfo = await tonweb.provider.getTransactions(MY_HOT_WALLET_ADDRESS, 1, undefined, hash);
    console.log('Сырая информация о транзакции:', JSON.stringify(transactionInfo, null, 2));
    
    if (!transactionInfo || transactionInfo.length === 0) {
      console.log(`Транзакция ${hash} не найдена`);
      return { status: 'unknown', hash: hash };
    }

    const tx = transactionInfo[0];
    console.log(`Детали транзакции:`, JSON.stringify(tx, null, 2));

    // Определение статуса транзакции
    let status;
    if (tx.status === 3) {
      console.log(`Транзакция ${hash} подтверждена`);
      status = 'confirmed';
    } else if (tx.status === 0) {
      console.log(`Транзакция ${hash} все еще в ожидании`);
      status = 'pending';
    } else {
      console.log(`Транзакция ${hash} имеет неизвестный статус: ${tx.status}`);
      status = 'unknown';
    }

    return {
      status: status,
      hash: hash,
      details: tx
    };
  } catch (error) {
    console.error(`Ошибка при проверке статуса транзакции: ${error.message}`);
    return { status: 'failed', error: error.message };
  }
}

async function updateTicketBalance(telegramId, ticketAmount, transactionHashOrBoc = null) {
  console.log(`Попытка обновления баланса билетов для пользователя ${telegramId}: добавление ${ticketAmount} билетов`);
  try {
    if (!telegramId || isNaN(ticketAmount)) {
      throw new Error('Требуются telegramId и ticketAmount');
    }

    if (ticketAmount <= 0) {
      throw new Error('ticketAmount должен быть положительным числом');
    }

    const userRef = database.ref(`users/${telegramId}`);
    let newBalance;

    await database.ref().transaction(async (data) => {
      if (!data) {
        console.log('Данные не найдены, инициализация новой структуры');
        return { users: {}, processedTransactions: {} };
      }

      if (transactionHashOrBoc) {
        if (!data.processedTransactions) data.processedTransactions = {};
        if (data.processedTransactions[transactionHashOrBoc]) {
          console.log(`Транзакция ${transactionHashOrBoc} уже была обработана`);
          return; // Прерываем транзакцию, не изменяя данные
        }
      }

      if (!data.users) data.users = {};
      if (!data.users[telegramId]) data.users[telegramId] = { ticketBalance: 0 };
      
      data.users[telegramId].ticketBalance += ticketAmount;
      newBalance = data.users[telegramId].ticketBalance;

      if (transactionHashOrBoc) {
        data.processedTransactions[transactionHashOrBoc] = true;
      }

      console.log(`Обновлен баланс билетов для пользователя ${telegramId}: новый баланс ${newBalance}`);
      return data;
    });

    if (newBalance === undefined) {
      throw new Error('Не удалось обновить баланс билетов');
    }

    console.log(`Успешно обновлен баланс билетов для пользователя ${telegramId}: добавлено ${ticketAmount} билетов, новый баланс: ${newBalance}`);
    return newBalance;
  } catch (error) {
    console.error(`Ошибка при обновлении баланса билетов для пользователя ${telegramId}:`, error);
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
  console.log('Raw query:', req.query);
  const { transactionHash, boc, telegramId, ticketAmount } = req.query;
  
  console.log(`Received request: telegramId=${telegramId}, ticketAmount=${ticketAmount}, transactionHash=${transactionHash}, boc=${boc}`);
  
  if (!telegramId || isNaN(ticketAmount) || (!transactionHash && !boc)) {
    return res.status(400).json({ error: 'Telegram ID, ticket amount, and either transaction hash or BOC are required' });
  }

  try {
    const transactionHashOrBoc = transactionHash || boc;
    const status = await checkTransactionStatus(transactionHashOrBoc);
    
    console.log(`Transaction status for ${transactionHashOrBoc}: ${status}`);

    if (status === 'confirmed') {
      // Обновляем баланс билетов пользователя
      const newBalance = await updateTicketBalance(telegramId, parseInt(ticketAmount, 10), transactionHashOrBoc);
      console.log(`Transaction processed successfully. New balance for user ${telegramId}: ${newBalance}`);
      res.json({ status, newBalance });
    } else if (status === 'pending') {
      console.log(`Transaction ${transactionHashOrBoc} is still pending`);
      res.json({ status: 'pending' });
    } else if (status === 'unknown') {
      console.log(`Transaction ${transactionHashOrBoc} has unknown status`);
      res.json({ status: 'unknown' });
    } else if (status === 'failed') {
      console.log(`Transaction ${transactionHashOrBoc} failed`);
      res.json({ status: 'failed' });
    } else {
      console.log(`Transaction ${transactionHashOrBoc} has unexpected status: ${status}`);
      res.json({ status: 'unknown' });
    }
  } catch (error) {
    console.error('Error in check_transaction_status:', error);
    res.status(500).json({ status: 'failed', error: error.message });
  }
});



// Эндпоинт для обновления баланса билетов пользователя
app.post('/updateTicketBalance', async (req, res) => {
  const { telegramId, amount, transactionHashOrBoc } = req.body;

  try {
    const newBalance = await updateTicketBalance(telegramId, parseInt(amount, 10), transactionHashOrBoc);
    res.json({ newBalance });
  } catch (error) {
    console.error('Error in /updateTicketBalance:', error);
    if (error.message === 'Transaction already processed') {
      res.status(400).json({ error: error.message });
    } else if (error.message === 'telegramId and ticketAmount are required' || error.message === 'ticketAmount must be positive') {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
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

async function attemptTransferToHotWallet(telegramId, addressOrTransactionHashOrBoc) {
  console.log(`Попытка перевода на горячий кошелек. Получено: ${addressOrTransactionHashOrBoc}`);
  try {
    let hash, address;

    if (addressOrTransactionHashOrBoc.startsWith('te6cck')) {
      console.log('Получен BOC, отправляем BOC для получения хеша');
      const boc = TonWeb.utils.base64ToBytes(addressOrTransactionHashOrBoc);
      const result = await tonweb.provider.sendBoc(boc);
      hash = result.hash;
      console.log('Получен хеш из BOC:', hash);
    } else if (addressOrTransactionHashOrBoc.startsWith('EQ') || addressOrTransactionHashOrBoc.startsWith('UQ')) {
      address = addressOrTransactionHashOrBoc;
    } else {
      hash = addressOrTransactionHashOrBoc;
    }

    if (address) {
      const balance = new TonWeb.utils.BN(await tonweb.provider.getBalance(address));
      console.log('Текущий баланс временного кошелька:', balance.toString());

      const minTransferAmount = TonWeb.utils.toNano('0.001');
      const feeReserve = TonWeb.utils.toNano('0.01');

      if (balance.lt(minTransferAmount.add(feeReserve))) {
        console.log('Недостаточный баланс для перевода');
        return { status: 'insufficient_balance', message: 'Недостаточный баланс для перевода' };
      }

      let amountToTransfer = balance.sub(feeReserve);
      if (amountToTransfer.lt(minTransferAmount)) {
        console.log('Сумма слишком мала, пытаемся перевести весь баланс');
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
        console.log('Пара ключей не найдена, создаем новый кошелек');
        keyPair = await tonweb.utils.keyPair();
      }

      const { wallet } = await createWallet(keyPair);
      let seqno = await getSeqno(wallet);

      console.log('Попытка перевода средств на горячий кошелек');
      const transfer = await wallet.methods.transfer({
        secretKey: keyPair.secretKey,
        toAddress: MY_HOT_WALLET_ADDRESS,
        amount: amountToTransfer,
        seqno: seqno,
        payload: `Перевод с временного кошелька ${address}`,
        sendMode: 3,
      });

      const transferResult = await transfer.send();
      console.log('Результат перевода:', transferResult);

      if (!transferResult.hash) {
        console.log('Хеш перевода не определен, ожидаем подтверждения...');
        for (let i = 0; i < 5; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const updatedResult = await checkTransactionStatus(address);
          if (updatedResult && updatedResult.hash) {
            transferResult.hash = updatedResult.hash;
            break;
          }
        }
        if (!transferResult.hash) {
          throw new Error('Не удалось получить хеш транзакции после нескольких попыток');
        }
      }

      hash = transferResult.hash;
    }

    // Проверка статуса транзакции
    const transactionStatus = await checkTransactionStatus(hash);
    console.log('Статус транзакции:', transactionStatus);

    await updateUserTransferStatus(telegramId, transactionStatus, { hash }, amountToTransfer);

    if (transactionStatus === 'confirmed') {
      console.log('Перевод успешно подтвержден');
      return { status: 'confirmed', hash: hash };
    } else if (transactionStatus === 'pending') {
      console.log('Перевод в ожидании, проверьте позже');
      return { status: 'pending', hash: hash };
    } else {
      throw new Error(`Перевод не удался со статусом: ${transactionStatus}`);
    }
  } catch (error) {
    console.error('Ошибка в attemptTransferToHotWallet:', error);
    await updateUserTransferStatus(telegramId, 'failed', null, null, error.message);

    if (error.message && error.message.includes('duplicate message')) {
      console.log('Возможно, транзакция уже была отправлена, проверяем статус...');
      const existingTransactionStatus = await checkTransactionStatus(addressOrTransactionHashOrBoc);
      if (existingTransactionStatus === 'confirmed') {
        console.log('Ранее отправленная транзакция была подтверждена');
        return { status: 'confirmed', message: 'Транзакция уже была обработана' };
      }
    }
    return { status: 'error', message: error.message };
  }
}

async function getSeqno(wallet) {
  try {
    const seqno = await wallet.methods.seqno().call();
    return typeof seqno === 'number' && seqno >= 0 ? seqno : 0;
  } catch (seqnoError) {
    console.log('Error getting seqno, wallet might be uninitialized. Using 0 as seqno.');
    return 0;
  }
}

async function updateUserTransferStatus(telegramId, status, result, amount, errorMessage = null) {
  if (telegramId) {
    const updateData = {
      timestamp: Date.now(),
      status: status
    };
    if (result) updateData.result = result;
    if (amount) updateData.amount = amount.toString();
    if (errorMessage) updateData.error = errorMessage;

    await database.ref(`users/${telegramId}/wallet/lastTransfer`).set(updateData);
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
    } else if (result.status === 'insufficient_balance') {
      res.json({ success: false, message: result.message });
    } else {
      res.status(400).json({ success: false, message: result.message || 'Transfer failed or has unknown status' });
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


  