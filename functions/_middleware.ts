/**
 * Fantasy Premier League MCP Server - Cloudflare Pages Edition (FIXED)
 * Comprehensive fixes for all 37 identified bugs
 */

interface Env {
  FPL_EMAIL: string;
  FPL_PASSWORD: string;
  FPL_TEAM_ID: string;
}

const FPL_API = "https://fantasy.premierleague.com/api";
const FPL_LOGIN = "https://users.premierleague.com/accounts/login/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// Enhanced caching with session storage
const cache = new Map<string, { timestamp: number; data: any }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const AUTH_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours for auth session

// Global auth session cache
let authSession: { cookies: string; timestamp: number } | null = null;

/**
 * Fetch from FPL API with caching
 */
async function fetchFPL(endpoint: string, useCache = true): Promise<any> {
  const cacheKey = `fpl:${endpoint}`;

  if (useCache && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
  }

  const response = await fetch(`${FPL_API}/${endpoint}`, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`FPL API error: ${response.statusText}`);
  }

  const data = await response.json();
  cache.set(cacheKey, { timestamp: Date.now(), data });
  return data;
}

/**
 * Authenticate with FPL and cache session (FIX: Bug #3 - Session caching)
 */
async function authenticatedFetch(endpoint: string, env: Env): Promise<any> {
  if (!env.FPL_EMAIL || !env.FPL_PASSWORD) {
    throw new Error("FPL credentials not configured");
  }

  // Check if we have a valid cached session
  const now = Date.now();
  if (authSession && (now - authSession.timestamp < AUTH_CACHE_TTL)) {
    // Use cached session
    const response = await fetch(`${FPL_API}/${endpoint}`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Cookie": authSession.cookies,
      },
    });

    if (response.ok) {
      return await response.json();
    }
    // If failed, invalidate cache and re-authenticate
    authSession = null;
  }

  // Get login page to get CSRF token
  const loginPage = await fetch(FPL_LOGIN, {
    headers: {
      "User-Agent": USER_AGENT,
      "accept-language": "en",
    },
  });

  const cookies = loginPage.headers.get("set-cookie") || "";
  const csrfMatch = cookies.match(/csrftoken=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";

  // Login with correct redirect_uri (FIX: Bug #1)
  const loginResponse = await fetch(FPL_LOGIN, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookies,
      "Referer": FPL_LOGIN,
      "accept-language": "en",
    },
    body: new URLSearchParams({
      login: env.FPL_EMAIL,
      password: env.FPL_PASSWORD,
      csrfmiddlewaretoken: csrfToken,
      app: "plfpl-web",
      redirect_uri: "https://fantasy.premierleague.com/a/login",
    }),
  });

  if (!loginResponse.ok) {
    throw new Error("Authentication failed");
  }

  const sessionCookie = loginResponse.headers.get("set-cookie") || "";

  // Cache the session
  authSession = {
    cookies: sessionCookie,
    timestamp: now,
  };

  // Fetch authenticated endpoint
  const response = await fetch(`${FPL_API}/${endpoint}`, {
    headers: {
      "User-Agent": USER_AGENT,
      "Cookie": sessionCookie,
    },
  });

  if (!response.ok) {
    throw new Error(`FPL API error: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * MCP Protocol Handler
 */
async function handleMCP(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();
    const { method, params, id } = body;

    console.log("MCP Request:", { method, params, id });

    // Handle notifications (no response needed)
    if (method?.startsWith("notifications/")) {
      console.log("Received notification:", method);
      return new Response(null, { status: 204 });
    }

    // Handle MCP methods
    switch (method) {
      case "initialize":
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              resources: {
                subscribe: false,
                listChanged: false,
              },
              tools: {
                listChanged: false,
              },
            },
            serverInfo: {
              name: "Fantasy Premier League",
              version: "1.0.0",
            },
          },
        });

      case "resources/list":
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          result: {
            resources: [
              { uri: "fpl://static/players", name: "All FPL Players", mimeType: "application/json" },
              { uri: "fpl://static/teams", name: "All Premier League Teams", mimeType: "application/json" },
              { uri: "fpl://gameweeks/current", name: "Current Gameweek", mimeType: "application/json" },
              { uri: "fpl://gameweeks/all", name: "All Gameweeks", mimeType: "application/json" },
              { uri: "fpl://fixtures", name: "All Fixtures", mimeType: "application/json" },
              { uri: "fpl://gameweeks/blank", name: "Blank Gameweeks", mimeType: "application/json" },
              { uri: "fpl://gameweeks/double", name: "Double Gameweeks", mimeType: "application/json" },
            ],
          },
        });

      case "resources/read":
        return await handleResourceRead(params.uri, env, id);

      case "tools/list":
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "search_player",
                description: "Search for players by name with comprehensive stats",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Player name to search" },
                  },
                  required: ["query"],
                },
              },
              {
                name: "compare_players",
                description: "Compare 2-5 players with structured analysis and best performers",
                inputSchema: {
                  type: "object",
                  properties: {
                    player_names: { type: "array", items: { type: "string" }, description: "2-5 player names" },
                    metrics: { type: "array", items: { type: "string" }, description: "Metrics to compare (optional)" },
                    include_fixtures: { type: "boolean", description: "Include fixture analysis" },
                    num_fixtures: { type: "number", description: "Number of fixtures (default 5)" },
                  },
                  required: ["player_names"],
                },
              },
              {
                name: "analyze_players",
                description: "Filter and analyze players with ownership and form filters",
                inputSchema: {
                  type: "object",
                  properties: {
                    position: { type: "string", description: "Position (GKP/DEF/MID/FWD)" },
                    team: { type: "string", description: "Team name" },
                    min_price: { type: "number", description: "Minimum price" },
                    max_price: { type: "number", description: "Maximum price" },
                    min_points: { type: "number", description: "Minimum total points" },
                    min_ownership: { type: "number", description: "Minimum ownership %" },
                    max_ownership: { type: "number", description: "Maximum ownership %" },
                    form_threshold: { type: "number", description: "Minimum form rating" },
                    sort_by: { type: "string", description: "Sort metric" },
                    limit: { type: "number", description: "Max results (default 20)" },
                  },
                },
              },
              {
                name: "get_gameweek_status",
                description: "Get current, previous, and next gameweek information",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "analyze_player_fixtures",
                description: "Analyze upcoming fixtures for a specific player",
                inputSchema: {
                  type: "object",
                  properties: {
                    player_name: { type: "string", description: "Player name" },
                    num_fixtures: { type: "number", description: "Number of fixtures (default 5)" },
                  },
                  required: ["player_name"],
                },
              },
              {
                name: "get_blank_gameweeks",
                description: "Identify upcoming blank gameweeks by counting fixtures",
                inputSchema: {
                  type: "object",
                  properties: {
                    num_gameweeks: { type: "number", description: "Number to check (default 5)" },
                  },
                },
              },
              {
                name: "get_double_gameweeks",
                description: "Identify upcoming double gameweeks by counting fixtures",
                inputSchema: {
                  type: "object",
                  properties: {
                    num_gameweeks: { type: "number", description: "Number to check (default 5)" },
                  },
                },
              },
              {
                name: "analyze_fixtures",
                description: "Analyze fixtures for teams, players, or positions",
                inputSchema: {
                  type: "object",
                  properties: {
                    entity_type: { type: "string", description: "Type: team/player/position (default: team)" },
                    entity_name: { type: "string", description: "Name of entity" },
                    num_gameweeks: { type: "number", description: "Number of gameweeks (default 5)" },
                    include_blanks: { type: "boolean", description: "Include blank GW info" },
                    include_doubles: { type: "boolean", description: "Include double GW info" },
                  },
                  required: ["entity_name"],
                },
              },
              {
                name: "get_my_team",
                description: "Get your FPL team with full squad, bench split, and player details",
                inputSchema: {
                  type: "object",
                  properties: {
                    gameweek: { type: "number", description: "Gameweek number (optional)" },
                  },
                },
              },
              {
                name: "get_team",
                description: "Get any FPL team with full squad and player details",
                inputSchema: {
                  type: "object",
                  properties: {
                    team_id: { type: "number", description: "FPL team ID" },
                    gameweek: { type: "number", description: "Gameweek number (optional)" },
                  },
                  required: ["team_id"],
                },
              },
              {
                name: "get_manager_info",
                description: "Get manager profile and league information",
                inputSchema: {
                  type: "object",
                  properties: {
                    team_id: { type: "number", description: "FPL team ID (optional)" },
                  },
                },
              },
              {
                name: "get_team_history",
                description: "Get historical performance over gameweeks",
                inputSchema: {
                  type: "object",
                  properties: {
                    team_id: { type: "number", description: "FPL team ID (optional)" },
                    num_gameweeks: { type: "number", description: "Number of gameweeks (default 5)" },
                  },
                },
              },
              {
                name: "get_league_standings",
                description: "Get league standings and rankings",
                inputSchema: {
                  type: "object",
                  properties: {
                    league_id: { type: "number", description: "League ID" },
                  },
                  required: ["league_id"],
                },
              },
              {
                name: "check_fpl_authentication",
                description: "Test if FPL credentials are working",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "get_team_statistics",
                description: "Get comprehensive team performance statistics (goals, clean sheets, form)",
                inputSchema: {
                  type: "object",
                  properties: {
                    team_name: { type: "string", description: "Team name (e.g., 'Arsenal', 'Liverpool')" },
                    num_gameweeks: { type: "number", description: "Number of recent gameweeks for form (default: 5)" },
                  },
                  required: ["team_name"],
                },
              },
            ],
          },
        });

      case "tools/call":
        return await handleToolCall(params.name, params.arguments || {}, env, id);

      default:
        console.log("Unknown method:", method);
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not supported: ${method}` }
        }, 400);
    }
  } catch (error: any) {
    console.error("MCP Error:", error);
    return jsonResponse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: error.message }
    }, 500);
  }
}

