"""
Fantasy Premier League MCP Server - Cloud Run Edition (Enhanced)
Phase 1 + Phase 2 improvements for feature parity with stdio version
Built with fastmcp 2.9.2 for HTTP transport
"""

import os
import logging
import asyncio
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
from collections import Counter
import httpx
import requests
from fastmcp import FastMCP

# Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger("fpl-mcp")

# Create MCP server
mcp = FastMCP("Fantasy Premier League")

# Configuration
FPL_API = "https://fantasy.premierleague.com/api"
FPL_LOGIN = "https://users.premierleague.com/accounts/login/"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# Environment variables
FPL_EMAIL = os.getenv("FPL_EMAIL")
FPL_PASSWORD = os.getenv("FPL_PASSWORD")
FPL_TEAM_ID = os.getenv("FPL_TEAM_ID")

# Cache
_cache: Dict[str, tuple[datetime, Any]] = {}
CACHE_TTL = timedelta(hours=1)
_http_client: Optional[httpx.AsyncClient] = None
_auth_session: Optional[requests.Session] = None
_last_auth_time: Optional[datetime] = None


# ====================================================================================
# PARAMETER UNWRAPPING HELPER (Phase 1)
# ====================================================================================

def unwrap_param(value: Any, param_name: str, default: Any = None) -> Any:
    """Unwrap parameter if it's a dict (for HTTP transport compatibility)

    Args:
        value: The parameter value (might be a dict)
        param_name: The expected parameter name
        default: Default value if extraction fails

    Returns:
        The unwrapped value
    """
    if isinstance(value, dict):
        # Try to extract using the parameter name
        if param_name in value:
            return value[param_name]
        # Try common aliases
        for alias in ['query', 'value', 'name']:
            if alias in value:
                return value[alias]
        # Return default or convert to string
        return default if default is not None else str(value)
    return value


# ====================================================================================
# HTTP CLIENT & CACHING
# ====================================================================================

async def get_client() -> httpx.AsyncClient:
    """Get HTTP client"""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=30.0)
    return _http_client


async def fetch(endpoint: str, use_cache: bool = True) -> Dict:
    """Fetch from FPL API with caching"""
    key = f"fpl:{endpoint}"

    if use_cache and key in _cache:
        cached_time, data = _cache[key]
        if datetime.now() - cached_time < CACHE_TTL:
            return data

    client = await get_client()
    response = await client.get(f"{FPL_API}/{endpoint}")
    response.raise_for_status()
    data = response.json()
    _cache[key] = (datetime.now(), data)
    return data


async def auth_fetch(endpoint: str) -> Dict:
    """Fetch authenticated endpoint using requests.Session"""
    global _auth_session, _last_auth_time

    # Re-authenticate if needed
    if _auth_session is None or (_last_auth_time and datetime.now() - _last_auth_time > timedelta(hours=2)):
        if not FPL_EMAIL or not FPL_PASSWORD:
            return {"error": "FPL_EMAIL and FPL_PASSWORD required"}

        try:
            # Create new session
            _auth_session = requests.Session()

            headers = {
                "User-Agent": USER_AGENT,
                "accept-language": "en"
            }

            data = {
                "login": FPL_EMAIL,
                "password": FPL_PASSWORD,
                "app": "plfpl-web",
                "redirect_uri": "https://fantasy.premierleague.com/a/login"
            }

            # Run synchronous POST in executor
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: _auth_session.post(FPL_LOGIN, data=data, headers=headers)
            )

            logger.info(f"Auth response: {response.status_code}")

            if 200 <= response.status_code < 400:
                _last_auth_time = datetime.now()
                logger.info("Authentication successful")
            else:
                _auth_session = None
                return {"error": f"Auth failed: HTTP {response.status_code}"}

        except Exception as e:
            logger.error(f"Auth error: {e}")
            _auth_session = None
            return {"error": str(e)}

    # Make authenticated request
    if _auth_session:
        try:
            # Run synchronous GET in executor
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: _auth_session.get(f"{FPL_API}/{endpoint}")
            )

            response.raise_for_status()
            return response.json()

        except Exception as e:
            logger.error(f"Request failed: {e}")
            return {"error": str(e)}

    return {"error": "Not authenticated"}


# ====================================================================================
# RESOURCES (12 total)
# ====================================================================================

@mcp.resource("fpl://static/players")
async def all_players() -> str:
    """All FPL players with comprehensive statistics"""
    data = await fetch("bootstrap-static/")
    players = data["elements"]
    teams = {t["id"]: t["name"] for t in data["teams"]}

    results = []
    for p in players[:100]:
        results.append(
            f"{p['web_name']} ({teams[p['team']]}) - "
            f"£{p['now_cost']/10}m, {p['total_points']}pts, Form: {p['form']}"
        )
    return f"Showing 100/{len(players)} players:\n" + "\n".join(results)


@mcp.resource("fpl://static/teams")
async def all_teams() -> str:
    """All Premier League teams with strength ratings"""
    data = await fetch("bootstrap-static/")
    teams = data["teams"]
    results = [
        f"{t['name']} - Strength: {t['strength']} "
        f"(H:{t['strength_overall_home']}, A:{t['strength_overall_away']})"
        for t in teams
    ]
    return "\n".join(results)


@mcp.resource("fpl://gameweeks/current")
async def current_gameweek() -> str:
    """Current gameweek information"""
    data = await fetch("bootstrap-static/")
    current = next((e for e in data["events"] if e["is_current"]), None)
    if current:
        return (f"Gameweek {current['id']}: {current['name']}\n"
                f"Deadline: {current['deadline_time']}\n"
                f"Finished: {current['finished']}")
    return "No current gameweek"


