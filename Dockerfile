# syntax=docker/dockerfile:1
# Single full-stack image: build the React app, then Hono serves the API + the
# built SPA. Runs via tsx straight off the TS source (no separate compile step) —
# fine for a demo deploy; revisit if cold-start matters.

FROM node:22-slim
WORKDIR /app

# ffmpeg: the Ken Burns video fallback needs it (Veo, the default here, does not).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci

RUN npm run --workspace @osai/web build

ENV NODE_ENV=production
ENV OSAI_ENV=production
ENV OSAI_PROVIDER=gemini
ENV OSAI_VIDEO=veo
ENV GOOGLE_GENAI_USE_VERTEXAI=true
ENV OSAI_WEB_DIR=/app/apps/web/dist
# Cloud Run's filesystem is writable in-memory only — keep state under /tmp.
ENV OSAI_PROJECTS_DIR=/tmp/osai/projects
ENV OSAI_JOBS_DB=/tmp/osai/jobs.sqlite
ENV OSAI_MEDIA_DIR=/tmp/osai/media
ENV PORT=8080
EXPOSE 8080

WORKDIR /app/apps/server
CMD ["npm", "run", "start"]
