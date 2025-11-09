/**
 * Fantasy Premier League MCP Server - Cloudflare Pages Edition
 * Middleware to handle all routes
 */

interface Env {
  FPL_EMAIL: string;
  FPL_PASSWORD: string;
  FPL_TEAM_ID: string;
}

const FPL_API = "https://fantasy.premierleague.com/api";
const FPL_LOGIN = "https://users.premierleague.com/accounts/login/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// Simple in-memory cache (resets on worker restart)
const cache = new Map<string, { timestamp: number; data: any }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

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
 * Authenticate with FPL and fetch protected endpoints
 */
async function authenticatedFetch(endpoint: string, env: Env): Promise<any> {
  if (!env.FPL_EMAIL || !env.FPL_PASSWORD) {
    throw new Error("FPL credentials not configured");
  }

  // Get login page to get CSRF token
  const loginPage = await fetch(FPL_LOGIN, {
    headers: { "User-Agent": USER_AGENT },
  });

  const cookies = loginPage.headers.get("set-cookie") || "";
  const csrfMatch = cookies.match(/csrftoken=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";

  // Login
  const loginResponse = await fetch(FPL_LOGIN, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookies,
      "Referer": FPL_LOGIN,
    },
    body: new URLSearchParams({
      login: env.FPL_EMAIL,
      password: env.FPL_PASSWORD,
      csrfmiddlewaretoken: csrfToken,
      app: "plfpl-web",
      redirect_uri: "https://fantasy.premierleague.com/",
    }),
  });

  if (!loginResponse.ok) {
    throw new Error("Authentication failed");
  }

  const sessionCookie = loginResponse.headers.get("set-cookie") || "";

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

    // Log incoming requests for debugging
    console.log("MCP Request:", { method, params, id });

    // Handle notifications (no response needed)
    if (method?.startsWith("notifications/")) {
      console.log("Received notification:", method);
      return new Response(null, { status: 204 }); // No Content
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
                description: "Search for players by name",
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
                description: "Compare multiple players across various metrics",
                inputSchema: {
                  type: "object",
                  properties: {
                    player_names: { type: "array", items: { type: "string" }, description: "2-5 player names" },
                    include_fixtures: { type: "boolean", description: "Include fixture analysis" },
                  },
                  required: ["player_names"],
                },
              },
              {
                name: "analyze_players",
                description: "Filter and analyze players by position, team, price, form, etc.",
                inputSchema: {
                  type: "object",
                  properties: {
                    position: { type: "string", description: "Position (GKP/DEF/MID/FWD)" },
                    team: { type: "string", description: "Team name" },
                    min_price: { type: "number", description: "Minimum price" },
                    max_price: { type: "number", description: "Maximum price" },
                    sort_by: { type: "string", description: "Sort by metric" },
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
                description: "Identify upcoming blank gameweeks and affected teams",
                inputSchema: {
                  type: "object",
                  properties: {
                    num_gameweeks: { type: "number", description: "Number to check (default 5)" },
                  },
                },
              },
              {
                name: "get_double_gameweeks",
                description: "Identify upcoming double gameweeks and teams playing twice",
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
                    team: { type: "string", description: "Team name" },
                    num_fixtures: { type: "number", description: "Number of fixtures (default 5)" },
                  },
                },
              },
              {
                name: "get_my_team",
                description: "Get your FPL team for a specific gameweek (requires auth)",
                inputSchema: {
                  type: "object",
                  properties: {
                    gameweek: { type: "number", description: "Gameweek number (optional)" },
                  },
                },
              },
              {
                name: "get_team",
                description: "Get any FPL team by ID (requires auth)",
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
                description: "Get manager profile and league information (requires auth)",
                inputSchema: {
                  type: "object",
                  properties: {
                    team_id: { type: "number", description: "FPL team ID (optional)" },
                  },
                },
              },
              {
                name: "get_team_history",
                description: "Get historical performance over gameweeks (requires auth)",
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
                description: "Get league standings and rankings (requires auth)",
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
 * Handle resource read requests
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
      const blankGWs = data.events.filter((e: any) => e.chip_plays?.length === 0);
      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(blankGWs, null, 2),
          },
        ],
      };
      break;

    case "fpl://gameweeks/double":
      const doubleGWs = data.events.filter((e: any) => e.chip_plays?.some((c: any) => c.chip_name === "bboost"));
      result = {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(doubleGWs, null, 2),
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
 * Handle tool call requests
 */
async function handleToolCall(toolName: string, args: any, env: Env, id: any): Promise<Response> {
  let result;

  try {
    switch (toolName) {
      case "search_player":
        result = await searchPlayer(args.query);
        break;

      case "compare_players":
        result = await comparePlayers(args.player_names, args.include_fixtures);
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
        result = await analyzeFixtures(args.team, args.num_fixtures || 5);
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

      case "get_my_team_details":
        result = await getMyTeamDetails(env);
        break;

      default:
        return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: "Tool not found" } }, 404);
    }

    return jsonResponse({ jsonrpc: "2.0", id, result });
  } catch (error: any) {
    return jsonResponse({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } }, 500);
  }
}