@mcp.resource("fpl://gameweeks/all")
async def all_gameweeks() -> str:
    """All gameweeks data"""
    data = await fetch("bootstrap-static/")
    events = data["events"]
    results = [f"GW{e['id']}: {e['name']} (Deadline: {e['deadline_time']})" for e in events[:10]]
    return f"Showing 10/{len(events)} gameweeks:\n" + "\n".join(results)


@mcp.resource("fpl://fixtures")
async def all_fixtures() -> str:
    """All fixtures for current season"""
    data = await fetch("fixtures/")
    fixtures = data[:20]

    teams_data = await fetch("bootstrap-static/")
    teams = {t["id"]: t["name"] for t in teams_data["teams"]}

    results = [
        f"GW{f['event']}: {teams.get(f['team_h'], '?')} vs {teams.get(f['team_a'], '?')} "
        f"({f['kickoff_time'][:10]})"
        for f in fixtures if f.get("event")
    ]
    return "Next 20 fixtures:\n" + "\n".join(results)


@mcp.resource("fpl://gameweeks/blank")
async def blank_gameweeks() -> str:
    """Upcoming blank gameweeks"""
    data = await fetch("bootstrap-static/")
    fixtures = await fetch("fixtures/")

    current_gw = next((e["id"] for e in data["events"] if e["is_current"]), 1)
    teams = {t["id"]: t["name"] for t in data["teams"]}

    blanks = []
    for gw in range(current_gw, min(current_gw + 10, 39)):
        gw_fixtures = [f for f in fixtures if f.get("event") == gw]
        teams_playing = set()
        for f in gw_fixtures:
            teams_playing.add(f["team_h"])
            teams_playing.add(f["team_a"])

        teams_blank = [teams[tid] for tid in teams.keys() if tid not in teams_playing]
        if teams_blank:
            blanks.append(f"GW{gw}: {', '.join(teams_blank)}")

    return "Blank gameweeks:\n" + ("\n".join(blanks) if blanks else "None found")


@mcp.resource("fpl://gameweeks/double")
async def double_gameweeks() -> str:
    """Upcoming double gameweeks"""
    fixtures = await fetch("fixtures/")
    data = await fetch("bootstrap-static/")

    current_gw = next((e["id"] for e in data["events"] if e["is_current"]), 1)
    teams = {t["id"]: t["name"] for t in data["teams"]}

    doubles = []
    for gw in range(current_gw, min(current_gw + 10, 39)):
        team_fixture_count = Counter()
        for f in fixtures:
            if f.get("event") == gw:
                team_fixture_count[f["team_h"]] += 1
                team_fixture_count[f["team_a"]] += 1

        teams_double = [teams[tid] for tid, count in team_fixture_count.items() if count >= 2]
        if teams_double:
            doubles.append(f"GW{gw}: {', '.join(teams_double)}")

    return "Double gameweeks:\n" + ("\n".join(doubles) if doubles else "None found")


# ====================================================================================
# TOOLS (14 total - Enhanced with Phase 1 + 2)
# ====================================================================================

@mcp.tool()
async def search_player(name: str) -> Dict[str, Any]:
    """Search for players by name

    Args:
        name: Player name to search
    """
    # Phase 1: Parameter unwrapping
    name = unwrap_param(name, 'name')

    data = await fetch("bootstrap-static/")
    players = data["elements"]
    teams = {t["id"]: t["name"] for t in data["teams"]}

    matches = [
        p for p in players
        if name.lower() in p["web_name"].lower() or
           name.lower() in f"{p['first_name']} {p['second_name']}".lower()
    ]

    if not matches:
        return {"error": f"No players found for '{name}'"}

    results = []
    for p in matches[:10]:
        results.append({
            "id": p["id"],
            "name": f"{p['first_name']} {p['second_name']}",
            "web_name": p["web_name"],
            "team": teams[p["team"]],
            "position": ["GKP", "DEF", "MID", "FWD"][p["element_type"] - 1],
            "price": p["now_cost"] / 10,
            "total_points": p["total_points"],
            "form": p["form"],
            "points_per_game": p["points_per_game"],
            "goals": p["goals_scored"],
            "assists": p["assists"],
            "bonus": p["bonus"],
            "selected_by": f"{p['selected_by_percent']}%",
            "expected_goals": p.get("expected_goals", "0"),
            "expected_assists": p.get("expected_assists", "0")
        })

    return {"found": len(matches), "players": results}


