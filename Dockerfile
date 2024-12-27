FROM alaminopu/puppeteer-docker:latest

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your application code
COPY . .

# Expose the desired port (if your application uses one)
EXPOSE 3000

# Command to run your application
CMD ["node", "scraper.js"]