import { MongoClient } from 'mongodb';
import moment from 'moment';

const MAX_URLS = 50;
const COLLECTION_NAME = 'sent_cars';
const PENDING_SMS_COLLECTION = 'pending_sms';
const PHONE_NUMBERS_COLLECTION = 'phone_numbers';
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
            
            // Create indexes for sent_cars collection
            await this.db.collection(COLLECTION_NAME).createIndex({ timestamp: 1 });
            await this.db.collection(COLLECTION_NAME).createIndex({ url: 1 }, { unique: true });
            
            // Create indexes for pending_sms collection
            await this.db.collection(PENDING_SMS_COLLECTION).createIndex({ scheduledFor: 1 });
            await this.db.collection(PENDING_SMS_COLLECTION).createIndex({ phoneNumber: 1 });
            
            // Create indexes for phone_numbers collection
            await this.db.collection(PHONE_NUMBERS_COLLECTION).createIndex({ phoneNumber: 1 });
            await this.db.collection(PHONE_NUMBERS_COLLECTION).createIndex({ parsedAt: 1 });
            
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
                const oldestRecord = await this.db.collection(COLLECTION_NAME)
                    .find()
                    .sort({ timestamp: 1 })
                    .limit(1)
                    .toArray();

                if (oldestRecord.length > 0) {
                    await this.db.collection(COLLECTION_NAME)
                        .deleteOne({ _id: oldestRecord[0]._id });
                }
            }

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

    async savePhoneNumber(phoneNumber, carInfo) {
        try {
            await this.db.collection(PHONE_NUMBERS_COLLECTION).insertOne({
                phoneNumber,
                carTitle: carInfo.title,
                carUrl: carInfo.url,
                parsedAt: new Date()
            });
        } catch (error) {
            console.error('Error saving phone number:', error);
        }
    }

    async getPhoneNumbers() {
        try {
            return await this.db.collection(PHONE_NUMBERS_COLLECTION)
                .find({})
                .sort({ parsedAt: -1 })
                .toArray();
        } catch (error) {
            console.error('Error getting phone numbers:', error);
            return [];
        }
    }

    async addPendingSMS(phoneNumber, carInfo) {
        try {
            // Schedule for next day 9:00
            const nextDay = moment().add(1, 'day').set({ hour: 9, minute: 0, second: 0 });
            
            await this.db.collection(PENDING_SMS_COLLECTION).insertOne({
                phoneNumber,
                carTitle: carInfo.title,
                carUrl: carInfo.url,
                message: "Дякуємо за публікацію автомобіля",
                scheduledFor: nextDay.toDate(),
                createdAt: new Date()
            });
        } catch (error) {
            console.error('Error adding pending SMS:', error);
        }
    }

    async getPendingSMSToSend() {
        try {
            const now = new Date();
            return await this.db.collection(PENDING_SMS_COLLECTION)
                .find({
                    scheduledFor: { $lte: now }
                })
                .toArray();
        } catch (error) {
            console.error('Error getting pending SMS:', error);
            return [];
        }
    }

    async removePendingSMS(ids) {
        try {
            await this.db.collection(PENDING_SMS_COLLECTION)
                .deleteMany({
                    _id: { $in: ids }
                });
        } catch (error) {
            console.error('Error removing pending SMS:', error);
        }
    }
}