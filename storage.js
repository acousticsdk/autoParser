import { MongoClient } from 'mongodb';

const MAX_URLS = 50;
const COLLECTION_NAME = 'sent_cars';

export class Storage {
  constructor() {
    this.client = new MongoClient(process.env.MONGODB_URI);
    this.loaded = false;
  }

  async load() {
    try {
      await this.client.connect();
      this.db = this.client.db('auto_ria_parser');
      await this.db.collection(COLLECTION_NAME).createIndex({ timestamp: 1 });
      this.loaded = true;
    } catch (error) {
      console.error('Error connecting to MongoDB:', error);
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
      // Add URL with timestamp
      await this.db.collection(COLLECTION_NAME).insertOne({
        url: carUrl,
        timestamp: new Date()
      });
      
      // Get total count
      const count = await this.db.collection(COLLECTION_NAME).countDocuments();
      
      // If we exceed the limit, remove oldest entries
      if (count > MAX_URLS) {
        const toRemove = count - MAX_URLS;
        const oldestDocs = await this.db.collection(COLLECTION_NAME)
          .find()
          .sort({ timestamp: 1 })
          .limit(toRemove)
          .toArray();
          
        if (oldestDocs.length > 0) {
          const oldestIds = oldestDocs.map(doc => doc._id);
          await this.db.collection(COLLECTION_NAME)
            .deleteMany({ _id: { $in: oldestIds } });
        }
      }
    } catch (error) {
      console.error('Error marking car as sent:', error);
    }
  }
}