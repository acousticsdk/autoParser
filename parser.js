import axios from 'axios';
import * as cheerio from 'cheerio';
import moment from 'moment';
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import { Storage } from './storage.js';
import 'dotenv/config';

// Validate environment variables
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error('Missing required environment variables');
    process.exit(1);
}

// URL config
const BASE_URL = 'https://auto.ria.com/uk/search/?indexName=auto,order_auto,newauto_search&distance_from_city_km[0]=100&categories.main.id=1&country.import.usa.not=-1&region.id[0]=4&city.id[0]=498&price.currency=1&sort[0].order=dates.created.desc&abroad.not=0&custom.not=1&page=0&size=100';

// Delay configurations (in milliseconds)
const MESSAGE_DELAY = 1000;   // 1 second between Telegram messages
const UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes between full updates

// Fresh listings threshold (in minutes)
const FRESH_LISTING_THRESHOLD = 11;

// Telegram limits
const MAX_MESSAGES_PER_CYCLE = 10;

let allCars = [];

// Initialize Telegram bot with error handling
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const storage = new Storage();

// Helper function for delays
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendToTelegram(car) {
    if (!await storage.isCarSent(car.url)) {
        const addedTime = car.date.format('HH:mm');
        const message = `🚗 Нове авто!\n\n${car.title} (додано ${addedTime})\n\n💰 ${car.price} $\n\n${car.url}`;

        try {
            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
            await storage.markCarAsSent(car.url);
            console.log(`✓ Sent to Telegram: ${car.title} (${addedTime})`);
            await delay(MESSAGE_DELAY);
            return true;
        } catch (error) {
            console.error('Error sending to Telegram:', error.message);
            return false;
        }
    }
    return false;
}

async function parsePage() {
    console.log('Parsing page...');
    const response = await axios.get(BASE_URL);
    const $ = cheerio.load(response.data);
    const cars = [];
    let carCount = 0;

    $('section.ticket-item').each((_, element) => {
        const dateElement = $(element).find('.footer_ticket span[data-add-date]');
        const dateStr = dateElement.attr('data-add-date');
        const link = $(element).find('div.item.ticket-title a.address');
        const url = link.attr('href');
        const title = link.attr('title');
        const price = $(element).find('span.bold.size22.green[data-currency="USD"]').text().trim();

        if (dateStr && url && title) {
            const parsedDate = moment(dateStr);
            console.log(`Raw date: ${dateStr}, Parsed date: ${parsedDate.format('YYYY-MM-DD HH:mm:ss')}`);
            
            cars.push({
                date: parsedDate,
                url,
                title,
                price: price || 'Ціна не вказана'
            });
            carCount++;
        }
    });
    
    console.log('\nFirst 3 cars with dates:');
    cars.slice(0, 3).forEach(car => {
        console.log(`${car.title}: ${car.date.format('YYYY-MM-DD HH:mm:ss')}`);
    });
    
    console.log(`✓ Parsing completed. Found ${carCount} cars`);
    return cars;
}

async function processNewCars() {
    const freshThreshold = moment().subtract(FRESH_LISTING_THRESHOLD, 'minutes');
    const newCars = allCars
        .filter(car => car.date.isAfter(freshThreshold))
        .sort((a, b) => a.date - b.date);

    console.log(`Found ${newCars.length} fresh listings in the last ${FRESH_LISTING_THRESHOLD} minutes`);

    const carsToProcess = newCars.slice(0, MAX_MESSAGES_PER_CYCLE);
    let sentCount = 0;
    
    for (const car of carsToProcess) {
        if (await sendToTelegram(car)) {
            sentCount++;
        }
    }

    console.log(`Successfully sent ${sentCount} messages`);

    if (newCars.length > MAX_MESSAGES_PER_CYCLE) {
        console.log(`Limiting messages to ${MAX_MESSAGES_PER_CYCLE}. ${newCars.length - MAX_MESSAGES_PER_CYCLE} cars will be processed in the next cycle.`);
    }
}

async function updateData() {
    try {
        console.log(`\n${moment().format('HH:mm')} - Starting update...`);
        const cars = await parsePage();
        if (cars.length > 0) {
            allCars = cars;
            await processNewCars();
        } else {
            console.log('No cars found in this update');
        }
    } catch (error) {
        console.error('Error in update cycle:', error);
    }
}

async function startParsing() {
    console.log('Parser started');
    try {
        await storage.load();
        await updateData();
        
        setInterval(async () => {
            console.log('\nStarting new update cycle...');
            await updateData();
        }, UPDATE_INTERVAL);
    } catch (error) {
        console.error('Critical error:', error);
        process.exit(1);
    }
}

// Create HTTP server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Parser is running');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    startParsing();
});