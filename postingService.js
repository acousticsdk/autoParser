import puppeteer from 'puppeteer';
import TelegramBot from 'node-telegram-bot-api';
import sharp from 'sharp';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

export async function postToTelegram(url) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);

    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 45000 
    });

    await Promise.race([
      page.waitForSelector('.auto-content_title'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for title')), 30000))
    ]);

    // Открываем галерею
    console.log('Opening gallery...');
    const galleryButton = await page.$('.count-photo.right.mp.fl-r.unlink');
    if (!galleryButton) {
      throw new Error('Gallery button not found');
    }

    await galleryButton.click();
    
    // Ждем полной загрузки галереи
    await page.waitForSelector('.megaphoto-container', { timeout: 10000 });
    
    // Добавляем задержку для полной загрузки изображений
    await new Promise(resolve => setTimeout(resolve, 5000));

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

    // Получаем URL изображений из открытой галереи
    console.log('Getting image URLs from gallery...');
    const imageUrls = await page.evaluate(() => {
      const images = Array.from(document.querySelectorAll('.megaphoto-container figure img'))
        .map(img => {
          const imageUrl = img.src;
          if (!imageUrl) return null;
          
          return imageUrl.replace(/\/s\d+x\d+/, '/s2048x2048');
        })
        .filter(src => src && !src.includes('data:image'));

      return [...new Set(images)];
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
    return false;
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