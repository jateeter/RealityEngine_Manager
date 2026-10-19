FROM node:26.12-alpine AS build

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:26.12-alpine

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm install --production

COPY --from=build /app/dist ./dist

EXPOSE 3004

CMD ["npm", "start"]