@mcp.tool()
async def compare_players(
    player_names: List[str],
    metrics: List[str] = None,
    include_fixtures: bool = True,
    num_fixtures: int = 5
) -> Dict[str, Any]:
    """Compare multiple players across various metrics (Phase 2 Enhanced)

    Args:
        player_names: List of 2-5 player names to compare
        metrics: List of metrics to compare (defaults to key metrics)
        include_fixtures: Include fixture difficulty analysis
        num_fixtures: Number of upcoming fixtures to analyze
    """
    # Phase 1: Parameter unwrapping
    player_names = unwrap_param(player_names, 'player_names', [])
    if isinstance(metrics, dict):
        metrics = unwrap_param(metrics, 'metrics')
    if isinstance(include_fixtures, dict):
        include_fixtures = unwrap_param(include_fixtures, 'include_fixtures', True)
    if isinstance(num_fixtures, dict):
        num_fixtures = unwrap_param(num_fixtures, 'num_fixtures', 5)

    # Validate inputs
    if not player_names or len(player_names) < 2:
        return {"error": "Please provide at least 2 player names to compare"}

    if len(player_names) > 5:
        return {"error": "Maximum 5 players can be compared at once"}

    # Default metrics if not specified
    if not metrics:
        metrics = ["total_points", "form", "goals_scored", "assists", "bonus",
                   "points_per_game", "expected_goals", "expected_assists", "minutes", "now_cost"]

    # Fetch data
    data = await fetch("bootstrap-static/")
    players_data = data["elements"]
    teams = {t["id"]: t for t in data["teams"]}

    # Find all players
    found_players = {}
    for name in player_names:
        player = next((p for p in players_data if name.lower() in p["web_name"].lower()), None)
        if not player:
            return {"error": f"Player not found: {name}"}
        found_players[name] = player

    # Build comparison
    comparison = {
        "players": {},
        "metrics_comparison": {},
        "best_performers": {}
    }

    # Add player details
    for name, player in found_players.items():
        comparison["players"][name] = {
            "id": player["id"],
            "name": player["web_name"],
            "team": teams[player["team"]]["name"],
            "position": ["GKP", "DEF", "MID", "FWD"][player["element_type"] - 1],
            "price": player["now_cost"] / 10,
            "status": "available" if player["status"] == "a" else "unavailable"
        }

    # Compare metrics
    for metric in metrics:
        metric_values = {}
        for name, player in found_players.items():
            if metric in player:
                try:
                    value = float(player[metric]) if metric == "now_cost" else player[metric]
                except (ValueError, TypeError):
                    value = player[metric]
                metric_values[name] = value

        if metric_values:
            comparison["metrics_comparison"][metric] = metric_values

            # Determine best performer for this metric
            if all(isinstance(v, (int, float)) for v in metric_values.values()):
                if metric == "now_cost":  # Lower is better for price
                    best = min(metric_values.items(), key=lambda x: x[1])[0]
                else:
                    best = max(metric_values.items(), key=lambda x: x[1])[0]
                comparison["best_performers"][metric] = best

    # Add fixture analysis if requested
    if include_fixtures:
        fixtures_all = await fetch("fixtures/")
        fixture_comparison = {}

        for name, player in found_players.items():
            team_id = player["team"]
            player_fixtures = [
                f for f in fixtures_all
                if (f["team_h"] == team_id or f["team_a"] == team_id) and not f.get("finished")
            ][:num_fixtures]

            fixture_list = []
            total_difficulty = 0
            for f in player_fixtures:
                is_home = f["team_h"] == team_id
                opponent_id = f["team_a"] if is_home else f["team_h"]
                difficulty = f["team_h_difficulty"] if is_home else f["team_a_difficulty"]
                total_difficulty += difficulty

                fixture_list.append({
                    "gameweek": f["event"],
                    "opponent": teams[opponent_id]["name"],
                    "location": "Home" if is_home else "Away",
                    "difficulty": difficulty
                })

            avg_difficulty = total_difficulty / len(fixture_list) if fixture_list else 3
            fixture_score = round((6 - avg_difficulty) * 2, 1) if fixture_list else 0

            fixture_comparison[name] = {
                "fixtures": fixture_list,
                "average_difficulty": round(avg_difficulty, 2),
                "fixture_score": fixture_score,
                "rating": "Excellent" if avg_difficulty <= 2 else "Good" if avg_difficulty <= 3 else "Average" if avg_difficulty <= 4 else "Difficult"
            }

        comparison["fixture_comparison"] = fixture_comparison

        # Add best fixtures performer
        if fixture_comparison:
            best_fixtures = max(fixture_comparison.items(), key=lambda x: x[1]["fixture_score"])[0]
            comparison["best_performers"]["fixtures"] = best_fixtures

    # Overall summary
    player_wins = {name: 0 for name in player_names}
    for metric, best_name in comparison["best_performers"].items():
        player_wins[best_name] = player_wins.get(best_name, 0) + 1

    comparison["summary"] = {
        "metrics_won": player_wins,
        "overall_best": max(player_wins.items(), key=lambda x: x[1])[0] if player_wins else None
    }

    return comparison


