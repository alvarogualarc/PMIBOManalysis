# Stage 1: Build the React frontend
FROM node:20-alpine AS frontend-build

WORKDIR /app

# Install deps first for layer caching
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

# Copy frontend source
COPY frontend/src ./src
COPY frontend/index.html ./index.html
COPY frontend/vite.config.ts ./vite.config.ts
COPY frontend/tsconfig.json* ./
COPY frontend/public* ./public/

# Build static assets into /app/dist
RUN npm run build


# Stage 2: Final runtime image
FROM python:3.11-slim

# Install nginx
RUN apt-get update && apt-get install -y --no-install-recommends nginx && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy FastAPI backend
COPY backend/ ./backend/

# nginx config (listens on 8080 per SPCS requirement)
COPY app/nginx.conf /etc/nginx/nginx.conf

# React static build output from stage 1
COPY --from=frontend-build /app/dist /usr/share/nginx/html

# Container entrypoint
COPY app/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# SPCS expects the service on port 8080
EXPOSE 8080

CMD ["/entrypoint.sh"]
