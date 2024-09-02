require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { Telegraf, Markup } = require('telegraf');
const TonWeb = require('tonweb');
const { tonweb, createWallet, createKeyPair, IS_TESTNET, TONCENTER_API_KEY, INDEX_API_URL, NODE_API_URL } = require('./common.js');
const BlockSubscriptionIndex = require('./block/BlockSubscriptionIndex');
const BN = TonWeb.utils.BN;
const { Cell, Transaction } = TonWeb.boc;
   const cors = require('cors');


   const MY_HOT_WALLET_ADDRESS = process.env.MY_HOT_WALLET_ADDRESS;

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.json());

app.use(cors({
  origin: 'https://www.method-ton.space', // замените на ваш домен
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.options('*', cors()); // Обработка предварительных запросов для всех маршрутов

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://method-e6c6c-default-rtdb.firebaseio.com"
});

const database = admin.database();
const token = process.env.TELEGRAM_TOKEN;
const webAppUrl = 'https://www.method-ton.space';
const bot = new Telegraf(token);

const rateLimit = require('express-rate-limit');

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 5000, // ограничение каждого IP до 5000 запросов за 15 минут
  skip: (req) => {
    // Пропускаем лимитер для определенных маршрутов
    const skippedRoutes = ['/farmingStatus', '/getMiniGameEntryPrice'];
    return skippedRoutes.includes(req.path);
  }
});

// Применяем общий лимитер ко всем запросам, кроме исключенных
app.use(generalLimiter);
app.get('/getTonWebConfig', (req, res) => {
  res.json({
      IS_TESTNET,
      NODE_API_URL,
      INDEX_API_URL
  });
});

function verifyTelegramWebAppData(telegramInitData) {
  const initData = new URLSearchParams(telegramInitData);
  const hash = initData.get('hash');
  const dataToCheck = [];

  initData.sort();
  initData.forEach((val, key) => {
    if (key !== 'hash') {
      dataToCheck.push(`${key}=${val}`);
    }
  });

  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_TOKEN).digest();
  const checkString = dataToCheck.join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  return hmac === hash;
}

