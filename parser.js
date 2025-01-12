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

// Common headers for requests
const commonHeaders = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache'
};

// Validate environment variables
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error('Missing required environment variables');
    process.exit(1);
}

// URL config
const BASE_URL = 'https://auto.ria.com/uk/search/?indexName=auto,order_auto,newauto_search&distance_from_city_km[0]=70&categories.main.id=1&country.import.usa.not=-1&region.id[0]=4&city.id[0]=498&price.currency=1&sort[0].order=dates.created.desc&abroad.not=0&custom.not=1&page=0';

// Size range for random page size
const MIN_SIZE = 20;
const MAX_SIZE = 80;

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
    const MAX_RETRIES = 3;
    let browser = null;
    let page = null;
    
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-extensions',
                '--memory-pressure-off',
                '--single-process',
                '--no-zygote'
            ]
        });

        page = await browser.newPage();
        
        // Установка таймаутов
        await page.setDefaultNavigationTimeout(45000);
        await page.setDefaultTimeout(45000);
        
        // Отключение изображений и стилей для экономии памяти
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        const browserProfile = getRandomBrowserProfile();
        await page.setUserAgent(browserProfile.userAgent);
        await page.setViewport({ width: 1280, height: 800 });

        // Переход на страницу с обработкой ошибок
        try {
            await page.goto(url, { 
                waitUntil: 'networkidle2',
                timeout: 30000
            });
        } catch (error) {
            console.log(`Navigation error: ${error.message}`);
            if (retryCount < MAX_RETRIES) {
                console.log(`Retrying navigation (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                return getPhoneNumber(url, retryCount + 1);
            }
            throw error;
        }

        // Ожидание появления кнопки и проверка видимости
        await page.waitForSelector('.phone_show_link', { timeout: 10000 });
        
        // Проверяем видимость элемента
        const isVisible = await page.evaluate(() => {
            const element = document.querySelector('.phone_show_link');
            if (!element) return false;
            
            const style = window.getComputedStyle(element);
            return style && 
                   style.display !== 'none' && 
                   style.visibility !== 'hidden' && 
                   style.opacity !== '0';
        });
        
        console.log(`Phone button visibility status: ${isVisible ? 'visible' : 'not visible'}`);
        
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Клик по кнопке с повторными попытками
        let clicked = false;
        for (let i = 0; i < 3; i++) {
            try {
                await page.click('.phone_show_link');
                clicked = true;
                break;
            } catch (error) {
                console.log(`Click attempt ${i + 1} failed: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        if (!clicked) {
            throw new Error('Failed to click phone button after 3 attempts');
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const phoneNumbers = await page.$$eval('span.phone.bold', elements => 
            elements.map(el => el.textContent.trim())
        );
        
        const hasShowWord = phoneNumbers.some(number => 
            number.toLowerCase().includes('показати')
        );
        
        if (hasShowWord && retryCount < MAX_RETRIES) {
            console.log(`Found "показати" in response, retrying... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            return getPhoneNumber(url, retryCount + 1);
        }
        
        if (phoneNumbers.length > 0 && !hasShowWord) {
            console.log('Phone numbers found:', phoneNumbers.length);
            return phoneNumbers;
        }
        
        return ['📞 Телефон на сайті'];
    } catch (error) {
        console.error(`Error getting phone numbers (attempt ${retryCount + 1}): ${error.message}`);
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying full process... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            return getPhoneNumber(url, retryCount + 1);
        }
        return ['📞 Телефон на сайті'];
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (e) {
                console.error('Error closing page:', e.message);
            }
        }
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                console.error('Error closing browser:', e.message);
            }
        }
    }
}

async function sendToTelegram(car) {
    if (!await storage.isCarSent(car.url)) {
        const addedTime = car.date.format('HH:mm');
        
        try {
            console.log(`Getting phone numbers for: ${car.title}`);
            const phoneNumbers = await getPhoneNumber(car.url);
            
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
        
        const browserProfile = getRandomBrowserProfile();
        console.log(`Using browser: ${browserProfile.name} ${browserProfile.version}`);
        console.log(`Using random page size: ${randomSize}`);
        
        const axiosInstance = axios.create({
            headers: {
                ...commonHeaders,
                ...browserProfile.headers
            },
            timeout: 30000,
            validateStatus: function (status) {
                return status >= 200 && status < 300;
            },
            decompress: true,
            responseType: 'text',
            maxRedirects: 5,
            withCredentials: false
        });
        
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

        // Очищаем память
        $.root().empty();
        response.data = null;
        
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

    const sortedCars = [...newCars].sort((a, b) => a.date - b.date);
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

async function runGarbageCollection() {
    if (global.gc) {
        console.log('Running garbage collection...');
        global.gc();
        console.log('Garbage collection completed');
    }
}

async function updateData() {
    try {
        console.log(`\n${moment().format('HH:mm')} - Starting update...`);
        const cars = await parsePage();
        if (cars.length > 0) {
            allCars = cars;
            await processNewCars();
            allCars = []; // Очищаем массив после обработки
            
            // Запускаем сборщик мусора через 60 секунд после завершения цикла
            setTimeout(runGarbageCollection, 60000);
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