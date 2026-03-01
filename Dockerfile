FROM node:20-slim AS builder

WORKDIR /app

# Install root dependencies
COPY package.json package-lock.json ./
RUN npm ci --production=false

# Install and build MCP server
COPY mcp-server/package.json mcp-server/package-lock.json* mcp-server/
RUN cd mcp-server && npm ci

COPY mcp-server/tsconfig.json mcp-server/
COPY mcp-server/src/ mcp-server/src/
RUN cd mcp-server && npm run build

# --- Production stage ---
FROM node:20-slim

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --production && npm cache clean --force

# Copy lib, schema, hooks, scripts
COPY lib/ lib/
COPY schema/ schema/
COPY hooks/ hooks/
COPY archive-turn.js extract-artifacts.js consolidate.js retrieve-context.js catchup-ingestion.js ./
COPY setup.sh ./

# Copy built MCP server
COPY --from=builder /app/mcp-server/dist/ mcp-server/dist/
COPY mcp-server/package.json mcp-server/
RUN cd mcp-server && npm ci --production && npm cache clean --force

# Make hooks executable
RUN chmod +x hooks/*.sh setup.sh

ENV NODE_ENV=production

# MCP server runs on stdio by default
CMD ["node", "mcp-server/dist/index.js"]