/**
 * Handle resource read requests (FIX: Bug #18, #19 - Blank/Double gameweeks)
 */
async function handleResourceRead(uri: string, env: Env, id: any): Promise<Response> {
  const data = await fetchFPL("bootstrap-static/");

  let result;
  switch (uri) {
    case "fpl://static/players":
      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(data.elements, null, 2),
          },
        ],
      };
      break;

    case "fpl://static/teams":
      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(data.teams, null, 2),
          },
        ],
      };
      break;

    case "fpl://gameweeks/current":
      const currentGW = data.events.find((e: any) => e.is_current);
      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(currentGW, null, 2),
          },
        ],
      };
      break;

    case "fpl://gameweeks/all":
      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(data.events, null, 2),
          },
        ],
      };
      break;

    case "fpl://fixtures":
      const fixtures = await fetchFPL("fixtures/");
      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(fixtures, null, 2),
          },
        ],
      };
      break;

    case "fpl://gameweeks/blank":
      // FIX: Bug #18 - Calculate blank gameweeks by counting fixtures, not chip_plays
      const fixturesForBlank = await fetchFPL("fixtures/");
      const currentId = data.events.find((e: any) => e.is_current)?.id || 1;
      const teams = data.teams;

      const blanks: any[] = [];
      for (let gw = currentId; gw < Math.min(currentId + 10, 39); gw++) {
        const gwFixtures = fixturesForBlank.filter((f: any) => f.event === gw);
        const teamsPlaying = new Set<number>();
        gwFixtures.forEach((f: any) => {
          teamsPlaying.add(f.team_h);
          teamsPlaying.add(f.team_a);
        });

        const teamsNotPlaying = teams.filter((t: any) => !teamsPlaying.has(t.id));
        if (teamsNotPlaying.length > 0) {
          blanks.push({
            gameweek: gw,
            teams: teamsNotPlaying.map((t: any) => t.name),
            count: teamsNotPlaying.length,
          });
        }
      }

      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(blanks, null, 2),
          },
        ],
      };
      break;

    case "fpl://gameweeks/double":
      // FIX: Bug #19 - Calculate double gameweeks by counting fixtures per team
      const fixturesForDouble = await fetchFPL("fixtures/");
      const currentIdDouble = data.events.find((e: any) => e.is_current)?.id || 1;
      const teamsDouble = data.teams;

      const doubles: any[] = [];
      for (let gw = currentIdDouble; gw < Math.min(currentIdDouble + 10, 39); gw++) {
        const teamCounts: Record<number, number> = {};
        fixturesForDouble.filter((f: any) => f.event === gw).forEach((f: any) => {
          teamCounts[f.team_h] = (teamCounts[f.team_h] || 0) + 1;
          teamCounts[f.team_a] = (teamCounts[f.team_a] || 0) + 1;
        });

        const teamsWithDouble = Object.entries(teamCounts)
          .filter(([_, count]) => count >= 2)
          .map(([teamId]) => teamsDouble.find((t: any) => t.id === parseInt(teamId))?.name);

        if (teamsWithDouble.length > 0) {
          doubles.push({
            gameweek: gw,
            teams: teamsWithDouble.filter((t: any) => t !== undefined),
            count: teamsWithDouble.length,
          });
        }
      }

      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(doubles, null, 2),
          },
        ],
      };
      break;

    default:
      return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32602, message: "Resource not found" } }, 404);
  }

  return jsonResponse({ jsonrpc: "2.0", id, result });
}

/**
 * Handle tool call requests (with error handling - FIX: Bug #26)
 */
