const TonWeb = require('tonweb');

const IS_TESTNET = false; // Установите true, если работаете с тестовой сетью

const NODE_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
const INDEX_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/index/' : 'https://toncenter.com/api/index/';

const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

const tonweb = new TonWeb(new TonWeb.HttpProvider(NODE_API_URL, {apiKey: TONCENTER_API_KEY}));

const createWallet = async (keyPair) => {
    const WalletClass = tonweb.wallet.all.v3R2;
    const wallet = new WalletClass(tonweb.provider, {
        publicKey: keyPair.publicKey
    });

    // Получаем адрес кошелька
    const address = await wallet.getAddress();

    return {
        wallet,
        address: address.toString(true, true, false) // Возвращаем адрес в формате для отображения в UI
    };
};

const generateKeyPair = () => {
    return TonWeb.utils.nacl.sign.keyPair();
};

module.exports = {
    tonweb,
    createWallet,
    generateKeyPair,
    IS_TESTNET,
    NODE_API_URL,
    INDEX_API_URL,
    TONCENTER_API_KEY
};