"""The ADK entry point — OSAI's "Executive Producer".

A SequentialAgent whose sub-agents each run one phase of the pipeline as a tool.
Step order is code (the `sub_agents` list here + pipeline.py), not LLM routing —
that's the "deterministic multi-step agent" the hackathon asks for. Gemini does
the creative work *inside* each OSAI route (Director brief, Writer script,
Cinematographer plan, Composer direction) plus the per-phase narration here.

Run locally:  adk run producer_agent
Needs:        OSAI_API_BASE pointing at a running OSAI server,
              GOOGLE_CLOUD_PROJECT + GOOGLE_GENAI_USE_VERTEXAI=true for Gemini.
"""
from __future__ import annotations

import logging

from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.tools import FunctionTool
from google.adk.tools.tool_context import ToolContext

from .osai_client import OsaiClient

MODEL = "gemini-2.5-flash"
_log = logging.getLogger("producer_agent")


# --- phase tools. State (project_id, idea, scene_ids) rides in tool_context.state ---


async def start_production(idea: str, tool_context: ToolContext) -> dict:
    """Create the OSAI project and generate the Director's creative brief for `idea`."""
    osai = OsaiClient()
    try:
        project_id = await osai.create_project(title=idea[:80])
        brief = await osai.generate_brief(project_id, idea)
    finally:
        await osai.aclose()
    tool_context.state["project_id"] = project_id
    tool_context.state["idea"] = idea
    return {"projectId": project_id, "brief": brief.get("style")}


async def research_and_write(tool_context: ToolContext) -> dict:
    """Fact-check the idea via Parallel Search, then draft and commit the script."""
    osai = OsaiClient()
    pid = tool_context.state["project_id"]
    idea = tool_context.state["idea"]
    degraded = False
    try:
        try:
            research = await osai.research(pid, idea)
        except Exception as err:  # noqa: BLE001
            _log.warning("Parallel research failed (%s) — writing without grounding.", err)
            research = {"findings": [], "sources": []}
            degraded = True
        script = await osai.generate_script(pid, idea, research)
        await osai.commit_script(pid, script)
        scene_ids = await osai.scene_ids(pid)
    finally:
        await osai.aclose()
    tool_context.state["scene_ids"] = scene_ids
    tool_context.state["research_degraded"] = degraded
    return {
        "findings": research["findings"],
        "sources": research["sources"],
        "sceneCount": len(scene_ids),
        "researchDegraded": degraded,
    }


async def plan_and_score(tool_context: ToolContext) -> dict:
    """Plan every scene's cinematography, then set the score's musical direction."""
    osai = OsaiClient()
    pid = tool_context.state["project_id"]
    scene_ids = tool_context.state["scene_ids"]
    try:
        for sid in scene_ids:
            await osai.plan_scene(pid, sid)
        music = await osai.generate_music(pid)
    finally:
        await osai.aclose()
    return {
        "scenesPlanned": len(scene_ids),
        "music": music.get("music"),
        "studioUrl": f"{osai.base_url}/studio?project={pid}",
    }


def _phase(name: str, what: str, fn) -> LlmAgent:
    return LlmAgent(
        name=name,
        model=MODEL,
        instruction=(
            f"You are the {name.replace('_', ' ')} of an AI video production crew. {what} "
            "Call your tool exactly once, then state what it produced in one or two sentences. "
            "Do not ask the user anything."
        ),
        tools=[FunctionTool(fn)],
    )


root_agent = SequentialAgent(
    name="executive_producer",
    description="Turns a one-line idea into a fully briefed, fact-checked, shot-planned and scored OSAI production.",
    sub_agents=[
        _phase("director_phase", "Take the user's idea and kick off production: create the project and generate the creative brief.", start_production),
        _phase("writer_phase", "Fact-check the idea with web research and write the script grounded in the findings.", research_and_write),
        _phase("crew_phase", "Plan the shots for every scene and set the musical direction.", plan_and_score),
    ],
)
