FROM alaminopu/puppeteer-docker:latest

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install express

# Copy the rest of your application code
COPY . .

# Expose the API port
EXPOSE 3000

# Command to run your application
CMD ["node", "server.js"]