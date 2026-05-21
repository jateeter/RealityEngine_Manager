FROM node:25.5-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json .npmrc ./

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy TypeScript config and source code
COPY tsconfig.json ./
COPY src ./src

# Build the application
RUN npm run build

# Production stage
FROM node:25.5-alpine

WORKDIR /app

# Copy package files
COPY package*.json .npmrc ./

# Install production dependencies only
RUN npm install --production

# Copy built files from build stage
COPY --from=build /app/dist ./dist

# Expose the port
EXPOSE 3001

# Start the server
CMD ["npm", "start"]