async function handleToolCall(toolName: string, args: any, env: Env, id: any): Promise<Response> {
  let result;

  try {
    switch (toolName) {
      case "search_player":
        result = await searchPlayer(args.query);
        break;

      case "compare_players":
        result = await comparePlayers(args.player_names, args.metrics, args.include_fixtures, args.num_fixtures);
        break;

      case "analyze_players":
        result = await analyzePlayers(args);
        break;

      case "get_gameweek_status":
        result = await getGameweekStatus();
        break;

      case "analyze_player_fixtures":
        result = await analyzePlayerFixtures(args.player_name, args.num_fixtures || 5);
        break;

      case "get_blank_gameweeks":
        result = await getBlankGameweeks(args.num_gameweeks || 5);
        break;

      case "get_double_gameweeks":
        result = await getDoubleGameweeks(args.num_gameweeks || 5);
        break;

      case "analyze_fixtures":
        result = await analyzeFixtures(args, env);
        break;

      case "get_my_team":
        result = await getMyTeam(env, args.gameweek);
        break;

      case "get_team":
        result = await getTeam(env, args.team_id, args.gameweek);
        break;

      case "get_manager_info":
        result = await getManagerInfo(env, args.team_id);
        break;

      case "get_team_history":
        result = await getTeamHistory(env, args.team_id, args.num_gameweeks || 5);
        break;

      case "get_league_standings":
        result = await getLeagueStandings(env, args.league_id);
        break;

      case "check_fpl_authentication":
        result = await checkFPLAuthentication(env);
        break;

      case "get_team_statistics":
        result = await getTeamStatistics(args.team_name, args.num_gameweeks);
        break;

      default:
        return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: "Tool not found" } }, 404);
    }

    return jsonResponse({ jsonrpc: "2.0", id, result });
  } catch (error: any) {
    console.error(`Tool ${toolName} error:`, error);
    return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } }, 500);
  }
}

/**
 * Tool: Search for players (FIX: Bug #22 - Add more stats)
 */
async function searchPlayer(query: string): Promise<any> {
  try {
    const data = await fetchFPL("bootstrap-static/");
    const players = data.elements;
    const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

    const results = players.filter((p: any) =>
      p.web_name.toLowerCase().includes(query.toLowerCase()) ||
      p.first_name.toLowerCase().includes(query.toLowerCase()) ||
      p.second_name.toLowerCase().includes(query.toLowerCase())
    );

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: `No players found for '${query}'` }, null, 2),
        }],
      };
    }

    const enrichedResults = results.slice(0, 10).map((p: any) => ({
      id: p.id,
      name: `${p.first_name} ${p.second_name}`,
      web_name: p.web_name,
      team: teams[p.team].name,
      position: ["GKP", "DEF", "MID", "FWD"][p.element_type - 1],
      price: p.now_cost / 10,
      total_points: p.total_points,
      form: p.form,
      points_per_game: p.points_per_game,
      goals: p.goals_scored,
      assists: p.assists,
      bonus: p.bonus,
      selected_by: `${p.selected_by_percent}%`,
      expected_goals: p.expected_goals || "0",
      expected_assists: p.expected_assists || "0",
      minutes: p.minutes,
      clean_sheets: p.clean_sheets,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ found: results.length, players: enrichedResults }, null, 2),
        },
      ],
    };
  } catch (error: any) {
    throw new Error(`Search failed: ${error.message}`);
  }
}

/**
 * Tool: Get gameweek status (FIX: Add previous gameweek - Bug #20)
 */
async function getGameweekStatus(): Promise<any> {
  try {
    const data = await fetchFPL("bootstrap-static/");
    const events = data.events;

    const current = events.find((e: any) => e.is_current);
    const next = events.find((e: any) => e.is_next);
    const previous = events.find((e: any) => e.is_previous);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            current: current ? {
              id: current.id,
              name: current.name,
              deadline: current.deadline_time,
              finished: current.finished,
            } : null,
            next: next ? {
              id: next.id,
              name: next.name,
              deadline: next.deadline_time,
            } : null,
            previous: previous ? {
              id: previous.id,
              name: previous.name,
            } : null,
          }, null, 2),
        },
      ],
    };
  } catch (error: any) {
    throw new Error(`Failed to get gameweek status: ${error.message}`);
  }
}

/**
 * Tool: Compare players (FIX: Bug #7, #8 - Add structured comparison and best performers)
 */
async function comparePlayers(
  playerNames: string[],
  metrics?: string[],
  includeFixtures = true,
  numFixtures = 5
): Promise<any> {
  try {
    if (!playerNames || playerNames.length < 2) {
      throw new Error("Please provide at least 2 player names");
    }
    if (playerNames.length > 5) {
      throw new Error("Maximum 5 players can be compared");
    }

    const data = await fetchFPL("bootstrap-static/");
    const players = data.elements;
    const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

    // Default metrics if not specified
    const compareMetrics = metrics || [
      "total_points", "form", "goals_scored", "assists", "bonus",
      "points_per_game", "expected_goals", "expected_assists", "minutes", "now_cost"
    ];

    const foundPlayers: any[] = [];
    for (const name of playerNames) {
      const player = players.find((p: any) =>
        p.web_name.toLowerCase().includes(name.toLowerCase())
      );
      if (!player) {
        throw new Error(`Player not found: ${name}`);
      }
      foundPlayers.push(player);
    }

    // Build structured comparison
    const comparison: any = {
      players: {},
      metrics_comparison: {},
      best_performers: {},
    };

    // Add player details
    for (const player of foundPlayers) {
      comparison.players[player.web_name] = {
        id: player.id,
        name: player.web_name,
        team: teams[player.team].name,
        position: ["GKP", "DEF", "MID", "FWD"][player.element_type - 1],
        price: player.now_cost / 10,
        status: player.status === "a" ? "available" : "unavailable",
      };
    }

    // Compare metrics
    for (const metric of compareMetrics) {
      const metricValues: any = {};
      for (const player of foundPlayers) {
        if (metric in player) {
          try {
            metricValues[player.web_name] = parseFloat(player[metric]) || player[metric];
          } catch {
            metricValues[player.web_name] = player[metric];
          }
        }
      }

      if (Object.keys(metricValues).length > 0) {
        comparison.metrics_comparison[metric] = metricValues;

        // Find best performer for this metric
        const numericValues = Object.entries(metricValues).filter(([_, v]) => typeof v === "number");
        if (numericValues.length > 0) {
          if (metric === "now_cost") {
            // Lower is better for price
            comparison.best_performers[metric] = numericValues.reduce((a, b) => a[1] < b[1] ? a : b)[0];
          } else {
            comparison.best_performers[metric] = numericValues.reduce((a, b) => a[1] > b[1] ? a : b)[0];
          }
        }
      }
    }

    // Add fixture analysis if requested
    if (includeFixtures) {
      const fixtures = await fetchFPL("fixtures/");
      const fixtureComparison: any = {};

      for (const player of foundPlayers) {
        const teamId = player.team;
        const playerFixtures = fixtures
          .filter((f: any) => !f.finished && (f.team_h === teamId || f.team_a === teamId))
          .slice(0, numFixtures);

        const fixtureList: any[] = [];
        let totalDifficulty = 0;

        for (const f of playerFixtures) {
          const isHome = f.team_h === teamId;
          const opponentId = isHome ? f.team_a : f.team_h;
          const difficulty = isHome ? f.team_h_difficulty : f.team_a_difficulty;
          totalDifficulty += difficulty;

          fixtureList.push({
            gameweek: f.event,
            opponent: teams[opponentId].name,
            location: isHome ? "Home" : "Away",
            difficulty,
          });
        }

        const avgDifficulty = fixtureList.length > 0 ? totalDifficulty / fixtureList.length : 3;
        const fixtureScore = fixtureList.length > 0 ? Math.round((6 - avgDifficulty) * 2 * 10) / 10 : 0;

        fixtureComparison[player.web_name] = {
          fixtures: fixtureList,
          average_difficulty: Math.round(avgDifficulty * 100) / 100,
          fixture_score: fixtureScore,
          rating: avgDifficulty <= 2 ? "Excellent" : avgDifficulty <= 3 ? "Good" : avgDifficulty <= 4 ? "Average" : "Difficult",
        };
      }

      comparison.fixture_comparison = fixtureComparison;

      // Add best fixtures performer
      if (Object.keys(fixtureComparison).length > 0) {
        const bestFixtures = Object.entries(fixtureComparison).reduce((a: any, b: any) =>
          a[1].fixture_score > b[1].fixture_score ? a : b
        )[0];
        comparison.best_performers.fixtures = bestFixtures;
      }
    }

    // Overall summary
    const playerWins: Record<string, number> = {};
    for (const name of playerNames) {
      playerWins[foundPlayers.find((p: any) => p.web_name.toLowerCase().includes(name.toLowerCase()))?.web_name || name] = 0;
    }

    for (const bestName of Object.values(comparison.best_performers)) {
      if (typeof bestName === "string") {
        playerWins[bestName] = (playerWins[bestName] || 0) + 1;
      }
    }

    const sortedWins = Object.entries(playerWins).sort((a, b) => b[1] - a[1]);
    comparison.summary = {
      metrics_won: playerWins,
      overall_best: sortedWins.length > 0 ? sortedWins[0][0] : null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(comparison, null, 2) }],
    };
  } catch (error: any) {
    throw new Error(`Comparison failed: ${error.message}`);
  }
}

