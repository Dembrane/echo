FROM node:18-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Add build arguments for feature flags
ARG VITE_ENABLE_REPLY=1
ARG VITE_ENABLE_REPORT_GENERATION=1
ARG VITE_ENABLE_CHAT_TEMPLATES=1
ARG VITE_ENABLE_LIBRARY_VIEWS=1
ARG VITE_ENABLE_LIBRARY_INSIGHTS=1
ARG VITE_ENABLE_IMAGE_GENERATION=1
ARG VITE_ENABLE_CONVERSATION_SUMMARY=1

# Add existing build arguments
ARG VITE_API_BASE_URL
ARG VITE_ADMIN_BASE_URL
ARG VITE_PARTICIPANT_BASE_URL
ARG VITE_BUILD_VERSION
ARG VITE_USE_PARTICIPANT_ROUTER
ARG VITE_DIRECTUS_PUBLIC_URL

# Build the application
RUN pnpm build

FROM node:18-alpine

WORKDIR /app

RUN npm install -g --force serve

COPY --from=builder /app/dist /app

CMD ["serve", "-p", "5173", "--single"]