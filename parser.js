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
const BASE_URL = 'https://auto.ria.com/uk/search/?indexName=auto,order_auto,newauto_search&distance_from_city_km[0]=100&categories.main.id=1&country.import.usa.not=-1&region.id[0]=4&city.id[0]=498&price.currency=1&sort[0].order=dates.created.desc&abroad.not=0&custom.not=1&page=0';

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

// Helper function to generate random delay
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

async function simulateHumanBehavior(page) {
    // Случайная задержка перед действиями
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));
    
    // Случайные движения мыши
    await page.mouse.move(getRandomInt(100, 700), getRandomInt(100, 500));
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(300, 800)));
    
    // Случайная прокрутка
    await page.evaluate((min, max) => {
        const scrollAmount = Math.floor(Math.random() * (max - min + 1)) + min;
        window.scrollBy(0, scrollAmount);
    }, 100, 300);
    
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(500, 1000)));
}

async function waitForSelectorWithRetry(page, selector, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await page.waitForSelector(selector, { 
                visible: true, 
                timeout: 15000 
            });
            
            // Дополнительная проверка на видимость и кликабельность
            const element = await page.$(selector);
            if (!element) {
                throw new Error('Element not found after waiting');
            }
            
            const isVisible = await element.isVisible();
            if (!isVisible) {
                throw new Error('Element is not visible');
            }
            
            const box = await element.boundingBox();
            if (!box) {
                throw new Error('Element has no bounding box');
            }
            
            return element;
        } catch (error) {
            console.log(`Attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
            if (attempt === maxAttempts) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

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
                '--no-zygote',
                '--window-size=1920,1080'
            ]
        });

        page = await browser.newPage();
        
        await page.setDefaultNavigationTimeout(45000);
        await page.setDefaultTimeout(45000);
        
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        const browserProfile = getRandomBrowserProfile();
        await page.setUserAgent(browserProfile.userAgent);
        await page.setViewport({ width: 1920, height: 1080 });

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

        // Эмуляция человеческого поведения перед поиском кнопки
        await simulateHumanBehavior(page);

        // Ждем появления кнопки с повторными попытками
        console.log('Waiting for phone button...');
        const phoneButton = await waitForSelectorWithRetry(page, '.phone_show_link');
        console.log('Phone button found');

        // Прокручиваем страницу к кнопке
        await page.evaluate(element => {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, phoneButton);

        await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));

        // Пробуем разные способы клика
        try {
            // 1. Прямой клик через ElementHandle
            await phoneButton.click({ delay: getRandomDelay(50, 150) });
            console.log('Direct click successful');
        } catch (error) {
            console.log('Direct click failed, trying alternative methods...');
            
            try {
                // 2. Клик через evaluate
                await page.evaluate(() => {
                    const button = document.querySelector('.phone_show_link');
                    if (button) {
                        button.click();
                    }
                });
                console.log('Evaluate click successful');
            } catch (evalError) {
                console.log('Evaluate click failed, trying dispatch...');
                
                // 3. Диспатч события клика
                await page.evaluate(() => {
                    const button = document.querySelector('.phone_show_link');
                    if (button) {
                        const clickEvent = new MouseEvent('click', {
                            bubbles: true,
                            cancelable: true,
                            view: window
                        });
                        button.dispatchEvent(clickEvent);
                    }
                });
            }
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
        
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