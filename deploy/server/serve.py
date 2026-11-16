"""The live Suplex site on one address: the web app, the API under /api and the AI service under /ai.

Run from the folder that holds api/, ai/, contracts/, pipeline/tiger/ and web/dist, with the engine
installed (deploy/publish.py stages exactly that):
    python -m uvicorn serve:app --host 0.0.0.0 --port 8080

The server sleeps when nobody is visiting (fly.toml), so it has to wake up fast. It answers as soon as it
starts and loads the city data on a background thread. GET /warmup says how far that load is, and the web
app shows a loading screen until it is done. A request for /api or /ai that arrives early waits for the
data instead of failing.

Fly.io has no spending limit and no billing alerts, so the limits live here (Budget): a month's worth of
data sent and of hours awake, counted in a file on the data disk so the count survives every sleep. Past
either one the site answers with a short "paused" page until the 1st and stops itself, so it is hardly
running. Change the numbers in fly.toml and publish again.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import sys
import threading
import time
from collections.abc import Awaitable, Callable, MutableMapping
from pathlib import Path
from typing import Any

from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import PlainTextResponse
from starlette.staticfiles import StaticFiles

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
App = Callable[[Scope, Receive, Send], Awaitable[None]]

HERE = Path(__file__).resolve().parent
log = logging.getLogger("uvicorn.error")

WARMUP_PATH = "/warmup"
API_PREFIX = "/api"   # the web app is built with VITE_API_BASE=/api, which also puts its AI calls on /ai
AI_PREFIX = "/ai"
# The briefing page (ai/page) asks for its own files and its briefing by absolute path, so these go to the
# AI service as they are. The web app's own files are under /assets, so nothing collides.
AI_OWN_PATHS = ("/page", "/static", "/briefing")
WAIT_FOR_DATA_S = 60.0   # an early /api or /ai request waits this long for the data, then gets a 503
GZIP_MIN_BYTES = 1000
HASHED_ASSETS = "/assets/"   # Vite puts a content hash in these file names, so a browser may keep them

# The loading steps in order, each with the share of the load it took on the live server (15.6 s in all,
# 2026-11-15: the "ready" line in its log gives each step's seconds). The shares only place the progress bar;
# a wrong one just moves it unevenly.
STEP_SHARES: dict[str, float] = {
    "imports": 0.25,     # Python reading geopandas, shapely and the two services
    "lots": 0.16,
    "corridors": 0.01,
    "addresses": 0.05,
    "buildings": 0.20,
    "wards": 0.01,
    "trees": 0.04,
    "index": 0.28,       # api.store.STEP_INDEX: the spatial indexes and the address search
}
READY = "ready"
PAUSED = "paused"   # the /warmup error once a monthly limit is reached; the web app has words for it

# The month's limits. At Fly's prices (2026-11) data sent costs $0.02 a GB, and this server, 4 shared CPUs
# with 4 GB, costs about $0.037 for each hour it is awake. fly.toml sets both; these are the same numbers.
DEFAULT_MONTHLY_GB = 20.0
DEFAULT_MONTHLY_AWAKE_HOURS = 60.0
# How often the use so far is written to the disk. A paused server also stops itself at the first count,
# so a visit to the paused site keeps it running about this long, not the minutes Fly waits for a quiet one.
COUNT_EVERY_S = 15.0
# One visitor's requests a minute. Opening the site and checking an address takes about 60.
REQUESTS_PER_MINUTE = 300
VISITORS_REMEMBERED = 10_000
# Polite crawlers stay off everything but the page itself, so they do not wake the data for nothing.
ROBOTS_TXT = "User-agent: *\n" + "".join(
    f"Disallow: {path}\n" for path in (API_PREFIX + "/", AI_PREFIX + "/", *AI_OWN_PATHS, WARMUP_PATH))
# The paused page: the page's lime and its ink (--suplex-paper and --suplex-ink in web/src/styles/palette.css).
PAUSED_PAGE = (
    '<!doctype html><html lang="en"><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Suplex</title>'
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#dfecbf;color:#14240a;'
    'font:17px/1.5 Helvetica,Arial,sans-serif"><main style="max-width:32rem;padding:2rem;text-align:center">'
    "<h1>Suplex</h1><p>{text}</p></main></body></html>"
)
PAUSED_FALLBACK = "Suplex is paused until the 1st of next month."


def place_services() -> None:
    """Tell the two services where they sit on the one address, before either is imported. These are paths,
    not hosts, so the site works the same on suplex.fly.dev and on a custom domain. Real environment
    variables win."""
    os.environ.setdefault("SUPLEX_AI_URL", AI_PREFIX)     # the API's briefing_url
    os.environ.setdefault("SUPLEX_API_URL", API_PREFIX)   # the briefing page reads the ward from here
    os.environ.setdefault("SUPLEX_WEB_URL", "/")
    if (HERE / "contracts").is_dir():   # the staged layout; in the repo the engine finds its own
        os.environ.setdefault("SUPLEX_CONTRACTS_DIR", str(HERE / "contracts"))


def paused_text() -> str:
    """The paused page's sentence, from the shared copy file like every other string a visitor reads."""
    # Staged, contracts/ is beside this file; in the repo it is two folders up. `.parent.parent` and not
    # `.parents[1]`: on the server this file is /app/serve.py, which has no second parent to index.
    for contracts in (HERE / "contracts", HERE.parent.parent / "contracts"):
        try:
            labels = json.loads((contracts / "copy" / "labels.json").read_text(encoding="utf-8"))
            return str(labels["warmup"]["paused"])
        except (OSError, ValueError, KeyError):
            continue
    return PAUSED_FALLBACK


