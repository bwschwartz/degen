import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from flask import Flask, jsonify, request

app = Flask(__name__)

API_BASE = "https://api.sportradar.com/wnba/trial/v8/en"
API_KEY = os.environ.get("SPORTS_API_KEY", "")

INDEX_CACHE_FILE = Path(__file__).parent / ".players_cache.json"
GAMES_CACHE_FILE = Path(__file__).parent / ".games_cache.json"
INDEX_TTL_SECONDS = 24 * 60 * 60
STATS_TTL_SECONDS = 10 * 60
PROFILE_TTL_SECONDS = 60 * 60
SCHEDULE_TTL_SECONDS = 60 * 60
MIN_REQUEST_INTERVAL = 1.15  # trial keys are limited to ~1 request/second

PLAYER_ID_RE = re.compile(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")

_api_lock = threading.Lock()
_last_request_at = 0.0


def _fetch(path):
    """GET a Sportradar endpoint, throttled to the trial rate limit."""
    global _last_request_at
    url = f"{API_BASE}{path}?api_key={urllib.parse.quote(API_KEY)}"
    with _api_lock:
        for attempt in range(4):
            wait = MIN_REQUEST_INTERVAL - (time.monotonic() - _last_request_at)
            if wait > 0:
                time.sleep(wait)
            _last_request_at = time.monotonic()
            try:
                with urllib.request.urlopen(url, timeout=30) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as err:
                if err.code == 429 and attempt < 3:
                    time.sleep(2**attempt)
                    continue
                raise


# ---------------------------------------------------------------------------
# League-wide player index (for search)
# ---------------------------------------------------------------------------

_index_lock = threading.Lock()
_index_ready = threading.Event()
_index_players = []
_index_error = None


def _build_index_from_api():
    hierarchy = _fetch("/league/hierarchy.json")
    players = []
    for conference in hierarchy.get("conferences", []):
        for team in conference.get("teams", []):
            profile = _fetch(f"/teams/{team['id']}/profile.json")
            team_name = f"{team.get('market', '')} {team.get('name', '')}".strip()
            for player in profile.get("players", []):
                players.append(
                    {
                        "id": player["id"],
                        "full_name": player.get("full_name", ""),
                        "position": player.get("position", ""),
                        "jersey_number": player.get("jersey_number", ""),
                        "team": team_name,
                    }
                )
    players.sort(key=lambda p: p["full_name"])
    return players


def _ensure_index():
    global _index_players, _index_error
    with _index_lock:
        if _index_ready.is_set():
            return
        try:
            if INDEX_CACHE_FILE.exists():
                cached = json.loads(INDEX_CACHE_FILE.read_text())
                if time.time() - cached.get("built_at", 0) < INDEX_TTL_SECONDS:
                    _index_players = cached["players"]
                    _index_ready.set()
                    return
            _index_players = _build_index_from_api()
            INDEX_CACHE_FILE.write_text(
                json.dumps({"built_at": time.time(), "players": _index_players})
            )
            _index_error = None
            _index_ready.set()
        except Exception as err:  # noqa: BLE001 - surfaced to the client
            _index_error = str(err)


threading.Thread(target=_ensure_index, daemon=True).start()


@app.route("/api/players/search")
def search_players():
    query = request.args.get("q", "").strip().lower()
    if not _index_ready.is_set():
        if _index_error:
            # Retry the build on the next search rather than staying broken.
            threading.Thread(target=_ensure_index, daemon=True).start()
            return jsonify({"error": f"Could not load rosters: {_index_error}"}), 502
        return jsonify({"building": True, "players": []})
    if len(query) < 2:
        return jsonify({"players": []})
    matches = [p for p in _index_players if query in p["full_name"].lower()]
    return jsonify({"players": matches[:20]})


# ---------------------------------------------------------------------------
# Per-player stats
# ---------------------------------------------------------------------------

_stats_cache = {}


def _latest_season(seasons):
    regular = [s for s in seasons if s.get("type") == "REG"]
    pool = regular or seasons
    return max(pool, key=lambda s: s.get("year", 0), default=None)


@app.route("/api/players/<player_id>/stats")
def player_stats(player_id):
    if not PLAYER_ID_RE.fullmatch(player_id):
        return jsonify({"error": "Invalid player id"}), 400

    cached = _stats_cache.get(player_id)
    if cached and time.time() - cached[0] < STATS_TTL_SECONDS:
        return jsonify(cached[1])

    try:
        profile = _fetch(f"/players/{player_id}/profile.json")
    except urllib.error.HTTPError as err:
        return jsonify({"error": f"Sportradar returned {err.code}"}), 502

    result = {
        "id": profile.get("id", player_id),
        "full_name": profile.get("full_name", ""),
        "position": profile.get("position", ""),
        "jersey_number": profile.get("jersey_number", ""),
        "team": None,
        "season": None,
        "games_played": None,
        "points": None,
        "rebounds": None,
        "minutes": None,
    }

    season = _latest_season(profile.get("seasons", []))
    if season:
        # A traded player has one entry per team; report the primary stint.
        team = max(
            season.get("teams", []),
            key=lambda t: t.get("total", {}).get("games_played", 0),
            default=None,
        )
        if team:
            average = team.get("average", {})
            result.update(
                {
                    "team": f"{team.get('market', '')} {team.get('name', '')}".strip(),
                    "season": {"year": season.get("year"), "type": season.get("type")},
                    "games_played": team.get("total", {}).get("games_played"),
                    "points": average.get("points"),
                    "rebounds": average.get("rebounds"),
                    "minutes": average.get("minutes"),
                }
            )

    _stats_cache[player_id] = (time.time(), result)
    return jsonify(result)


# ---------------------------------------------------------------------------
# Per-player game log (last N games)
# ---------------------------------------------------------------------------

_profile_cache = {}
_schedule_cache = {}
_games_lock = threading.Lock()
try:
    _games_cache = json.loads(GAMES_CACHE_FILE.read_text())
except (OSError, ValueError):
    _games_cache = {}


def _get_profile(player_id):
    cached = _profile_cache.get(player_id)
    if cached and time.time() - cached[0] < PROFILE_TTL_SECONDS:
        return cached[1]
    profile = _fetch(f"/players/{player_id}/profile.json")
    _profile_cache[player_id] = (time.time(), profile)
    return profile


def _get_schedule(year):
    cached = _schedule_cache.get(year)
    if cached and time.time() - cached[0] < SCHEDULE_TTL_SECONDS:
        return cached[1]
    schedule = _fetch(f"/games/{year}/REG/schedule.json")
    games = schedule.get("games", [])
    _schedule_cache[year] = (time.time(), games)
    return games


def _parse_minutes(value):
    """'34:12' -> 34.2; passes numbers through."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        parts = str(value).split(":")
        return round(int(parts[0]) + int(parts[1]) / 60, 1)
    except (ValueError, IndexError):
        return None


def _extract_game(summary):
    """Reduce a game summary to the fields the gamelog needs; closed games
    never change, so this is cached to disk indefinitely."""
    out = {
        "id": summary["id"],
        "scheduled": summary.get("scheduled"),
        "players": {},
    }
    for side in ("home", "away"):
        team = summary.get(side, {})
        out[side] = {
            "id": team.get("id"),
            "alias": team.get("alias"),
            "points": team.get("points"),
        }
        for player in team.get("players", []):
            stats = player.get("statistics")
            if not stats:
                continue
            out["players"][player["id"]] = {
                "played": bool(player.get("played")),
                "points": stats.get("points"),
                "rebounds": stats.get("rebounds"),
                "minutes": _parse_minutes(stats.get("minutes")),
            }
    return out


def _get_game(game_id):
    with _games_lock:
        cached = _games_cache.get(game_id)
    if cached:
        return cached
    extracted = _extract_game(_fetch(f"/games/{game_id}/summary.json"))
    with _games_lock:
        _games_cache[game_id] = extracted
        GAMES_CACHE_FILE.write_text(json.dumps(_games_cache))
    return extracted


@app.route("/api/players/<player_id>/gamelog")
def player_gamelog(player_id):
    if not PLAYER_ID_RE.fullmatch(player_id):
        return jsonify({"error": "Invalid player id"}), 400
    try:
        profile = _get_profile(player_id)
        team = profile.get("team") or {}
        team_id = team.get("id")
        if not team_id:
            return jsonify({"error": "Player has no current team"}), 404
        season = _latest_season(profile.get("seasons", []))
        if not season:
            return jsonify({"error": "No season data for player"}), 404

        schedule = _get_schedule(season["year"])
        team_games = sorted(
            (
                g
                for g in schedule
                if g.get("status") == "closed"
                and team_id in (g["home"]["id"], g["away"]["id"])
            ),
            key=lambda g: g.get("scheduled", ""),
            reverse=True,
        )

        games = []
        # Scan a few extra games past 10 to skip ones the player sat out.
        for scheduled_game in team_games[:15]:
            if len(games) >= 10:
                break
            game = _get_game(scheduled_game["id"])
            line = game["players"].get(player_id)
            if not line or not line["played"] or not line["minutes"]:
                continue
            is_home = game["home"]["id"] == team_id
            own, opp = (
                (game["home"], game["away"]) if is_home else (game["away"], game["home"])
            )
            games.append(
                {
                    "game_id": game["id"],
                    "date": game["scheduled"],
                    "home": is_home,
                    "opponent": opp["alias"],
                    "team_points": own["points"],
                    "opponent_points": opp["points"],
                    "points": line["points"],
                    "rebounds": line["rebounds"],
                    "minutes": line["minutes"],
                }
            )
        games.reverse()  # chronological, oldest first

        return jsonify(
            {
                "id": player_id,
                "full_name": profile.get("full_name", ""),
                "team": f"{team.get('market', '')} {team.get('name', '')}".strip(),
                "season": {"year": season.get("year"), "type": season.get("type")},
                "games": games,
            }
        )
    except urllib.error.HTTPError as err:
        return jsonify({"error": f"Sportradar returned {err.code}"}), 502
