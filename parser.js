import axios from 'axios';
import * as cheerio from 'cheerio';
import moment from 'moment';
import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { Storage } from './storage.js';

// URL and pagination config
const BASE_URL = 'https://auto.ria.com/uk/search/?indexName=auto,order_auto,newauto_search&distance_from_city_km[0]=100&country.import.usa.not=-1&region.id[0]=4&city.id[0]=498&price.currency=1&abroad.not=0&custom.not=1&page=0&size=20';
const PAGES = 10;

// Delay configurations (in milliseconds)
const MIN_PAGE_DELAY = 5000; // 5 seconds
const MAX_PAGE_DELAY = 6000; // 8 seconds
const MESSAGE_DELAY = 1000;   // 1 second between Telegram messages
const UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes between full updates

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
        const minutesAgo = moment().diff(car.date, 'minutes');
        const timeAgoText = minutesAgo <= 1 ? 'тільки що' : `${minutesAgo} хвилин тому`;
        
        const message = `🚗 Нове авто! Додано ${timeAgoText}\n\n${car.title}\n\n💰 ${car.price}\n\n${car.url}`;
        
        try {
            await bot.sendMessage(config.TELEGRAM_CHAT_ID, message);
            await storage.markCarAsSent(car.url);
            console.log(`✓ Sent to Telegram: ${car.title} (${timeAgoText})`);
            await delay(MESSAGE_DELAY);
        } catch (error) {
            console.error('Error sending to Telegram:', error.message);
        }
    }
}

async function parsePage(page) {
    console.log(`Parsing page ${page}...`);
    const response = await axios.get(`${BASE_URL}?page=${page}`);
    const $ = cheerio.load(response.data);
    const cars = [];
    let pageCarCount = 0;

    $('section.ticket-item').each((_, element) => {
        const dateElement = $(element).find('.footer_ticket span[data-add-date]');
        const dateStr = dateElement.attr('data-add-date');
        const link = $(element).find('div.item.ticket-title a.address');
        const url = link.attr('href');
        const title = link.attr('title');
        const price = $(element).find('span.bold.size22.green[data-currency="USD"]').text().trim();
        const phone = $(element).find('.phone').text().trim();

        if (dateStr && url && title) {
            cars.push({
                date: moment(dateStr),
                url,
                title,
                price: price || 'Ціна не вказана',
                phone
            });
            pageCarCount++;
        }
    });
    console.log(`✓ Page ${page} completed. Found ${pageCarCount} cars`);
    return cars;
}

async function parseAllPages() {
    console.log('Starting to parse all pages...');
    let allPageCars = [];

    for (let page = 1; page <= PAGES; page++) {
        try {
            const cars = await parsePage(page);
            allPageCars = [...allPageCars, ...cars];

            if (page < PAGES) {
                const delayTime = Math.floor(Math.random() * (MAX_PAGE_DELAY - MIN_PAGE_DELAY) + MIN_PAGE_DELAY);
                console.log(`Waiting ${Math.round(delayTime/1000)} seconds before next page...`);
                await delay(delayTime);
            }
        } catch (error) {
            console.error(`❌ Error parsing page ${page}:`, error.message);
        }
    }

    console.log(`Parsing completed. Total cars found: ${allPageCars.length}`);
    return allPageCars;
}

async function processNewCars() {
    const freshThreshold = moment().subtract(FRESH_LISTING_THRESHOLD, 'minutes');
    const newCars = allCars
        .filter(car => car.date.isAfter(freshThreshold))
        .sort((a, b) => b.date - a.date); // Newest first

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
    console.log(`\n${moment().format('HH:mm:ss')} - Starting update...`);
    allCars = await parseAllPages();
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