class Budget:
    """This month's use against its two limits, kept in a file so it survives every sleep and restart."""

    def __init__(self, path: Path, monthly_bytes: float, monthly_awake_s: float,
                 clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self.monthly_bytes = monthly_bytes
        self.monthly_awake_s = monthly_awake_s
        self.clock = clock
        self._lock = threading.Lock()
        self.month = self._this_month()
        self.sent = 0
        self.awake_s = 0.0
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            if saved.get("month") == self.month:
                self.sent, self.awake_s = int(saved["sent_bytes"]), float(saved["awake_s"])
        except (OSError, ValueError, KeyError, TypeError):
            pass   # no file yet, or one that cannot be read: the month starts from nothing

    @classmethod
    def from_env(cls) -> Budget:
        data_dir = Path(os.environ.get("SUPLEX_DATA_DIR", "").strip() or "./data/out")
        gb = float(os.environ.get("SUPLEX_MONTHLY_GB") or DEFAULT_MONTHLY_GB)
        hours = float(os.environ.get("SUPLEX_MONTHLY_AWAKE_HOURS") or DEFAULT_MONTHLY_AWAKE_HOURS)
        return cls(data_dir / "usage.json", gb * 1e9, hours * 3600)

    def _this_month(self) -> str:
        return time.strftime("%Y-%m", time.gmtime(self.clock()))   # UTC, like Fly's invoices

    def _roll_over(self) -> None:
        if self.month != self._this_month():
            self.month, self.sent, self.awake_s = self._this_month(), 0, 0.0

    def add(self, sent: int = 0, awake_s: float = 0.0) -> None:
        with self._lock:
            self._roll_over()
            self.sent += sent
            self.awake_s += awake_s

    def over(self) -> str | None:
        """Which limit this month has reached, "transfer" or "awake", or None while there is room."""
        with self._lock:
            self._roll_over()
            if self.sent >= self.monthly_bytes:
                return "transfer"
            if self.awake_s >= self.monthly_awake_s:
                return "awake"
            return None

    def save(self) -> None:
        with self._lock:
            body = json.dumps({"month": self.month, "sent_bytes": self.sent, "awake_s": round(self.awake_s, 1)})
        try:
            scratch = self.path.with_suffix(".tmp")
            scratch.write_text(body, encoding="utf-8")
            scratch.replace(self.path)   # never a half-written file
        except OSError as e:
            log.warning("suplex: could not save the month's use to %s (%s)", self.path, e)


class Limiter:
    """At most `per_minute` requests a minute from one visitor: plenty for a person, not for a flood."""

    def __init__(self, per_minute: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.per_minute = per_minute
        self.clock = clock
        self._lock = threading.Lock()
        self._seen: dict[str, tuple[int, int]] = {}   # visitor -> (the minute, requests in it)

    def allow(self, visitor: str) -> bool:
        minute = int(self.clock() // 60)
        with self._lock:
            then, count = self._seen.get(visitor, (minute, 0))
            count = count + 1 if then == minute else 1
            if len(self._seen) >= VISITORS_REMEMBERED and visitor not in self._seen:
                self._seen = {v: seen for v, seen in self._seen.items() if seen[0] == minute}
            self._seen[visitor] = (minute, count)
            return count <= self.per_minute


class Warmup:
    """How far the background load is. Written by the loading thread, read by every request."""

    def __init__(self, shares: dict[str, float]) -> None:
        total = sum(shares.values())
        self._span: dict[str, tuple[float, float]] = {}   # step -> (progress when it starts, when it ends)
        done = 0.0
        for step, share in shares.items():
            self._span[step] = (done / total, (done + share) / total)
            done += share
        self._lock = threading.Lock()
        self.step = next(iter(shares))
        self.progress = 0.0
        self.until = self._span[self.step][1]
        self.error: str | None = None
        self.apps: dict[str, App] = {}
        self.began: list[tuple[str, float]] = []   # each step and when it started, for the log

    @property
    def ready(self) -> bool:
        return bool(self.apps)

    def timings(self) -> str:
        """How long each step took, for the log: "imports 4.1 s, lots 1.2 s, ..."."""
        with self._lock:
            ends = [at for _, at in self.began[1:]] + [time.perf_counter()]
            return ", ".join(f"{step} {end - at:.1f} s" for (step, at), end in zip(self.began, ends, strict=True))

    def begin(self, step: str) -> None:
        """A step has started. A step this server has no share for keeps the bar where it is."""
        with self._lock:
            self.began.append((step, time.perf_counter()))
            start, end = self._span.get(step, (self.progress, self.until))
            self.step = step
            self.progress = max(self.progress, start)
            self.until = max(self.progress, end)

    def finish(self, apps: dict[str, App]) -> None:
        with self._lock:
            self.step, self.progress, self.until, self.apps = READY, 1.0, 1.0, apps

    def fail(self, error: str) -> None:
        with self._lock:
            self.error = error

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            # `until` is where the current step ends: the loading screen may creep up to it, never past it.
            return {"ready": self.ready and not self.error, "progress": round(self.progress, 3),
                    "until": round(self.until, 3), "step": self.step, "error": self.error}

    async def wait(self, timeout_s: float) -> bool:
        """True once the data is loaded; False if the load failed or `timeout_s` ran out first."""
        deadline = time.monotonic() + timeout_s
        while not self.ready:
            if self.error or time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.1)
        return True


def load_everything(state: Warmup) -> None:
    """Import both services and load the city data, reporting each step. Runs on its own thread."""
    t0 = time.perf_counter()
    try:
        state.begin("imports")
        place_services()
        sys.path.insert(0, str(HERE))
        from ai.main import app as ai_app
        from api.main import Settings, create_app
        from api.store import StoreError, load
    except Exception:
        log.exception("suplex: the services could not be imported")
        state.fail("failed")
        return
    try:
        settings = Settings.from_env()
        store = load(settings.data_dir, settings.gpkg_path, on_step=state.begin)
        timings = state.timings()
        # With the store given, the API's own startup has nothing left to load.
        state.finish({"api": create_app(store=store, settings=settings), "ai": ai_app})
    except StoreError as e:
        log.error("suplex: no data to serve: %s", e)
        state.fail("data_missing")
    except Exception:
        log.exception("suplex: the data could not be loaded")
        state.fail("failed")
    else:
        log.info("suplex: ready %.1f s after the server started (%s)", time.perf_counter() - t0, timings)


def site_app(dist: Path) -> App:
    """The built web app, compressed, with the hashed files cacheable and index.html always fresh."""
    # check_dir is off so this module imports without a build; the startup below reports a missing one.
    files = GZipMiddleware(StaticFiles(directory=dist, html=True, check_dir=False), minimum_size=GZIP_MIN_BYTES)

    async def site(scope: Scope, receive: Receive, send: Send) -> None:
        cache = "public, max-age=31536000, immutable" if scope["path"].startswith(HASHED_ASSETS) else "no-cache"

        async def send_with_cache(message: Message) -> None:
            if message["type"] == "http.response.start" and message["status"] == 200:
                MutableHeaders(scope=message)["cache-control"] = cache
            await send(message)

        try:
            await files(scope, receive, send_with_cache)
        except HTTPException as e:
            # StaticFiles raises for a missing file or a wrong method and leaves the answer to an app around
            # it. There is none here, so answer directly.
            await PlainTextResponse(e.detail, status_code=e.status_code)(scope, receive, send)

    return site


async def send_body(send: Send, status: int, content_type: bytes, data: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", content_type), (b"content-length", str(len(data)).encode()),
                            (b"cache-control", b"no-store")]})
    await send({"type": "http.response.body", "body": data})


