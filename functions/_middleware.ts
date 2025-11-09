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
    const { method, params } = body;

    // Handle MCP methods
    switch (method) {
      case "initialize":
        return jsonResponse({
          protocolVersion: "2024-11-05",
          capabilities: {
            resources: {},
            tools: {},
          },
          serverInfo: {
            name: "Fantasy Premier League",
            version: "1.0.0",
          },
        });

      case "resources/list":
        return jsonResponse({
          resources: [
            { uri: "fpl://static/players", name: "All FPL Players", mimeType: "application/json" },
            { uri: "fpl://static/teams", name: "All Premier League Teams", mimeType: "application/json" },
            { uri: "fpl://gameweeks/current", name: "Current Gameweek", mimeType: "application/json" },
            { uri: "fpl://gameweeks/all", name: "All Gameweeks", mimeType: "application/json" },
            { uri: "fpl://fixtures", name: "All Fixtures", mimeType: "application/json" },
            { uri: "fpl://gameweeks/blank", name: "Blank Gameweeks", mimeType: "application/json" },
            { uri: "fpl://gameweeks/double", name: "Double Gameweeks", mimeType: "application/json" },
          ],
        });

      case "resources/read":
        return await handleResourceRead(params.uri, env);

      case "tools/list":
        return jsonResponse({
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
              name: "get_gameweek_status",
              description: "Get current gameweek information",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "get_my_team_details",
              description: "Get your FPL team details (requires auth)",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });

      case "tools/call":
        return await handleToolCall(params.name, params.arguments || {}, env);

      default:
        return jsonResponse({ error: "Method not supported" }, 400);
    }
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * Handle resource read requests
 */
async function handleResourceRead(uri: string, env: Env): Promise<Response> {
  const data = await fetchFPL("bootstrap-static/");

  switch (uri) {
    case "fpl://static/players":
      return jsonResponse({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(data.elements, null, 2),
          },
        ],
      });

    case "fpl://static/teams":
      return jsonResponse({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(data.teams, null, 2),
          },
        ],
      });

    case "fpl://gameweeks/current":
      const currentGW = data.events.find((e: any) => e.is_current);
      return jsonResponse({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(currentGW, null, 2),
          },
        ],
      });

    case "fpl://gameweeks/all":
      return jsonResponse({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(data.events, null, 2),
          },
        ],
      });

    case "fpl://fixtures":
      const fixtures = await fetchFPL("fixtures/");
      return jsonResponse({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(fixtures, null, 2),
          },
        ],
      });

    case "fpl://gameweeks/blank":
      const blankGWs = data.events.filter((e: any) => e.chip_plays?.length === 0);
      return jsonResponse({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(blankGWs, null, 2),
          },
        ],
      });

    case "fpl://gameweeks/double":
      const doubleGWs = data.events.filter((e: any) => e.chip_plays?.some((c: any) => c.chip_name === "bboost"));
      return jsonResponse({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(doubleGWs, null, 2),
          },
        ],
      });

    default:
      return jsonResponse({ error: "Resource not found" }, 404);
  }
}

/**
 * Handle tool call requests
 */
async function handleToolCall(toolName: string, args: any, env: Env): Promise<Response> {
  switch (toolName) {
    case "search_player":
      return await searchPlayer(args.query);

    case "get_gameweek_status":
      return await getGameweekStatus();

    case "get_my_team_details":
      return await getMyTeamDetails(env);

    default:
      return jsonResponse({ error: "Tool not found" }, 404);
  }
}

/**
 * Tool: Search for players
 */
async function searchPlayer(query: string): Promise<Response> {
  const data = await fetchFPL("bootstrap-static/");
  const players = data.elements;

  const results = players.filter((p: any) =>
    p.web_name.toLowerCase().includes(query.toLowerCase()) ||
    p.first_name.toLowerCase().includes(query.toLowerCase()) ||
    p.second_name.toLowerCase().includes(query.toLowerCase())
  );

  return jsonResponse({
    content: [
      {
        type: "text",
        text: JSON.stringify(results.slice(0, 10), null, 2),
      },
    ],
  });
}

/**
 * Tool: Get gameweek status
 */
async function getGameweekStatus(): Promise<Response> {
  const data = await fetchFPL("bootstrap-static/");
  const current = data.events.find((e: any) => e.is_current);
  const next = data.events.find((e: any) => e.is_next);

  return jsonResponse({
    content: [
      {
        type: "text",
        text: JSON.stringify({ current, next }, null, 2),
      },
    ],
  });
}

/**
 * Tool: Get my team details (authenticated)
 */
async function getMyTeamDetails(env: Env): Promise<Response> {
  if (!env.FPL_TEAM_ID) {
    return jsonResponse({ error: "FPL_TEAM_ID not configured" }, 400);
  }

  const teamData = await authenticatedFetch(`entry/${env.FPL_TEAM_ID}/`, env);

  return jsonResponse({
    content: [
      {
        type: "text",
        text: JSON.stringify(teamData, null, 2),
      },
    ],
  });
}

/**
 * Helper: JSON response
 */
function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Pages Functions Middleware - handles all routes
 */
export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  // Handle MCP endpoint
  if (url.pathname === "/mcp" && request.method === "POST") {
    return handleMCP(request, env);
  }

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    return new Response("FPL MCP Server - Cloudflare Pages Edition ✓", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Continue to next middleware/page if exists
  return new Response("Not Found", { status: 404 });
};
