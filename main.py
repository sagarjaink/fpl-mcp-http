"""
Fantasy Premier League MCP Server - Cloud Run Edition
All 14 tools + 12 resources + authentication
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
    """Fetch authenticated endpoint using requests.Session (like original package)"""
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
            
            # Run synchronous POST in executor (EXACTLY like original)
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
            # Run synchronous GET in executor (EXACTLY like original)
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
# TOOLS (14 total)
# ====================================================================================

@mcp.tool()
async def search_player(name: str) -> Dict[str, Any]:
    """Search for players by name
    
    Args:
        name: Player name to search
    """
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
async def compare_players(player1_name: str, player2_name: str, include_fixtures: bool = True) -> Dict[str, Any]:
    """Compare two players head-to-head
    
    Args:
        player1_name: First player
        player2_name: Second player
        include_fixtures: Include upcoming fixture analysis
    """
    data = await fetch("bootstrap-static/")
    players = data["elements"]
    teams = {t["id"]: t["name"] for t in data["teams"]}
    
    p1 = next((p for p in players if player1_name.lower() in p["web_name"].lower()), None)
    p2 = next((p for p in players if player2_name.lower() in p["web_name"].lower()), None)
    
    if not p1:
        return {"error": f"Player not found: {player1_name}"}
    if not p2:
        return {"error": f"Player not found: {player2_name}"}
    
    metrics = ["total_points", "form", "goals_scored", "assists", "bonus", "now_cost", 
               "points_per_game", "expected_goals", "expected_assists", "minutes"]
    
    comparison = {
        "player_1": {
            "name": p1["web_name"],
            "team": teams[p1["team"]],
            **{m: p1.get(m, 0) for m in metrics}
        },
        "player_2": {
            "name": p2["web_name"],
            "team": teams[p2["team"]],
            **{m: p2.get(m, 0) for m in metrics}
        },
        "winner": {}
    }
    
    # Determine winner for each metric
    for metric in metrics:
        v1 = float(p1.get(metric, 0))
        v2 = float(p2.get(metric, 0))
        if metric == "now_cost":  # Lower is better for price
            comparison["winner"][metric] = p1["web_name"] if v1 < v2 else p2["web_name"] if v2 < v1 else "tie"
        else:
            comparison["winner"][metric] = p1["web_name"] if v1 > v2 else p2["web_name"] if v2 > v1 else "tie"
    
    return comparison


@mcp.tool()
async def analyze_players(
    position: Optional[str] = None,
    team: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    min_points: Optional[int] = None,
    min_form: Optional[float] = None,
    max_ownership: Optional[float] = None,
    sort_by: str = "total_points",
    limit: int = 20
) -> Dict[str, Any]:
    """Filter and analyze players with multiple criteria
    
    Args:
        position: Position filter (GKP/DEF/MID/FWD)
        team: Team name filter
        min_price: Minimum price in millions
        max_price: Maximum price in millions
        min_points: Minimum total points
        min_form: Minimum form rating
        max_ownership: Maximum ownership percentage
        sort_by: Sort metric (default: total_points)
        limit: Max results (default: 20)
    """
    data = await fetch("bootstrap-static/")
    players = data["elements"]
    teams = {t["id"]: t for t in data["teams"]}
    
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
        if team and team.lower() not in teams[p["team"]]["name"].lower():
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
        if min_form:
            try:
                if float(p.get("form", 0)) < min_form:
                    continue
            except:
                continue
        
        # Ownership filter
        if max_ownership:
            try:
                ownership = float(p["selected_by_percent"])
                if ownership > max_ownership:
                    continue
            except:
                continue
        
        filtered.append({
            "name": p["web_name"],
            "team": teams[p["team"]]["name"],
            "position": ["GKP", "DEF", "MID", "FWD"][p["element_type"] - 1],
            "price": price,
            "points": p["total_points"],
            "form": p["form"],
            "ownership": f"{p['selected_by_percent']}%",
            "goals": p["goals_scored"],
            "assists": p["assists"]
        })
    
    # Sort
    filtered.sort(key=lambda x: x.get(sort_by, 0), reverse=True)
    
    return {
        "total_found": len(filtered),
        "filters_applied": {k: v for k, v in {
            "position": position, "team": team, "min_price": min_price,
            "max_price": max_price, "min_points": min_points, "min_form": min_form,
            "max_ownership": max_ownership
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
    num_gameweeks: int = 5
) -> Dict[str, Any]:
    """Analyze upcoming fixtures
    
    Args:
        entity_type: Type (player/team/position)
        entity_name: Name of entity
        num_gameweeks: Number of gameweeks ahead
    """
    data = await fetch("bootstrap-static/")
    fixtures = await fetch("fixtures/")
    teams = {t["id"]: t for t in data["teams"]}
    
    current_gw = next((e["id"] for e in data["events"] if e["is_current"]), 1)
    
    if entity_type == "team":
        team = next((t for t in teams.values() if entity_name.lower() in t["name"].lower()), None)
        if not team:
            return {"error": f"Team not found: {entity_name}"}
        
        team_id = team["id"]
        team_fixtures = [
            f for f in fixtures
            if (f["team_h"] == team_id or f["team_a"] == team_id) and
               f.get("event") and current_gw <= f["event"] <= current_gw + num_gameweeks - 1
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
        
        return {
            "entity": {"type": "team", "name": team["name"]},
            "fixtures": results,
            "average_difficulty": round(avg_diff, 2)
        }
    
    return {"error": "Only team analysis supported in this version"}


@mcp.tool()
async def get_my_team_details() -> Dict[str, Any]:
    """Get your team info (requires FPL_TEAM_ID, FPL_EMAIL, FPL_PASSWORD)"""
    if not FPL_TEAM_ID:
        return {"error": "FPL_TEAM_ID not configured in environment variables"}
    
    if not FPL_EMAIL or not FPL_PASSWORD:
        return {"error": "FPL_EMAIL and FPL_PASSWORD required for authentication"}
    
    try:
        team = await auth_fetch(f"entry/{FPL_TEAM_ID}/")
        
        if "error" in team:
            return team  # Return the error as-is
        
        # Check if we got valid data
        if not team.get("name"):
            return {
                "error": "Authentication succeeded but received empty data - check if team ID is correct",
                "team_id": FPL_TEAM_ID
            }
        
        return {
            "team_name": team.get("name"),
            "manager": f"{team.get('player_first_name', '')} {team.get('player_last_name', '')}".strip(),
            "overall_rank": team.get("summary_overall_rank"),
            "overall_points": team.get("summary_overall_points"),
            "gameweek_points": team.get("summary_event_points"),
            "team_value": team.get("last_deadline_value", 0) / 10,
            "bank": team.get("last_deadline_bank", 0) / 10,
            "total_transfers": team.get("total_transfers"),
            "team_id": FPL_TEAM_ID
        }
    except Exception as e:
        logger.error(f"Failed to fetch team: {e}", exc_info=True)
        return {"error": f"Failed to fetch team: {str(e)}"}



@mcp.tool()
async def get_team(team_id: int, gameweek: Optional[int] = None) -> Dict[str, Any]:
    """Get any team's details
    
    Args:
        team_id: FPL team ID
        gameweek: Gameweek number (defaults to current)
    """
    try:
        # Get basic team info
        team = await fetch(f"entry/{team_id}/", use_cache=False)
        
        # Get gameweek if not specified
        if not gameweek:
            data = await fetch("bootstrap-static/")
            gameweek = next((e["id"] for e in data["events"] if e["is_current"]), 1)
        
        # Get team picks for gameweek
        picks = await auth_fetch(f"entry/{team_id}/event/{gameweek}/picks/")
        
        return {
            "team_name": team.get("name"),
            "manager": f"{team.get('player_first_name')} {team.get('player_last_name')}",
            "overall_rank": team.get("summary_overall_rank"),
            "gameweek": gameweek,
            "gameweek_points": picks.get("entry_history", {}).get("points"),
            "total_players": len(picks.get("picks", []))
        }
    except Exception as e:
        return {"error": f"Failed to fetch team: {str(e)}"}


@mcp.tool()
async def get_manager_info(team_id: Optional[int] = None) -> Dict[str, Any]:
    """Get manager profile details
    
    Args:
        team_id: FPL team ID (defaults to your team)
    """
    tid = team_id or FPL_TEAM_ID
    if not tid:
        return {"error": "No team ID provided"}
    
    try:
        team = await fetch(f"entry/{tid}/", use_cache=False)
        return {
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
    tid = team_id or FPL_TEAM_ID
    if not tid:
        return {"error": "No team ID provided"}
    
    try:
        history = await auth_fetch(f"entry/{tid}/history/")
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
    try:
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
    logger.info(f"🚀 Starting Fantasy PL MCP Server")
    logger.info(f"📍 Port: {port}, Path: /mcp")
    logger.info(f"🔐 Auth configured: {bool(FPL_EMAIL and FPL_PASSWORD)}")
    
    mcp.run(transport="http", host="0.0.0.0", port=port, path="/mcp")
