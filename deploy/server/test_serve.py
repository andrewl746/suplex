"""Tests for the live server's routing and its loading state. No city data is read: the loader is a fake."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))

import serve  # needs the path above


def echo_app(name: str) -> Starlette:
    """A service that answers every path with its own name and the path it was asked for."""
    async def show(request: Request) -> JSONResponse:
        return JSONResponse({"service": name, "path": request.scope["path"], "root_path": request.scope["root_path"],
                             "route": request.url.path.removeprefix(request.scope["root_path"])})

    return Starlette(routes=[Route("/{rest:path}", show)])


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><title>Suplex</title>", encoding="utf-8")
    (tmp_path / "assets" / "app-abc123.js").write_text("console.log('suplex')", encoding="utf-8")
    return tmp_path


class Loader:
    """Stands in for load_everything: reports the real step names, then waits to be released."""

    def __init__(self, fail_with: str | None = None) -> None:
        self.release = threading.Event()
        self.reached_index = threading.Event()
        self.fail_with = fail_with

    def __call__(self, state: serve.Warmup) -> None:
        for step in serve.STEP_SHARES:
            state.begin(step)
        self.reached_index.set()
        self.release.wait(timeout=10)
        if self.fail_with:
            state.fail(self.fail_with)
        else:
            state.finish({"api": echo_app("api"), "ai": echo_app("ai")})


MONTH_1 = 1_793_000_000.0            # a moment in October 2026 (UTC)
MONTH_2 = MONTH_1 + 31 * 86_400      # and one in the month after


def roomy(tmp_path: Path) -> serve.Budget:
    """A month's limits nothing in a test reaches, counted in a scratch file (never data/out)."""
    return serve.Budget(tmp_path / "usage.json", monthly_bytes=1e12, monthly_awake_s=1e9)


def started(dist: Path, loader: Loader, **parts: object) -> TestClient:
    parts.setdefault("budget", roomy(dist))
    parts.setdefault("stop_running", lambda: None)
    return TestClient(serve.create_server(dist, loader=loader, **parts))


def test_the_step_shares_cover_every_step_the_store_reports() -> None:
    from api.store import OPTIONAL_LAYERS, REQUIRED_LAYERS, STEP_INDEX

    assert list(serve.STEP_SHARES) == ["imports", *REQUIRED_LAYERS, *OPTIONAL_LAYERS, STEP_INDEX]


def test_progress_only_moves_forward_and_ends_at_one() -> None:
    state = serve.Warmup(serve.STEP_SHARES)
    seen = [state.snapshot()["progress"]]
    for step in serve.STEP_SHARES:
        state.begin(step)
        now = state.snapshot()
        assert now["progress"] < now["until"] <= 1.0   # each step has room for the bar to creep through
        seen.append(now["progress"])
    state.begin("a step this server has no share for")
    seen.append(state.snapshot()["progress"])
    assert seen == sorted(seen) and seen[0] == 0.0 and seen[-1] < 1.0
    state.finish({"api": echo_app("api")})
    assert state.snapshot() == {"ready": True, "progress": 1.0, "until": 1.0, "step": serve.READY, "error": None}


def test_the_site_and_the_warmup_answer_before_the_data_is_loaded(dist: Path) -> None:
    loader = Loader()
    with started(dist, loader) as client:
        assert loader.reached_index.wait(timeout=5)
        page = client.get("/")
        assert page.status_code == 200 and "Suplex" in page.text
        assert page.headers["cache-control"] == "no-cache"
        asset = client.get("/assets/app-abc123.js")
        assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
        warmup = client.get("/warmup")
        assert warmup.headers["cache-control"] == "no-store"
        body = warmup.json()
        assert body["ready"] is False and body["step"] == "index" and 0 < body["progress"] < 1
        loader.release.set()


def test_each_service_gets_its_own_paths_once_ready(dist: Path) -> None:
    loader = Loader()
    loader.release.set()
    with started(dist, loader) as client:
        assert client.get("/api/check?address_id=1").json() == {
            "service": "api", "path": "/api/check", "root_path": "/api", "route": "/check"}
        assert client.get("/ai/b/04").json()["route"] == "/b/04"
        assert client.get("/ai/b/04").json()["service"] == "ai"
        # The briefing page's own files, and its briefing, keep their absolute paths.
        for path in ("/page/briefing.js", "/static/design-tokens.css", "/briefing"):
            assert client.get(path).json() == {"service": "ai", "path": path, "root_path": "", "route": path}
        assert client.get("/warmup").json()["ready"] is True
        assert client.get("/apiary").status_code == 404   # the site, not the API: "/api" must be a whole segment


def test_an_early_api_request_waits_for_the_data(dist: Path) -> None:
    loader = Loader()
    with started(dist, loader) as client:
        assert loader.reached_index.wait(timeout=5)
        threading.Timer(0.3, loader.release.set).start()
        assert client.get("/api/health").json()["service"] == "api"


def test_a_failed_load_is_a_503_in_the_api_error_shape(dist: Path) -> None:
    loader = Loader(fail_with="data_missing")
    loader.release.set()
    with started(dist, loader) as client:
        response = client.get("/api/health")
        assert response.status_code == 503 and response.json() == {"error": "starting", "detail": "data_missing"}
        assert client.get("/warmup").json()["error"] == "data_missing"
        assert client.get("/").status_code == 200   # the page still loads, so it can say what happened


