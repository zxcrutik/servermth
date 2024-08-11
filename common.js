const TonWeb = require('tonweb');
const tonMnemonic = require('tonweb-mnemonic');

const IS_TESTNET = false;
const NODE_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
const INDEX_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/index/' : 'https://toncenter.com/api/index/';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

const tonweb = new TonWeb(new TonWeb.HttpProvider(NODE_API_URL, {apiKey: TONCENTER_API_KEY}));

const createKeyPair = async () => {
    const words = await tonMnemonic.generateMnemonic();
    const seed = await tonMnemonic.mnemonicToSeed(words);
    return TonWeb.utils.nacl.sign.keyPair.fromSeed(seed);
};

const createWallet = async (keyPair) => {
    const WalletClass = tonweb.wallet.all.v3R2;
    const wallet = new WalletClass(tonweb.provider, {
        publicKey: keyPair.publicKey
    });
    const address = await wallet.getAddress();
    return {
        wallet,
        address: address.toString(true, true, false)
    };
};

module.exports = {
    tonweb,
    createKeyPair,
    createWallet,
    IS_TESTNET,
    NODE_API_URL,
    INDEX_API_URL,
    TONCENTER_API_KEY
};