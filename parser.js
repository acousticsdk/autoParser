import axios from 'axios';
import * as cheerio from 'cheerio';
import moment from 'moment';
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import { Storage } from './storage.js';
import { SMSService } from './smsService.js';
import { getRandomBrowserProfile } from './browsers.js';
import { postToTelegram } from './postingService.js';
import puppeteer from 'puppeteer';
import 'dotenv/config';

// Set timezone for Ukraine
process.env.TZ = 'Europe/Kiev';
moment.locale('uk');

// Cache for processed URLs to prevent duplicates within the same cycle
const processedUrls = new Set();

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
const BASE_URL = 'https://auto.ria.com/uk/search/?indexName=auto,order_auto,newauto_search&region.id[0]=4&city.id[0]=498&distance_from_city_km[0]=100&price.currency=1&sort[0].order=dates.created.desc&abroad.not=0&custom.not=1&brand.id[0].not=88&brand.id[1].not=18&brand.id[2].not=89&categories.main.id=1&price.USD.gte=5000&page=0';

// Size range for random page size
const MIN_SIZE = 11;
const MAX_SIZE = 60;

// Update interval (in milliseconds)
const UPDATE_INTERVAL = 14 * 60 * 1000; // 14 minutes between full update

// Fresh listings threshold (in minutes)
const FRESH_LISTING_THRESHOLD = 59;

// SMS sending time window
const SMS_START_HOUR = 9;
const SMS_END_HOUR = 18;

// SMS delay between sends (in milliseconds)
const SMS_SEND_DELAY = 3000; // 3 seconds

// Telegram limits
const MAX_MESSAGES_PER_CYCLE = 50;

