# Use the official Node.js 20-alpine image
FROM node:20-alpine

# Create and define the application directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Expose the application port
EXPOSE 3100

# Start the application
CMD ["npm", "start"]