@mcp.tool()
async def analyze_players(
    position: Optional[str] = None,
    team: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    min_points: Optional[int] = None,
    min_ownership: Optional[float] = None,
    max_ownership: Optional[float] = None,
    form_threshold: Optional[float] = None,
    sort_by: str = "total_points",
    limit: int = 20
) -> Dict[str, Any]:
    """Filter and analyze players (Phase 2 Enhanced with more filters)

    Args:
        position: Position filter (GKP/DEF/MID/FWD)
        team: Team name filter
        min_price: Minimum price in millions
        max_price: Maximum price in millions
        min_points: Minimum total points
        min_ownership: Minimum ownership percentage
        max_ownership: Maximum ownership percentage
        form_threshold: Minimum form rating
        sort_by: Sort metric (default: total_points)
        limit: Max results (default: 20)
    """
    # Phase 1: Parameter unwrapping
    position = unwrap_param(position, 'position') if position else None
    team = unwrap_param(team, 'team') if team else None
    min_price = unwrap_param(min_price, 'min_price') if min_price else None
    max_price = unwrap_param(max_price, 'max_price') if max_price else None
    min_points = unwrap_param(min_points, 'min_points') if min_points else None
    min_ownership = unwrap_param(min_ownership, 'min_ownership') if min_ownership else None
    max_ownership = unwrap_param(max_ownership, 'max_ownership') if max_ownership else None
    form_threshold = unwrap_param(form_threshold, 'form_threshold') if form_threshold else None
    sort_by = unwrap_param(sort_by, 'sort_by', 'total_points')
    limit = unwrap_param(limit, 'limit', 20)

    data = await fetch("bootstrap-static/")
    players = data["elements"]
    teams_data = {t["id"]: t for t in data["teams"]}

    # Normalize position
    pos_map = {"GOALKEEPER": "GKP", "DEFENDER": "DEF", "MIDFIELDER": "MID", "FORWARD": "FWD"}
    if position:
        position = pos_map.get(position.upper(), position.upper())

    # Filter
    filtered = []
    for p in players:
        # Position filter
        if position and ["GKP", "DEF", "MID", "FWD"][p["element_type"] - 1] != position:
            continue

        # Team filter
        if team and team.lower() not in teams_data[p["team"]]["name"].lower():
            continue

        # Price filters
        price = p["now_cost"] / 10
        if min_price and price < min_price:
            continue
        if max_price and price > max_price:
            continue

        # Points filter
        if min_points and p["total_points"] < min_points:
            continue

        # Form filter
        if form_threshold:
            try:
                if float(p.get("form", 0)) < form_threshold:
                    continue
            except:
                continue

        # Ownership filters (Phase 2 enhancement)
        if min_ownership or max_ownership:
            try:
                ownership = float(p["selected_by_percent"])
                if min_ownership and ownership < min_ownership:
                    continue
                if max_ownership and ownership > max_ownership:
                    continue
            except:
                continue

        filtered.append({
            "id": p["id"],
            "name": p["web_name"],
            "team": teams_data[p["team"]]["name"],
            "position": ["GKP", "DEF", "MID", "FWD"][p["element_type"] - 1],
            "price": price,
            "points": p["total_points"],
            "form": p["form"],
            "ownership": f"{p['selected_by_percent']}%",
            "goals": p["goals_scored"],
            "assists": p["assists"],
            "expected_goals": p.get("expected_goals", "0"),
            "expected_assists": p.get("expected_assists", "0")
        })

    # Sort
    try:
        filtered.sort(key=lambda x: float(x.get(sort_by, 0)) if isinstance(x.get(sort_by), (int, float, str)) and str(x.get(sort_by)).replace('.', '').isdigit() else 0, reverse=True)
    except:
        filtered.sort(key=lambda x: x.get("points", 0), reverse=True)

    # Calculate summary statistics
    total = len(filtered)
    avg_points = sum(x["points"] for x in filtered) / max(1, total)
    avg_price = sum(x["price"] for x in filtered) / max(1, total)

    position_counts = Counter(x["position"] for x in filtered)
    team_counts = Counter(x["team"] for x in filtered)

    return {
        "summary": {
            "total_matches": total,
            "average_points": round(avg_points, 1),
            "average_price": round(avg_price, 2),
            "position_distribution": dict(position_counts),
            "top_teams": dict(sorted(team_counts.items(), key=lambda x: x[1], reverse=True)[:10])
        },
        "filters_applied": {k: v for k, v in {
            "position": position, "team": team, "min_price": min_price,
            "max_price": max_price, "min_points": min_points,
            "min_ownership": min_ownership, "max_ownership": max_ownership,
            "form_threshold": form_threshold
        }.items() if v is not None},
        "players": filtered[:limit]
    }


@mcp.tool()
async def get_gameweek_status() -> Dict[str, Any]:
    """Get current, previous, and next gameweek information"""
    data = await fetch("bootstrap-static/")
    events = data["events"]

    current = next((e for e in events if e["is_current"]), None)
    next_gw = next((e for e in events if e["is_next"]), None)
    previous = next((e for e in events if e["is_previous"]), None)

    return {
        "current": {
            "id": current["id"],
            "name": current["name"],
            "deadline": current["deadline_time"],
            "finished": current["finished"]
        } if current else None,
        "next": {
            "id": next_gw["id"],
            "name": next_gw["name"],
            "deadline": next_gw["deadline_time"]
        } if next_gw else None,
        "previous": {
            "id": previous["id"],
            "name": previous["name"]
        } if previous else None
    }


@mcp.tool()
async def analyze_player_fixtures(player_name: str, num_fixtures: int = 5) -> Dict[str, Any]:
    """Analyze upcoming fixtures for a player

    Args:
        player_name: Player name
        num_fixtures: Number of fixtures to analyze
    """
    # Phase 1: Parameter unwrapping
    player_name = unwrap_param(player_name, 'player_name')
    num_fixtures = unwrap_param(num_fixtures, 'num_fixtures', 5)

    data = await fetch("bootstrap-static/")
    players = data["elements"]
    teams = {t["id"]: t for t in data["teams"]}

    player = next((p for p in players if player_name.lower() in p["web_name"].lower()), None)
    if not player:
        return {"error": f"Player not found: {player_name}"}

    team_id = player["team"]
    fixtures = await fetch("fixtures/")

    team_fixtures = [
        f for f in fixtures
        if (f["team_h"] == team_id or f["team_a"] == team_id) and not f.get("finished")
    ][:num_fixtures]

    results = []
    total_difficulty = 0
    for f in team_fixtures:
        is_home = f["team_h"] == team_id
        opponent_id = f["team_a"] if is_home else f["team_h"]
        difficulty = f["team_h_difficulty"] if is_home else f["team_a_difficulty"]
        total_difficulty += difficulty

        results.append({
            "gameweek": f["event"],
            "opponent": teams[opponent_id]["name"],
            "location": "Home" if is_home else "Away",
            "difficulty": difficulty,
            "kickoff": f["kickoff_time"]
        })

    avg_difficulty = total_difficulty / len(results) if results else 3

    return {
        "player": {
            "name": player["web_name"],
            "team": teams[team_id]["name"]
        },
        "fixtures": results,
        "summary": {
            "average_difficulty": round(avg_difficulty, 2),
            "rating": "Excellent" if avg_difficulty <= 2 else "Good" if avg_difficulty <= 3 else "Average" if avg_difficulty <= 4 else "Difficult"
        }
    }


