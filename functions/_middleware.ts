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

      case "get_gameweek_status":
        result = await getGameweekStatus();
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