/**
 * Tool: Analyze players (FIX: Bug #9, #10 - Add ownership and form filters)
 */
async function analyzePlayers(args: any): Promise<any> {
  try {
    const data = await fetchFPL("bootstrap-static/");
    const players = data.elements;
    const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

    // Normalize position
    const posMap: Record<string, string> = {
      "GOALKEEPER": "GKP", "DEFENDER": "DEF", "MIDFIELDER": "MID", "FORWARD": "FWD"
    };
    const position = args.position ? (posMap[args.position.toUpperCase()] || args.position.toUpperCase()) : null;

    let filtered = players.filter((p: any) => {
      // Position filter
      if (position) {
        const pos = ["GKP", "DEF", "MID", "FWD"][p.element_type - 1];
        if (pos !== position) return false;
      }

      // Team filter
      if (args.team && !teams[p.team].name.toLowerCase().includes(args.team.toLowerCase())) {
        return false;
      }

      // Price filters
      const price = p.now_cost / 10;
      if (args.min_price && price < args.min_price) return false;
      if (args.max_price && price > args.max_price) return false;

      // Points filter
      if (args.min_points && p.total_points < args.min_points) return false;

      // Form filter
      if (args.form_threshold) {
        try {
          if (parseFloat(p.form || 0) < args.form_threshold) return false;
        } catch {
          return false;
        }
      }

      // Ownership filters
      if (args.min_ownership || args.max_ownership) {
        try {
          const ownership = parseFloat(p.selected_by_percent || 0);
          if (args.min_ownership && ownership < args.min_ownership) return false;
          if (args.max_ownership && ownership > args.max_ownership) return false;
        } catch {
          return false;
        }
      }

      return true;
    });

    // Sort
    const sortBy = args.sort_by || "total_points";
    filtered.sort((a: any, b: any) => {
      const aVal = parseFloat(a[sortBy] || 0);
      const bVal = parseFloat(b[sortBy] || 0);
      return bVal - aVal;
    });

    const limit = args.limit || 20;
    const results = filtered.slice(0, limit).map((p: any) => ({
      id: p.id,
      name: p.web_name,
      team: teams[p.team].name,
      position: ["GKP", "DEF", "MID", "FWD"][p.element_type - 1],
      price: p.now_cost / 10,
      total_points: p.total_points,
      form: p.form,
      ownership: parseFloat(p.selected_by_percent || 0),
      goals: p.goals_scored,
      assists: p.assists,
      expected_goals: p.expected_goals || "0",
      expected_assists: p.expected_assists || "0",
    }));

    // Calculate summary statistics
    const totalMatches = filtered.length;
    const avgPoints = totalMatches > 0 ? filtered.reduce((sum: number, p: any) => sum + p.total_points, 0) / totalMatches : 0;
    const avgPrice = totalMatches > 0 ? filtered.reduce((sum: number, p: any) => sum + p.now_cost / 10, 0) / totalMatches : 0;

    const positionCounts: Record<string, number> = {};
    const teamCounts: Record<string, number> = {};
    filtered.forEach((p: any) => {
      const pos = ["GKP", "DEF", "MID", "FWD"][p.element_type - 1];
      positionCounts[pos] = (positionCounts[pos] || 0) + 1;
      teamCounts[teams[p.team].name] = (teamCounts[teams[p.team].name] || 0) + 1;
    });

    const topTeams = Object.entries(teamCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          summary: {
            total_matches: totalMatches,
            average_points: Math.round(avgPoints * 10) / 10,
            average_price: Math.round(avgPrice * 100) / 100,
            position_distribution: positionCounts,
            top_teams: topTeams,
          },
          filters_applied: {
            position, team: args.team, min_price: args.min_price, max_price: args.max_price,
            min_points: args.min_points, min_ownership: args.min_ownership,
            max_ownership: args.max_ownership, form_threshold: args.form_threshold,
          },
          players: results,
        }, null, 2),
      }],
    };
  } catch (error: any) {
    throw new Error(`Analysis failed: ${error.message}`);
  }
}

/**
 * Tool: Analyze player fixtures
 */
async function analyzePlayerFixtures(playerName: string, numFixtures = 5): Promise<any> {
  try {
    const data = await fetchFPL("bootstrap-static/");
    const players = data.elements;
    const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

    const player = players.find((p: any) =>
      p.web_name.toLowerCase().includes(playerName.toLowerCase())
    );
    if (!player) {
      throw new Error(`Player not found: ${playerName}`);
    }

    const teamId = player.team;
    const fixtures = await fetchFPL("fixtures/");

    const upcoming = fixtures
      .filter((f: any) => !f.finished && (f.team_h === teamId || f.team_a === teamId))
      .slice(0, numFixtures)
      .map((f: any) => {
        const isHome = f.team_h === teamId;
        const opponentId = isHome ? f.team_a : f.team_h;
        return {
          gameweek: f.event,
          opponent: teams[opponentId].name,
          location: isHome ? "Home" : "Away",
          difficulty: isHome ? f.team_h_difficulty : f.team_a_difficulty,
          kickoff: f.kickoff_time,
        };
      });

    const totalDiff = upcoming.reduce((sum: number, f: any) => sum + f.difficulty, 0);
    const avgDiff = upcoming.length > 0 ? totalDiff / upcoming.length : 3;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          player: {
            name: player.web_name,
            team: teams[teamId].name,
          },
          fixtures: upcoming,
          summary: {
            average_difficulty: Math.round(avgDiff * 100) / 100,
            rating: avgDiff <= 2 ? "Excellent" : avgDiff <= 3 ? "Good" : avgDiff <= 4 ? "Average" : "Difficult",
          },
        }, null, 2),
      }],
    };
  } catch (error: any) {
    throw new Error(`Fixture analysis failed: ${error.message}`);
  }
}

