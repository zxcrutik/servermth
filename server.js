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



async function verifyTransaction(uniqueId, telegramId, ticketAmount, transactionHash) {
  console.log(`Начало проверки транзакции. UniqueId: ${uniqueId}, TelegramId: ${telegramId}, Количество билетов: ${ticketAmount}, TransactionHash: ${transactionHash}`);

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

                  return tx.in_msg.message.includes(uniqueId) && timeDiff <= 5;
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

  // Если transactionHash не предоставлен, пытаемся его найти
  if (!transactionHash) {
      transactionHash = await getTransactionHash(telegramId, ticketAmount, uniqueId);
      if (!transactionHash) {
          console.log('Не удалось найти хеш транзакции');
          return {
              isConfirmed: false,
              status: 'pending',
              message: 'Транзакция не найдена'
          };
      }
  }

  async function checkTransactionLocally(uniqueId) {
      try {
          const transactions = await tonweb.provider.getTransactions(await getDepositAddress(telegramId), 10);
          console.log('Локальная проверка транзакций:', transactions);
          const transaction = transactions.find(tx => tx.in_msg && tx.in_msg.message && tx.in_msg.message.includes(uniqueId));
          const isConfirmed = transaction && transaction.status === 3;
          console.log('Результат локальной проверки:', isConfirmed);
          return isConfirmed;
      } catch (error) {
          console.error('Ошибка при локальной проверке транзакции:', error);
          return false;
      }
  }

  async function checkTransactionViaToncenter(transactionHash) {
        try {
            const response = await fetch(`https://toncenter.com/api/v2/transactions/${transactionHash}`, {
                headers: { 'X-API-Key': TONCENTER_API_KEY }
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            console.log('Ответ от Toncenter:', data);
            const isConfirmed = data.result && data.result.status === 'confirmed';
            console.log('Результат проверки через Toncenter:', isConfirmed);
            return isConfirmed;
        } catch (error) {
            console.error('Ошибка при проверке через Toncenter:', error);
            return false;
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

  const isConfirmedLocally = await checkTransactionLocally(uniqueId);
    const isConfirmedViaToncenter = await checkTransactionViaToncenter(transactionHash);
    const isConfirmedExternally = await checkTransactionExternally(transactionHash);

    console.log(`Результаты проверок: Локально: ${isConfirmedLocally}, Toncenter: ${isConfirmedViaToncenter}, Внешне: ${isConfirmedExternally}`);

    const isConfirmed = isConfirmedLocally || isConfirmedViaToncenter || isConfirmedExternally;

    return {
        isConfirmed,
        status: isConfirmed ? 'confirmed' : 'pending',
        message: isConfirmed ? 'Транзакция подтверждена' : 'Транзакция все еще в обработке'
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

    if (userData && userData.wallet && userData.wallet.address) {
      console.log('Existing deposit address found:', userData.wallet.address);
      return res.json({ address: userData.wallet.address });
    }

    console.log('No existing address found, generating new one...');
    const address = await generateDepositAddress(telegramId);
    console.log('New deposit address generated:', address);

    // Сохраняем новый адрес в базу данных
    await userRef.update({
      wallet: {
        address: address
      }
    });
    console.log('New address saved to database');

    res.json({ address });
  } catch (error) {
    console.error('Error in /getDepositAddress:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.get('/checkTransactionStatus', async (req, res) => {
  const { uniqueId, telegramId, ticketAmount, transactionHash } = req.query;
  
  try {
    const verificationResult = await verifyTransaction(uniqueId, telegramId, ticketAmount, transactionHash);
    
    if (verificationResult.isConfirmed) {
      const transferResult = await attemptTransferToHotWallet(telegramId, uniqueId, ticketAmount);
      
      if (transferResult.status === 'success') {
        await updateTicketBalance(telegramId, ticketAmount, uniqueId);
        verificationResult.ticketsUpdated = true;
      } else {
        verificationResult.ticketsUpdated = false;
      }
      
      verificationResult.transferStatus = transferResult.status;
    }
    
    res.json(verificationResult);
  } catch (error) {
    console.error('Ошибка при проверке статуса транзакции:', error);
    res.status(500).json({ status: 'error', message: error.message });
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
  const snapshot = await database.ref(`transactions/${uniqueId}`).once('value');
  return snapshot.exists() && snapshot.val().processed === true;
}

async function markTransactionAsProcessed(uniqueId) {
  await database.ref(`transactions/${uniqueId}/processed`).set(true);
}

async function attemptTransferToHotWallet(telegramId, uniqueId, ticketAmount) {
  console.log(`Попытка перевода на горячий кошелек. Telegram ID: ${telegramId}, Unique ID: ${uniqueId}, Ticket Amount: ${ticketAmount}`);
  try {
    // Получаем информацию о пользователе и транзакции
    const userSnapshot = await database.ref(`users/${telegramId}`).once('value');
    const userData = userSnapshot.val();
    if (!userData || !userData.wallet || !userData.wallet.address) {
      throw new Error('Не найдена информация о кошельке пользователя');
    }
    const address = userData.wallet.address;

    // Проверяем баланс временного кошелька
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

    // Обновляем статус транзакции в базе данных
    await updateTransactionStatus(uniqueId, 'pending');

    // Запускаем процесс проверки статуса транзакции
    await checkTransferStatus(uniqueId, telegramId, ticketAmount, amountToTransfer);

    return { status: 'success', message: 'Перевод инициирован, ожидается подтверждение' };
  } catch (error) {
    console.error('Ошибка в attemptTransferToHotWallet:', error);
    await updateUserTransferStatus(telegramId, 'failed', null, null, error.message);
    return { status: 'error', message: error.message };
  }
}

async function updateTransactionStatus(uniqueId, status) {
  await database.ref(`transactions/${uniqueId}/status`).set(status);
}

async function checkTransferStatus(uniqueId, telegramId, ticketAmount, amount) {
  let attempts = 0;
  const maxAttempts = 10;
  const delay = 30000; // 30 секунд

  const checkStatus = async () => {
    attempts++;
    console.log(`Проверка статуса транзакции ${uniqueId}, попытка ${attempts}`);

    try {
      const transactionInfo = await tonweb.provider.getTransactions(MY_HOT_WALLET_ADDRESS, 1);
      const tx = transactionInfo.find(tx => tx.in_msg && tx.in_msg.message === `Transfer:${uniqueId}`);

      if (tx) {
        if (tx.status === 3) { // Успешная транзакция
          await updateTransactionStatus(uniqueId, 'confirmed');
          await updateUserTransferStatus(telegramId, 'confirmed', { uniqueId }, amount);
          console.log(`Транзакция ${uniqueId} подтверждена`);
          
          // Обновляем баланс билетов
          await updateTicketBalance(telegramId, parseInt(ticketAmount), uniqueId);
          
          return { status: 'success', ticketsUpdated: true };
        }
      }

      if (attempts < maxAttempts) {
        setTimeout(checkStatus, delay);
      } else {
        console.log(`Достигнуто максимальное количество попыток для транзакции ${uniqueId}`);
        await updateTransactionStatus(uniqueId, 'failed');
        await updateUserTransferStatus(telegramId, 'failed', { uniqueId }, amount, 'Превышено время ожидания подтверждения');
        return { status: 'failed', ticketsUpdated: false };
      }
    } catch (error) {
      console.error(`Ошибка при проверке статуса транзакции ${uniqueId}:`, error);
      if (attempts < maxAttempts) {
        setTimeout(checkStatus, delay);
      } else {
        await updateTransactionStatus(uniqueId, 'failed');
        await updateUserTransferStatus(telegramId, 'failed', { uniqueId }, amount, error.message);
        return { status: 'error', ticketsUpdated: false };
      }
    }
  };

  return checkStatus();
}

async function updateTicketBalance(telegramId, ticketAmount, uniqueId) {
  const userRef = database.ref(`users/${telegramId}`);
  await userRef.child('ticketBalance').transaction(currentBalance => {
    return (currentBalance || 0) + ticketAmount;
  });
  await database.ref(`transactions/${uniqueId}/processed`).set(true);
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

app.get('/checkTransactionStatus', async (req, res) => {
  const { uniqueId, telegramId, ticketAmount, transactionHash } = req.query;
  
  try {
    const status = await verifyTransaction(uniqueId, telegramId, ticketAmount, transactionHash);
    
    if (status.isConfirmed) {
      const transferResult = await attemptTransferToHotWallet(telegramId, uniqueId, ticketAmount);
      
      if (transferResult.status === 'success') {
        await updateTicketBalance(telegramId, ticketAmount, uniqueId);
        status.ticketsUpdated = true;
      } else {
        status.ticketsUpdated = false;
      }
      
      status.transferStatus = transferResult.status;
    }
    
    res.json(status);
  } catch (error) {
    console.error('Ошибка при проверке статуса транзакции:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

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
  const { telegramId, uniqueId, ticketAmount } = req.body;
  
  if (!telegramId || !uniqueId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const result = await attemptTransferToHotWallet(telegramId, uniqueId);
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


  