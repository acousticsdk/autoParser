FROM ghcr.io/puppeteer/puppeteer:21.7.0

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy project files
COPY . .

# Set Node options for memory limit and garbage collection
ENV NODE_OPTIONS="--max-old-space-size=512 --expose-gc"

# Start the application
CMD ["node", "parser.js"]