"""Thin async HTTP wrapper over the OSAI API. One method per pipeline step.

Every method maps to a route that already exists in apps/server/src/routes.ts —
this agent adds no server-side code, it just drives the existing pipeline.
"""
from __future__ import annotations

import os
from typing import Any

import httpx


class OsaiClient:
    def __init__(self, base_url: str | None = None, client: httpx.AsyncClient | None = None) -> None:
        self.base_url = (base_url or os.environ.get("OSAI_API_BASE", "http://localhost:3000")).rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=120.0)

    async def _post(self, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        r = await self._client.post(f"{self.base_url}{path}", json=body or {})
        r.raise_for_status()
        return r.json()

    async def _get(self, path: str) -> Any:
        r = await self._client.get(f"{self.base_url}{path}")
        r.raise_for_status()
        return r.json()

    # --- pipeline steps, in order ---------------------------------------------

    async def create_project(self, title: str) -> str:
        return (await self._post("/projects", {"title": title}))["projectId"]

    async def generate_brief(self, project_id: str, idea: str) -> dict[str, Any]:
        """Director — POST /projects/:id/style/generate. Real Vertex Gemini call server-side."""
        return await self._post(f"/projects/{project_id}/style/generate", {"idea": idea})

    async def research(self, project_id: str, idea: str) -> dict[str, Any]:
        """Researcher — POST /projects/:id/research/generate. Real Parallel Search call server-side."""
        return await self._post(f"/projects/{project_id}/research/generate", {"idea": idea})

    async def generate_script(self, project_id: str, idea: str, research: dict[str, Any]) -> str:
        """Writer — POST /projects/:id/script/generate, grounded in the research findings."""
        out = await self._post(
            f"/projects/{project_id}/script/generate", {"idea": idea, "research": research}
        )
        return out["script"]

    async def commit_script(self, project_id: str, script: str) -> dict[str, Any]:
        """Commit the draft — POST /projects/:id/script. Splits paragraphs into scene segments."""
        segments = [{"text": para.strip()} for para in script.split("\n\n") if para.strip()]
        return await self._post(f"/projects/{project_id}/script", {"segments": segments})

    async def scene_ids(self, project_id: str) -> list[str]:
        overview = await self._get(f"/projects/{project_id}")
        return [s["sceneId"] for s in overview["scenes"]]

    async def plan_scene(self, project_id: str, scene_id: str) -> dict[str, Any]:
        """Cinematographer — POST /projects/:id/scenes/:sceneId/plan/generate."""
        return await self._post(f"/projects/{project_id}/scenes/{scene_id}/plan/generate")

    async def generate_music(self, project_id: str) -> dict[str, Any]:
        """Composer — POST /projects/:id/music/generate."""
        return await self._post(f"/projects/{project_id}/music/generate")

    async def overview(self, project_id: str) -> dict[str, Any]:
        return await self._get(f"/projects/{project_id}")

    async def aclose(self) -> None:
        await self._client.aclose()
