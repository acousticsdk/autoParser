import axios from 'axios';
import * as cheerio from 'cheerio';
import moment from 'moment';
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import { Storage } from './storage.js';
import { SMSService } from './smsService.js';
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

// URL config
const BASE_URL = 'https://auto.ria.com/uk/search/?indexName=auto,order_auto,newauto_search&region.id[0]=4&city.id[0]=498&distance_from_city_km[0]=20&price.currency=1&sort[0].order=dates.created.desc&abroad.not=0&custom.not=1&size=20&brand.id[0].not=88&brand.id[1].not=18&brand.id[2].not=89&categories.main.id=1&price.USD.gte=5000&page=0';

// Size range for random page size
const MIN_SIZE = 10;
const MAX_SIZE = 40;

// Update interval (in milliseconds)
const UPDATE_INTERVAL = 8 * 60 * 1000; // 8 minutes between full update

// Fresh listings threshold (in minutes)
const FRESH_LISTING_THRESHOLD = 30;

// SMS sending time window
const SMS_START_HOUR = 9;
const SMS_END_HOUR = 18;

// SMS delay between sends (in milliseconds)
const SMS_SEND_DELAY = 10000; // 10 seconds

// Telegram limits
const MAX_MESSAGES_PER_CYCLE = 50;

// Initialize services
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const storage = new Storage();
const smsService = new SMSService();

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
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));
    await page.mouse.move(getRandomInt(100, 700), getRandomInt(100, 500));
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(300, 800)));
    await page.evaluate(() => {
        const scrollAmount = Math.floor(Math.random() * 200) + 100;
        window.scrollBy(0, scrollAmount);
    });
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(500, 1000)));
}

async function tryGetPhoneNumbers(browser, url) {
    let page = null;
    try {
        page = await browser.newPage();
        
        // Устанавливаем лимиты на использование памяти для страницы
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'font', 'stylesheet', 'media'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        const browserProfile = getRandomBrowserProfile();
        await page.setUserAgent(browserProfile.userAgent);
        await page.setViewport({ width: 1920, height: 1080 });

        // Устанавливаем таймаут для навигации
        await page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 10000 
        });

        await simulateHumanBehavior(page);

        await page.waitForSelector('.phone_show_link', { 
            visible: true, 
            timeout: 15000 
        });

        const phoneButton = await page.$('.phone_show_link');
        await page.evaluate(element => {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, phoneButton);

        await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));

        try {
            await phoneButton.click({ delay: getRandomDelay(50, 150) });
        } catch (error) {
            await page.evaluate(() => {
                const button = document.querySelector('.phone_show_link');
                if (button) button.click();
            });
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const phoneNumbers = await page.$$eval('span.phone.bold', elements => 
            elements.map(el => el.textContent.trim())
        );
        
        if (phoneNumbers.some(number => number.toLowerCase().includes('показати'))) {
            throw new Error('Phone numbers not revealed');
        }
        
        if (phoneNumbers.length > 0) {
            return [phoneNumbers[0]];
        }
        
        throw new Error('No phone numbers found');
    } finally {
        if (page) {
            try {
                await page.close();
                global.gc && global.gc();
            } catch (e) {
                console.error('Error closing page:', e.message);
            }
        }
    }
}

async function getPhoneNumber(url) {
    const MAX_RETRIES = 2;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        let browser = null;
        
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
                    '--window-size=1920,1080',
                    '--js-flags="--max-old-space-size=256"'
                ]
            });

            const phoneNumbers = await tryGetPhoneNumbers(browser, url);
            
            if (browser) {
                await browser.close();
            }
            
            return phoneNumbers;
        } catch (error) {
            console.error(`Error in attempt ${attempt + 1}: ${error.message}`);
            
            if (browser) {
                try {
                    await browser.close();
                } catch (e) {
                    console.error('Error closing browser:', e.message);
                }
            }
            
            if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
        }
    }
    
    return ['Телефон на сайті'];
}

async function handlePhoneNumbers(phoneNumbers, car) {
    const phoneNumber = phoneNumbers[0];
    await storage.savePhoneNumber(phoneNumber, car);

    const currentHour = moment().hour();
    
    if (currentHour >= SMS_START_HOUR && currentHour < SMS_END_HOUR) {
        const result = await smsService.sendSMS([phoneNumber], "Дякуємо за публікацію автомобіля");
        if (result) {
            console.log(`✓ SMS sent immediately to ${phoneNumber} for car: ${car.title}`);
        }
    } else {
        await storage.addPendingSMS(phoneNumber, car);
        console.log(`✓ SMS scheduled for next day 9:00 for ${phoneNumber} (car: ${car.title})`);
    }
}

async function processPendingSMS() {
    try {
        const pendingSMS = await storage.getPendingSMSToSend();
        if (pendingSMS.length === 0) return;

        console.log(`\nProcessing ${pendingSMS.length} pending SMS messages...`);
        
        for (const sms of pendingSMS) {
            const result = await smsService.sendSMS([sms.phoneNumber], sms.message);
            
            if (result) {
                await storage.removePendingSMS([sms._id]);
                console.log(`✓ Pending SMS sent to ${sms.phoneNumber} for car: ${sms.carTitle}`);
                
                if (pendingSMS.indexOf(sms) < pendingSMS.length - 1) {
                    console.log('Waiting 10 seconds before sending next SMS...');
                    await new Promise(resolve => setTimeout(resolve, SMS_SEND_DELAY));
                }
            }
        }
        
        console.log('✓ Finished processing pending SMS messages');
    } catch (error) {
        console.error('Error processing pending SMS:', error);
    }
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

        console.log('Processing page content...');

        const $ = cheerio.load(response.data, {
            decodeEntities: false,
            xmlMode: false,
            lowerCaseTags: true
        });
        
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
                const car = {
                    date: parsedDate,
                    url,
                    title,
                    price: price || 'Ціна не вказана'
                };
                cars.push(car);
               
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

async function sendToTelegram(car) {
    if (!await storage.isCarSent(car.url)) {
        
        const addedTime = car.date.format('HH:mm');
        
        try {
            const phoneNumbers = await getPhoneNumber(car.url);
            
            await handlePhoneNumbers(phoneNumbers, car);
            
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
            console.error('Error sending to Telegram:', error);
            return false;
        }
    }
    return false;
}

async function processNewCars(cars) {
    const freshThreshold = moment().subtract(FRESH_LISTING_THRESHOLD, 'minutes');
    
    const newCars = cars.filter(car => {
        const isFresh = car.date.isAfter(freshThreshold);
        return isFresh;
    });

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
        global.gc && global.gc();
    }

    if (newCars.length > MAX_MESSAGES_PER_CYCLE) {
        console.log(`Limiting messages to ${MAX_MESSAGES_PER_CYCLE}. ${newCars.length - MAX_MESSAGES_PER_CYCLE} cars will be processed in the next cycle.`);
    }
}

async function runGarbageCollection() {
    if (typeof global.gc === 'undefined') {
        console.log('Garbage collection is not enabled. To enable, run Node.js with --expose-gc flag');
        return;
    }
    
    global.gc();
} 

async function updateData() {
    try {
        console.log(`\n${moment().format('HH:mm')} - Starting update...`);
        
        await processPendingSMS();
        
        const cars = await parsePage();
        if (cars.length > 0) {
            await processNewCars(cars);
            
            setTimeout(runGarbageCollection, 30000);
        } else {
            console.log('No cars found in this update');
        }
    } catch (error) {
        console.error('Error in update cycle:', error);
    }
}

async function startParsing() {
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