/**
 * Tool: Search for players
 */
async function searchPlayer(query: string): Promise<any> {
  const data = await fetchFPL("bootstrap-static/");
  const players = data.elements;

  const results = players.filter((p: any) =>
    p.web_name.toLowerCase().includes(query.toLowerCase()) ||
    p.first_name.toLowerCase().includes(query.toLowerCase()) ||
    p.second_name.toLowerCase().includes(query.toLowerCase())
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(results.slice(0, 10), null, 2),
      },
    ],
  };
}

/**
 * Tool: Get gameweek status
 */
async function getGameweekStatus(): Promise<any> {
  const data = await fetchFPL("bootstrap-static/");
  const current = data.events.find((e: any) => e.is_current);
  const next = data.events.find((e: any) => e.is_next);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ current, next }, null, 2),
      },
    ],
  };
}

/**
 * Tool: Get my team details (authenticated)
 */
async function getMyTeamDetails(env: Env): Promise<any> {
  if (!env.FPL_TEAM_ID) {
    throw new Error("FPL_TEAM_ID not configured");
  }

  const teamData = await authenticatedFetch(`entry/${env.FPL_TEAM_ID}/`, env);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(teamData, null, 2),
      },
    ],
  };
}

/**
 * Tool: Compare players
 */
async function comparePlayers(playerNames: string[], includeFixtures = true): Promise<any> {
  if (!playerNames || playerNames.length < 2) {
    throw new Error("Please provide at least 2 player names");
  }
  if (playerNames.length > 5) {
    throw new Error("Maximum 5 players can be compared");
  }

  const data = await fetchFPL("bootstrap-static/");
  const players = data.elements;
  const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

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

  const comparison = foundPlayers.map((p: any) => ({
    name: p.web_name,
    team: teams[p.team].name,
    position: ["GKP", "DEF", "MID", "FWD"][p.element_type - 1],
    price: p.now_cost / 10,
    total_points: p.total_points,
    form: p.form,
    points_per_game: p.points_per_game,
    goals: p.goals_scored,
    assists: p.assists,
    ownership: `${p.selected_by_percent}%`,
  }));

  return {
    content: [{ type: "text", text: JSON.stringify({ comparison }, null, 2) }],
  };
}

/**
 * Tool: Analyze players
 */
async function analyzePlayers(args: any): Promise<any> {
  const data = await fetchFPL("bootstrap-static/");
  const players = data.elements;
  const teams = data.teams.reduce((acc: any, t: any) => ({ ...acc, [t.id]: t }), {});

  let filtered = players.filter((p: any) => {
    if (args.position) {
      const pos = ["GKP", "DEF", "MID", "FWD"][p.element_type - 1];
      if (pos !== args.position.toUpperCase()) return false;
    }
    if (args.team && !teams[p.team].name.toLowerCase().includes(args.team.toLowerCase())) {
      return false;
    }
    const price = p.now_cost / 10;
    if (args.min_price && price < args.min_price) return false;
    if (args.max_price && price > args.max_price) return false;
    return true;
  });

  const sortBy = args.sort_by || "total_points";
  filtered.sort((a: any, b: any) => (b[sortBy] || 0) - (a[sortBy] || 0));

  const limit = args.limit || 20;
  const results = filtered.slice(0, limit).map((p: any) => ({
    name: p.web_name,
    team: teams[p.team].name,
    position: ["GKP", "DEF", "MID", "FWD"][p.element_type - 1],
    price: p.now_cost / 10,
    total_points: p.total_points,
    form: p.form,
    ownership: `${p.selected_by_percent}%`,
  }));

  return {
    content: [{ type: "text", text: JSON.stringify({ total: filtered.length, players: results }, null, 2) }],
  };
}

/**
 * Tool: Analyze player fixtures
 */
async function analyzePlayerFixtures(playerName: string, numFixtures = 5): Promise<any> {
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
    .map((f: any) => ({
      opponent: teams[f.team_h === teamId ? f.team_a : f.team_h].name,
      home: f.team_h === teamId,
      difficulty: f.team_h === teamId ? f.team_h_difficulty : f.team_a_difficulty,
    }));

  return {
    content: [{ type: "text", text: JSON.stringify({ player: player.web_name, fixtures: upcoming }, null, 2) }],
  };
}

/**
 * Tool: Get blank gameweeks
 */
async function getBlankGameweeks(numGameweeks = 5): Promise<any> {
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
        teams_not_playing: teamsNotPlaying.map((t: any) => t.name),
      });
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ blank_gameweeks: blanks }, null, 2) }],
  };
}

/**
 * Tool: Get double gameweeks
 */
