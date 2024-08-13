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
        
    }

    async saveLastProcessedBlock() {
        await this.database.ref('lastProcessedBlock').set(this.lastProcessedMasterchainBlockNumber);
    }

    async start() {
        await this.loadLastProcessedBlock();

        const getTransactionsByMasterchainSeqno = async (masterchainBlockNumber) => {
            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-API-Key': this.apiKey
            };
            const url = `${this.indexApiUrl}getTransactionsByMasterchainSeqno?seqno=${masterchainBlockNumber}`;
            try {
                const response = await axios.get(url, { headers });
                if (response.data.error) {
                    throw new Error(`API Error: ${response.data.error}`);
                }
                return response.data;
            } catch (error) {
            
                throw error;
            }
        };

        let isProcessing = false;

        const tick = async () => {
            if (isProcessing) return;
            isProcessing = true;
        
            try {
                const masterchainInfo = await this.tonweb.provider.getMasterchainInfo();
                const lastMasterchainBlockNumber = masterchainInfo.last.seqno;
        
                if (lastMasterchainBlockNumber > this.lastProcessedMasterchainBlockNumber) {
                    const masterchainBlockNumber = this.lastProcessedMasterchainBlockNumber + 1;
                    const transactions = await getTransactionsByMasterchainSeqno(masterchainBlockNumber);
        
                    
        
                    for (const tx of transactions) {
                        try {
                            await this.onTransaction(tx);
                        } catch (txError) {
                            console.error(`Error processing transaction in block ${masterchainBlockNumber}:`, txError);
                            // Можно добавить логику для сохранения информации о неудачной обработке транзакции
                        }
                    }
        
                    this.lastProcessedMasterchainBlockNumber = masterchainBlockNumber;
                    await this.saveLastProcessedBlock();
                }
            } catch (e) {
                console.error('Error in BlockSubscriptionIndex:', e);
                if (e.response) {
                    console.error('Response data:', e.response.data);
                    console.error('Response status:', e.response.status);
                }
                // Можно добавить логику для повторной попытки или уведомления администратора
            } finally {
                isProcessing = false;
            }
        };

        setInterval(tick, 1000);
    }
}

module.exports = BlockSubscriptionIndex;