// Database pagination
const ITEMS_PER_PAGE = 50;

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
        console.log(`Attempting to get phone numbers for URL: ${url}`);
        page = await browser.newPage();
        
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

        console.log('Navigating to page...');
        await page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 30000 
        });

        console.log('Simulating human behavior...');
        await simulateHumanBehavior(page);

        console.log('Waiting for phone button...');
        await page.waitForSelector('.phone_show_link', { 
            visible: true, 
            timeout: 15000 
        });

        const phoneButton = await page.$('.phone_show_link');
        await page.evaluate(element => {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, phoneButton);

        await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));

        console.log('Clicking phone button...');
        try {
            await phoneButton.click({ delay: getRandomDelay(50, 150) });
        } catch (error) {
            console.log('Direct click failed, trying alternative method...');
            await page.evaluate(() => {
                const button = document.querySelector('.phone_show_link');
                if (button) button.click();
            });
        }

        console.log('Waiting for phone numbers to appear...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const phoneNumbers = await page.$$eval('span.phone.bold', elements => 
            elements.map(el => el.textContent.trim())
        );
        
        if (phoneNumbers.some(number => number.toLowerCase().includes('показати'))) {
            throw new Error('Phone numbers not revealed');
        }
        
        if (phoneNumbers.length > 0) {
            console.log(`Successfully retrieved phone numbers: ${phoneNumbers[0]}`);
            return [phoneNumbers[0]];
        }
        
        throw new Error('No phone numbers found');
    } catch (error) {
        console.error(`Error in tryGetPhoneNumbers: ${error.message}`);
        throw error;
    } finally {
        if (page) {
            try {
                console.log('Closing page...');
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
            console.log(`Starting attempt ${attempt + 1}/${MAX_RETRIES + 1} to get phone number...`);
            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1920,1080',
                    '--js-flags="--max-old-space-size=256"'
                ]
            });
          
            console.log('Browser launched successfully');
            const phoneNumbers = await tryGetPhoneNumbers(browser, url);
            
            if (browser) {
                console.log('Closing browser...');
                await browser.close();
            }
            
            return phoneNumbers;
        } catch (error) {
            console.error(`Error in attempt ${attempt + 1}: ${error.message}`);
            
            if (browser) {
                try {
                    console.log('Closing browser after error...');
                    await browser.close();
                } catch (e) {
                    console.error('Error closing browser:', e.message);
                }
            }
            
            if (attempt < MAX_RETRIES) {
                console.log(`Waiting 5 seconds before retry ${attempt + 2}...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
        }
    }
    
    console.log('All attempts failed, returning default phone message');
    return ['Телефон на сайті'];
}

async function handlePhoneNumbers(phoneNumbers, car) {
    const phoneNumber = phoneNumbers[0];
    console.log(`Processing phone number for car ${car.title}: ${phoneNumber}`);
    
    const saveResult = await storage.savePhoneNumber(phoneNumber, car);
    if (!saveResult) {
        console.log(`Skipping SMS handling for invalid phone number: ${phoneNumber}`);
        return false;
    }

    const currentHour = moment().hour();
    const currentTime = moment();
    const nextSendTime = moment();

    if (currentHour < SMS_START_HOUR || currentHour >= SMS_END_HOUR) {
        if (currentHour >= SMS_END_HOUR) {
            nextSendTime.add(1, 'day');
        }
        nextSendTime.set({ hour: SMS_START_HOUR, minute: 0, second: 0 });

        const result = await storage.addPendingSMS(phoneNumber, car, nextSendTime.toDate());
        if (result) {
            console.log(`✓ SMS scheduled for ${nextSendTime.format('DD.MM.YYYY HH:mm')} for ${phoneNumber} (car: ${car.title})`);
            return true;
        } else {
            console.log(`✗ Failed to schedule SMS for ${phoneNumber} (car: ${car.title})`);
            return false;
        }
    } else {
        const result = await smsService.sendSMS([phoneNumber], "Продайте авто швидко та вигідно! Майданчик у Кам'янці-Подільському, просп. Грушевського, 1А. Все просто: професійна оцінка, реклама, швидкий продаж! Телефонуйте: 0988210707. Менеджер зв'яжеться з вами найближчим часом!");
        return result;
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
                    console.log('Waiting 3 seconds before sending next SMS...');
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

async function processCarSequentially(car) {
    if (processedUrls.has(car.url)) {
        console.log(`Skipping duplicate URL in current cycle: ${car.url}`);
        return false;
    }

    console.log('\n=== Starting car processing ===');
    console.log(`URL: ${car.url}`);
    
    const isAlreadySent = await storage.isCarSent(car.url);
    console.log(`Already sent check: ${isAlreadySent}`);
    
    if (!isAlreadySent) {
        console.log(`\nProcessing car: ${car.title}`);
        const addedTime = car.date.format('HH:mm');
        
        try {
            // 1. Get phone numbers
            console.log('\n1. Getting phone numbers...');
            const phoneNumbers = await getPhoneNumber(car.url);
            console.log(`Phone numbers received: ${JSON.stringify(phoneNumbers)}`);
            
            // 2. Handle phone numbers and send SMS
            console.log('\n2. Handling phone numbers...');
            const phoneHandlingResult = await handlePhoneNumbers(phoneNumbers, car);
            console.log(`Phone handling result: ${phoneHandlingResult}`);
            
            // 3. Send to main channel
            console.log('\n3. Sending to main Telegram channel...');
            let phoneInfo = '';
            if (phoneNumbers.length === 1) {
                phoneInfo = `\n📞 ${phoneNumbers[0]}`;
            } else if (phoneNumbers.length > 1) {
                phoneInfo = '\n' + phoneNumbers.map(phone => `📞 ${phone}`).join('\n');
            }
            
            const message = `🚗 Нове авто!\n\n${car.title} (додано ${addedTime})\n\n💰 ${car.price} $${phoneInfo}\n\n${car.url}`;
            const mainChannelResult = await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
            console.log(`Main channel send result: ${JSON.stringify(mainChannelResult)}`);
            
            // 4. Send to second channel
            console.log('\n4. Sending to second Telegram channel...');
            const secondChannelResult = await postToTelegram(car.url);
            console.log(`Second channel posting result: ${secondChannelResult}`);
            
            // 5. Mark as processed
            if (mainChannelResult && secondChannelResult) {
                console.log('\n5. Marking car as sent...');
                const markingResult = await storage.markCarAsSent(car.url);
                console.log(`Marking result: ${markingResult}`);
                
                processedUrls.add(car.url);
                console.log(`\n✓ Successfully processed: ${car.title} (${addedTime})`);
                return true;
            }
        } catch (error) {
            console.error('\n❌ Error in car processing:', error);
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
        console.log(`\nProcessing new cars... Found ${newCars.length} fresh listings`);
    }

    console.log('Sorting cars by date...');
    const sortedCars = [...newCars].sort((a, b) => a.date - b.date);
    const carsToProcess = sortedCars.slice(0, MAX_MESSAGES_PER_CYCLE);
    console.log(`Will process ${carsToProcess.length} cars in this cycle`);
    
    let processedCount = 0;
    
    // Последовательная обработка каждого автомобиля
    for (const car of carsToProcess) {
        const success = await processCarSequentially(car);
        if (success) {
            processedCount++;
            console.log(`Progress: ${processedCount}/${carsToProcess.length} cars processed`);
            
            // Добавляем небольшую задержку между обработкой автомобилей
            if (processedCount < carsToProcess.length) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
        global.gc && global.gc();
    }

    console.log(`\nFinished processing cars. Successfully processed: ${processedCount}/${carsToProcess.length}`);

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

let isUpdating = false;
let updateTimeout = null;

async function updateData() {
    if (isUpdating) {
        console.log('Update already in progress, skipping...');
        return;
    }

    try {
        isUpdating = true;
        const startTime = moment();
        console.log(`\n${startTime.format('HH:mm')} - Starting update...`);
        
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
    } finally {
        isUpdating = false;
        processedUrls.clear();
    }
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/database')) {
        try {
            const urlParams = new URL(req.url, `http://${req.headers.host}`);
            const page = parseInt(urlParams.searchParams.get('page')) || 1;
            const skip = (page - 1) * ITEMS_PER_PAGE;
            
            const { phoneNumbers, totalCount } = await storage.getPhoneNumbers(skip, ITEMS_PER_PAGE);
            const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
            
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            
            let html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Phone Numbers Database</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            margin: 20px;
                            background-color: #f5f5f5;
                        }
                        table {
                            width: 100%;
                            border-collapse: collapse;
                            background-color: white;
                            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                            margin-bottom: 20px;
                        }
                        th, td {
                            padding: 12px;
                            text-align: left;
                            border-bottom: 1px solid #ddd;
                        }
                        th {
                            background-color: #4CAF50;
                            color: white;
                        }
                        tr:hover {
                            background-color: #f5f5f5;
                        }
                        .date {
                            color: #666;
                        }
                        .pagination {
                            display: flex;
                            justify-content: center;
                            gap: 10px;
                            margin-top: 20px;
                        }
                        .pagination a {
                            padding: 8px 16px;
                            text-decoration: none;
                            background-color: white;
                            border: 1px solid #ddd;
                            color: black;
                        }
                        .pagination a:hover {
                            background-color: #ddd;
                        }
                        .pagination .active {
                            background-color: #4CAF50;
                            color: white;
                            border: 1px solid #4CAF50;
                        }
                        .pagination .disabled {
                            color: #ddd;
                            pointer-events: none;
                        }
                    </style>
                </head>
                <body>
                    <h1>Phone Numbers Database</h1>
                    <table>
                        <tr>
                            <th>Car Title</th>
                            <th>Phone Number</th>
                            <th>Date</th>
                        </tr>
            `;
            
            for (const record of phoneNumbers) {
                const date = moment(record.parsedAt).format('DD.MM.YYYY HH:mm');
                html += `
                    <tr>
                        <td>${record.carTitle}</td>
                        <td>${record.phoneNumber}</td>
                        <td class="date">${date}</td>
                    </tr>
                `;
            }
            
            html += `
                    </table>
                    <div class="pagination">
            `;
            
            // Add pagination links
            if (page > 1) {
                html += `<a href="/database?page=1">&laquo; First</a>`;
                html += `<a href="/database?page=${page - 1}">Previous</a>`;
            } else {
                html += `<a class="disabled">&laquo; First</a>`;
                html += `<a class="disabled">Previous</a>`;
            }
            
            // Show current page and total pages
            html += `<a class="active">Page ${page} of ${totalPages}</a>`;
            
            if (page < totalPages) {
                html += `<a href="/database?page=${page + 1}">Next</a>`;
                html += `<a href="/database?page=${totalPages}">Last &raquo;</a>`;
            } else {
                html += `<a class="disabled">Next</a>`;
                html += `<a class="disabled">Last &raquo;</a>`;
            }
            
            html += `
                    </div>
                </body>
                </html>
            `;
            
            res.end(html);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        }
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Parser is running');
    }
});

// Функция запуска парсера
async function startParser() {
    try {
        await storage.load();
        console.log('Database connected successfully');
        
        // Запускаем первое обновление
        await updateData();
        
        // Устанавливаем интервал обновления
        setInterval(updateData, UPDATE_INTERVAL);
        
        console.log(`Parser started. Updates will occur every ${UPDATE_INTERVAL / 1000 / 60} minutes`);
    } catch (error) {
        console.error('Critical error:', error);
        process.exit(1);
    }
}

// Запускаем сервер и парсер
const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    startParser();
});