async def send_json(send: Send, status: int, body: dict[str, Any]) -> None:
    await send_body(send, status, b"application/json", json.dumps(body).encode())


def under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def visitor_of(scope: Scope) -> str:
    for name, value in scope.get("headers", []):
        if name == b"fly-client-ip":   # set by Fly's proxy to the visitor's real address
            return value.decode("latin-1")
    client = scope.get("client")
    return client[0] if client else "unknown"


def create_server(dist: Path, state: Warmup | None = None, loader: Callable[[Warmup], None] = load_everything,
                  budget: Budget | None = None, limiter: Limiter | None = None,
                  stop_running: Callable[[], None] = lambda: os._exit(0)) -> App:
    """The server. Tests pass their own `state`, a `loader` that does not read the real data, a `budget` on
    a scratch file and a `stop_running` that does not end the test run."""
    state = state or Warmup(STEP_SHARES)
    budget = budget or Budget.from_env()
    limiter = limiter or Limiter(REQUESTS_PER_MINUTE)
    site = site_app(dist)
    paused_page = PAUSED_PAGE.format(text=html.escape(paused_text())).encode()
    counted_at = time.monotonic()

    def count_awake() -> str | None:
        """Add the time since the last count, save, and say which limit is reached, if one is."""
        nonlocal counted_at
        now = time.monotonic()
        budget.add(awake_s=now - counted_at)
        counted_at = now
        budget.save()
        return budget.over()

    def keep_count() -> None:
        while True:
            time.sleep(COUNT_EVERY_S)
            if limit := count_awake():
                log.warning("suplex: the month's %s limit is reached; paused until the 1st", limit)
                state.fail(PAUSED)
                return stop_running()   # the next visitor starts it again, for one count, to read "paused"

    async def lifespan(receive: Receive, send: Send) -> None:
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                nonlocal counted_at
                counted_at = time.monotonic()
                if not (dist / "index.html").is_file():
                    log.error("suplex: no built web app at %s", dist)
                if budget.over():
                    state.fail(PAUSED)   # and the 2 GB of data stays on the disk
                else:
                    threading.Thread(target=loader, args=(state,), name="suplex-load", daemon=True).start()
                threading.Thread(target=keep_count, name="suplex-count", daemon=True).start()
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                count_awake()
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def server(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            return await lifespan(receive, send)
        if scope["type"] != "http":
            return
        path: str = scope["path"]

        async def counted(message: Message) -> None:
            if message["type"] == "http.response.body":
                budget.add(sent=len(message.get("body", b"")))
            await send(message)

        if path == WARMUP_PATH:   # always answers: Fly's health check, and the loading screen
            return await send_json(counted, 200, state.snapshot())
        if budget.over():
            return await send_body(counted, 503, b"text/html; charset=utf-8", paused_page)
        if not limiter.allow(visitor_of(scope)):
            return await send_json(counted, 429, {"error": "too_many_requests"})
        if path == "/robots.txt":
            return await send_body(counted, 200, b"text/plain; charset=utf-8", ROBOTS_TXT.encode())

        if under(path, API_PREFIX):
            name, prefix = "api", API_PREFIX
        elif under(path, AI_PREFIX):
            name, prefix = "ai", AI_PREFIX
        elif any(under(path, own) for own in AI_OWN_PATHS):
            name, prefix = "ai", ""
        else:
            return await site(scope, receive, counted)

        if not await state.wait(WAIT_FOR_DATA_S):
            # The API's own error shape, so the web app reads it like any other server error.
            return await send_json(counted, 503, {"error": "starting", "detail": state.error or "still loading"})
        # The service sees its own paths: the prefix moves into root_path, as a Starlette mount does.
        inner = {**scope, "root_path": scope.get("root_path", "") + prefix} if prefix else scope
        await state.apps[name](inner, receive, counted)

    return server


app = create_server(HERE / "web" / "dist")
