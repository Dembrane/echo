FROM node:22-alpine AS third-party-ext

RUN apk add python3 g++ make

WORKDIR /extensions

COPY extensions .

RUN npm install
# Move all extensions the starts with 'directus-extension-', using find, to the /extensions/directus folder
RUN mkdir -p ./directus

RUN cd node_modules && find . -maxdepth 1 -type d -name "directus-extension-*" -exec mv {} ../directus \;


FROM directus/directus:11.5.1

# for extensions installed via npm

COPY ./directus-sync.config.js ./directus-sync.config.js

COPY --from=third-party-ext /extensions/directus ./extensions
COPY ./templates ./templates/

# https://github.com/directus/directus/blob/main/Dockerfile
CMD : \
    && node cli.js bootstrap \
    && pm2-runtime start ecosystem.config.cjs \
    ;