@mcp.tool()
async def get_blank_gameweeks(num_gameweeks: int = 5) -> Dict[str, Any]:
    """Get upcoming blank gameweeks

    Args:
        num_gameweeks: Number of gameweeks to check
    """
    # Phase 1: Parameter unwrapping
    num_gameweeks = unwrap_param(num_gameweeks, 'num_gameweeks', 5)

    data = await fetch("bootstrap-static/")
    fixtures = await fetch("fixtures/")

    current_gw = next((e["id"] for e in data["events"] if e["is_current"]), 1)
    teams = {t["id"]: t["name"] for t in data["teams"]}

    blanks = []
    for gw in range(current_gw, min(current_gw + num_gameweeks, 39)):
        gw_fixtures = [f for f in fixtures if f.get("event") == gw]
        teams_playing = set()
        for f in gw_fixtures:
            teams_playing.add(f["team_h"])
            teams_playing.add(f["team_a"])

        teams_blank = [teams[tid] for tid in teams.keys() if tid not in teams_playing]
        if teams_blank:
            blanks.append({
                "gameweek": gw,
                "teams": teams_blank,
                "count": len(teams_blank)
            })

    return {"blank_gameweeks": blanks}


@mcp.tool()
async def get_double_gameweeks(num_gameweeks: int = 5) -> Dict[str, Any]:
    """Get upcoming double gameweeks

    Args:
        num_gameweeks: Number of gameweeks to check
    """
    # Phase 1: Parameter unwrapping
    num_gameweeks = unwrap_param(num_gameweeks, 'num_gameweeks', 5)

    fixtures = await fetch("fixtures/")
    data = await fetch("bootstrap-static/")

    current_gw = next((e["id"] for e in data["events"] if e["is_current"]), 1)
    teams = {t["id"]: t["name"] for t in data["teams"]}

    doubles = []
    for gw in range(current_gw, min(current_gw + num_gameweeks, 39)):
        team_fixture_count = Counter()
        for f in fixtures:
            if f.get("event") == gw:
                team_fixture_count[f["team_h"]] += 1
                team_fixture_count[f["team_a"]] += 1

        teams_double = [teams[tid] for tid, count in team_fixture_count.items() if count >= 2]
        if teams_double:
            doubles.append({
                "gameweek": gw,
                "teams": teams_double,
                "count": len(teams_double)
            })

    return {"double_gameweeks": doubles}


