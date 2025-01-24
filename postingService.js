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

// Функции для эмуляции человеческого поведения
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

async function simulateHumanBehavior(page) {
  // Случайная задержка перед действиями
  await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));

  // Случайные движения мыши
  for (let i = 0; i < getRandomInt(2, 4); i++) {
    await page.mouse.move(
      getRandomInt(100, 700),
      getRandomInt(100, 500),
      { steps: getRandomInt(5, 10) }
    );
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(300, 800)));
  }

  // Случайный скролл
  await page.evaluate(() => {
    const scrollSteps = getRandomInt(3, 6);
    const scrollInterval = setInterval(() => {
      window.scrollBy(0, getRandomInt(100, 200));
    }, getRandomInt(100, 300));

    setTimeout(() => {
      clearInterval(scrollInterval);
    }, scrollSteps * 300);
  });

  // Ждем завершения скролла
  await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));
}

async function simulateGalleryBrowsing(page) {
  // Имитация просмотра галереи
  for (let i = 0; i < getRandomInt(3, 5); i++) {
    // Случайные движения мыши над фотографиями
    const photos = await page.$$('.megaphoto-container figure img');
    if (photos.length > 0) {
      const randomPhoto = photos[getRandomInt(0, photos.length - 1)];
      const box = await randomPhoto.boundingBox();
      if (box) {
        await page.mouse.move(
          box.x + box.width / 2 + getRandomInt(-20, 20),
          box.y + box.height / 2 + getRandomInt(-20, 20),
          { steps: getRandomInt(5, 10) }
        );
      }
    }
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(500, 1500)));
  }
}

function normalizeText(text) {
  return text ? text.replace(/\s+/g, ' ').trim() : text;
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

    await bot.sendMediaGroup(channelId, media);

    await new Promise(resolve => setTimeout(resolve, 2000));

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
  console.log(`Using browser profile: ${browserProfile.name} ${browserProfile.version}`);

  const browser = await puppeteer.launch({
    headless: 'new',
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

  const page = await browser.newPage();
  await page.setUserAgent(browserProfile.userAgent);
  await page.setViewport(browserProfile.viewport);
  await page.setExtraHTTPHeaders(browserProfile.headers);

  return { browser, page, profile: browserProfile };
}

async function tryPostToTelegram(url) {
  let browser = null;
  let page = null;
  
  try {
    // Создаем новый браузер с новым профилем для каждой попытки
    const { browser: newBrowser, page: newPage } = await createBrowserWithProfile();
    browser = newBrowser;
    page = newPage;

    page.setDefaultNavigationTimeout(45000);

    console.log('Navigating to page...');
    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 45000 
    });

    // Эмулируем человеческое поведение после загрузки страницы
    console.log('Simulating human behavior...');
    await simulateHumanBehavior(page);

    await Promise.race([
      page.waitForSelector('.auto-content_title'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for title')), 30000))
    ]);

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

    // Небольшая задержка перед кликом
    await new Promise(resolve => setTimeout(resolve, getRandomDelay(1000, 2000)));

    // Кликаем на кнопку галереи
    await galleryButton.click({ delay: getRandomDelay(50, 150) });
    
    await page.waitForSelector('.megaphoto-container', { timeout: 10000 });
    
    // Эмулируем просмотр галереи
    console.log('Browsing gallery...');
    await simulateGalleryBrowsing(page);

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
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }
  }
}

export async function postToTelegram(url) {
  const MAX_RETRIES = 2;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Starting attempt ${attempt + 1}/${MAX_RETRIES + 1} to post to Telegram...`);
      const result = await tryPostToTelegram(url);
      return result;
    } catch (error) {
      console.error(`Error in attempt ${attempt + 1}: ${error.message}`);
      
      if (attempt < MAX_RETRIES) {
        console.log(`Waiting 5 seconds before retry ${attempt + 2}...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
    }
  }
  
  console.log('All attempts failed');
  return false;
}