"""Data-backed API tests against the Ward 04 store (or SUPLEX_GPKG). Skipped without the GeoPackage."""
from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import shapely
from pyproj import Transformer
from suplex_engine.classify import NOT_CHECKED_CLASSES

from api.store import normalise_address

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"
WARD = "04"
TO_WGS84 = Transformer.from_crs("EPSG:2952", "EPSG:4326", always_xy=True)


def lonlat(x: float, y: float) -> tuple[float, float]:
    lon, lat = TO_WGS84.transform(x, y)
    return float(lon), float(lat)


def ward_lots_with_address(store: Any) -> Iterator[tuple[int, int]]:
    """(lot position, primary address position) for the dev ward's lots, in file order."""
    for lot in range(store.lot_count):
        if str(store.lot_cols["ward_id"][lot]) == WARD and store.primary_address(lot) is not None:
            yield lot, store.primary_address(lot)


# ---------- /health, /designs ----------

def test_health(client, store) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["lot_count"] == store.lot_count > 0
    assert body["ward_count"] == 25
    assert set(body["layers"]) == {"lots", "buildings", "addresses", "corridors", "trees"}
    assert body["layers"]["lots"] == body["lot_count"]
    assert isinstance(body["load_seconds"], float)
    assert body["ward_summary_loaded"] is (store.ward_summary is not None)
    assert isinstance(body["tiger_dsn_set"], bool)
    assert body["data_dates"] == store.data_dates
    assert {"engine_version", "designs_version", "config_version"} <= set(body)


def test_designs_is_the_contract_file(client) -> None:
    r = client.get("/designs")
    assert r.status_code == 200
    assert r.json() == json.loads((CONTRACTS / "designs.json").read_text(encoding="utf-8"))


# ---------- /search ----------

def test_search_prefix_matches_one_result_per_lot(client, store, schema_errors) -> None:
    _, address = next(ward_lots_with_address(store))
    full = str(store.adr_full[address])
    q = normalise_address(full)[:-2]
    body = client.get("/search", params={"q": q}).json()
    assert schema_errors("search.response", body) == []
    assert body["query"] == q
    results = body["results"]
    assert 1 <= len(results) <= 8
    norms = [normalise_address(r["address_full"]) for r in results]
    assert all(n.startswith(q) for n in norms)
    assert norms == sorted(norms)
    lots = [store.lot_of_address(store.address_pos(r["address_id"])) for r in results]
    assert len(set(lots)) == len(lots)
    assert all(r["ward_id"] == WARD and r["ward_name"] for r in results)

    # Case and spacing do not matter; the full address finds itself (it is its lot's primary address).
    shouty = client.get("/search", params={"q": "  " + full.upper().replace(" ", "   ") + " "}).json()
    assert str(store.adr_ids[address]) in [r["address_id"] for r in shouty["results"]]


def test_search_short_or_unmatched_query_is_empty(client) -> None:
    assert client.get("/search", params={"q": "2"}).json() == {"query": "2", "results": []}
    assert client.get("/search", params={"q": " "}).json()["results"] == []
    assert client.get("/search", params={"q": "zzzz no such street"}).json()["results"] == []
    assert client.get("/search").json() == {"query": "", "results": []}


def test_search_limit_is_capped_at_eight(client) -> None:
    assert len(client.get("/search", params={"q": "10"}).json()["results"]) == 8
    assert len(client.get("/search", params={"q": "10", "limit": 3}).json()["results"]) == 3
    assert len(client.get("/search", params={"q": "10", "limit": 50}).json()["results"]) == 8


# ---------- /check ----------

def test_check_by_address_is_valid_and_under_a_second(client, store, schema_errors) -> None:
    sample = [pair for pair, _ in zip(ward_lots_with_address(store), range(10), strict=False)]
    client.get("/check", params={"address_id": str(store.adr_ids[sample[0][1]])})        # warm-up
    timings = []
    for lot, address in sample:
        aid = str(store.adr_ids[address])
        t0 = time.perf_counter()
        r = client.get("/check", params={"address_id": aid})
        timings.append(time.perf_counter() - t0)
        assert r.status_code == 200, r.text
        body = r.json()
        assert schema_errors("check.response", body) == []
        assert body["address"]["address_id"] == aid
        assert body["address"]["address_full"] == str(store.adr_full[address])
        assert body["lot"]["lot_id"] == str(store.lot_ids[lot])
        assert body["meta"]["data_dates"] == store.data_dates
    print("/check ms:", [round(1000 * t) for t in timings])
    assert max(timings) < 1.0