app.post('/auth',(req, res) => {
  const { initData } = req.body;
  
  if (!initData) {
    return res.status(400).json({ success: false, error: 'No initData provided' });
  }

  try {
    if (verifyTelegramWebAppData(initData)) {
      const parsedInitData = new URLSearchParams(initData);
      const user = JSON.parse(parsedInitData.get('user'));
      const telegramId = user.id.toString();

      const sessionToken = crypto.randomBytes(64).toString('hex');

      database.ref(`users/${telegramId}/sessionToken`).set(sessionToken)
        .then(() => {
          res.json({ success: true, sessionToken });
        })
        .catch(error => {
          console.error('Error saving session token:', error);
          res.status(500).json({ success: false, error: 'Internal server error' });
        });
    } else {
      res.status(401).json({ success: false, error: 'Invalid Telegram data' });
    }
  } catch (error) {
    console.error('Error in /auth:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header provided' });
  }

  const [bearer, token] = authHeader.split(' ');
  if (bearer !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Invalid authorization header format' });
  }

  try {
    const userSnapshot = await database.ref('users').orderByChild('sessionToken').equalTo(token).once('value');
    if (userSnapshot.exists()) {
      const userData = userSnapshot.val();
      const telegramId = Object.keys(userData)[0];
      req.user = { telegramId, ...userData[telegramId] };
      next();
    } else {
      res.status(401).json({ error: 'Invalid session token' });
    }
  } catch (error) {
    console.error('Error in authMiddleware:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function generateDepositAddress(telegramId) {
  console.log('Generating deposit address for Telegram ID:', telegramId);
  try {
    const keyPair = await createKeyPair();
    console.log('Key pair generated');
    const { wallet, address } = await createWallet(keyPair);
    console.log('Wallet created, address:', address);
    
    // Сохраняем keyPair и address в базу данных, связав с telegramId
    const walletData = {
      publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
      secretKey: Buffer.from(keyPair.secretKey).toString('hex'),
      address: address
    };
    
    await database.ref(`users/${telegramId}/wallet`).set(walletData);
    console.log('Wallet data saved to database');
    
    return address;
  } catch (error) {
    console.error('Error generating deposit address:', error);
    throw error;
  }
}

async function updateExistingUserWallet(telegramId) {
  console.log(`Updating wallet for Telegram ID: ${telegramId}`);
  try {
    const userRef = database.ref(`users/${telegramId}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    if (userData && userData.wallet && userData.wallet.address && !userData.wallet.publicKey) {
      // У пользователя есть адрес, но нет ключей
      const keyPair = await createKeyPair();
      const { wallet, address } = await createWallet(keyPair);

      // Проверяем, совпадает ли новый адрес с существующим
      if (address !== userData.wallet.address) {
        console.log(`Warning: New address ${address} doesn't match existing ${userData.wallet.address}`);
        // Здесь можно добавить логику для обработки несовпадения адресов
      }

      const walletData = {
        publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
        secretKey: Buffer.from(keyPair.secretKey).toString('hex'),
        address: address
      };

      await userRef.child('wallet').update(walletData);
      console.log('Wallet data updated for existing user');
    }
  } catch (error) {
    console.error('Error updating existing user wallet:', error);
  }
}

async function recoverStuckFunds(oldAddress, telegramId) {
  console.log(`Попытка восстановления средств с ${oldAddress} для Telegram ID: ${telegramId}`);

  try {
    // Проверяем баланс старого кошелька
    const balance = new TonWeb.utils.BN(await tonweb.provider.getBalance(oldAddress));
    console.log('Текущий баланс старого кошелька:', balance.toString());

    if (balance.isZero()) {
      console.log('Нет средств для восстановления');
      return { status: 'no_funds', message: 'Нет средств для восстановления' };
    }

    // Получаем информацию о пользователе
    const userSnapshot = await database.ref(`users/${telegramId}`).once('value');
    const userData = userSnapshot.val();
    if (!userData || !userData.wallet || !userData.wallet.publicKey || !userData.wallet.secretKey) {
      throw new Error('Не найдена информация о кошельке пользователя');
    }

    // Получаем ключевую пару пользователя
    const keyPair = {
      publicKey: Buffer.from(userData.wallet.publicKey, 'hex'),
      secretKey: Buffer.from(userData.wallet.secretKey, 'hex')
    };

    const { wallet } = await createWallet(keyPair);
    let seqno = await getSeqno(wallet);

    const minTransferAmount = TonWeb.utils.toNano('0.001');
    const feeReserve = TonWeb.utils.toNano('0.01');

    let amountToTransfer = balance.sub(feeReserve);
    if (amountToTransfer.lt(minTransferAmount)) {
      console.log('Сумма слишком мала, пытаемся перевести весь баланс');
      amountToTransfer = balance;
    }

    console.log('Попытка перевода средств на горячий кошелек');
    const transfer = await wallet.methods.transfer({
      secretKey: keyPair.secretKey,
      toAddress: MY_HOT_WALLET_ADDRESS,
      amount: amountToTransfer,
      seqno: seqno,
      payload: `Recover:${telegramId}`,
      sendMode: 3,
    });

    const transferResult = await transfer.send();
    console.log('Результат перевода:', transferResult);

    if (transferResult['@type'] === 'ok') {
      console.log('Перевод успешно выполнен');
      return { 
        status: 'success', 
        message: 'Средства успешно восстановлены',
        amount: amountToTransfer.toString()
      };
    } else {
      console.log('Перевод инициирован, ожидается подтверждение');
      return { 
        status: 'pending', 
        message: 'Перевод инициирован, ожидается подтверждение',
        transactionId: transferResult.transaction_id
      };
    }
  } catch (error) {
    console.error('Ошибка в recoverStuckFunds:', error);
    return { status: 'error', message: error.message };
  }
}

app.post('/updateUserWallet', async (req, res) => {
  const { telegramId, oldAddress } = req.body;
  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram ID не предоставлен' });
  }
  try {
    await updateExistingUserWallet(telegramId);
    let recoveryResult = null;
    if (oldAddress) {
      recoveryResult = await recoverStuckFunds(oldAddress, telegramId);
    }
    res.json({ 
      success: true, 
      message: 'Wallet updated', 
      recoveryResult 
    });
  } catch (error) {
    console.error('Error in updateUserWallet:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

async function verifyTransaction(uniqueId, telegramId, ticketAmount, transactionHash) {
  console.log(`Начало проверки транзакции. UniqueId: ${uniqueId}, TelegramId: ${telegramId}, Количество билетов: ${ticketAmount}, TransactionHash: ${transactionHash}`);

  const maxRetries = 10;
  const delayBetweenRetries = 10000; // 10 секунд
  const initialDelay = 15000; // 15 секунд начальной задержки

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function getDepositAddress(telegramId) {
    try {
      const userRef = database.ref(`users/${telegramId}`);
      const snapshot = await userRef.once('value');
      const userData = snapshot.val();
      if (userData && userData.wallet && userData.wallet.address) {
        return userData.wallet.address;
      }
      throw new Error('Адрес депозита не найден для пользователя');
    } catch (error) {
      console.error('Ошибка при получении адреса депозита:', error);
      throw error;
    }
  }

  async function getTransactionHash(telegramId, ticketAmount, uniqueId) {
    console.log(`Поиск транзакции. TelegramId: ${telegramId}, TicketAmount: ${ticketAmount}, UniqueId: ${uniqueId}`);
    try {
      const depositAddress = await getDepositAddress(telegramId);
      console.log(`Используемый адрес депозита: ${depositAddress}`);

      const transactions = await tonweb.provider.getTransactions(depositAddress, 20);
      console.log(`Получено ${transactions.length} транзакций`);

      if (transactions.length === 0) {
        console.log('Транзакции не найдены');
        return null;
      }

      const currentTime = new Date();
      const transaction = transactions.find(tx => {
        if (tx.in_msg) {
          const txTime = new Date(tx.utime * 1000);
          const timeDiff = (currentTime - txTime) / 1000 / 60;

          console.log(`Проверка транзакции: Amount: ${tx.in_msg.value}, Время: ${txTime}, Разница во времени: ${timeDiff} минут`);

          return tx.in_msg.message.includes(uniqueId) && timeDiff <= 30; // Увеличено до 30 минут
        }
        return false;
      });

      if (transaction) {
        console.log('Найдена подходящая транзакция:', transaction);
        return transaction.transaction_id.hash;
      } else {
        console.log(`Подходящая транзакция не найдена для TicketAmount: ${ticketAmount}, UniqueId: ${uniqueId}`);
        return null;
      }
    } catch (error) {
      console.error('Ошибка при получении хеша транзакции:', error);
      return null;
    }
  }

  async function checkTransactionExternally(transactionHash) {
    try {
      if (!transactionHash) {
        console.log('TransactionHash не предоставлен для внешней проверки');
        return false;
      }
      
      const url = `https://tonapi.io/v2/blockchain/transactions/${transactionHash}`;
      console.log('URL запроса:', url);
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      console.log('Внешняя проверка транзакции:', data);
      const isConfirmed = data.success === true;
      console.log('Результат внешней проверки:', isConfirmed);
      return isConfirmed;
    } catch (error) {
      console.error('Ошибка при внешней проверке транзакции:', error);
      return false;
    }
  }

  await delay(initialDelay);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Проверяем, была ли транзакция уже обработана
      const isProcessed = await checkIfTransactionProcessed(uniqueId);
      if (isProcessed) {
        console.log(`Транзакция ${uniqueId} уже была обработана`);
        return { isConfirmed: true, status: 'confirmed', message: 'Транзакция уже обработана' };
      }

      if (!transactionHash) {
        transactionHash = await getTransactionHash(telegramId, ticketAmount, uniqueId);
        if (!transactionHash) {
          if (attempt < maxRetries - 1) {
            console.log(`Ожидание ${delayBetweenRetries / 1000} секунд перед следующей попыткой...`);
            await delay(delayBetweenRetries);
            continue;
          }
          return { isConfirmed: false, status: 'pending', message: 'Транзакция не найдена после нескольких попыток' };
        }
      }

      const isConfirmedExternally = await checkTransactionExternally(transactionHash);

      console.log(`Результат внешней проверки: ${isConfirmedExternally}`);

      if (isConfirmedExternally) {
        await markTransactionAsProcessed(uniqueId);
        return {
          isConfirmed: true,
          status: 'confirmed',
          message: 'Транзакция подтверждена',
          transactionHash: transactionHash
        };
      } else {
        console.log('Транзакция все еще в обработке');
      }
    } catch (error) {
      console.error(`Ошибка при проверке статуса транзакции (попытка ${attempt + 1}):`, error);
    }

    if (attempt < maxRetries - 1) {
      console.log(`Ожидание ${delayBetweenRetries / 1000} секунд перед следующей попыткой...`);
      await delay(delayBetweenRetries);
    }
  }

  return {
    isConfirmed: false,
    status: 'pending',
    message: 'Транзакция не подтверждена после нескольких попыток'
  };
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

    if (userData && userData.wallet && userData.wallet.address && userData.wallet.publicKey && userData.wallet.secretKey) {
      console.log('Existing wallet data found:', userData.wallet.address);
      return res.json({ address: userData.wallet.address });
    }

    console.log('No existing wallet data found, generating new one...');
    const address = await generateDepositAddress(telegramId);
    console.log('New deposit address generated:', address);

    res.json({ address });
  } catch (error) {
    console.error('Error in /getDepositAddress:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.post('/updateTicketBalance', async (req, res) => {
  const { telegramId, amount, uniqueId } = req.body;

  try {
      // Проверяем, не была ли эта транзакция уже обработана
      const isProcessed = await checkIfTransactionProcessed(uniqueId);
      if (isProcessed) {
          return res.status(400).json({ error: 'Эта транзакция уже была обработана' });
      }

      // Обновляем баланс билетов пользователя
      const newBalance = await updateUserTicketBalance(telegramId, parseInt(amount, 10));

      // Отмечаем транзакцию как обработанную
      await markTransactionAsProcessed(uniqueId);

      res.json({ newBalance });
  } catch (error) {
      console.error('Ошибка при обновлении баланса билетов:', error);
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Обновите функцию processDeposit
async function processDeposit(tx) {
  const telegramId = await getTelegramIdByAddress(tx.account);
  if (!telegramId) {
    console.log('Telegram ID not found for address:', tx.account);
    return;
  }

  const depositAmountTON = parseFloat(TonWeb.utils.fromNano(tx.in_msg.value));
  console.log(`Deposit amount: ${depositAmountTON} TON`);

  // Извлекаем информацию из комментария транзакции
  const commentParts = tx.in_msg.message.split(':');
  if (commentParts[0] !== 'buytickets' || commentParts.length !== 3) {
    console.log('Invalid transaction comment format');
    return;
  }

  const [_, ticketAmount, uniqueId] = commentParts;

  try {
    // Проверяем, не была ли эта транзакция уже обработана
    const isProcessed = await checkIfTransactionProcessed(uniqueId);
    if (isProcessed) {
      console.log('This transaction has already been processed');
      return;
    }

    // Обновляем баланс билетов пользователя
    const newTicketBalance = await updateTicketBalance(telegramId, parseInt(ticketAmount, 10));
    console.log(`Updated ticket balance for user ${telegramId}: new balance ${newTicketBalance}`);

    // Отмечаем транзакцию как обработанную
    await markTransactionAsProcessed(uniqueId);

    // Попытка перевода средств на горячий кошелек
    await attemptTransferToHotWallet(telegramId, uniqueId);
  } catch (dbError) {
    console.error('Error processing deposit:', dbError);
  }
}

async function updateUserTicketBalance(telegramId, amount) {
  console.log(`Обновление баланса билетов для пользователя ${telegramId} на ${amount} билетов`);
  
  try {
    const userRef = database.ref(`users/${telegramId}`);
    
    // Получаем текущий баланс билетов пользователя
    const snapshot = await userRef.child('ticketBalance').once('value');
    const currentBalance = snapshot.val() || 0;
    
    // Вычисляем новый баланс
    const newBalance = currentBalance + amount;
    
    // Обновляем баланс в базе данных
    await userRef.child('ticketBalance').set(newBalance);
    
    console.log(`Баланс билетов обновлен. Новый баланс: ${newBalance}`);
    
    // Обновляем историю транзакций
    await userRef.child('transactions').push({
      type: 'ticket_purchase',
      amount: amount,
      timestamp: Date.now()
    });
    
    return newBalance;
  } catch (error) {
    console.error(`Ошибка при обновлении баланса билетов для пользователя ${telegramId}:`, error);
    throw error;
  }
}

// Добавьте эти вспомогательные функции
async function checkIfTransactionProcessed(uniqueId) {
  const snapshot = await database.ref(`transactions/${uniqueId}/processed`).once('value');
  return snapshot.val() === true;
}

async function markTransactionAsProcessed(uniqueId) {
  await database.ref(`transactions/${uniqueId}/processed`).set(true);
}

const transferAttempts = new Set();

async function attemptTransferToHotWallet(telegramId, uniqueId, ticketAmount) {
  console.log(`Попытка перевода на горячий кошелек. Telegram ID: ${telegramId}, Unique ID: ${uniqueId}, Ticket Amount: ${ticketAmount}`);

  // Проверяем статус перевода перед попыткой инициировать новый перевод
  const transferStatus = await getTransferStatus(uniqueId, telegramId);
  if (transferStatus === 'success' || transferStatus === 'confirmed') {
    console.log(`Перевод для транзакции ${uniqueId} уже был успешно выполнен.`);
    return { status: 'success', message: 'Перевод уже был успешно выполнен' };
  }

  // Проверяем, была ли уже попытка перевода для этой транзакции
  if (transferAttempts.has(uniqueId)) {
    console.log(`Перевод для транзакции ${uniqueId} уже был инициирован ранее.`);
    return { status: 'already_attempted', message: 'Перевод уже был инициирован ранее' };
  }

  // Добавляем uniqueId в множество попыток
  transferAttempts.add(uniqueId);

  try {
    // Добавляем задержку в 5 секунд перед попыткой перевода
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Получаем информацию о пользователе и транзакции
    const userSnapshot = await database.ref(`users/${telegramId}`).once('value');
    const userData = userSnapshot.val();
    if (!userData || !userData.wallet || !userData.wallet.publicKey || !userData.wallet.secretKey) {
      console.log('Wallet data is incomplete. Updating...');
      await updateExistingUserWallet(telegramId);
      // Получаем обновленные данные
      const updatedSnapshot = await database.ref(`users/${telegramId}`).once('value');
      userData = updatedSnapshot.val();
    }
    const address = userData.wallet.address;

    // Проверяем баланс временного кошелька
    const balance = new TonWeb.utils.BN(await tonweb.provider.getBalance(address));
    console.log('Текущий баланс временного кошелька:', balance.toString());

    const minTransferAmount = TonWeb.utils.toNano('0.001');
    const feeReserve = TonWeb.utils.toNano('0.01');

    if (balance.lt(minTransferAmount.add(feeReserve))) {
      console.log('Недостаточный баланс для перевода');
      await updateUserTransferStatus(telegramId, 'failed', { uniqueId }, balance.toString(), 'Недостаточный баланс для перевода');
      return { status: 'insufficient_balance', message: 'Недостаточный баланс для перевода' };
    }

    let amountToTransfer = balance.sub(feeReserve);
    if (amountToTransfer.lt(minTransferAmount)) {
      console.log('Сумма слишком мала, пытаемся перевести весь баланс');
      amountToTransfer = balance;
    }

    // Получаем ключевую пару пользователя
    const keyPair = {
      publicKey: Buffer.from(userData.wallet.publicKey, 'hex'),
      secretKey: Buffer.from(userData.wallet.secretKey, 'hex')
    };

    const { wallet } = await createWallet(keyPair);
    let seqno = await getSeqno(wallet);

    console.log('Попытка перевода средств на горячий кошелек');
    const transfer = await wallet.methods.transfer({
      secretKey: keyPair.secretKey,
      toAddress: MY_HOT_WALLET_ADDRESS,
      amount: amountToTransfer,
      seqno: seqno,
      payload: `Transfer:${uniqueId}`,
      sendMode: 3,
    });

    const transferResult = await transfer.send();
    console.log('Результат перевода:', transferResult);

    if (transferResult['@type'] === 'ok') {
      await updateUserTransferStatus(telegramId, 'success', { uniqueId }, amountToTransfer.toString());
      
      // Обновляем баланс билетов пользователя
      const newBalance = await updateTicketBalance(telegramId, parseInt(ticketAmount), uniqueId);
      
      return { 
        status: 'success', 
        message: 'Перевод успешно выполнен и билеты начислены',
        newBalance: newBalance
      };
    } else {
      await updateUserTransferStatus(telegramId, 'pending', { uniqueId }, amountToTransfer.toString());
      return { 
        status: 'pending', 
        message: 'Перевод инициирован, ожидается подтверждение',
        transactionId: transferResult.transaction_id
      };
    }
  } catch (error) {
    console.error('Ошибка в attemptTransferToHotWallet:', error);
    await updateUserTransferStatus(telegramId, 'failed', { uniqueId }, null, error.message);
    return { status: 'error', message: error.message };
  } finally {

    transferAttempts.delete(uniqueId);
  }
}

// Функция для получения статуса перевода
async function getTransferStatus(uniqueId, telegramId) {
  const userRef = database.ref(`users/${telegramId}/transactions/${uniqueId}`);
  const snapshot = await userRef.once('value');
  const transactionData = snapshot.val();
  return transactionData ? transactionData.status : null;
}

async function updateUserTransferStatus(telegramId, status, result, amount, errorMessage = null) {
  if (telegramId) {
    const updateData = {
      timestamp: Date.now(),
      status: status
    };
    if (result) updateData.result = result;
    if (amount) updateData.amount = amount;
    if (errorMessage) updateData.error = errorMessage;

    await database.ref(`users/${telegramId}/wallet/lastTransfer`).set(updateData);
  }
}

async function updateTicketBalance(telegramId, ticketAmount, uniqueId) {
  console.log(`Обновление баланса билетов. Telegram ID: ${telegramId}, Ticket Amount: ${ticketAmount}, Unique ID: ${uniqueId}`);
  const userRef = database.ref(`users/${telegramId}`);
  
  try {
    const snapshot = await userRef.once('value');
    const userData = snapshot.val() || {};
    
    if (userData.lastProcessedUniqueId === uniqueId) {
      console.log(`Транзакция ${uniqueId} уже обработана, пропускаем обновление баланса`);
      return userData.ticketBalance || 0;
    }

    const currentBalance = userData.ticketBalance || 0;
    const newBalance = currentBalance + parseInt(ticketAmount, 10);
    
    await userRef.update({
      ticketBalance: newBalance,
      lastProcessedUniqueId: uniqueId,
      lastUpdated: Date.now()
    });

    console.log(`Баланс билетов обновлен. Новый баланс: ${newBalance}`);
    
    // Добавляем запись в историю транзакций
    await userRef.child('transactions').push({
      type: 'ticket_purchase',
      amount: ticketAmount,
      uniqueId: uniqueId,
      timestamp: Date.now()
    });

    return newBalance;
  } catch (error) {
    console.error('Ошибка при обновлении баланса билетов:', error);
    throw error;
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
  console.log(`Обновление статуса перевода. Telegram ID: ${telegramId}, Status: ${status}`);
  if (telegramId) {
    const updateData = {
      timestamp: Date.now(),
      status: status
    };
    if (result) updateData.result = result;
    if (amount) updateData.amount = amount.toString();
    if (errorMessage) updateData.error = errorMessage;

    try {
      await database.ref(`users/${telegramId}/wallet/lastTransfer`).set(updateData);
      console.log('Статус перевода успешно обновлен');
    } catch (error) {
      console.error('Ошибка при обновлении статуса перевода:', error);
    }
  }
}

app.get('/checkTransactionStatus', async (req, res) => {
  const { uniqueId, telegramId, ticketAmount, transactionHash } = req.query;
  
  console.log(`Запрос проверки статуса транзакции. TelegramId: ${telegramId}, UniqueId: ${uniqueId}, Количество билетов: ${ticketAmount}`);

  try {
    const status = await checkTransactionAndTransferStatus(uniqueId, telegramId, ticketAmount, transactionHash);
    res.json(status);
  } catch (error) {
    console.error('Ошибка при проверке статуса транзакции:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

async function checkTransactionAndTransferStatus(uniqueId, telegramId, ticketAmount, transactionHash) {
  const maxAttempts = 10;
  const delay = 30000; // 30 секунд

  // Сначала проверяем статус исходной транзакции
  const transactionStatus = await verifyTransaction(uniqueId, telegramId, ticketAmount, transactionHash);
  
  if (!transactionStatus.isConfirmed) {
    return transactionStatus;
  }

  // Если транзакция подтверждена, инициируем перевод на горячий кошелек
  const transferResult = await attemptTransferToHotWallet(telegramId, uniqueId, ticketAmount);
  
  if (transferResult.status === 'success') {
    return { 
      status: 'success', 
      message: transferResult.message,
      ticketsUpdated: true, 
      newBalance: transferResult.newBalance 
    };
  } else if (transferResult.status === 'error' || transferResult.status === 'insufficient_balance') {
    return {
      status: transferResult.status,
      message: transferResult.message,
      ticketsUpdated: false
    };
  } else if (transferResult.status === 'already_attempted') {
    // Если перевод уже был инициирован ранее, проверяем его статус
    console.log(`Перевод для ${uniqueId} уже был инициирован ранее, проверяем статус`);
  } else if (transferResult.status !== 'pending') {
    return transferResult; // Возвращаем результат для других неожиданных статусов
  }

  // Проверяем статус перевода на горячий кошелек
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    console.log(`Проверка статуса перевода ${uniqueId}, попытка ${attempts}`);

    try {
      const transactionInfo = await tonweb.provider.getTransactions(MY_HOT_WALLET_ADDRESS, 1);
      const tx = transactionInfo.find(tx => tx.in_msg && tx.in_msg.message === `Transfer:${uniqueId}`);

      if (tx) {
        console.log(`Найдена транзакция для ${uniqueId}. Статус:`, tx.status);
        
        if (tx.status === 3) { // Успешная транзакция
          await updateUserTransferStatus(telegramId, 'confirmed', { uniqueId }, tx.in_msg.value);
          console.log(`Транзакция ${uniqueId} подтверждена`);
          
          // Обновляем баланс билетов
          const newBalance = await updateTicketBalance(telegramId, parseInt(ticketAmount), uniqueId);
          console.log(`Баланс билетов обновлен. Новый баланс: ${newBalance}`);
          
          return { 
            status: 'success', 
            message: 'Транзакция подтверждена, перевод выполнен, билеты начислены',
            ticketsUpdated: true, 
            newBalance 
          };
        } else {
          console.log(`Транзакция ${uniqueId} найдена, но еще не подтверждена. Статус: ${tx.status}`);
        }
      } else {
        console.log(`Транзакция ${uniqueId} не найдена в этой попытке`);
      }

      if (attempts < maxAttempts) {
        console.log(`Ожидание ${delay / 1000} секунд перед следующей попыткой...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.log(`Достигнуто максимальное количество попыток для транзакции ${uniqueId}`);
        await updateUserTransferStatus(telegramId, 'failed', { uniqueId }, null, 'Превышено время ожидания подтверждения');
        return { 
          status: 'failed', 
          message: 'Транзакция подтверждена, но возникли проблемы с переводом',
          ticketsUpdated: false 
        };
      }
    } catch (error) {
      console.error(`Ошибка при проверке статуса транзакции ${uniqueId}:`, error);
      if (attempts === maxAttempts) {
        await updateUserTransferStatus(telegramId, 'failed', { uniqueId }, null, error.message);
        return { 
          status: 'error', 
          message: 'Произошла ошибка при проверке статуса перевода',
          ticketsUpdated: false 
        };
      }
      console.log(`Ожидание ${delay / 1000} секунд перед следующей попыткой из-за ошибки...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Если цикл завершился без возврата, возвращаем статус 'pending'
  return { 
    status: 'pending', 
    message: 'Транзакция подтверждена, ожидается завершение перевода',
    ticketsUpdated: false 
  };
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
  if (tx.out_msgs.length > 0 || !tx.in_msg || tx.in_msg.value === '0') {
    return;
  }

  try {
    if (await isDepositAddress(tx.account)) {
      const status = await verifyTransaction(tx.hash, null, null, tx.hash);
      if (status.isConfirmed) {
        await processDeposit(tx);
      }
    }
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
}
async function initBlockSubscription() {
  const masterchainInfo = await tonweb.provider.getMasterchainInfo();
  const lastMasterchainBlockNumber = masterchainInfo.last.seqno;
  console.log(`Starts from ${lastMasterchainBlockNumber} masterchain block`);

  const blockSubscription = new BlockSubscriptionIndex(tonweb, lastMasterchainBlockNumber, onTransaction, INDEX_API_URL, TONCENTER_API_KEY);
  await blockSubscription.start();
}

initBlockSubscription().catch(console.error);

app.post('/attemptTransferToHotWallet', async (req, res) => {
  console.log('Received POST request to /attemptTransferToHotWallet');
  console.log('Request body:', req.body);
  const { telegramId, uniqueId, ticketAmount } = req.body;
  
  if (!telegramId || !uniqueId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const result = await attemptTransferToHotWallet(telegramId, uniqueId, ticketAmount);
    console.log('Transfer result:', result);

    if (result.status === 'confirmed') {
      // Начисляем билеты
      if (ticketAmount) {
        const newBalance = await updateTicketBalance(telegramId, uniqueId);
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

app.post('/updateTaskTicketBalance', async (req, res) => {
  const { telegramId, taskType } = req.body;

  if (!telegramId || !taskType) {
    return res.status(400).json({ error: 'Требуется указать telegramId и taskType' });
  }

  try {
    const userRef = database.ref(`users/${telegramId}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val() || {};

    const currentTicketBalance = userData.ticketBalance || 0;
    const newTicketBalance = currentTicketBalance + 2; // Добавляем 2 тикета за каждую задачу

    await userRef.update({
      ticketBalance: newTicketBalance,
      [`${taskType}Completed`]: true
    });

    res.json({ success: true, newTicketBalance });
  } catch (error) {
    console.error('Ошибка при обновлении баланса тикетов за задачу:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
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
    ticketBalance: 10,
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

  // Добавляем telegramUsername только если он существует
  if (telegramUsername) {
      userData.telegramUsername = telegramUsername;
  }

  await database.ref(`users/${telegramId}`).set(userData);
  return userData;
}

async function getUserReferralLink(telegramId) {
  // Удаляем символ $ из telegramId, если он есть
  const cleanTelegramId = telegramId.replace('$', '');
  
  const userSnapshot = await database.ref(`users/${cleanTelegramId}`).once('value');
  
  if (userSnapshot.exists() && userSnapshot.val().referralCode) {
    return `https://t.me/${bot.botInfo.username}?start=${userSnapshot.val().referralCode}`;
  } else {
    const referralCode = Math.random().toString(36).substring(2, 15);
    await database.ref(`users/${cleanTelegramId}/referralCode`).set(referralCode);
    await database.ref(`inviteCodes/${referralCode}`).set({
      telegramId: cleanTelegramId,
      createdAt: Date.now()
    });
    return `https://t.me/${bot.botInfo.username}?start=${referralCode}`;
  }
}

function getRandomPrice() {
  const random = Math.random() * 100; // Генерируем случайное число от 0 до 100

  if (random < 40) {
    return 2; // 40% шанс
  } else if (random < 80) {
    return 3; // 40% шанс
  } else if (random < 95) {
    return 4; // 15% шанс
  } else {
    return 5; // 5% шанс
  }
}

app.get('/getMiniGameEntryPrice', async (req, res) => {
  const { telegramId } = req.query;
  if (!telegramId) {
    return res.status(400).json({ error: 'Telegram ID is required' });
  }

  try {
    const userRef = database.ref(`users/${telegramId}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    const currentTime = Date.now();
    let price, lastPriceUpdateTime;

    if (!userData || !userData.miniGameEntryPrice || !userData.lastPriceUpdateTime || 
        (currentTime - userData.lastPriceUpdateTime >= 24 * 60 * 60 * 1000)) {
          price = getRandomPrice(); // Случайное число от 2 до 5
      lastPriceUpdateTime = currentTime;
      await userRef.update({
        miniGameEntryPrice: price,
        lastPriceUpdateTime: lastPriceUpdateTime
      });
      console.log(`Updated mini game entry price for user ${telegramId}: ${price} tickets`);
    } else {
      price = userData.miniGameEntryPrice;
      lastPriceUpdateTime = userData.lastPriceUpdateTime;
    }

    res.json({ price, lastPriceUpdateTime });
  } catch (error) {
    console.error('Error getting mini game entry price:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function updateTotalFarmed(telegramId, reward) {
  console.log(`Updating total farmed for user ${telegramId} with reward ${reward}`);
  if (telegramId) {
    const userRef = database.ref('users/' + telegramId);
    try {
      const snapshot = await userRef.once('value');
      if (snapshot.exists()) {
        const userData = snapshot.val();
        let currentTotalFarmed = userData.totalFarmed || 0;
        let newTotalFarmed = currentTotalFarmed + reward;
        
        await userRef.update({ totalFarmed: newTotalFarmed });
        console.log(`Total farmed updated successfully for user ${telegramId}. New total: ${newTotalFarmed}`);
        return newTotalFarmed;
      } else {
        console.log(`User data not found for telegramId: ${telegramId}`);
        return null;
      }
    } catch (error) {
      console.error('Error updating total farmed:', error);
      throw error;
    }
  } else {
    console.error('Telegram ID not provided');
    throw new Error('Telegram ID not provided');
  }
}

app.post('/updateTotalFarmed', async (req, res) => {
  const { telegramId, reward } = req.body;
  if (!telegramId || reward === undefined) {
    return res.status(400).json({ error: 'Telegram ID and reward are required' });
  }
  try {
    const newTotalFarmed = await updateTotalFarmed(telegramId, reward);
    res.json({ success: true, newTotalFarmed });
  } catch (error) {
    console.error('Error in /updateTotalFarmed:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.post('/farming', async (req, res) => {
  const { telegramId, action } = req.body;
  if (!telegramId || !action) {
      return res.status(400).json({ error: 'Telegram ID and action are required' });
  }

  try {
      const userRef = database.ref('users/' + telegramId);
      const snapshot = await userRef.once('value');

      if (snapshot.exists()) {
          const userData = snapshot.val();
          const currentTime = Date.now();

          if (action === 'start') {
              const farmingStartTime = currentTime;
              const farmingEndTime = farmingStartTime + (12 * 60 * 60 * 1000); // 12 часов в миллисекундах

              await userRef.update({
                  farmingState: {
                      isActive: true,
                      startTime: farmingStartTime,
                      endTime: farmingEndTime
                  }
              });

              res.json({ success: true, endTime: farmingEndTime });
          } else if (action === 'claim') {
              const farmingState = userData.farmingState;
              if (farmingState && farmingState.isActive && currentTime >= farmingState.endTime) {
                  let currentTotalFarmed = userData.totalFarmed || 0;
                  let newTotalFarmed = currentTotalFarmed + 120;

                  await userRef.update({
                      totalFarmed: newTotalFarmed,
                      farmingState: {
                          isActive: false,
                          startTime: null,
                          endTime: null
                      }
                  });

                  res.json({ success: true, newTotalFarmed });
              } else {
                  res.status(400).json({ error: 'Farming is not ready to be claimed' });
              }
          } else {
              res.status(400).json({ error: 'Invalid action' });
          }
      } else {
          res.status(404).json({ error: 'User not found' });
      }
  } catch (error) {
      console.error('Error in farming:', error);
      res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.get('/farmingStatus', authMiddleware, async (req, res) => {
  const telegramId = req.user.telegramId;

  try {
    const userRef = database.ref('users/' + telegramId);
    const snapshot = await userRef.once('value');

    if (snapshot.exists()) {
      const userData = snapshot.val();
      const farmingState = userData.farmingState;

      res.json({ farmingState });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Error in farmingStatus:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});
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

    const enterButton = Markup.button.webApp('Join to Method🫧', `${webAppUrl}?telegramId=${telegramId}`);
const communityButton = Markup.button.url('Join to Community💎', 'https://t.me/method_community');

    await ctx.reply(
      'Добро пожаловать в Method! ☑️\n\n' +
      'Вот что вы можете сделать с Method прямо сейчас:\n\n' +
      '📊 Farm $MTHC: Начинайте фармить $MTHC, чтобы в будущем обменять валюту на наш токен $MTH или же $TON\n' +
      '🤖 Приглашайте друзей: Приведите своих друзей, чтобы получить больше $MTHC! Больше друзей = больше $MTHC\n' +
      '✅ Выполняйте задания: Завершайте задачи и зарабатывайте еще больше $MTHC!\n\n' +
      'Начните зарабатывать $MTHC уже сейчас, и, возможно, в будущем вас ждут удивительные награды! 🚀\n\n' +
      'Оставайтесь с METHOD!💎', 
      Markup.inlineKeyboard([
        [enterButton],
        [communityButton]
      ])
    );
  } catch (error) {
    console.error('Error with /start command:', error);
    ctx.reply('An error occurred while processing your request. Please try again later.');
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
    const telegramId = req.query.telegramId;
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
      const userData = await createUser(telegramId, telegramUsername);
      res.status(200).json({ success: true, userData });
  } catch (error) {
      console.error('Ошибка при создании пользователя:', error);
      res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

app.post('/updateUserData', async (req, res) => {
  const { telegramId, updateData } = req.body;
  
  if (!telegramId || !updateData) {
    return res.status(400).json({ error: 'Telegram ID and update data are required' });
  }

  try {
    const userRef = database.ref(`users/${telegramId}`);
    await userRef.update(updateData);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating user data:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.get('/getUserReferralLink', async (req, res) => {
  let telegramId = req.query.telegramId || (req.user && req.user.telegramId);
  
  // Удаляем символ $ из telegramId, если он есть
  telegramId = telegramId ? telegramId.replace('$', '') : null;

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
  
app.get('/reward', async (req, res) => {
  const telegramId = req.query.telegramId;

  if (!telegramId) {
    return res.status(400).send('Telegram ID is required');
  }

  try {
    const userRef = database.ref('users/' + telegramId);
    await userRef.update({ adsgramTaskCompleted: true });

    // Обновляем баланс тикетов
    await updateTaskTicketBalance(telegramId, 'adsgramTask');

    res.status(200).send('OK');
  } catch (error) {
    console.error('Error updating Adsgram task status:', error);
    res.status(500).send('Internal Server Error');
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
//

  





