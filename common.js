const TonWeb = require('tonweb');
const tonMnemonic = require('tonweb-mnemonic');

const IS_TESTNET = false;
const NODE_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
const INDEX_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/index/' : 'https://toncenter.com/api/index/';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

const tonweb = new TonWeb(new TonWeb.HttpProvider(NODE_API_URL, {apiKey: TONCENTER_API_KEY}));

const createKeyPair = async () => {
    console.log('Starting createKeyPair');
    const words = await tonMnemonic.generateMnemonic();
    console.log('Mnemonic generated');
    const seed = await tonMnemonic.mnemonicToSeed(words);
    console.log('Seed generated');
    const keyPair = TonWeb.utils.nacl.sign.keyPair.fromSeed(seed);
    console.log('KeyPair created');
    return keyPair;
};

const createWallet = async (keyPair) => {
    console.log('Starting createWallet');
    console.log('KeyPair:', {
        publicKeyLength: keyPair.publicKey.length,
        secretKeyLength: keyPair.secretKey.length
    });
    const WalletClass = tonweb.wallet.all.v3R2;
    const wallet = new WalletClass(tonweb.provider, {
        publicKey: keyPair.publicKey instanceof Uint8Array ? keyPair.publicKey : new Uint8Array(keyPair.publicKey)
    });
    console.log('Wallet instance created');
    console.log('Wallet methods:', Object.keys(wallet.methods));
    const address = await wallet.getAddress();
    console.log('Address generated:', address.toString(true, true, false));
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
    TONCENTER_API_KEY,
    tonMnemonic
    
};