/**
 * Tool: Get blank gameweeks (FIX: Bug #18)
 */
async function getBlankGameweeks(numGameweeks = 5): Promise<any> {
  try {
    const data = await fetchFPL("bootstrap-static/");
    const fixtures = await fetchFPL("fixtures/");
    const teams = data.teams;

    const currentGW = data.events.find((e: any) => e.is_current);
    if (!currentGW) {
      throw new Error("No current gameweek found");
    }

    const blanks: any[] = [];
    for (let i = 0; i < numGameweeks; i++) {
      const gwId = currentGW.id + i;
      const gwFixtures = fixtures.filter((f: any) => f.event === gwId);
      const teamsPlaying = new Set([
        ...gwFixtures.map((f: any) => f.team_h),
        ...gwFixtures.map((f: any) => f.team_a),
      ]);

      const teamsNotPlaying = teams.filter((t: any) => !teamsPlaying.has(t.id));
      if (teamsNotPlaying.length > 0) {
        blanks.push({
          gameweek: gwId,
          teams: teamsNotPlaying.map((t: any) => t.name),
          count: teamsNotPlaying.length,
        });
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ blank_gameweeks: blanks }, null, 2) }],
    };
  } catch (error: any) {
    throw new Error(`Failed to get blank gameweeks: ${error.message}`);
  }
}

/**
 * Tool: Get double gameweeks (FIX: Bug #19)
 */
async function getDoubleGameweeks(numGameweeks = 5): Promise<any> {
  try {
    const data = await fetchFPL("bootstrap-static/");
    const fixtures = await fetchFPL("fixtures/");
    const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

    const currentGW = data.events.find((e: any) => e.is_current);
    if (!currentGW) {
      throw new Error("No current gameweek found");
    }

    const doubles: any[] = [];
    for (let i = 0; i < numGameweeks; i++) {
      const gwId = currentGW.id + i;
      const gwFixtures = fixtures.filter((f: any) => f.event === gwId);

      const teamCounts: any = {};
      gwFixtures.forEach((f: any) => {
        teamCounts[f.team_h] = (teamCounts[f.team_h] || 0) + 1;
        teamCounts[f.team_a] = (teamCounts[f.team_a] || 0) + 1;
      });

      const teamsWithDouble = Object.entries(teamCounts)
        .filter(([_, count]) => (count as number) >= 2)
        .map(([teamId]) => teams[parseInt(teamId)].name);

      if (teamsWithDouble.length > 0) {
        doubles.push({
          gameweek: gwId,
          teams: teamsWithDouble,
          count: teamsWithDouble.length,
        });
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ double_gameweeks: doubles }, null, 2) }],
    };
  } catch (error: any) {
    throw new Error(`Failed to get double gameweeks: ${error.message}`);
  }
}

/**
 * Tool: Analyze fixtures (FIX: Bug #11, #12, #13 - Add player/position support)
 */
async function analyzeFixtures(args: any, env: Env): Promise<any> {
  try {
    const entityType = args.entity_type || "team";
    const entityName = args.entity_name;
    const numGameweeks = args.num_gameweeks || 5;
    const includeBlanks = args.include_blanks || false;
    const includeDoubles = args.include_doubles || false;

    if (!entityName) {
      throw new Error("entity_name is required");
    }

    const data = await fetchFPL("bootstrap-static/");
    const fixtures = await fetchFPL("fixtures/");
    const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});
    const players = data.elements;

    const currentGW = data.events.find((e: any) => e.is_current);
    if (!currentGW) {
      throw new Error("No current gameweek found");
    }

    const result: any = {
      entity_type: entityType,
      entity_name: entityName,
      current_gameweek: currentGW.id,
      analysis_range: Array.from({ length: numGameweeks }, (_, i) => currentGW.id + i + 1),
    };

    if (entityType === "team") {
      const team = Object.values(teams).find((t: any) =>
        t.name.toLowerCase().includes(entityName.toLowerCase())
      );
      if (!team) {
        throw new Error(`Team not found: ${entityName}`);
      }

      const teamId = (team as any).id;
      const teamFixtures = fixtures
        .filter((f: any) => !f.finished && (f.team_h === teamId || f.team_a === teamId))
        .filter((f: any) => f.event && f.event > currentGW.id && f.event <= currentGW.id + numGameweeks);

      const fixtureList = teamFixtures.map((f: any) => {
        const isHome = f.team_h === teamId;
        const opponentId = isHome ? f.team_a : f.team_h;
        return {
          gameweek: f.event,
          opponent: teams[opponentId].name,
          location: isHome ? "Home" : "Away",
          difficulty: isHome ? f.team_h_difficulty : f.team_a_difficulty,
        };
      });

      const avgDiff = fixtureList.length > 0
        ? fixtureList.reduce((sum: number, f: any) => sum + f.difficulty, 0) / fixtureList.length
        : 3;

      result.entity = { type: "team", name: (team as any).name };
      result.fixtures = fixtureList;
      result.average_difficulty = Math.round(avgDiff * 100) / 100;
      result.fixture_score = Math.round((6 - avgDiff) * 2 * 10) / 10;
      result.rating = avgDiff <= 2 ? "Excellent" : avgDiff <= 3 ? "Good" : avgDiff <= 4 ? "Average" : "Difficult";

    } else if (entityType === "player") {
      const player = players.find((p: any) =>
        p.web_name.toLowerCase().includes(entityName.toLowerCase())
      );
      if (!player) {
        throw new Error(`Player not found: ${entityName}`);
      }

      const teamId = player.team;
      const playerFixtures = fixtures
        .filter((f: any) => !f.finished && (f.team_h === teamId || f.team_a === teamId))
        .filter((f: any) => f.event && f.event > currentGW.id && f.event <= currentGW.id + numGameweeks);

      const fixtureList = playerFixtures.map((f: any) => {
        const isHome = f.team_h === teamId;
        const opponentId = isHome ? f.team_a : f.team_h;
        return {
          gameweek: f.event,
          opponent: teams[opponentId].name,
          location: isHome ? "Home" : "Away",
          difficulty: isHome ? f.team_h_difficulty : f.team_a_difficulty,
        };
      });

      const avgDiff = fixtureList.length > 0
        ? fixtureList.reduce((sum: number, f: any) => sum + f.difficulty, 0) / fixtureList.length
        : 3;

      result.player = {
        name: player.web_name,
        team: teams[teamId].name,
        position: ["GKP", "DEF", "MID", "FWD"][player.element_type - 1],
      };
      result.fixtures = fixtureList;
      result.average_difficulty = Math.round(avgDiff * 100) / 100;
      result.fixture_score = Math.round((6 - avgDiff) * 2 * 10) / 10;
      result.rating = avgDiff <= 2 ? "Excellent" : avgDiff <= 3 ? "Good" : avgDiff <= 4 ? "Average" : "Difficult";

    } else if (entityType === "position") {
      const posMap: Record<string, string> = {
        "GOALKEEPER": "GKP", "DEFENDER": "DEF", "MIDFIELDER": "MID", "FORWARD": "FWD",
        "GKP": "GKP", "DEF": "DEF", "MID": "MID", "FWD": "FWD"
      };
      const normalizedPos = posMap[entityName.toUpperCase()];

      if (!normalizedPos) {
        throw new Error(`Invalid position: ${entityName}. Use GKP/DEF/MID/FWD`);
      }

      const teamsByFixtures: any = {};
      for (const [teamId, team] of Object.entries(teams)) {
        const id = parseInt(teamId);
        const teamFixtures = fixtures
          .filter((f: any) => !f.finished && (f.team_h === id || f.team_a === id))
          .filter((f: any) => f.event && f.event > currentGW.id && f.event <= currentGW.id + numGameweeks);

        const fixtureList = teamFixtures.map((f: any) => {
          const isHome = f.team_h === id;
          const opponentId = isHome ? f.team_a : f.team_h;
          return {
            gameweek: f.event,
            opponent: teams[opponentId].name,
            location: isHome ? "Home" : "Away",
            difficulty: isHome ? f.team_h_difficulty : f.team_a_difficulty,
          };
        });

        if (fixtureList.length > 0) {
          const totalDiff = fixtureList.reduce((sum: number, f: any) => sum + f.difficulty, 0);
          const avgDiff = totalDiff / fixtureList.length;
          teamsByFixtures[(team as any).name] = {
            fixtures: fixtureList,
            average_difficulty: Math.round(avgDiff * 100) / 100,
            fixture_score: Math.round((6 - avgDiff) * 2 * 10) / 10,
          };
        }
      }

      const sortedTeams = Object.entries(teamsByFixtures).sort((a: any, b: any) =>
        b[1].fixture_score - a[1].fixture_score
      );

      result.position = normalizedPos;
      result.team_fixtures = Object.fromEntries(sortedTeams.slice(0, 10));
      result.best_fixtures = sortedTeams.slice(0, 3).map(([name]) => name);

    } else {
      throw new Error(`Invalid entity_type: ${entityType}. Use 'player', 'team', or 'position'`);
    }

    // Add blank/double gameweek info if requested
    if (includeBlanks) {
      const blankData = await getBlankGameweeks(numGameweeks);
      const blankContent = JSON.parse(blankData.content[0].text);
      result.blank_gameweeks = blankContent.blank_gameweeks || [];
    }

    if (includeDoubles) {
      const doubleData = await getDoubleGameweeks(numGameweeks);
      const doubleContent = JSON.parse(doubleData.content[0].text);
      result.double_gameweeks = doubleContent.double_gameweeks || [];
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error: any) {
    throw new Error(`Fixture analysis failed: ${error.message}`);
  }
}

