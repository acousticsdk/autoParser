import puppeteer from 'puppeteer';
import TelegramBot from 'node-telegram-bot-api';
import sharp from 'sharp';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRandomBrowserProfile } from './browsers.js';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const token = process.env.POSTING_BOT_TOKEN;
const channelId = process.env.POSTING_CHANNEL_ID;
const bot = new TelegramBot(token, { polling: false });

bot.setWebHook('');

const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir);
}

async function handleTelegramError(error) {
  // Обработка ошибки превышения лимита
  if (error.message.includes('429') && error.message.includes('retry after')) {
    const retryAfter = parseInt(error.message.match(/retry after (\d+)/)[1]) || 10;
    console.log(`Rate limit hit. Waiting ${retryAfter} seconds before retry...`);
    await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
    return true;
  }
  
  // Обработка ошибки разрыва соединения
  if (error.message.includes('socket hang up') || error.message.includes('ETIMEDOUT')) {
    console.log('Connection error detected. Waiting 15 seconds before retry...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    return true;
  }
  
  return false;
}

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

async function simulateHumanBehavior(page) {
  try {
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));
    for (let i = 0; i < getRandomInt(2, 4); i++) {
      await page.mouse.move(
        getRandomInt(100, 700),
        getRandomInt(100, 500),
        { steps: getRandomInt(5, 10) }
      );
      await new Promise(resolve => setTimeout(resolve, getRandomDelay(300, 800)));
    }
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(Math.random() * 200) + 100);
    });
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(500, 1000)));
  } catch (error) {
    console.error('Error in simulateHumanBehavior:', error);
  }
}

function normalizeText(text) {
  if (!text) return text;
  
  if (text.includes('л') && text.includes('(')) {
    text = text.replace(/\s*\([^)]*\)\s*/g, ' ');
  }
  
  return text.replace(/\s+/g, ' ').trim();
}

function getRandomPhotos(photos, count) {
  const result = [...photos];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.slice(0, Math.min(count, result.length));
}

function truncateDescription(description) {
  if (!description || description.length <= 250) {
    return description ? description.replace(/<br>/gi, '\n') : description;
  }

  const truncated = description.substring(0, 250);
  const lastPeriodIndex = truncated.lastIndexOf('.');
  
  if (lastPeriodIndex === -1) {
    return truncated + '..';
  }
  
  return description.substring(0, lastPeriodIndex + 1).replace(/<br>/gi, '\n') + '...';
}

async function downloadAndCropImage(url, index) {
  try {
    const response = await axios({
      url,
      responseType: 'arraybuffer',
      timeout: 30000
    });

    const imagePath = path.join(imagesDir, `image_${index}.jpg`);
    const croppedPath = path.join(imagesDir, `cropped_${index}.jpg`);

    await fs.promises.writeFile(imagePath, response.data);

    await sharp(imagePath)
        .metadata()
        .then(metadata => {
          return sharp(imagePath)
              .extract({
                top: 100,
                left: 0,
                width: metadata.width,
                height: metadata.height - 100
              })
              .toFile(croppedPath);
        });

    return croppedPath;
  } catch (error) {
    console.error(`Error processing image ${index}:`, error);
    throw error;
  }
}

