import axios from 'axios';
import * as cheerio from 'cheerio';
import moment from 'moment';
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import { Storage } from './storage.js';
import { getRandomBrowserProfile } from './browsers.js';
import puppeteer from 'puppeteer';
import 'dotenv/config';

// Set timezone for Ukraine
process.env.TZ = 'Europe/Kiev';
moment.locale('uk');

// Validate environment variables
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error('Missing required environment variables');
    process.exit(1);
}

// URL config
const BASE_URL = 'https://auto.ria.com/uk/search/?indexName=auto,order_auto,newauto_search&distance_from_city_km[0]=20&categories.main.id=1&country.import.usa.not=-1&region.id[0]=4&city.id[0]=498&price.currency=1&sort[0].order=dates.created.desc&abroad.not=0&custom.not=1&page=0';

// Size range for random page size
const MIN_SIZE = 20;
const MAX_SIZE = 100;

// Update interval (in milliseconds)
const UPDATE_INTERVAL = 4 * 60 * 1000; // 4 minutes between full update

// Fresh listings threshold (in minutes)
const FRESH_LISTING_THRESHOLD = 30;

// Telegram limits
const MAX_MESSAGES_PER_CYCLE = 50;

let allCars = [];

// Initialize Telegram bot with error handling
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const storage = new Storage();

// Helper function to get random integer between min and max (inclusive)
function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Verify bot connection
bot.getMe().catch(error => {
    console.error('Failed to connect to Telegram:', error);
    process.exit(1);
});

async function getPhoneNumber(url, retryCount = 0) {
    try {
        const browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox']
        });
        const page = await browser.newPage();
        await page.goto(url);
        
        // Wait 2 seconds after page load
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Click the show phone button
        await page.click('.phone_show_link');
        
        // Wait 1 second after clicking
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Get all phone numbers
        const phoneNumbers = await page.$$eval('span.phone.bold', elements => 
            elements.map(el => el.textContent.trim())
        );
        
        await browser.close();

        // Проверяем, содержит ли хотя бы один номер слово "показати"
        const hasShowWord = phoneNumbers.some(number => number.toLowerCase().includes('показати'));
        
        // Если есть слово "показати" и это первая попытка
        if (hasShowWord && retryCount === 0) {
            console.log('Phone number contains "показати", retrying...');
            return getPhoneNumber(url, 1); // Повторный запуск с увеличенным счетчиком
        }
        
        // Если это вторая попытка и все еще есть "показати"
        if (hasShowWord && retryCount === 1) {
            return ['Номер на сайті'];
        }

        console.log('Phone numbers found:', phoneNumbers.length);
        phoneNumbers.forEach((number, index) => {
            console.log(`Phone number ${index + 1}:`, number);
        });

        return phoneNumbers;
    } catch (error) {
        console.error('Error:', error.message);
        if (retryCount === 0) {
            console.log('Error occurred, retrying...');
            return getPhoneNumber(url, 1);
        }
        return ['Номер на сайті'];
    }
}

async function sendToTelegram(car) {
    if (!await storage.isCarSent(car.url)) {
        const addedTime = car.date.format('HH:mm');
        
        try {
            // Get phone numbers before sending message
            console.log(`Getting phone numbers for: ${car.title}`);
            const phoneNumbers = await getPhoneNumber(car.url);
            
            // Format phone numbers
            let phoneInfo = '';
            if (phoneNumbers.length === 1) {
                phoneInfo = `\n📞 ${phoneNumbers[0]}`;
            } else if (phoneNumbers.length > 1) {
                phoneInfo = '\n' + phoneNumbers.map(phone => `📞 ${phone}`).join('\n');
            }
            
            const message = `🚗 Нове авто!\n\n${car.title} (додано ${addedTime})\n\n💰 ${car.price} $${phoneInfo}\n\n${car.url}`;

            await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
            await storage.markCarAsSent(car.url);
            console.log(`✓ Sent to Telegram: ${car.title} (${addedTime})`);
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
    try {
        const timestamp = Date.now();
        const randomParam = Math.random().toString(36).substring(7);
        const randomSize = getRandomInt(MIN_SIZE, MAX_SIZE);
        const urlWithParams = `${BASE_URL}&size=${randomSize}&_=${timestamp}&nocache=${randomParam}`;
        
        // Get random browser profile
        const browserProfile = getRandomBrowserProfile();
        console.log(`Using browser: ${browserProfile.name} ${browserProfile.version}`);
        console.log(`Using random page size: ${randomSize}`);
        
        // Create custom axios instance for this request
        const axiosInstance = axios.create({
            headers: browserProfile.headers,
            timeout: 30000,
            validateStatus: function (status) {
                return status >= 200 && status < 300;
            },
            decompress: true,
            responseType: 'text',
            maxRedirects: 5,
            withCredentials: false
        });
        
        // Add random query parameters to simulate different sessions
        const sessionParams = new URLSearchParams({
            '_rand': Math.random().toString(36).substring(7),
            'tz': browserProfile.timezoneOffset.toString(),
            'sw': browserProfile.screenParams.resolution.width.toString(),
            'sh': browserProfile.screenParams.resolution.height.toString(),
            'cd': browserProfile.screenParams.colorDepth.toString(),
            'v': Math.floor(Math.random() * 1000000).toString()
        });
        
        const finalUrl = `${urlWithParams}&${sessionParams.toString()}`;
        const response = await axiosInstance.get(finalUrl);

        // Add delay after request to allow page to fully load
        console.log('Waiting for page to load completely...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('Processing page content...');

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
                cars.push({
                    date: parsedDate,
                    url,
                    title,
                    price: price || 'Ціна не вказана'
                });
                carCount++;
            }
        });
        
        console.log(`✓ Parsing completed. Found ${carCount} cars`);
        return cars;
    } catch (error) {
        console.error('Error parsing page:', error);
        return [];
    }
}

async function processNewCars() {
    const now = moment();
    const freshThreshold = now.subtract(FRESH_LISTING_THRESHOLD, 'minutes');
    
    const newCars = allCars.filter(car => car.date.isAfter(freshThreshold));

    console.log(`\nFound ${newCars.length} fresh listings`);

    if (newCars.length > 0) {
        console.log('\nProcessing new cars...');
    }

    // Sort cars by date (oldest first)
    const sortedCars = [...newCars].sort((a, b) => a.date - b.date);
    
    // Take only the allowed number of messages
    const carsToProcess = sortedCars.slice(0, MAX_MESSAGES_PER_CYCLE);
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
            const currentTime = moment().format('HH:mm:ss');
            console.log(`\nStarting new update cycle... [${currentTime}]`);
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