/**
 * Tool: Get my team (FIX: Bug #14, #15, #16, #17 - Full squad with all details)
 */
async function getMyTeam(env: Env, gameweek?: number): Promise<any> {
  try {
    if (!env.FPL_TEAM_ID) {
      throw new Error("FPL_TEAM_ID not configured");
    }

    // Get player data for enrichment
    const data = await fetchFPL("bootstrap-static/");
    const players = data.elements.reduce((acc: any, p: any) => ({ ...acc, [p.id]: p }), {});
    const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

    // If no gameweek specified, get current gameweek number
    let gwNumber = gameweek;
    if (!gwNumber) {
      const currentGW = data.events.find((e: any) => e.is_current);
      gwNumber = currentGW ? currentGW.id : 1;
    }

    const picks = await authenticatedFetch(`entry/${env.FPL_TEAM_ID}/event/${gwNumber}/picks/`, env);

    // Format each player with full details
    const formattedPicks = picks.picks?.map((pick: any) => {
      const player = players[pick.element];
      if (!player) return null;

      const team = teams[player.team];
      return {
        id: player.id,
        position_order: pick.position,
        multiplier: pick.multiplier || 0,
        is_captain: pick.is_captain || false,
        is_vice_captain: pick.is_vice_captain || false,

        // Player details
        web_name: player.web_name,
        full_name: `${player.first_name} ${player.second_name}`,
        price: player.now_cost / 10,
        form: player.form,
        total_points: player.total_points,
        minutes: player.minutes,
        goals: player.goals_scored,
        assists: player.assists,
        clean_sheets: player.clean_sheets,
        bonus: player.bonus,

        // Team details
        team: team.name,
        team_short: team.short_name,
        position: ["GKP", "DEF", "MID", "FWD"][player.element_type - 1],
      };
    }).filter((p: any) => p !== null);

    // Sort by position order
    formattedPicks.sort((a: any, b: any) => a.position_order - b.position_order);

    // Split into active (playing 11) and bench (4 players)
    const active = formattedPicks.filter((p: any) => p.multiplier > 0);
    const bench = formattedPicks.filter((p: any) => p.multiplier === 0);

    const captain = formattedPicks.find((p: any) => p.is_captain);
    const viceCaptain = formattedPicks.find((p: any) => p.is_vice_captain);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          gameweek: gwNumber,
          team_id: parseInt(env.FPL_TEAM_ID),
          active,
          bench,
          captain,
          vice_captain: viceCaptain,
          points: picks.entry_history?.points || 0,
          total_points: picks.entry_history?.total_points || 0,
          rank: picks.entry_history?.overall_rank || 0,
          bank: (picks.entry_history?.bank || 0) / 10,
          team_value: (picks.entry_history?.value || 0) / 10,
          transfers_made: picks.entry_history?.event_transfers || 0,
          transfers_cost: picks.entry_history?.event_transfers_cost || 0,
        }, null, 2),
      }],
    };
  } catch (error: any) {
    throw new Error(`Failed to get my team: ${error.message}`);
  }
}

/**
 * Tool: Get team (FIX: Bug #14, #15, #16, #17 - Full squad with all details)
 */
