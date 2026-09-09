"""The orchestrator must drive the OSAI API in a fixed order, and abort on a step failure."""
from __future__ import annotations

import httpx
import pytest

from producer_agent.pipeline import run_pipeline


class RecordingTransport(httpx.AsyncBaseTransport):
    """Records (method, path) of every call and returns canned success responses."""

    def __init__(self, fail_on: str | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self.fail_on = fail_on

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if self.fail_on and self.fail_on in path:
            return httpx.Response(500, json={"error": "boom"})

        if path == "/projects":
            return httpx.Response(201, json={"projectId": "proj_1"})
        if path.endswith("/style/generate"):
            return httpx.Response(200, json={"style": {"genre": "Drama"}, "overview": {}})
        if path.endswith("/research/generate"):
            return httpx.Response(200, json={"findings": ["f1"], "sources": [{"title": "s", "url": "u"}]})
        if path.endswith("/script/generate"):
            return httpx.Response(200, json={"script": "Scene one.\n\nScene two."})
        if path.endswith("/script"):
            return httpx.Response(
                200, json={"applied": True, "overview": {"scenes": [{"sceneId": "sc_1"}, {"sceneId": "sc_2"}]}}
            )
        if path == "/projects/proj_1":
            return httpx.Response(200, json={"scenes": [{"sceneId": "sc_1"}, {"sceneId": "sc_2"}]})
        if path.endswith("/plan/generate"):
            return httpx.Response(200, json={"report": {}, "scene": {}})
        if path.endswith("/music/generate"):
            return httpx.Response(200, json={"music": {"genre": "orchestral"}, "overview": {}})
        return httpx.Response(404, json={"error": f"unmocked {path}"})


@pytest.mark.asyncio
async def test_steps_fire_in_fixed_order() -> None:
    transport = RecordingTransport()
    client = httpx.AsyncClient(transport=transport, base_url="http://osai.test")
    summary = await run_pipeline("a lighthouse keeper on his last night", client=client)

    paths = [p for _, p in transport.calls]
    assert paths.index("/projects/proj_1/style/generate") < paths.index("/projects/proj_1/research/generate")
    assert paths.index("/projects/proj_1/research/generate") < paths.index("/projects/proj_1/script/generate")
    assert paths.index("/projects/proj_1/script/generate") < paths.index("/projects/proj_1/script")
    # every scene planned before the score
    last_plan = max(i for i, p in enumerate(paths) if p.endswith("/plan/generate"))
    assert last_plan < paths.index("/projects/proj_1/music/generate")
    # both scenes were planned
    assert sum(1 for p in paths if p.endswith("/plan/generate")) == 2

    assert summary["projectId"] == "proj_1"
    assert summary["sceneCount"] == 2
    assert summary["researchDegraded"] is False
    assert summary["studioUrl"].endswith("/studio?project=proj_1")


@pytest.mark.asyncio
async def test_a_step_failure_aborts_the_sequence() -> None:
    transport = RecordingTransport(fail_on="/style/generate")
    client = httpx.AsyncClient(transport=transport, base_url="http://osai.test")

    with pytest.raises(httpx.HTTPStatusError):
        await run_pipeline("an idea", client=client)

    paths = [p for _, p in transport.calls]
    assert not any(p.endswith("/script/generate") for p in paths)
    assert not any(p.endswith("/music/generate") for p in paths)


@pytest.mark.asyncio
async def test_parallel_down_degrades_loudly_but_continues(caplog) -> None:
    transport = RecordingTransport(fail_on="/research/generate")
    client = httpx.AsyncClient(transport=transport, base_url="http://osai.test")

    with caplog.at_level("WARNING"):
        summary = await run_pipeline("an idea", client=client)

    assert summary["researchDegraded"] is True
    assert any("research" in r.message.lower() for r in caplog.records if r.levelname == "WARNING")
    paths = [p for _, p in transport.calls]
    assert any(p.endswith("/script/generate") for p in paths)  # it continued