def test_check_validates_for_a_checked_an_attached_and_a_not_checked_lot(client, store, schema_errors) -> None:
    wanted = {"checked": None, "attached": None, "not_checked": None}
    for lot, address in ward_lots_with_address(store):
        cls = store.check(lot, address)["lot"]["class"]
        key = "not_checked" if cls in NOT_CHECKED_CLASSES else cls
        if key in wanted and wanted[key] is None:
            wanted[key] = str(store.adr_ids[address])
        if all(wanted.values()):
            break
    assert all(wanted.values()), wanted
    for key, aid in wanted.items():
        body = client.get("/check", params={"address_id": aid}).json()
        assert schema_errors("check.response", body) == [], key
        results = {d["result"] for d in body["designs"]}
        assert (results == {"not_checked"}) is (key == "not_checked")


def test_check_by_lot_id_uses_the_primary_address(client, store, schema_errors) -> None:
    lot, address = next(ward_lots_with_address(store))
    body = client.get("/check", params={"lot_id": str(store.lot_ids[lot])}).json()
    assert body["lot"]["lot_id"] == str(store.lot_ids[lot])
    assert body["address"]["address_id"] == str(store.adr_ids[address])

    bare = next(i for i in range(store.lot_count) if store.primary_address(i) is None)
    body = client.get("/check", params={"lot_id": str(store.lot_ids[bare])}).json()
    assert schema_errors("check.response", body) == []
    assert body["address"]["address_id"] is None and body["address"]["address_full"] is None
    assert (body["address"]["lon"], body["address"]["lat"]) == (body["context"]["origin"]["lon"],
                                                                 body["context"]["origin"]["lat"])


def test_check_context_reaches_the_engine(client, store) -> None:
    """Buildings, trees and permits fetched by the store end up in the response, counted independently here."""
    def permits_within(lot: int) -> int:
        centroid = store.lot_geoms[lot].centroid
        return int((shapely.distance(store.permit_geoms, centroid) <= store.cfg.nearby_permits_radius_m).sum())

    lot, address = next((lot, a) for lot, a in ward_lots_with_address(store)
                        if permits_within(lot) > 0 and store.check(lot, a)["lot"]["class"] == "checked")
    body = client.get("/check", params={"address_id": str(store.adr_ids[address])}).json()
    centroid = store.lot_geoms[lot].centroid
    ctx, permits = body["context"], body["permits_nearby"]

    radius = store.cfg.context_radius_m
    near_buildings = int((shapely.distance(store.bld_geoms, centroid) <= radius).sum())
    assert len({b["building_id"] for b in ctx["buildings"]}) == near_buildings > 0
    assert any(b["on_lot"] for b in ctx["buildings"]) is not body["lot"]["vacant"]
    assert len(ctx["trees"]) == int((shapely.distance(store.tree_geoms, centroid) <= radius).sum())
    assert permits["count"] == len(permits["points"]) == permits_within(lot) > 0
    assert (ctx["origin"]["x_2952"], ctx["origin"]["y_2952"]) == (round(centroid.x, 2), round(centroid.y, 2))


def test_check_unknown_ids_are_address_not_found(client) -> None:
    for params in ({"address_id": "999999999999"}, {"address_id": "not-an-id"}, {"lot_id": "999999999999"}):
        r = client.get("/check", params=params)
        assert r.status_code == 404
        assert r.json() == {"error": "address_not_found"}


def test_check_lon_lat_inside_a_lot_returns_that_lot(client, store) -> None:
    lot, _ = next(ward_lots_with_address(store))
    p = shapely.point_on_surface(store.lot_geoms[lot])
    lon, lat = lonlat(p.x, p.y)
    r = client.get("/check", params={"lon": lon, "lat": lat})
    assert r.status_code == 200, r.text
    assert r.json()["lot"]["lot_id"] == str(store.lot_ids[lot])


def test_check_lon_lat_in_the_lake_is_outside_toronto(client) -> None:
    r = client.get("/check", params={"lon": -79.38, "lat": 43.60})
    assert r.status_code == 404
    assert r.json() == {"error": "outside_toronto"}


def test_check_lon_lat_on_a_street_is_address_not_found(client, store) -> None:
    ward = store.ward_geoms[list(store.ward_names).index(WARD)]
    for geom in store.cor_geoms:
        p = shapely.point_on_surface(geom)
        if ward.contains(p) and store.lot_at(p.x, p.y) is None:
            break
    else:
        pytest.fail("no street point found in the ward")
    lon, lat = lonlat(p.x, p.y)
    r = client.get("/check", params={"lon": lon, "lat": lat})
    assert r.status_code == 404
    assert r.json() == {"error": "address_not_found"}


# ---------- /ward/{id}, /ward/{id}/trend ----------

def test_ward_needs_the_batch_summary(client, store, schema_errors) -> None:
    r = client.get(f"/ward/{WARD}")
    if store.ward_summary is None:
        assert r.status_code == 503
        assert r.json() == {"error": "ward_summary_unavailable",
                            "detail": "run the batch (python -m suplex_engine.batch --all)"}
    else:
        assert r.status_code == 200
        assert schema_errors("ward.response", r.json()) == []
    for bad in ("99", "4", "city"):
        r = client.get(f"/ward/{bad}")
        assert r.status_code == 404
        assert r.json() == {"error": "ward_not_found"}


