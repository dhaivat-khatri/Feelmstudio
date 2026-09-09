# OSAI Executive Producer — ADK agent

The Google Cloud Agent Builder entry point for OSAI. A [Google ADK](https://google.github.io/adk-docs/)
`SequentialAgent` that turns a one-line idea into a fully briefed, fact-checked,
shot-planned and scored production by driving the existing OSAI API.

## Deterministic multi-step

Step order is **code**, not LLM routing — it lives in
[`producer_agent/pipeline.py`](producer_agent/pipeline.py) and the `sub_agents`
list in [`producer_agent/agent.py`](producer_agent/agent.py):

| Phase | ADK sub-agent | OSAI routes it calls | Model work |
|---|---|---|---|
| Director | `director_phase` | `POST /projects`, `POST /projects/:id/style/generate` | Vertex Gemini writes the creative brief |
| Writer | `writer_phase` | `POST /projects/:id/research/generate`, `POST /projects/:id/script/generate`, `POST /projects/:id/script` | **Parallel Search** fact-checks the idea; Vertex Gemini writes the script grounded in the findings |
| Crew | `crew_phase` | `POST /projects/:id/scenes/:sceneId/plan/generate` (per scene), `POST /projects/:id/music/generate` | Vertex Gemini plans each shot and sets the musical direction |

Each phase `LlmAgent` runs on `gemini-2.5-flash` and narrates what its tool produced.

If Parallel Search is down, the Writer phase logs a `WARNING`, sets
`researchDegraded`, and continues without grounding — it never aborts the run.

## Runtime use of Google Cloud + Parallel

- **Vertex AI:** every OSAI creative route runs `@google/genai` with
  `vertexai: true` — see `../../packages/inference/src/gemini-adapter.ts`.
- **Parallel:** `../../packages/inference/src/parallel-adapter.ts` calls
  `POST https://api.parallel.ai/v1/search`.
- **ADK / Agent Builder:** `producer_agent/agent.py` — `SequentialAgent`,
  `LlmAgent(model="gemini-2.5-flash")`, `FunctionTool`.

## Run it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env      # set GOOGLE_CLOUD_PROJECT; OSAI_API_BASE defaults to localhost:3000

# terminal 1 — the OSAI server (needs Vertex + Parallel creds, see apps/server/.env.example)
cd ../server && OSAI_PROVIDER=gemini npm run dev

# terminal 2 — the agent
.venv/bin/adk run producer_agent
# then type an idea, e.g.:  a lighthouse keeper spends one last night on duty
```

## Tests

```bash
.venv/bin/python -m pytest -q
```

`tests/test_pipeline_order.py` asserts the fixed step order, abort-on-failure,
and the Parallel-down degrade path, using a recording `httpx` transport — no
network, no credentials.

## Deploy to Vertex AI Agent Engine (not run for the hackathon submission — Fork A)

The demo runs the agent locally via `adk run` against the hosted OSAI URL. To
deploy the agent itself:

```bash
.venv/bin/adk deploy agent_engine \
  --project "$GOOGLE_CLOUD_PROJECT" --region us-central1 \
  --staging_bucket "gs://$GOOGLE_CLOUD_PROJECT-osai-staging" \
  producer_agent
```
