import puppeteer from 'puppeteer';
import TelegramBot from 'node-telegram-bot-api';
import sharp from 'sharp';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Replace these with your actual Telegram bot token and channel ID
const token = '7231242979:AAEvkENHXxUbRO7Xoczg0kqZTBi9fDffUX4';
const channelId = '-1002378383260'; // Format: '@channelname' or '-100xxxxxxxxxx'
const bot = new TelegramBot(token, { polling: false });

// Disable deprecation warning
bot.setWebHook('');

// Create images directory if it doesn't exist
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
  return result.slice(0, count);
}

function truncateDescription(description) {
  if (!description || description.length <= 250) {
    return description;
  }

  // Find the last period before 250 characters
  const truncated = description.substring(0, 250);
  const lastPeriodIndex = truncated.lastIndexOf('.');
  
  if (lastPeriodIndex === -1) {
    // If no period found, return first 250 characters
    return truncated;
  }
  
  // Return text up to the last period
  return description.substring(0, lastPeriodIndex + 1);
}

async function downloadAndCropImage(url, index) {
  try {
    const response = await axios({
      url,
      responseType: 'arraybuffer'
    });

    const imagePath = path.join(imagesDir, `image_${index}.jpg`);
    const croppedPath = path.join(imagesDir, `cropped_${index}.jpg`);

    // Save original image
    await fs.promises.writeFile(imagePath, response.data);

    // Crop image (remove top 100px)
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
    // Always take first 3 photos
    const firstThree = photos.slice(0, 3);

    // Get remaining photos
    const remainingPhotos = photos.slice(3);

    // Randomly select 7 photos from the remaining ones
    const randomSeven = getRandomPhotos(remainingPhotos, 7);

    // Combine first 3 and random 7
    const selectedPhotos = [...firstThree, ...randomSeven];

    // Download, crop and prepare all selected photos
    const processedPhotos = await Promise.all(
        selectedPhotos.map((photo, index) => downloadAndCropImage(photo, index))
    );

    // Create caption with exact format and normalize all text fields
    let caption = `🚘 ${normalizeText(title)}\n\n`;

    // Add price if available
    if (price) {
      caption += `💵 Ціна: ${normalizeText(price)}\n`;
    }

    // Add technical specifications if available
    if (engineInfo) caption += `🚲 Двигун: ${normalizeText(engineInfo)}\n`;
    if (transmission) caption += `🗳 КПП: ${normalizeText(transmission)}\n`;
    if (drivetrain) caption += `🔗 Привід: ${normalizeText(drivetrain)}\n`;
    if (mileage) caption += `🏃‍♂ Пробіг: ${normalizeText(mileage)}\n`;

    // Add empty line before description if any specs were added
    if (engineInfo || transmission || drivetrain || mileage) {
      caption += '\n';
    }

    // Add truncated description if available
    if (description) {
      const normalizedDesc = normalizeText(description);
      const truncatedDesc = truncateDescription(normalizedDesc);
      caption += `Короткий опис:\n${truncatedDesc}\n\n`;
    }

    // Add contact information
    caption += `📞 Телефон: +380988210707`;

    // Create media group for Telegram using processed photos
    const media = processedPhotos.map((photoPath, index) => ({
      type: 'photo',
      media: fs.createReadStream(photoPath),
      filename: path.basename(photoPath),
      contentType: 'image/jpeg',
      caption: index === 0 ? caption : undefined, // Add caption only to the first photo
      parse_mode: index === 0 ? 'Markdown' : undefined // Enable Markdown formatting for the caption
    }));

    // Send all 10 photos as one group
    await bot.sendMediaGroup(channelId, media);

    // Clean up - delete all processed images
    for (const photoPath of processedPhotos) {
      fs.unlink(photoPath, err => {
        if (err) console.error('Error deleting file:', err);
      });
      fs.unlink(photoPath.replace('cropped_', 'image_'), err => {
        if (err) console.error('Error deleting original file:', err);
      });
    }

    console.log('Successfully sent 10 cropped photos to Telegram');
    return true;
  } catch (error) {
    console.error('Error sending photos to Telegram:', error);
    return false;
  }
}

export async function postToTelegram(url) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Get the car title
    const title = await page.$eval('.auto-content_title', el => el.textContent.replace(/\s+/g, ' ').trim());
    console.log('Car title:', title);

    // Get the price
    const price = await page.evaluate(() => {
      const priceElement = document.querySelector('section.price div.price_value strong');
      return priceElement ? priceElement.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    console.log('Price:', price);

    // Get engine information
    const engineInfo = await page.evaluate(() => {
      const engineLabel = Array.from(document.querySelectorAll('dd span.label')).find(el => el.textContent.trim() === 'Двигун');
      if (engineLabel) {
        const engineSpan = engineLabel.parentElement.querySelector('span.argument');
        return engineSpan ? engineSpan.textContent.replace(/\s+/g, ' ').trim() : '';
      }
      return '';
    });
    console.log('Engine info:', engineInfo);

    // Get transmission information
    const transmission = await page.evaluate(() => {
      const transmissionLabel = Array.from(document.querySelectorAll('.technical-info dd span.label')).find(el => el.textContent.trim() === 'Коробка передач');
      if (transmissionLabel) {
        const transmissionSpan = transmissionLabel.parentElement.querySelector('span.argument');
        return transmissionSpan ? transmissionSpan.textContent.replace(/\s+/g, ' ').trim() : '';
      }
      return '';
    });
    console.log('Transmission:', transmission);

    // Get drivetrain information
    const drivetrain = await page.evaluate(() => {
      const drivetrainLabel = Array.from(document.querySelectorAll('.technical-info dd span.label')).find(el => el.textContent.trim() === 'Привід');
      if (drivetrainLabel) {
        const drivetrainSpan = drivetrainLabel.parentElement.querySelector('span.argument');
        return drivetrainSpan ? drivetrainSpan.textContent.replace(/\s+/g, ' ').trim() : '';
      }
      return '';
    });
    console.log('Drivetrain:', drivetrain);

    // Get mileage information
    const mileage = await page.evaluate(() => {
      const mileageLabel = Array.from(document.querySelectorAll('dd span.label')).find(el => el.textContent.trim() === 'Пробіг');
      if (mileageLabel) {
        const mileageSpan = mileageLabel.parentElement.querySelector('span.argument');
        return mileageSpan ? mileageSpan.textContent.replace(/\s+/g, ' ').trim() : '';
      }
      return '';
    });
    console.log('Mileage:', mileage);

    // Get description
    const description = await page.evaluate(() => {
      const descElement = document.querySelector('.additional-data.show-line .full-description');
      return descElement ? descElement.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    console.log('Description:', description);

    // Click on the photo gallery button
    await page.click('.count-photo.right.mp.fl-r.unlink');

    // Wait for the photo container to appear
    await page.waitForSelector('.megaphoto-container');

    // Wait additional 5 seconds for images to load
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Extract all image URLs
    const imageUrls = await page.evaluate(() => {
      const figures = document.querySelectorAll('.megaphoto-container figure img');
      return Array.from(figures).map(img => img.src);
    });

    console.log(`Found ${imageUrls.length} images`);

    if (imageUrls.length >= 10) {
      // Send photos to Telegram with all car details
      return await sendPhotosToTelegram(imageUrls, title, price, engineInfo, mileage, transmission, drivetrain, description);
    } else {
      console.log('Not enough photos found (less than 10)');
      return false;
    }
  } catch (error) {
    console.error('Error occurred:', error);
    return false;
  } finally {
    await browser.close();
  }
}