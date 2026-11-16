"""Put Suplex live on Fly.io, on one server that sleeps when nobody is visiting.

Once, in your own terminal: install flyctl (https://fly.io/docs/flyctl/install/) and run
    fly auth login

Then, from the repo root:
    .venv/Scripts/python.exe deploy/publish.py              # build the web app and publish the code
    .venv/Scripts/python.exe deploy/publish.py --data       # the same, then send data/out to the server
    .venv/Scripts/python.exe deploy/publish.py --stage      # only build deploy/build, upload nothing
    .venv/Scripts/python.exe deploy/publish.py --app NAME   # a different Fly app name

The first publish needs --data. After that, --data is only for when data/out has changed.

The data goes straight from this computer to the server's own disk (a Fly volume). It is never put on
GitHub, because Suplex offers no download of lots. The layers go as compressed GeoParquet, a third of the
GeoPackage's size: the server's disk reads about 30 MB a second, and that reading is most of the wait when
it wakes. The live site is https://<app>.fly.dev
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / "deploy" / "build"
PACKED = ROOT / "deploy" / "data-zip"   # the layers as GeoParquet, and the zip that is sent
DATA_ZIP = PACKED / "data.zip"
GPKG = "suplex.gpkg"
REGION = "yyz"                # Toronto, the same as primary_region in deploy/server/fly.toml
VOLUME = "suplex_data"        # the same as [mounts] source in deploy/server/fly.toml
VOLUME_GB = 2                 # the data is about 0.4 GB, and its zip sits beside it while it unpacks
REMOTE_DATA = "/data"         # the same as [mounts] destination and SUPLEX_DATA_DIR
# What the API reads from data/out (api/store.py and api/main.py), beside the layers. Nothing else is sent.
DATA_FILES = ("data_dates.json", "ward_summary.json", "permits.geojson")
DATA_FOLDERS = ("wards", "trend_cache")
# The web app is built to find the API, the AI service and the loading status on its own address.
WEB_ENV = {"VITE_API_BASE": "/api", "VITE_WARMUP_URL": "/warmup"}
# Left out of the staged server: tests, and both caches. api/cache is the demo cache for a laptop without the
# data. ai/cache holds Gemini answers keyed to the addresses they were made for (localhost), so the live site
# could never read them; without a GEMINI_API_KEY it writes from the templates.
SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", "tests", "test_*.py", "cache", "logs", ".pytest_cache",
                              ".ruff_cache")
KEEP_AWAKE_EVERY_S = 20       # the server sleeps after a few idle minutes; an upload is not a visit
READY_WITHIN_S = 180


def run(*args: object, **kwargs: object) -> subprocess.CompletedProcess:
    print(">", " ".join(str(a) for a in args))
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def flyctl() -> str:
    for name in ("fly", "flyctl"):
        if found := shutil.which(name):
            return found
    default = Path.home() / ".fly" / "bin" / "flyctl.exe"
    if default.exists():
        return str(default)
    sys.exit("flyctl is not installed: see https://fly.io/docs/flyctl/install/")


def build_web() -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("VITE_")} | WEB_ENV
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    run(npm, "run", "build", cwd=ROOT / "web", env=env)


def stage(app: str) -> None:
    """Lay out deploy/build the way deploy/server/serve.py and the Dockerfile expect it."""
    if STAGE.exists():
        shutil.rmtree(STAGE)
    shutil.copytree(ROOT / "deploy" / "server", STAGE, ignore=SKIP)
    for folder in ("api", "ai", "contracts"):
        shutil.copytree(ROOT / folder, STAGE / folder, ignore=SKIP)
    shutil.copytree(ROOT / "engine" / "suplex_engine", STAGE / "engine" / "suplex_engine", ignore=SKIP)
    (STAGE / "pipeline" / "tiger").mkdir(parents=True)
    shutil.copy2(ROOT / "pipeline" / "tiger" / "queries.py", STAGE / "pipeline" / "tiger" / "queries.py")
    shutil.copytree(ROOT / "web" / "dist", STAGE / "web" / "dist")
    toml = STAGE / "fly.toml"
    toml.write_text(toml.read_text(encoding="utf-8").replace("APP_NAME", app), encoding="utf-8")
    print(f"Staged the server in {STAGE}")


def check_data(data_dir: Path) -> None:
    missing = [name for name in (GPKG, *DATA_FILES, *DATA_FOLDERS) if not (data_dir / name).exists()]
    if missing:
        sys.exit(f"{data_dir} has no {', '.join(missing)}: build the data first (CLAUDE.md, run commands)")


def pack_data(data_dir: Path) -> dict[str, Path]:
    """Write the layers as GeoParquet and zip them with the other files. Returns each file by the path it
    has on the server, under REMOTE_DATA."""
    sys.path.insert(0, str(ROOT))
    from api.store import LAYERS_DIR, write_layers

    shutil.rmtree(PACKED, ignore_errors=True)
    print(f"Writing the layers of {data_dir / GPKG} as GeoParquet ...")
    files = {f"{LAYERS_DIR}/{path.name}": path for path in write_layers(data_dir / GPKG, PACKED / LAYERS_DIR)}
    files |= {name: data_dir / name for name in DATA_FILES}
    for folder in DATA_FOLDERS:
        found = sorted(p for p in (data_dir / folder).rglob("*") if p.is_file())
        files |= {p.relative_to(data_dir).as_posix(): p for p in found}
    with zipfile.ZipFile(DATA_ZIP, "w") as z:
        for name, path in files.items():
            # Parquet is compressed already; the JSON shrinks to a fifth.
            packed = zipfile.ZIP_STORED if path.suffix == ".parquet" else zipfile.ZIP_DEFLATED
            z.write(path, name, compress_type=packed, compresslevel=1)
    total = sum(path.stat().st_size for path in files.values())
    print(f"{len(files)} files, {total / 1e6:.0f} MB, in a {DATA_ZIP.stat().st_size / 1e6:.0f} MB zip")
    return files


def warmup(app: str) -> dict:
    with urllib.request.urlopen(f"https://{app}.fly.dev/warmup", timeout=60) as response:
        return json.load(response)


def keep_awake(app: str, stop: threading.Event) -> None:
    while not stop.wait(KEEP_AWAKE_EVERY_S):
        try:
            warmup(app)
        except OSError:
            pass


def on_server(fly: str, app: str, command: str) -> str:
    """Run one command on the server and return what it printed."""
    done = run(fly, "ssh", "console", "-a", app, "-C", command, capture_output=True, text=True)
    return done.stdout


def send_data(fly: str, app: str, files: dict[str, Path]) -> None:
    """Upload the zip to the volume, unpack it there, and restart the server so it loads the new data."""
    warmup(app)  # wakes the server if it is asleep
    stop = threading.Event()
    threading.Thread(target=keep_awake, args=(app, stop), daemon=True).start()
    remote_zip = f"{REMOTE_DATA}/data.zip"
    # Everything a publish has ever put there, so no old file outlives the new data: a GeoPackage left
    # behind would be read before the layers (api/store.py, load). The month's use (usage.json) stays.
    old = " ".join(f"{REMOTE_DATA}/{name}" for name in ("data.zip", GPKG, "layers", *DATA_FILES, *DATA_FOLDERS))
    try:
        on_server(fly, app, f"rm -rf {old}")
        run(fly, "ssh", "sftp", "put", DATA_ZIP, remote_zip, "-a", app)
        on_server(fly, app, f"python -m zipfile -e {remote_zip} {REMOTE_DATA}")
        on_server(fly, app, f"rm -f {remote_zip}")
        # Unpacked files sit in memory for a while before Linux writes them out, and a restart does not wait:
        # without this the first publish lost the end of its biggest file. Write them out, then check that
        # every file arrived whole.
        on_server(fly, app, "sync")
        remotes = [f"{REMOTE_DATA}/{name}" for name in files]
        sizes = on_server(fly, app, "stat -c %s " + " ".join(remotes)).split()[-len(files):]
        for (name, path), size in zip(files.items(), sizes, strict=True):
            if size != str(path.stat().st_size):
                sys.exit(f"{name} is {size} bytes on the server, {path.stat().st_size} here: run --data again")
        print(f"All {len(files)} files are on the server at their full size")
    finally:
        stop.set()
    run(fly, "apps", "restart", app)


def wait_until_ready(app: str) -> None:
    deadline = time.monotonic() + READY_WITHIN_S
    status: dict = {}
    while time.monotonic() < deadline:
        try:
            status = warmup(app)
        except OSError:
            status = {}
        if status.get("ready") or status.get("error"):
            break
        time.sleep(2)
    if status.get("ready"):
        print(f"Live: https://{app}.fly.dev")
    elif status.get("error") == "data_missing":
        sys.exit(f"https://{app}.fly.dev is up but has no data yet: run this again with --data")
    else:
        sys.exit(f"https://{app}.fly.dev did not become ready: {status or 'no answer'} (see: fly logs -a {app})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stage", action="store_true", help="build deploy/build only, upload nothing")
    parser.add_argument("--data", action="store_true", help="also send data/out to the server's disk")
    parser.add_argument("--app", default="suplex", help="Fly app name, also the address <app>.fly.dev")
    args = parser.parse_args()

    data_dir = Path(os.environ.get("SUPLEX_DATA_DIR") or ROOT / "data" / "out")
    if args.data:
        check_data(data_dir)  # stop now, not after the build, if the data is not there
    fly = None if args.stage else flyctl()
    build_web()
    stage(args.app)
    if args.stage:
        return

    if subprocess.run([fly, "status", "-a", args.app], capture_output=True, check=False).returncode != 0:
        run(fly, "apps", "create", args.app, "--org", "personal")  # every account has this org
    volumes = json.loads(run(fly, "volumes", "list", "-a", args.app, "--json", capture_output=True).stdout or "[]")
    if not any(v.get("name") == VOLUME for v in volumes):
        run(fly, "volumes", "create", VOLUME, "-a", args.app, "--region", REGION, "--size", VOLUME_GB, "--yes")
    # One machine only (--ha=false): the volume holds one copy of the data.
    run(fly, "deploy", "--remote-only", "--ha=false", cwd=STAGE)
    if args.data:
        send_data(fly, args.app, pack_data(data_dir))
    wait_until_ready(args.app)


if __name__ == "__main__":
    main()
