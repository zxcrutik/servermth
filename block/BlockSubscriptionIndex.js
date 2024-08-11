const axios = require('axios');
const admin = require('firebase-admin');

class BlockSubscriptionIndex {
    constructor(tonweb, lastMasterchainBlockNumber, onTransaction, indexApiUrl, apiKey) {
        this.tonweb = tonweb;
        this.lastProcessedMasterchainBlockNumber = lastMasterchainBlockNumber;
        this.onTransaction = onTransaction;
        this.indexApiUrl = indexApiUrl;
        this.apiKey = apiKey;
        this.database = admin.database();
    }

    async loadLastProcessedBlock() {
        const snapshot = await this.database.ref('lastProcessedBlock').once('value');
        if (snapshot.exists()) {
            this.lastProcessedMasterchainBlockNumber = snapshot.val();
        }
        console.log(`Loaded last processed block: ${this.lastProcessedMasterchainBlockNumber}`);
    }

    async saveLastProcessedBlock() {
        await this.database.ref('lastProcessedBlock').set(this.lastProcessedMasterchainBlockNumber);
        console.log(`Saved last processed block: ${this.lastProcessedMasterchainBlockNumber}`);
    }

    async start() {
        await this.loadLastProcessedBlock();

        while (true) {
            try {
                const response = await axios.get(`${this.indexApiUrl}getBlockTransactions?workchain=-1&shard=-9223372036854775808&seqno=${this.lastProcessedMasterchainBlockNumber}&apiKey=${this.apiKey}`);
                const transactions = response.data.result;
                
                for (const tx of transactions) {
                    await this.onTransaction(tx);
                }

                this.lastProcessedMasterchainBlockNumber++;
                await this.saveLastProcessedBlock();
            } catch (error) {
                console.error('Error in BlockSubscriptionIndex:', error);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
}

module.exports = BlockSubscriptionIndex;