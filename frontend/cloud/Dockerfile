FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
# npm ci needs a lockfile; `npm install` is the fallback for a first build
# before one is committed. Once package-lock.json exists this is a no-op
# difference, but without it the image build would fail outright.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
# EXPO_PUBLIC_API_URL must be the origin + product path, WITHOUT /api — the
# frontend code appends /api/v1/... itself (see src/api.js). On the shared
# domain that is https://3vnsystems.com/delivery-manager; on a dedicated
# host it is just https://deliveries.example.com
ARG EXPO_PUBLIC_API_URL=https://api.example.com
ARG EXPO_PUBLIC_APP_ENV=prod
# Must match the path this product is served under (see the Caddyfile and
# the nginx config baked in below). Leave blank for a root-domain deploy.
ARG EXPO_WEB_BASE_PATH=/delivery-manager
# Google Cloud Console OAuth 2.0 Web client ID, for ADMIN sign-in only.
# Optional: leave blank and the "Sign in with Google" button doesn't render
# (see src/GoogleSignInButton.js). Drivers never need it — they sign in
# with a phone number and a PIN their admin issued. Must match the
# backend's GOOGLE_CLIENT_ID for the same deploy, since the backend checks
# it as the token audience.
ARG EXPO_PUBLIC_GOOGLE_CLIENT_ID=
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL
ENV EXPO_PUBLIC_APP_ENV=$EXPO_PUBLIC_APP_ENV
ENV EXPO_WEB_BASE_PATH=$EXPO_WEB_BASE_PATH
ENV EXPO_PUBLIC_GOOGLE_CLIENT_ID=$EXPO_PUBLIC_GOOGLE_CLIENT_ID

RUN EXPO_NO_TELEMETRY=1 npx expo export --platform web --output-dir dist-web

FROM nginx:1.27-alpine
# nginx.conf serves under /delivery-manager/ (shared domain, behind the
# shared Caddy); nginx.root.conf serves at / (dedicated host). Pick with
#   --build-arg NGINX_CONF=nginx.root.conf
# and remember to blank EXPO_WEB_BASE_PATH in the same build — the two
# must agree or the app will request assets from a path nginx doesn't serve.
ARG NGINX_CONF=nginx.conf
COPY ${NGINX_CONF} /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist-web /usr/share/nginx/html
