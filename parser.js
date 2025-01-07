import axios from 'axios';
import * as cheerio from 'cheerio';
import moment from 'moment';
import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { Storage } from './storage.js';

// URL config
const BASE_URL = 'https://auto.ria.com/uk/search/?indexName=auto,order_auto,newauto_search&distance_from_city_km[0]=100&country.import.usa.not=-1&region.id[0]=4&city.id[0]=498&price.currency=1&abroad.not=0&custom.not=1&page=0&size=100';

// Delay configurations (in milliseconds)
const MESSAGE_DELAY = 1000;   // 1 second between Telegram messages
const UPDATE_INTERVAL = 10 * 60 * 1000; // 5 minutes between full updates

// Fresh listings threshold (in minutes)
const FRESH_LISTING_THRESHOLD = 60; // Consider listings fresh if they're less than 60 minutes old

// Telegram limits
const MAX_MESSAGES_PER_CYCLE = 10;

let allCars = [];

// Initialize Telegram bot
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN);
const storage = new Storage();

// Helper function for delays
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendToTelegram(car) {
    if (!await storage.isCarSent(car.url)) {
        const addedTime = car.date.format('HH:mm');
        
        const message = `🚗 Нове авто! Час додавання: ${addedTime}\n\n${car.title}\n\n💰 ${car.price}\n\n${car.url}`;
        
        try {
            await bot.sendMessage(config.TELEGRAM_CHAT_ID, message);
            await storage.markCarAsSent(car.url);
            console.log(`✓ Sent to Telegram: ${car.title} (${addedTime})`);
            await delay(MESSAGE_DELAY);
        } catch (error) {
            console.error('Error sending to Telegram:', error.message);
        }
    }
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
            cars.push({
                date: moment(dateStr),
                url,
                title,
                price: price || 'Ціна не вказана'
            });
            carCount++;
        }
    });
    console.log(`✓ Parsing completed. Found ${carCount} cars`);
    return cars;
}

async function processNewCars() {
    const freshThreshold = moment().subtract(FRESH_LISTING_THRESHOLD, 'minutes');
    const newCars = allCars
        .filter(car => car.date.isAfter(freshThreshold))
        .sort((a, b) => a.date - b.date); // Oldest first

    console.log(`Found ${newCars.length} fresh listings in the last ${FRESH_LISTING_THRESHOLD} minutes`);

    // Only process up to MAX_MESSAGES_PER_CYCLE new cars
    const carsToProcess = newCars.slice(0, MAX_MESSAGES_PER_CYCLE);
    
    for (const car of carsToProcess) {
        await sendToTelegram(car);
    }

    if (newCars.length > MAX_MESSAGES_PER_CYCLE) {
        console.log(`Limiting messages to ${MAX_MESSAGES_PER_CYCLE}. ${newCars.length - MAX_MESSAGES_PER_CYCLE} cars will be processed in the next cycle.`);
    }
}

async function updateData() {
    console.log(`\n${moment().format('HH:mm')} - Starting update...`);
    allCars = await parsePage();
    await processNewCars();
}

async function startParsing() {
    console.log('Parser started');
    await storage.load();
    await updateData();
    
    // Restart the whole process every 5 minutes
    setTimeout(() => {
        console.log('\nRestarting parser process...');
        startParsing();
    }, UPDATE_INTERVAL);
}

// Start the parser
startParsing();