import { MongoClient } from 'mongodb';

const MAX_URLS = 50;
const COLLECTION_NAME = 'sent_cars';
const CONNECT_OPTIONS = {
    connectTimeoutMS: 5000,
    socketTimeoutMS: 30000,
    maxPoolSize: 10,
    minPoolSize: 1
};

export class Storage {
    constructor() {
        this.client = new MongoClient(process.env.MONGODB_URI, CONNECT_OPTIONS);
        this.loaded = false;
        this.retryCount = 0;
        this.maxRetries = 3;
    }

    async load() {
        try {
            await this.client.connect();
            this.db = this.client.db('auto_ria_parser');
            
            await this.db.collection(COLLECTION_NAME).createIndex({ timestamp: 1 });
            await this.db.collection(COLLECTION_NAME).createIndex({ url: 1 }, { unique: true });
            
            this.loaded = true;
            this.retryCount = 0;
        } catch (error) {
            console.error('Error connecting to MongoDB:', error);
            
            if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                console.log(`Retrying connection (attempt ${this.retryCount}/${this.maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                return this.load();
            }
            
            throw error;
        }
    }

    async isCarSent(carUrl) {
        try {
            const result = await this.db.collection(COLLECTION_NAME)
                .findOne({ url: carUrl });
            return !!result;
        } catch (error) {
            console.error('Error checking car status:', error);
            return false;
        }
    }

    async markCarAsSent(carUrl) {
        try {
            const count = await this.db.collection(COLLECTION_NAME).countDocuments();
            
            if (count >= MAX_URLS) {
                // Находим самую старую запись для удаления
                const oldestRecord = await this.db.collection(COLLECTION_NAME)
                    .find()
                    .sort({ timestamp: 1 })
                    .limit(1)
                    .toArray();

                if (oldestRecord.length > 0) {
                    // Удаляем самую старую запись
                    await this.db.collection(COLLECTION_NAME)
                        .deleteOne({ _id: oldestRecord[0]._id });
                }
            }

            // Добавляем новую запись
            await this.db.collection(COLLECTION_NAME).insertOne({
                url: carUrl,
                timestamp: new Date()
            });
        } catch (error) {
            if (error.code !== 11000) {
                console.error('Error marking car as sent:', error);
            }
        }
    }
}