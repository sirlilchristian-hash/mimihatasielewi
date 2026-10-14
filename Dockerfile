# Stage 1: Build Frontend and Server
FROM node:22-slim AS builder
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install all dependencies reliably
RUN npm ci --legacy-peer-deps

# Copy application source code
COPY . .

# Run unified build (Vite client SPA + esbuild dist/server.cjs)
RUN npm run build

# Stage 2: Minimal Production Server Runner
FROM node:22-slim AS runner
WORKDIR /app

# Set Node environment to production
ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# Copy compiled distribution output from builder
COPY --from=builder /app/dist ./dist

# Copy sample document fallback for offline PDF verification
COPY sample.pdf ./sample.pdf

# Cloud Run defaults to 8080 (injected at container runtime)
EXPOSE 8080

# Production startup entry
CMD ["npm", "start"]
