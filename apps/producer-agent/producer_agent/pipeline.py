"""The deterministic pipeline.

Plain async code so its order is testable without an LLM in the loop. `agent.py`
wraps each phase as an ADK tool and lets a SequentialAgent narrate/drive it, but
the ordering guarantee lives here: a fixed sequence of HTTP calls to the OSAI API.

Scope (3-day hackathon): stops at a fully briefed, researched, scripted, shot-
planned and scored production. No async media generation — that path is flaky
under a deadline and adds nothing the judges grade.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from .osai_client import OsaiClient

_log = logging.getLogger("producer_agent")


async def run_pipeline(
    idea: str,
    *,
    client: httpx.AsyncClient | None = None,
    base_url: str | None = None,
) -> dict[str, Any]:
    osai = OsaiClient(base_url=base_url, client=client)

    project_id = await osai.create_project(title=idea[:80])
    await osai.generate_brief(project_id, idea)  # Director (Vertex Gemini)

    research_degraded = False
    try:
        research = await osai.research(project_id, idea)  # Researcher (Parallel Search)
    except Exception as err:  # noqa: BLE001 — any research failure degrades, never aborts
        _log.warning(
            "Parallel research failed (%s) — continuing WITHOUT grounding; the script "
            "will be less fact-checked.",
            err,
        )
        research = {"findings": [], "sources": []}
        research_degraded = True

    script = await osai.generate_script(project_id, idea, research)  # Writer (Vertex Gemini)
    await osai.commit_script(project_id, script)

    scene_ids = await osai.scene_ids(project_id)
    for sid in scene_ids:  # Cinematographer (Vertex Gemini), one call per scene, in order
        await osai.plan_scene(project_id, sid)

    music = await osai.generate_music(project_id)  # Composer (Vertex Gemini)

    return {
        "projectId": project_id,
        "sceneCount": len(scene_ids),
        "researchDegraded": research_degraded,
        "findings": research["findings"],
        "sources": research["sources"],
        "musicGenre": (music.get("music") or {}).get("genre"),
        "studioUrl": f"{osai.base_url}/studio?project={project_id}",
    }
