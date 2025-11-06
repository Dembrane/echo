# for installing custom extensions via npm

# FROM node:22-alpine AS third-party-ext

# RUN apk add python3 g++ make

# WORKDIR /extensions

# # Copy package files first for better layer caching
# COPY extensions/package*.json ./

# RUN npm install

# # Copy the rest of the extensions after npm install
# COPY extensions/. ./
# # Move all extensions the starts with 'directus-extension-', using find, to the /extensions/directus folder
# RUN mkdir -p ./directus

# RUN cd node_modules && find . -maxdepth 1 -type d -name "directus-extension-*" -exec mv {} ../directus \;

FROM tractr/directus-sync:11.13.0

COPY ./directus-sync.config.js ./directus-sync.config.js

# COPY --from=third-party-ext /extensions/directus ./extensions

COPY ./templates ./templates/

# https://github.com/directus/directus/blob/main/Dockerfile
CMD : \
    && node cli.js bootstrap \
    && pm2-runtime start ecosystem.config.cjs \
    ;