def test_trend_without_tiger_dsn_is_the_cache(client, store, monkeypatch, schema_errors) -> None:
    monkeypatch.delenv("TIGER_DSN", raising=False)
    r = client.get(f"/ward/{WARD}/trend")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "cache"
    assert schema_errors("trend.response", body) == []
    cache = json.loads((store.data_dir / "trend_cache" / f"{WARD}.json").read_text(encoding="utf-8"))
    assert body == cache
    r = client.get("/ward/99/trend")
    assert r.status_code == 404
    assert r.json() == {"error": "ward_not_found"}


# ---------- /static ----------

def test_static_permits_is_gzipped_geojson(client) -> None:
    r = client.get("/static/permits.geojson", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/geo+json")
    assert r.headers.get("content-encoding") == "gzip"
    assert r.json()["type"] == "FeatureCollection"


def test_static_serves_nothing_else(client, store) -> None:
    lots = client.get(f"/static/wards/{WARD}.geojson")
    if not (store.data_dir / "wards" / f"{WARD}.geojson").is_file():
        assert lots.status_code == 404
        assert lots.json() == {"error": "not_found"}
    for path in ("/static/wards/99.geojson", "/static/suplex.gpkg", "/static/data_dates.json",
                 "/static/trend_cache/04.json", "/static/wards/..%2Fsuplex.gpkg"):
        r = client.get(path)
        assert r.status_code == 404, path
        assert r.json() == {"error": "not_found"}, path


def test_load_names_each_layer_then_the_index(store) -> None:
    """`on_step` gets every layer as its read starts and ends with the index step: the live server's progress."""
    from api.store import OPTIONAL_LAYERS, REQUIRED_LAYERS, STEP_INDEX, load

    steps: list[str] = []
    one_lot = tuple(float(v) for v in shapely.bounds(store.lot_geoms[0]))
    load(store.data_dir, store.gpkg_path, bbox=one_lot, on_step=steps.append)
    assert steps[:len(REQUIRED_LAYERS)] == list(REQUIRED_LAYERS)
    assert steps[-1] == STEP_INDEX
    assert set(steps[len(REQUIRED_LAYERS):-1]) <= set(OPTIONAL_LAYERS)


def _same(a: Any, b: Any) -> bool:
    """Two of a store's arrays hold the same values of the same types (geometry compared byte for byte)."""
    if a.dtype != b.dtype or a.shape != b.shape:
        return False
    if a.dtype == object and len(a) and isinstance(a.flat[0], shapely.Geometry):
        return shapely.to_wkb(a).tolist() == shapely.to_wkb(b).tolist()
    if a.dtype == object or a.dtype.kind in "UT":
        return [f"{type(v).__name__}:{v}" for v in a.tolist()] == [f"{type(v).__name__}:{v}" for v in b.tolist()]
    return a.tobytes() == b.tobytes()


def test_a_store_read_from_the_parquet_layers_is_the_same_store(store, tmp_path) -> None:
    """The live server has no GeoPackage: it reads <data_dir>/layers/*.parquet, which `write_layers` makes."""
    import numpy as np

    from api.store import LAYERS_DIR, load, write_layers

    x0, y0, x1, y1 = (float(v) for v in shapely.bounds(store.lot_geoms[0]))
    block = (x0 - 150, y0 - 150, x1 + 150, y1 + 150)
    written = write_layers(store.gpkg_path, tmp_path / LAYERS_DIR, bbox=block)
    assert {path.stem for path in written} >= {"lots", "corridors", "addresses", "buildings", "wards"}
    for name in ("data_dates.json", "ward_summary.json", "permits.geojson"):
        if (store.data_dir / name).is_file():
            (tmp_path / name).write_bytes((store.data_dir / name).read_bytes())

    from_gpkg = load(store.data_dir, store.gpkg_path, bbox=block)
    from_layers = load(tmp_path)
    assert from_layers.gpkg_path == tmp_path / LAYERS_DIR
    assert from_layers.layer_counts == from_gpkg.layer_counts and from_gpkg.lot_count > 1
    arrays = {name: value for name, value in vars(from_gpkg).items() if isinstance(value, np.ndarray)}
    assert len(arrays) > 15
    for name, value in arrays.items():
        assert _same(value, getattr(from_layers, name)), name
    for column, value in from_gpkg.lot_cols.items():
        assert _same(value, from_layers.lot_cols[column]), column


def test_a_folder_with_neither_the_geopackage_nor_the_layers_cannot_start(tmp_path) -> None:
    from api.store import StoreError, load

    with pytest.raises(StoreError, match="GeoPackage not found"):
        load(tmp_path)
