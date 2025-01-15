FROM ghcr.io/puppeteer/puppeteer:21.7.0

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy project files
COPY . .

# Set memory limit
ENV NODE_OPTIONS=--max-old-space-size=512

# Start the application with garbage collection enabled
CMD ["node", "--expose-gc", "parser.js"]