@mcp.tool()
async def analyze_fixtures(
    entity_type: str = "team",
    entity_name: str = "",
    num_gameweeks: int = 5,
    include_blanks: bool = False,
    include_doubles: bool = False
) -> Dict[str, Any]:
    """Analyze upcoming fixtures (Phase 2 Enhanced - supports player/team/position)

    Args:
        entity_type: Type (player/team/position)
        entity_name: Name of entity
        num_gameweeks: Number of gameweeks ahead
        include_blanks: Include blank gameweek information
        include_doubles: Include double gameweek information
    """
    # Phase 1: Parameter unwrapping
    entity_type = unwrap_param(entity_type, 'entity_type', 'team')
    entity_name = unwrap_param(entity_name, 'entity_name', '')
    num_gameweeks = unwrap_param(num_gameweeks, 'num_gameweeks', 5)
    include_blanks = unwrap_param(include_blanks, 'include_blanks', False)
    include_doubles = unwrap_param(include_doubles, 'include_doubles', False)

    data = await fetch("bootstrap-static/")
    fixtures = await fetch("fixtures/")
    teams = {t["id"]: t for t in data["teams"]}
    players = data["elements"]

    current_gw = next((e["id"] for e in data["events"] if e["is_current"]), 1)

    result = {
        "entity_type": entity_type,
        "entity_name": entity_name,
        "current_gameweek": current_gw,
        "analysis_range": list(range(current_gw + 1, current_gw + num_gameweeks + 1))
    }

    if entity_type == "team":
        team = next((t for t in teams.values() if entity_name.lower() in t["name"].lower()), None)
        if not team:
            return {"error": f"Team not found: {entity_name}"}

        team_id = team["id"]
        team_fixtures = [
            f for f in fixtures
            if (f["team_h"] == team_id or f["team_a"] == team_id) and
               f.get("event") and current_gw <= f["event"] <= current_gw + num_gameweeks
        ]

        results = []
        for f in team_fixtures:
            is_home = f["team_h"] == team_id
            opponent = teams[f["team_a"] if is_home else f["team_h"]]["name"]
            difficulty = f["team_h_difficulty"] if is_home else f["team_a_difficulty"]

            results.append({
                "gameweek": f["event"],
                "opponent": opponent,
                "location": "Home" if is_home else "Away",
                "difficulty": difficulty
            })

        avg_diff = sum(r["difficulty"] for r in results) / len(results) if results else 3

        result.update({
            "entity": {"type": "team", "name": team["name"]},
            "fixtures": results,
            "average_difficulty": round(avg_diff, 2),
            "fixture_score": round((6 - avg_diff) * 2, 1),
            "rating": "Excellent" if avg_diff <= 2 else "Good" if avg_diff <= 3 else "Average" if avg_diff <= 4 else "Difficult"
        })

    elif entity_type == "player":
        # Phase 2: Player fixture analysis
        player = next((p for p in players if entity_name.lower() in p["web_name"].lower()), None)
        if not player:
            return {"error": f"Player not found: {entity_name}"}

        team_id = player["team"]
        player_fixtures = [
            f for f in fixtures
            if (f["team_h"] == team_id or f["team_a"] == team_id) and
               f.get("event") and current_gw < f["event"] <= current_gw + num_gameweeks and
               not f.get("finished")
        ]

        fixture_list = []
        total_difficulty = 0
        for f in player_fixtures:
            is_home = f["team_h"] == team_id
            opponent_id = f["team_a"] if is_home else f["team_h"]
            difficulty = f["team_h_difficulty"] if is_home else f["team_a_difficulty"]
            total_difficulty += difficulty

            fixture_list.append({
                "gameweek": f["event"],
                "opponent": teams[opponent_id]["name"],
                "location": "Home" if is_home else "Away",
                "difficulty": difficulty
            })

        avg_diff = total_difficulty / len(fixture_list) if fixture_list else 3

        result.update({
            "player": {
                "name": player["web_name"],
                "team": teams[team_id]["name"],
                "position": ["GKP", "DEF", "MID", "FWD"][player["element_type"] - 1]
            },
            "fixtures": fixture_list,
            "average_difficulty": round(avg_diff, 2),
            "fixture_score": round((6 - avg_diff) * 2, 1),
            "rating": "Excellent" if avg_diff <= 2 else "Good" if avg_diff <= 3 else "Average" if avg_diff <= 4 else "Difficult"
        })

    elif entity_type == "position":
        # Phase 2: Position fixture analysis
        pos_map = {"GOALKEEPER": "GKP", "DEFENDER": "DEF", "MIDFIELDER": "MID", "FORWARD": "FWD",
                   "GKP": "GKP", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}
        normalized_pos = pos_map.get(entity_name.upper())

        if not normalized_pos:
            return {"error": f"Invalid position: {entity_name}. Use GKP/DEF/MID/FWD"}

        # Get all teams with players in this position
        teams_by_fixtures = {}
        for team_id, team in teams.items():
            team_fixtures = [
                f for f in fixtures
                if (f["team_h"] == team_id or f["team_a"] == team_id) and
                   f.get("event") and current_gw < f["event"] <= current_gw + num_gameweeks
            ]

            fixture_list = []
            total_diff = 0
            for f in team_fixtures:
                is_home = f["team_h"] == team_id
                opponent_id = f["team_a"] if is_home else f["team_h"]
                difficulty = f["team_h_difficulty"] if is_home else f["team_a_difficulty"]
                total_diff += difficulty

                fixture_list.append({
                    "gameweek": f["event"],
                    "opponent": teams[opponent_id]["name"],
                    "location": "Home" if is_home else "Away",
                    "difficulty": difficulty
                })

            if fixture_list:
                avg_diff = total_diff / len(fixture_list)
                teams_by_fixtures[team["name"]] = {
                    "fixtures": fixture_list,
                    "average_difficulty": round(avg_diff, 2),
                    "fixture_score": round((6 - avg_diff) * 2, 1)
                }

        # Sort by fixture score (best first)
        sorted_teams = sorted(teams_by_fixtures.items(), key=lambda x: x[1]["fixture_score"], reverse=True)

        result.update({
            "position": normalized_pos,
            "team_fixtures": {team: data for team, data in sorted_teams[:10]},
            "best_fixtures": [team for team, _ in sorted_teams[:3]]
        })

    else:
        return {"error": f"Invalid entity_type: {entity_type}. Use 'player', 'team', or 'position'"}

    # Add blank/double gameweek info if requested
    if include_blanks:
        blank_gws = await get_blank_gameweeks(num_gameweeks)
        result["blank_gameweeks"] = blank_gws.get("blank_gameweeks", [])

    if include_doubles:
        double_gws = await get_double_gameweeks(num_gameweeks)
        result["double_gameweeks"] = double_gws.get("double_gameweeks", [])

    return result


