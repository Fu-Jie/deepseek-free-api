# ---------------------------------------------------------
# Step 1: Build source
# ---------------------------------------------------------
FROM node:lts-alpine AS build

WORKDIR /app

# Install all dependencies for building
COPY package.json yarn.lock* ./
RUN yarn install --registry https://registry.npmmirror.com/

# Copy source and build
COPY . .
RUN yarn run build

# ---------------------------------------------------------
# Step 2: Prepare production node_modules
# ---------------------------------------------------------
FROM node:lts-alpine AS prod-deps

WORKDIR /app

# Only install mandatory production dependencies
COPY package.json yarn.lock* ./
RUN yarn install --production --registry https://registry.npmmirror.com/ --prefer-offline

# ---------------------------------------------------------
# Step 3: Minimal Runtime image
# ---------------------------------------------------------
FROM node:lts-alpine

WORKDIR /app
ENV NODE_ENV=production

# Only copy build artifacts and runtime dependencies
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/configs ./configs
COPY --from=build /app/*.wasm ./
COPY --from=prod-deps /app/node_modules ./node_modules

EXPOSE 8000

CMD ["node", "dist/index.js"]