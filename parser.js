import fs from 'fs/promises';

const DB_FILE = 'sent_cars.json';
const MAX_URLS = 50; // Changed from 300 to 10

export class Storage {
  constructor() {
    this.sentCars = new Set();
    this.urlTimestamps = new Map(); // Track when URLs were added
    this.loaded = false;
  }

  async load() {
    try {
      const data = await fs.readFile(DB_FILE, 'utf-8');
      const urls = JSON.parse(data);
      
      // Convert to Map with timestamps
      urls.forEach(url => {
        this.sentCars.add(url);
        this.urlTimestamps.set(url, Date.now());
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.save();
      } else {
        console.error('Error loading storage:', error);
      }
    }
    this.loaded = true;
  }

  async save() {
    await fs.writeFile(DB_FILE, JSON.stringify([...this.sentCars]));
  }

  isCarSent(carUrl) {
    return this.sentCars.has(carUrl);
  }

  async markCarAsSent(carUrl) {
    this.sentCars.add(carUrl);
    this.urlTimestamps.set(carUrl, Date.now());

    // Remove oldest URLs if we exceed the limit
    if (this.sentCars.size > MAX_URLS) {
      const urlsArray = [...this.urlTimestamps.entries()];
      urlsArray.sort((a, b) => a[1] - b[1]); // Sort by timestamp
      
      // Remove oldest URLs until we're back at the limit
      while (this.sentCars.size > MAX_URLS) {
        const [oldestUrl] = urlsArray.shift();
        this.sentCars.delete(oldestUrl);
        this.urlTimestamps.delete(oldestUrl);
      }
    }

    await this.save();
  }
}