async function getDoubleGameweeks(numGameweeks = 5): Promise<any> {
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
      .filter(([_, count]) => (count as number) > 1)
      .map(([teamId]) => teams[parseInt(teamId)].name);

    if (teamsWithDouble.length > 0) {
      doubles.push({
        gameweek: gwId,
        teams_with_double: teamsWithDouble,
      });
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ double_gameweeks: doubles }, null, 2) }],
  };
}

/**
 * Tool: Analyze fixtures
 */
async function analyzeFixtures(team?: string, numFixtures = 5): Promise<any> {
  const data = await fetchFPL("bootstrap-static/");
  const fixtures = await fetchFPL("fixtures/");
  const teams = data.teams;

  if (!team) {
    throw new Error("Team name required");
  }

  const teamData = teams.find((t: any) =>
    t.name.toLowerCase().includes(team.toLowerCase())
  );
  if (!teamData) {
    throw new Error(`Team not found: ${team}`);
  }

  const teamFixtures = fixtures
    .filter((f: any) => !f.finished && (f.team_h === teamData.id || f.team_a === teamData.id))
    .slice(0, numFixtures)
    .map((f: any) => {
      const isHome = f.team_h === teamData.id;
      const opponent = teams.find((t: any) => t.id === (isHome ? f.team_a : f.team_h));
      return {
        opponent: opponent.name,
        home: isHome,
        difficulty: isHome ? f.team_h_difficulty : f.team_a_difficulty,
      };
    });

  return {
    content: [{ type: "text", text: JSON.stringify({ team: teamData.name, fixtures: teamFixtures }, null, 2) }],
  };
}

/**
 * Tool: Get my team
 */
async function getMyTeam(env: Env, gameweek?: number): Promise<any> {
  if (!env.FPL_TEAM_ID) {
    throw new Error("FPL_TEAM_ID not configured");
  }

  // If no gameweek specified, get current gameweek number
  let gwNumber = gameweek;
  if (!gwNumber) {
    const data = await fetchFPL("bootstrap-static/");
    const currentGW = data.events.find((e: any) => e.is_current);
    gwNumber = currentGW ? currentGW.id : 1;
  }

  const picks = await authenticatedFetch(`entry/${env.FPL_TEAM_ID}/event/${gwNumber}/picks/`, env);

  return {
    content: [{ type: "text", text: JSON.stringify(picks, null, 2) }],
  };
}

/**
 * Tool: Get team
 */
async function getTeam(env: Env, teamId: number, gameweek?: number): Promise<any> {
  // If no gameweek specified, get current gameweek number
  let gwNumber = gameweek;
  if (!gwNumber) {
    const data = await fetchFPL("bootstrap-static/");
    const currentGW = data.events.find((e: any) => e.is_current);
    gwNumber = currentGW ? currentGW.id : 1;
  }

  const picks = await authenticatedFetch(`entry/${teamId}/event/${gwNumber}/picks/`, env);

  return {
    content: [{ type: "text", text: JSON.stringify(picks, null, 2) }],
  };
}

/**
 * Tool: Get manager info
 */
async function getManagerInfo(env: Env, teamId?: number): Promise<any> {
  const id = teamId || env.FPL_TEAM_ID;
  if (!id) {
    throw new Error("Team ID required");
  }

  const managerData = await authenticatedFetch(`entry/${id}/`, env);

  return {
    content: [{ type: "text", text: JSON.stringify(managerData, null, 2) }],
  };
}

/**
 * Tool: Get team history
 */
async function getTeamHistory(env: Env, teamId?: number, numGameweeks = 5): Promise<any> {
  const id = teamId || env.FPL_TEAM_ID;
  if (!id) {
    throw new Error("Team ID required");
  }

  const history = await authenticatedFetch(`entry/${id}/history/`, env);
  const recent = history.current?.slice(-numGameweeks) || [];

  return {
    content: [{ type: "text", text: JSON.stringify({ history: recent }, null, 2) }],
  };
}

/**
 * Tool: Get league standings
 */
async function getLeagueStandings(env: Env, leagueId: number): Promise<any> {
  const standings = await authenticatedFetch(`leagues-classic/${leagueId}/standings/`, env);

  return {
    content: [{ type: "text", text: JSON.stringify(standings, null, 2) }],
  };
}

/**
 * Tool: Check authentication
 */
async function checkFPLAuthentication(env: Env): Promise<any> {
  if (!env.FPL_EMAIL || !env.FPL_PASSWORD) {
    return {
      content: [{ type: "text", text: JSON.stringify({ authenticated: false, message: "Credentials not configured" }, null, 2) }],
    };
  }

  try {
    await authenticatedFetch("me/", env);
    return {
      content: [{ type: "text", text: JSON.stringify({ authenticated: true }, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ authenticated: false, error: (error as Error).message }, null, 2) }],
    };
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
      }, 30000); // ping every 30 seconds

      // Wait for client to close connection
      await new Promise(() => {}); // Keep alive indefinitely
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
    return new Response("FPL MCP Server - Cloudflare Pages Edition ✓", {
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Continue to next middleware/page if exists
  return new Response("Not Found", { status: 404 });
};