async function getTeam(env: Env, teamId: number, gameweek?: number): Promise<any> {
  try {
    // Get player data for enrichment
    const data = await fetchFPL("bootstrap-static/");
    const players = data.elements.reduce((acc: any, p: any) => ({ ...acc, [p.id]: p }), {});
    const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

    // If no gameweek specified, get current gameweek number
    let gwNumber = gameweek;
    if (!gwNumber) {
      const currentGW = data.events.find((e: any) => e.is_current);
      gwNumber = currentGW ? currentGW.id : 1;
    }

    const picks = await authenticatedFetch(`entry/${teamId}/event/${gwNumber}/picks/`, env);

    // Format each player with full details (same logic as getMyTeam)
    const formattedPicks = picks.picks?.map((pick: any) => {
      const player = players[pick.element];
      if (!player) return null;

      const team = teams[player.team];
      return {
        id: player.id,
        position_order: pick.position,
        multiplier: pick.multiplier || 0,
        is_captain: pick.is_captain || false,
        is_vice_captain: pick.is_vice_captain || false,
        web_name: player.web_name,
        full_name: `${player.first_name} ${player.second_name}`,
        price: player.now_cost / 10,
        form: player.form,
        total_points: player.total_points,
        minutes: player.minutes,
        goals: player.goals_scored,
        assists: player.assists,
        clean_sheets: player.clean_sheets,
        bonus: player.bonus,
        team: team.name,
        team_short: team.short_name,
        position: ["GKP", "DEF", "MID", "FWD"][player.element_type - 1],
      };
    }).filter((p: any) => p !== null);

    formattedPicks.sort((a: any, b: any) => a.position_order - b.position_order);

    const active = formattedPicks.filter((p: any) => p.multiplier > 0);
    const bench = formattedPicks.filter((p: any) => p.multiplier === 0);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          gameweek: gwNumber,
          team_id: teamId,
          active,
          bench,
          captain: formattedPicks.find((p: any) => p.is_captain),
          vice_captain: formattedPicks.find((p: any) => p.is_vice_captain),
          points: picks.entry_history?.points || 0,
          total_points: picks.entry_history?.total_points || 0,
          rank: picks.entry_history?.overall_rank || 0,
          bank: (picks.entry_history?.bank || 0) / 10,
          team_value: (picks.entry_history?.value || 0) / 10,
          transfers_made: picks.entry_history?.event_transfers || 0,
          transfers_cost: picks.entry_history?.event_transfers_cost || 0,
        }, null, 2),
      }],
    };
  } catch (error: any) {
    throw new Error(`Failed to get team: ${error.message}`);
  }
}

/**
 * Tool: Get manager info (FIX: Use public endpoint - Bug #28)
 */
async function getManagerInfo(env: Env, teamId?: number): Promise<any> {
  try {
    const id = teamId || (env.FPL_TEAM_ID ? parseInt(env.FPL_TEAM_ID) : null);
    if (!id) {
      throw new Error("Team ID required");
    }

    // FIX: Use fetchFPL for public endpoint instead of authenticatedFetch
    const managerData = await fetchFPL(`entry/${id}/`, false);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          team_id: id,
          manager_name: `${managerData.player_first_name} ${managerData.player_last_name}`,
          team_name: managerData.name,
          region: managerData.player_region_name,
          started_event: managerData.started_event,
          overall_rank: managerData.summary_overall_rank,
          overall_points: managerData.summary_overall_points,
        }, null, 2),
      }],
    };
  } catch (error: any) {
    throw new Error(`Failed to get manager info: ${error.message}`);
  }
}

/**
 * Tool: Get team history
 */
async function getTeamHistory(env: Env, teamId?: number, numGameweeks = 5): Promise<any> {
  try {
    const id = teamId || (env.FPL_TEAM_ID ? parseInt(env.FPL_TEAM_ID) : null);
    if (!id) {
      throw new Error("Team ID required");
    }

    const history = await authenticatedFetch(`entry/${id}/history/`, env);
    const recent = history.current?.slice(-numGameweeks) || [];

    const results = recent.map((gw: any) => ({
      gameweek: gw.event,
      points: gw.points,
      total_points: gw.total_points,
      rank: gw.overall_rank,
      value: gw.value / 10,
      bank: gw.bank / 10,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ team_id: id, history: results }, null, 2),
      }],
    };
  } catch (error: any) {
    throw new Error(`Failed to get team history: ${error.message}`);
  }
}

/**
 * Tool: Get league standings (FIX: Use public endpoint - Bug #29)
 */
async function getLeagueStandings(env: Env, leagueId: number): Promise<any> {
  try {
    // FIX: Use fetchFPL for public endpoint
    const league = await fetchFPL(`leagues-classic/${leagueId}/standings/`, false);
    const standings = league.standings?.results || [];

    const results = standings.slice(0, 25).map((s: any) => ({
      rank: s.rank,
      team_name: s.entry_name,
      manager: s.player_name,
      total_points: s.total,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          league_name: league.league?.name,
          total_teams: standings.length,
          standings: results,
        }, null, 2),
      }],
    };
  } catch (error: any) {
    throw new Error(`Failed to get league standings: ${error.message}`);
  }
}

/**
 * Tool: Check authentication (FIX: Use correct endpoint - Bug #30)
 */
async function checkFPLAuthentication(env: Env): Promise<any> {
  try {
    if (!env.FPL_EMAIL || !env.FPL_PASSWORD) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: false,
            message: "Credentials not configured",
            missing: [
              ...(!env.FPL_EMAIL ? ["FPL_EMAIL"] : []),
              ...(!env.FPL_PASSWORD ? ["FPL_PASSWORD"] : []),
              ...(!env.FPL_TEAM_ID ? ["FPL_TEAM_ID"] : []),
            ],
          }, null, 2),
        }],
      };
    }

    // FIX: Use entry endpoint instead of "me/"
    const team = await authenticatedFetch(`entry/${env.FPL_TEAM_ID}/`, env);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          authenticated: true,
          team_name: team.name,
          manager: `${team.player_first_name} ${team.player_last_name}`,
          team_id: env.FPL_TEAM_ID,
          overall_rank: team.summary_overall_rank,
          overall_points: team.summary_overall_points,
        }, null, 2),
      }],
    };
  } catch (error: any) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          authenticated: false,
          error: error.message,
        }, null, 2),
      }],
    };
  }
}

/**
 * Tool: Get team statistics (NEW)
 */