@mcp.tool()
async def get_my_team(gameweek: Optional[int] = None) -> Dict[str, Any]:
    """Get your FPL team with full squad list (Phase 1 Fixed)

    Args:
        gameweek: Gameweek number (defaults to current gameweek)

    Returns:
        Complete team including 15-player squad, captain, bench, etc.
    """
    # Phase 1: Parameter unwrapping
    if isinstance(gameweek, dict):
        gameweek = unwrap_param(gameweek, 'gameweek')

    if not FPL_TEAM_ID:
        return {"error": "FPL_TEAM_ID not configured in environment variables"}

    if not FPL_EMAIL or not FPL_PASSWORD:
        return {"error": "FPL_EMAIL and FPL_PASSWORD required for authentication"}

    try:
        # Get current gameweek if not specified
        if gameweek is None:
            data = await fetch("bootstrap-static/")
            current_gw = next((e for e in data["events"] if e["is_current"]), None)
            gameweek = current_gw["id"] if current_gw else 1

        # CRITICAL FIX: Use picks endpoint instead of entry endpoint
        picks_data = await auth_fetch(f"entry/{FPL_TEAM_ID}/event/{gameweek}/picks/")

        if "error" in picks_data:
            return picks_data

        # Get player data to enrich picks
        bootstrap = await fetch("bootstrap-static/")
        players = {p["id"]: p for p in bootstrap["elements"]}
        teams = {t["id"]: t for t in bootstrap["teams"]}

        # Process picks
        picks = picks_data.get("picks", [])
        entry_history = picks_data.get("entry_history", {})

        # Format each player with full details
        formatted_picks = []
        for pick in picks:
            player_id = pick["element"]
            player_data = players.get(player_id, {})

            if not player_data:
                continue

            team_id = player_data["team"]
            team_data = teams.get(team_id, {})

            position_map = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}
            position = position_map.get(player_data["element_type"], "UNK")

            formatted_picks.append({
                "id": player_id,
                "position_order": pick["position"],
                "multiplier": pick["multiplier"],
                "is_captain": pick.get("is_captain", False),
                "is_vice_captain": pick.get("is_vice_captain", False),

                # Player details
                "web_name": player_data["web_name"],
                "full_name": f"{player_data['first_name']} {player_data['second_name']}",
                "price": player_data["now_cost"] / 10.0,
                "form": player_data["form"],
                "total_points": player_data["total_points"],
                "minutes": player_data["minutes"],
                "goals": player_data["goals_scored"],
                "assists": player_data["assists"],
                "clean_sheets": player_data["clean_sheets"],
                "bonus": player_data["bonus"],

                # Team details
                "team": team_data["name"],
                "team_short": team_data["short_name"],
                "position": position,
            })

        # Sort by position order
        formatted_picks.sort(key=lambda p: p["position_order"])

        # Split into active (playing 11) and bench (4 players)
        active = [p for p in formatted_picks if p["multiplier"] > 0]
        bench = [p for p in formatted_picks if p["multiplier"] == 0]

        captain = next((p for p in formatted_picks if p["is_captain"]), None)
        vice = next((p for p in formatted_picks if p["is_vice_captain"]), None)

        return {
            "gameweek": gameweek,
            "team_id": int(FPL_TEAM_ID),
            "active": active,              # THE SQUAD LIST!
            "bench": bench,                # THE BENCH!
            "captain": captain,
            "vice_captain": vice,
            "points": entry_history.get("points", 0),
            "total_points": entry_history.get("total_points", 0),
            "rank": entry_history.get("overall_rank", 0),
            "bank": entry_history.get("bank", 0) / 10.0,
            "team_value": entry_history.get("value", 0) / 10.0,
            "transfers_made": entry_history.get("event_transfers", 0),
            "transfers_cost": entry_history.get("event_transfers_cost", 0),
        }
    except Exception as e:
        logger.error(f"Failed to fetch team: {e}", exc_info=True)
        return {"error": f"Failed to fetch team: {str(e)}"}


@mcp.tool()
async def get_team(team_id: int, gameweek: Optional[int] = None) -> Dict[str, Any]:
    """Get any team's full squad (Phase 1 Fixed)

    Args:
        team_id: FPL team ID (required)
        gameweek: Gameweek number (defaults to current)

    Returns:
        Complete team including squad list
    """
    # Phase 1: Parameter unwrapping
    team_id = unwrap_param(team_id, 'team_id')
    if isinstance(gameweek, dict):
        gameweek = unwrap_param(gameweek, 'gameweek')

    try:
        # Convert team_id to int
        team_id = int(team_id)

        # Get current gameweek if not specified
        if gameweek is None:
            data = await fetch("bootstrap-static/")
            gameweek = next((e["id"] for e in data["events"] if e["is_current"]), 1)

        # CRITICAL FIX: Use picks endpoint
        picks_data = await auth_fetch(f"entry/{team_id}/event/{gameweek}/picks/")

        if "error" in picks_data:
            return picks_data

        # Get player data
        bootstrap = await fetch("bootstrap-static/")
        players = {p["id"]: p for p in bootstrap["elements"]}
        teams = {t["id"]: t for t in bootstrap["teams"]}

        # Process picks (same logic as get_my_team)
        picks = picks_data.get("picks", [])
        entry_history = picks_data.get("entry_history", {})

        formatted_picks = []
        for pick in picks:
            player_id = pick["element"]
            player_data = players.get(player_id, {})

            if not player_data:
                continue

            team_data = teams.get(player_data["team"], {})
            position_map = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}

            formatted_picks.append({
                "id": player_id,
                "position_order": pick["position"],
                "multiplier": pick["multiplier"],
                "is_captain": pick.get("is_captain", False),
                "is_vice_captain": pick.get("is_vice_captain", False),
                "web_name": player_data["web_name"],
                "full_name": f"{player_data['first_name']} {player_data['second_name']}",
                "price": player_data["now_cost"] / 10.0,
                "form": player_data["form"],
                "total_points": player_data["total_points"],
                "team": team_data["name"],
                "team_short": team_data["short_name"],
                "position": position_map.get(player_data["element_type"], "UNK"),
            })

        formatted_picks.sort(key=lambda p: p["position_order"])

        active = [p for p in formatted_picks if p["multiplier"] > 0]
        bench = [p for p in formatted_picks if p["multiplier"] == 0]

        return {
            "gameweek": gameweek,
            "team_id": team_id,
            "active": active,
            "bench": bench,
            "captain": next((p for p in formatted_picks if p["is_captain"]), None),
            "vice_captain": next((p for p in formatted_picks if p["is_vice_captain"]), None),
            "points": entry_history.get("points", 0),
            "total_points": entry_history.get("total_points", 0),
            "rank": entry_history.get("overall_rank", 0),
            "bank": entry_history.get("bank", 0) / 10.0,
            "team_value": entry_history.get("value", 0) / 10.0,
        }
    except Exception as e:
        logger.error(f"Failed to fetch team {team_id}: {e}", exc_info=True)
        return {"error": f"Failed to fetch team: {str(e)}"}


