# Build stage
FROM node:25.5-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json .npmrc ./

# Install dependencies
RUN npm install

# Copy source code and config files
COPY . .

# Build the application
RUN npm run build

# Fix permissions in build stage before copying
RUN find /app/dist -type f -exec chmod 644 {} \; && \
    find /app/dist -type d -exec chmod 755 {} \;

# Production stage
FROM nginx:alpine

# Copy built files from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Fix permissions for all files to ensure nginx can serve them
RUN find /usr/share/nginx/html -type f -exec chmod 644 {} \; && \
    find /usr/share/nginx/html -type d -exec chmod 755 {} \;

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
