FROM ghcr.io/puppeteer/puppeteer:21.7.0

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy project files
COPY . .

# Start the application
CMD ["node", "parser.js"]