@mcp.tool()
async def get_manager_info(team_id: Optional[int] = None) -> Dict[str, Any]:
    """Get manager profile details

    Args:
        team_id: FPL team ID (defaults to your team)
    """
    # Phase 1: Parameter unwrapping
    if isinstance(team_id, dict):
        team_id = unwrap_param(team_id, 'team_id')

    tid = team_id or (int(FPL_TEAM_ID) if FPL_TEAM_ID else None)
    if not tid:
        return {"error": "No team ID provided"}

    try:
        tid = int(tid)
        team = await fetch(f"entry/{tid}/", use_cache=False)
        return {
            "team_id": tid,
            "manager_name": f"{team.get('player_first_name')} {team.get('player_last_name')}",
            "team_name": team.get("name"),
            "region": team.get("player_region_name"),
            "started_event": team.get("started_event"),
            "overall_rank": team.get("summary_overall_rank"),
            "overall_points": team.get("summary_overall_points")
        }
    except Exception as e:
        return {"error": f"Failed to fetch manager: {str(e)}"}


@mcp.tool()
async def get_team_history(team_id: Optional[int] = None, num_gameweeks: int = 5) -> Dict[str, Any]:
    """Get team's historical performance

    Args:
        team_id: FPL team ID (defaults to your team)
        num_gameweeks: Number of recent gameweeks
    """
    # Phase 1: Parameter unwrapping
    if isinstance(team_id, dict):
        team_id = unwrap_param(team_id, 'team_id')
    num_gameweeks = unwrap_param(num_gameweeks, 'num_gameweeks', 5)

    tid = team_id or (int(FPL_TEAM_ID) if FPL_TEAM_ID else None)
    if not tid:
        return {"error": "No team ID provided"}

    try:
        tid = int(tid)
        history = await auth_fetch(f"entry/{tid}/history/")

        if "error" in history:
            return history

        current_season = history.get("current", [])
        recent = current_season[-num_gameweeks:] if len(current_season) >= num_gameweeks else current_season

        results = []
        for gw in recent:
            results.append({
                "gameweek": gw["event"],
                "points": gw["points"],
                "total_points": gw["total_points"],
                "rank": gw["overall_rank"],
                "value": gw["value"] / 10,
                "bank": gw["bank"] / 10
            })

        return {"team_id": tid, "history": results}
    except Exception as e:
        return {"error": f"Failed to fetch history: {str(e)}"}


@mcp.tool()
async def get_league_standings(league_id: int) -> Dict[str, Any]:
    """Get league standings

    Args:
        league_id: League ID
    """
    # Phase 1: Parameter unwrapping
    league_id = unwrap_param(league_id, 'league_id')

    try:
        league_id = int(league_id)
        league = await fetch(f"leagues-classic/{league_id}/standings/")
        standings = league.get("standings", {}).get("results", [])

        results = []
        for s in standings[:25]:  # Top 25
            results.append({
                "rank": s["rank"],
                "team_name": s["entry_name"],
                "manager": s["player_name"],
                "total_points": s["total"]
            })

        return {
            "league_name": league.get("league", {}).get("name"),
            "total_teams": len(standings),
            "standings": results
        }
    except Exception as e:
        return {"error": f"Failed to fetch league: {str(e)}"}


@mcp.tool()
async def check_fpl_authentication() -> Dict[str, Any]:
    """Check if FPL authentication is working"""
    if not FPL_EMAIL or not FPL_PASSWORD or not FPL_TEAM_ID:
        return {
            "authenticated": False,
            "message": "Credentials not fully configured",
            "missing": [
                k for k, v in {
                    "FPL_EMAIL": FPL_EMAIL,
                    "FPL_PASSWORD": FPL_PASSWORD,
                    "FPL_TEAM_ID": FPL_TEAM_ID
                }.items() if not v
            ]
        }

    try:
        team = await auth_fetch(f"entry/{FPL_TEAM_ID}/")

        if "error" in team:
            return {
                "authenticated": False,
                "error": team["error"],
                "credentials_configured": True,
                "team_id": FPL_TEAM_ID
            }

        return {
            "authenticated": True,
            "team_name": team.get("name"),
            "manager": f"{team.get('player_first_name')} {team.get('player_last_name')}",
            "team_id": FPL_TEAM_ID,
            "overall_rank": team.get("summary_overall_rank"),
            "overall_points": team.get("summary_overall_points")
        }
    except Exception as e:
        logger.error(f"Auth check failed: {e}", exc_info=True)
        return {
            "authenticated": False,
            "error": str(e),
            "credentials_configured": True
        }


# ====================================================================================
# RUN SERVER
# ====================================================================================

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    logger.info(f"🚀 Starting Fantasy PL MCP Server (Enhanced)")
    logger.info(f"📍 Port: {port}, Path: /mcp")
    logger.info(f"🔐 Auth configured: {bool(FPL_EMAIL and FPL_PASSWORD)}")
    logger.info(f"✨ Phase 1 + 2 enhancements active")

    mcp.run(transport="http", host="0.0.0.0", port=port, path="/mcp")