async function getTeamStatistics(teamName: string, numGameweeks = 5): Promise<any> {
  try {
    if (!teamName) {
      throw new Error("team_name is required");
    }

    // Fetch teams and fixtures
    const data = await fetchFPL("bootstrap-static/");
    const fixtures = await fetchFPL("fixtures/");
    const teams = data.teams;

    // Find the team
    const team = teams.find((t: any) =>
      t.name.toLowerCase().includes(teamName.toLowerCase())
    );

    if (!team) {
      throw new Error(`Team not found: ${teamName}`);
    }

    const teamId = team.id;

    // Get all finished fixtures for this team
    const teamFixtures = fixtures.filter((f: any) =>
      f.finished && (f.team_h === teamId || f.team_a === teamId)
    );

    if (teamFixtures.length === 0) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            team: team.name,
            message: "No finished fixtures found for this team yet",
          }, null, 2),
        }],
      };
    }

    // Sort by gameweek
    teamFixtures.sort((a: any, b: any) => a.event - b.event);

    // Calculate season stats
    const seasonStats = {
      games_played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goals_for: 0,
      goals_against: 0,
      clean_sheets: 0,
      goals_per_game: 0,
      goals_against_per_game: 0,
      home: { played: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0 },
      away: { played: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0 },
    };

    // Calculate recent form stats
    const recentFixtures = teamFixtures.slice(-numGameweeks);
    const formStats = {
      games_played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goals_for: 0,
      goals_against: 0,
      clean_sheets: 0,
      form_string: "", // e.g., "WWDLW"
    };

    // Process all fixtures for season stats
    teamFixtures.forEach((fixture: any) => {
      const isHome = fixture.team_h === teamId;
      const goalsFor = isHome ? fixture.team_h_score : fixture.team_a_score;
      const goalsAgainst = isHome ? fixture.team_a_score : fixture.team_h_score;

      seasonStats.games_played++;
      seasonStats.goals_for += goalsFor;
      seasonStats.goals_against += goalsAgainst;

      if (goalsAgainst === 0) seasonStats.clean_sheets++;

      if (goalsFor > goalsAgainst) {
        seasonStats.wins++;
      } else if (goalsFor === goalsAgainst) {
        seasonStats.draws++;
      } else {
        seasonStats.losses++;
      }

      // Home/Away breakdown
      if (isHome) {
        seasonStats.home.played++;
        seasonStats.home.goals_for += goalsFor;
        seasonStats.home.goals_against += goalsAgainst;
        if (goalsFor > goalsAgainst) seasonStats.home.wins++;
        else if (goalsFor === goalsAgainst) seasonStats.home.draws++;
        else seasonStats.home.losses++;
      } else {
        seasonStats.away.played++;
        seasonStats.away.goals_for += goalsFor;
        seasonStats.away.goals_against += goalsAgainst;
        if (goalsFor > goalsAgainst) seasonStats.away.wins++;
        else if (goalsFor === goalsAgainst) seasonStats.away.draws++;
        else seasonStats.away.losses++;
      }
    });

    // Calculate averages
    seasonStats.goals_per_game = Math.round((seasonStats.goals_for / seasonStats.games_played) * 100) / 100;
    seasonStats.goals_against_per_game = Math.round((seasonStats.goals_against / seasonStats.games_played) * 100) / 100;

    // Process recent fixtures for form
    const formLetters: string[] = [];
    recentFixtures.forEach((fixture: any) => {
      const isHome = fixture.team_h === teamId;
      const goalsFor = isHome ? fixture.team_h_score : fixture.team_a_score;
      const goalsAgainst = isHome ? fixture.team_a_score : fixture.team_h_score;

      formStats.games_played++;
      formStats.goals_for += goalsFor;
      formStats.goals_against += goalsAgainst;

      if (goalsAgainst === 0) formStats.clean_sheets++;

      if (goalsFor > goalsAgainst) {
        formStats.wins++;
        formLetters.push("W");
      } else if (goalsFor === goalsAgainst) {
        formStats.draws++;
        formLetters.push("D");
      } else {
        formStats.losses++;
        formLetters.push("L");
      }
    });

    formStats.form_string = formLetters.join("");

    // Get recent results details
    const recentResults = recentFixtures.map((f: any) => {
      const isHome = f.team_h === teamId;
      const opponent = teams.find((t: any) => t.id === (isHome ? f.team_a : f.team_h));
      const goalsFor = isHome ? f.team_h_score : f.team_a_score;
      const goalsAgainst = isHome ? f.team_a_score : f.team_h_score;
      const result = goalsFor > goalsAgainst ? "W" : goalsFor === goalsAgainst ? "D" : "L";

      return {
        gameweek: f.event,
        opponent: opponent?.name || "Unknown",
        location: isHome ? "H" : "A",
        score: `${goalsFor}-${goalsAgainst}`,
        result,
      };
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          team: team.name,
          season_statistics: {
            games_played: seasonStats.games_played,
            record: {
              wins: seasonStats.wins,
              draws: seasonStats.draws,
              losses: seasonStats.losses,
              win_percentage: Math.round((seasonStats.wins / seasonStats.games_played) * 100),
            },
            goals: {
              for: seasonStats.goals_for,
              against: seasonStats.goals_against,
              difference: seasonStats.goals_for - seasonStats.goals_against,
              per_game: seasonStats.goals_per_game,
              against_per_game: seasonStats.goals_against_per_game,
            },
            clean_sheets: seasonStats.clean_sheets,
            home_record: {
              played: seasonStats.home.played,
              wins: seasonStats.home.wins,
              draws: seasonStats.home.draws,
              losses: seasonStats.home.losses,
              goals_for: seasonStats.home.goals_for,
              goals_against: seasonStats.home.goals_against,
            },
            away_record: {
              played: seasonStats.away.played,
              wins: seasonStats.away.wins,
              draws: seasonStats.away.draws,
              losses: seasonStats.away.losses,
              goals_for: seasonStats.away.goals_for,
              goals_against: seasonStats.away.goals_against,
            },
          },
          recent_form: {
            last_n_games: formStats.games_played,
            form: formStats.form_string,
            record: {
              wins: formStats.wins,
              draws: formStats.draws,
              losses: formStats.losses,
            },
            goals: {
              for: formStats.goals_for,
              against: formStats.goals_against,
            },
            clean_sheets: formStats.clean_sheets,
            results: recentResults,
          },
        }, null, 2),
      }],
    };
  } catch (error: any) {
    throw new Error(`Failed to get team statistics: ${error.message}`);
  }
}

/**
 * Helper: JSON response with CORS headers
 */
function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/**
 * Handle SSE endpoint (Server-Sent Events for Claude.ai)
 */
async function handleSSE(request: Request, env: Env): Promise<Response> {
  // For POST requests, handle MCP messages
  if (request.method === "POST") {
    return handleMCP(request, env);
  }

  // For GET requests, establish SSE connection
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Send SSE data helper
  const sendEvent = async (event: string, data: any) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await writer.write(encoder.encode(message));
  };

  // Start the SSE stream
  (async () => {
    try {
      // Send endpoint event (tells client where to send messages)
      await sendEvent("endpoint", { url: new URL("/sse", request.url).href });

      // Send server capabilities on connection
      await sendEvent("message", {
        jsonrpc: "2.0",
        method: "server/initialized",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {
            resources: {},
            tools: {},
          },
          serverInfo: {
            name: "Fantasy Premier League",
            version: "1.0.0",
          },
        },
      });

      // Keep connection alive with periodic pings
      const keepAlive = setInterval(async () => {
        try {
          await writer.write(encoder.encode(": ping\n\n"));
        } catch (e) {
          clearInterval(keepAlive);
        }
      }, 30000);

      // Wait for client to close connection
      await new Promise(() => {});
    } catch (error) {
      console.error("SSE error:", error);
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/**
 * Pages Functions Middleware - handles all routes
 */
export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Handle SSE endpoint (for Claude.ai custom connectors)
  if (url.pathname === "/sse") {
    return handleSSE(request, env);
  }

  // Handle MCP endpoint (for regular HTTP MCP clients)
  if (url.pathname === "/mcp" && request.method === "POST") {
    return handleMCP(request, env);
  }

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response("FPL MCP Server - Cloudflare Pages Edition ✓ (All bugs fixed)", {
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Continue to next middleware/page if exists
  return new Response("Not Found", { status: 404 });
};