def test_the_months_use_survives_a_restart_and_starts_again_next_month(tmp_path: Path) -> None:
    now = [MONTH_1]
    path = tmp_path / "usage.json"
    budget = serve.Budget(path, monthly_bytes=1000, monthly_awake_s=3600, clock=lambda: now[0])
    budget.add(sent=400, awake_s=60)
    budget.save()
    again = serve.Budget(path, monthly_bytes=1000, monthly_awake_s=3600, clock=lambda: now[0])
    assert (again.sent, again.awake_s, again.over()) == (400, 60.0, None)
    again.add(sent=600)
    assert again.over() == "transfer"
    now[0] = MONTH_2
    assert again.over() is None and again.sent == 0
    again.save()
    assert serve.Budget(path, 1000, 3600, clock=lambda: now[0]).sent == 0


def test_too_many_awake_hours_is_a_limit_too_and_an_unreadable_file_counts_from_nothing(tmp_path: Path) -> None:
    path = tmp_path / "usage.json"
    path.write_text("not json", encoding="utf-8")
    budget = serve.Budget(path, monthly_bytes=1000, monthly_awake_s=3600, clock=lambda: MONTH_1)
    assert (budget.sent, budget.awake_s) == (0, 0.0)
    budget.add(awake_s=3600)
    assert budget.over() == "awake"


def test_what_is_sent_is_counted_and_saved_when_the_server_stops(dist: Path, tmp_path: Path) -> None:
    loader = Loader()
    loader.release.set()
    budget = roomy(tmp_path)
    with started(dist, loader, budget=budget) as client:
        body = client.get("/assets/app-abc123.js").content
        assert budget.sent == len(body) > 0
        time.sleep(0.15)   # the awake time is saved to a tenth of a second
    saved = serve.Budget(tmp_path / "usage.json", 1e12, 1e9)
    assert saved.sent == len(body) and saved.awake_s > 0


def test_past_a_limit_every_page_is_the_short_paused_one_and_the_data_is_not_loaded(dist: Path, tmp_path: Path) -> None:
    budget = serve.Budget(tmp_path / "usage.json", monthly_bytes=1000, monthly_awake_s=3600)
    budget.add(sent=1000)
    loader = Loader()
    with started(dist, loader, budget=budget) as client:
        for path in ("/", "/assets/app-abc123.js", "/api/check?address_id=1", "/ai/b/04"):
            response = client.get(path)
            assert response.status_code == 503 and "paused" in response.text.lower()
            assert len(response.content) < 2000
        assert not loader.reached_index.is_set()   # the loader never ran
        status = client.get("/warmup")
        assert status.status_code == 200 and status.json()["error"] == serve.PAUSED
        assert status.json()["ready"] is False


def test_a_server_that_reaches_a_limit_while_running_pauses_and_stops_itself(
        dist: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve, "COUNT_EVERY_S", 0.05)
    budget = serve.Budget(tmp_path / "usage.json", monthly_bytes=1e12, monthly_awake_s=0.01)
    stopped = threading.Event()
    loader = Loader()
    loader.release.set()
    with started(dist, loader, budget=budget, stop_running=stopped.set) as client:
        assert stopped.wait(timeout=5)
        assert client.get("/").status_code == 503
        assert client.get("/warmup").json() == {
            "ready": False, "progress": 1.0, "until": 1.0, "step": serve.READY, "error": serve.PAUSED}


def test_one_visitor_is_held_to_a_number_of_requests_a_minute() -> None:
    now = [0.0]
    limiter = serve.Limiter(3, clock=lambda: now[0])
    assert [limiter.allow("a") for _ in range(4)] == [True, True, True, False]
    assert limiter.allow("b")            # another visitor is not held back by the first
    now[0] = 60.0
    assert limiter.allow("a")            # and a new minute starts the count again


def test_a_flood_gets_a_429_and_crawlers_are_kept_off_the_data(dist: Path) -> None:
    loader = Loader()
    loader.release.set()
    with started(dist, loader, limiter=serve.Limiter(2)) as client:
        robots = client.get("/robots.txt")
        assert robots.status_code == 200 and "Disallow: /api/" in robots.text and "Disallow: /warmup" in robots.text
        assert client.get("/").status_code == 200
        flooded = client.get("/")
        assert flooded.status_code == 429 and flooded.json() == {"error": "too_many_requests"}
        assert client.get("/warmup").status_code == 200   # the health check always gets through


def test_the_paused_sentence_is_found_from_a_folder_one_level_deep(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """On the server this file is /app/serve.py: one parent, then the root. The first publish of the limits
    crashed there, on a path two levels up that does not exist."""
    root = Path(tmp_path.anchor)
    monkeypatch.setattr(serve, "HERE", root / "suplex-test-folder-that-does-not-exist")
    assert serve.paused_text() == serve.PAUSED_FALLBACK
    monkeypatch.setattr(serve, "HERE", root)
    assert serve.paused_text() == serve.PAUSED_FALLBACK
    monkeypatch.undo()
    assert "paused" in serve.paused_text() and serve.paused_text() != serve.PAUSED_FALLBACK