async function sendPhotosToTelegram(photos, title, price, engineInfo, mileage, transmission, drivetrain, description) {
  try {
    let selectedPhotos = [];
    
    if (photos.length <= 10) {
      selectedPhotos = photos;
    } else {
      const firstThree = photos.slice(0, 3);
      const remainingPhotos = photos.slice(3);
      const randomSeven = getRandomPhotos(remainingPhotos, 7);
      selectedPhotos = [...firstThree, ...randomSeven];
    }

    const processedPhotos = await Promise.all(
      selectedPhotos.map((photo, index) => downloadAndCropImage(photo, index))
    );

    let caption = `🚘 ${normalizeText(title)}\n\n`;

    if (price) {
      caption += `💵 Ціна: ${normalizeText(price)}\n`;
    }

    if (engineInfo) caption += `🚲 Двигун: ${normalizeText(engineInfo)}\n`;
    if (transmission) caption += `🗳 КПП: ${normalizeText(transmission)}\n`;
    if (drivetrain) caption += `🔗 Привід: ${normalizeText(drivetrain)}\n`;
    if (mileage) caption += `🏃‍♂ Пробіг: ${normalizeText(mileage)}\n`;

    if (engineInfo || transmission || drivetrain || mileage) {
      caption += '\n';
    }

    if (description) {
      const normalizedDesc = normalizeText(description);
      const truncatedDesc = truncateDescription(normalizedDesc);
      caption += `Короткий опис:\n${truncatedDesc}\n\n`;
    }

    caption += `📞 Телефон: +380988210707`;

    const media = processedPhotos.map((photoPath, index) => ({
      type: 'photo',
      media: fs.createReadStream(photoPath),
      filename: path.basename(photoPath),
      contentType: 'image/jpeg',
      caption: index === 0 ? caption : undefined
    }));

    let retries = 5; // Увеличиваем количество попыток
    let delay = 5000; // Начальная задержка 5 секунд

    while (retries > 0) {
      try {
        await bot.sendMediaGroup(channelId, media);
        break;
      } catch (error) {
        console.error(`Telegram error (${retries} retries left):`, error.message);
        
        if (await handleTelegramError(error)) {
          retries--;
          if (retries > 0) {
            // Увеличиваем задержку с каждой попыткой
            delay *= 1.5;
            console.log(`Waiting ${delay/1000} seconds before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        throw error;
      }
    }

    // Добавляем стандартную задержку между отправками
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Очищаем временные файлы
    for (const photoPath of processedPhotos) {
      fs.unlink(photoPath, () => {});
      fs.unlink(photoPath.replace('cropped_', 'image_'), () => {});
    }

    return true;
  } catch (error) {
    console.error('Error sending photos to Telegram:', error);
    return false;
  }
}

async function createBrowserWithProfile() {
  const browserProfile = getRandomBrowserProfile();
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--js-flags="--max-old-space-size=256"',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--no-zygote',
      '--single-process'
    ]
  });

  const page = await browser.newPage();
  
  // Отключаем загрузку изображений и других ресурсов
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.setUserAgent(browserProfile.userAgent);
  await page.setViewport(browserProfile.viewport);
  await page.setExtraHTTPHeaders(browserProfile.headers);

  // Устанавливаем таймауты
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);

  return { browser, page, profile: browserProfile };
}

async function tryPostToTelegram(url) {
  let browser = null;
  let page = null;
  
  try {
    console.log('Creating browser instance...');
    const { browser: newBrowser, page: newPage } = await createBrowserWithProfile();
    browser = newBrowser;
    page = newPage;

    console.log('Navigating to page...');
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });

    console.log('Simulating human behavior...');
    await simulateHumanBehavior(page);

    console.log('Waiting for title element...');
    await page.waitForSelector('.auto-content_title', { timeout: 30000 });

    const carData = await page.evaluate(() => {
      const getData = (selector) => {
        const element = document.querySelector(selector);
        return element ? element.textContent.replace(/\s+/g, ' ').trim() : '';
      };

      const getSpecValue = (label) => {
        const labelElement = Array.from(document.querySelectorAll('dd span.label'))
          .find(el => el.textContent.trim() === label);
        if (labelElement) {
          const valueSpan = labelElement.parentElement.querySelector('span.argument');
          return valueSpan ? valueSpan.textContent.replace(/\s+/g, ' ').trim() : '';
        }
        return '';
      };

      return {
        title: getData('.auto-content_title'),
        price: getData('section.price div.price_value strong'),
        engineInfo: getSpecValue('Двигун'),
        transmission: getSpecValue('Коробка передач'),
        drivetrain: getSpecValue('Привід'),
        mileage: getSpecValue('Пробіг'),
        description: getData('.additional-data.show-line .full-description')
      };
    });

    console.log('Opening gallery...');
    const galleryButton = await page.$('.count-photo.right.mp.fl-r.unlink');
    if (!galleryButton) {
      throw new Error('Gallery button not found');
    }

    // Прокручиваем к кнопке галереи
    await page.evaluate(element => {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, galleryButton);

    await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));

    await galleryButton.click({ delay: getRandomDelay(50, 150) });
    
    console.log('Waiting for gallery to load...');
    await page.waitForFunction(() => {
      const container = document.querySelector('.megaphoto-container');
      const images = container ? container.querySelectorAll('figure img') : [];
      return images.length > 0;
    }, { timeout: 30000 });

    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('Getting image URLs from gallery...');
    const imageUrls = await page.evaluate(() => {
      const figures = document.querySelectorAll('.megaphoto-container figure img');
      return Array.from(figures)
        .map(img => img.src)
        .filter(src => src && !src.includes('data:image'));
    });

    console.log(`Found ${imageUrls.length} images in gallery`);

    if (!imageUrls.length) {
      throw new Error('No images found in gallery');
    }

    return await sendPhotosToTelegram(
      imageUrls,
      carData.title,
      carData.price,
      carData.engineInfo,
      carData.mileage,
      carData.transmission,
      carData.drivetrain,
      carData.description
    );
  } catch (error) {
    console.error('Error occurred:', error);
    throw error;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.error('Error closing page:', e);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('Error closing browser:', e);
      }
    }
  }
}

export async function postToTelegram(url) {
  const MAX_RETRIES = 3;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Starting attempt ${attempt + 1}/${MAX_RETRIES + 1} to post to Telegram...`);
      const result = await tryPostToTelegram(url);
      return result;
    } catch (error) {
      console.error(`Error in attempt ${attempt + 1}: ${error.message}`);
      
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 5000; // Увеличиваем задержку с каждой попыткой
        console.log(`Waiting ${delay/1000} seconds before retry ${attempt + 2}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
    }
  }
  
  console.log('All attempts failed');
  return false;
}