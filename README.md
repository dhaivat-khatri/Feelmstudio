# Feelm Studio

**An agentic idea-to-film production studio.** Five specialist AI agents — Director, Writer,
Cinematographer, Composer, Editor — take a one-line idea all the way to a finished film,
handing off structured work the way a real crew does.

- **Live:** https://osai-api-701444444212.us-central1.run.app
- **License:** MIT

Built for the Google Cloud × Partner *Summer Blockbuster* hackathon (Parallel track).

## What it does

Give it a sentence. A **Researcher** fact-checks the idea via the Parallel Search API. The
**Director** writes the creative brief plus a visual-continuity note that keeps every scene
the same film. The **Writer** drafts the script scene by scene, grounded in the research. The
**Cinematographer** plans each shot; stills are generated with Gemini on Vertex AI and turned
into motion with Veo. The **Composer** scores it (Lyria). The **Editor** assembles the cut.

Two things make it more than a prompt chain:

- **Every asset is a node in an explicit dependency graph** (`packages/core`). Change the
  brief and *only* the scenes that used it get flagged stale — never "everything downstream."
  Hand-edited work is never silently overwritten, and scene identity survives a merge, split,
  or rewrite.
- **Agent Rooms** — for any scene, the five agents deliberate (think / ask / reply), and each
  one distils a craft lesson that persists across every future project and folds into its
  prompts. The Writer literally gets better at being the Writer.

A Python **ADK "Executive Producer"** agent (`apps/producer-agent`) orchestrates the whole
pipeline, each step one HTTP call to the studio API.

## Architecture

| Piece | Path | Notes |
|---|---|---|
| Graph engine | `packages/core` | dependency graph, precise staleness, versioning, deliberation log |
| Job queue | `packages/jobs` | SQLite-backed async generation queue |
| Model adapters | `packages/inference` | Gemini/Imagen (Vertex), Veo, Lyria, Parallel Search — one fixed contract |
| Persistence | `packages/persistence` | file-backed project store |
| API + web | `apps/server`, `apps/web` | Hono API + React 19 studio, one Cloud Run container |
| Orchestrator | `apps/producer-agent` | `google-adk` SequentialAgent |

## Run it locally

Requires **Node ≥ 22**, `ffmpeg`, and (for real generation) a Google Cloud project with
Vertex AI enabled + `gcloud auth application-default login`.

```bash
npm install
npm run check                       # typecheck + tests (all workspaces)

cp apps/server/.env.example apps/server/.env   # fill in GOOGLE_CLOUD_PROJECT, PARALLEL_API_KEY
npm run dev --workspace @osai/server           # API on :3000
npm run dev --workspace @osai/web              # studio on :5173
```

Without credentials it runs on fake adapters (fast, offline) — set `OSAI_PROVIDER=gemini` to
use real Vertex models.

## Deploy

Single container, Hono serves the API + the built studio:

```bash
gcloud run deploy feelm-studio --source . --region us-central1 \
  --set-env-vars OSAI_ENV=production,OSAI_PROVIDER=gemini,OSAI_VIDEO=veo,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=<project>,GOOGLE_CLOUD_LOCATION=us-central1 \
  --set-secrets PARALLEL_API_KEY=PARALLEL_API_KEY:latest
```

## The orchestrator

```bash
cd apps/producer-agent
pip install -e ".[dev]"
echo "OSAI_API_BASE=<your deployed URL>" > .env
adk run producer_agent          # then give it an idea
```
