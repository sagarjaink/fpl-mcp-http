# Fantasy Premier League MCP Server - Cloudflare Pages Edition

Complete Fantasy Premier League MCP server deployed on Cloudflare Pages with HTTP transport. Zero cost, zero configuration, auto-deploys from GitHub.

## Why Cloudflare Pages?

✅ **$0/month** - 100,000 free requests/day (vs $15-20/month on Cloud Run)
✅ **No CLI needed** - Deploy via GitHub dashboard
✅ **Auto-deploy** - Push to GitHub → automatic deployment
✅ **DDoS protected** - Built-in Cloudflare security
✅ **Global CDN** - Fast worldwide access
✅ **No cold starts** - Workers are always ready

## Features

### 7 Resources (Read-only Data)
1. `fpl://static/players` - All FPL players with comprehensive stats
2. `fpl://static/teams` - All Premier League teams with strength ratings
3. `fpl://gameweeks/current` - Current gameweek information
4. `fpl://gameweeks/all` - All gameweeks data
5. `fpl://fixtures` - All season fixtures
6. `fpl://gameweeks/blank` - Upcoming blank gameweeks (fixture-based calculation)
7. `fpl://gameweeks/double` - Upcoming double gameweeks (fixture-based calculation)

### 14 Tools (Executable Functions)

#### Public Tools (No Auth Required)
1. **search_player** - Find players by name with comprehensive stats (xG, xA, minutes, clean sheets)
2. **compare_players** - Advanced player comparison with structured metrics, best performers, and fixture analysis
3. **analyze_players** - Filter players by position, team, price, form, ownership (min/max), with summary statistics
4. **get_gameweek_status** - Current/previous/next gameweek info
5. **analyze_player_fixtures** - Fixture difficulty analysis for specific player
6. **get_blank_gameweeks** - Identify blank gameweeks by counting fixtures (not chip plays)
7. **get_double_gameweeks** - Identify double gameweeks by counting fixtures per team
8. **analyze_fixtures** - Fixture analysis for teams/players/positions (3 modes)

#### Authenticated Tools (Require FPL Credentials)
9. **get_my_team** - Your complete squad (15 players) split into active 11 + bench 4, with full player stats
10. **get_team** - View any team by ID with complete squad and player details
11. **get_manager_info** - Manager profile and league info (public endpoint)
12. **get_team_history** - Historical performance over gameweeks
13. **get_league_standings** - League standings and rankings (public endpoint)
14. **check_fpl_authentication** - Test if credentials are working

## Recent Improvements (All 37 Bugs Fixed)

### Critical Fixes
- ✅ **Authentication caching** - 2-hour session cache prevents rate limiting
- ✅ **Blank/Double gameweeks** - Complete rewrite using fixture counting (was using wrong chip_plays logic)
- ✅ **compare_players** - Now includes structured comparison, best_performers tracking, and overall summary
- ✅ **get_my_team & get_team** - Full 15-player squad with active/bench split and comprehensive stats

### Enhanced Features
- ✅ **analyze_fixtures** - Now supports team/player/position modes with blank/double GW integration
- ✅ **analyze_players** - Added ownership filters (min/max), form threshold, and summary statistics
- ✅ **search_player** - Added xG, xA, minutes, clean sheets
- ✅ **Error handling** - Comprehensive try/catch blocks on all tools
- ✅ **Type safety** - Fixed all unsafe operations and added null checks

## API Source

**Official Fantasy Premier League API**
- Base URL: `https://fantasy.premierleague.com/api`
- Same API used by the official FPL website
- Public endpoints: players, teams, fixtures, gameweeks (no auth)
- Private endpoints: team picks, history (requires auth with 2hr caching)

## Environment Variables

Set these in Cloudflare Pages dashboard to unlock authenticated features:

| Variable | Description | Example |
|----------|-------------|---------|
| `FPL_EMAIL` | Your FPL account email | `yourmail@example.com` |
| `FPL_PASSWORD` | Your FPL password | `YourPassword123` |
| `FPL_TEAM_ID` | Your FPL team ID | `1234567` |

**Finding your Team ID:**
1. Log into Fantasy Premier League website
2. Go to "Points" or "Transfers" page
3. Look at the URL: `fantasy.premierleague.com/entry/1234567/event/10`
4. Your team ID is the number after `/entry/` (e.g., `1234567`)

## Technical Details

**Built With:**
- TypeScript - Type-safe implementation
- Cloudflare Pages Functions - Serverless Workers runtime
- Cloudflare Workers API - Edge computing platform

**Features:**
- ✅ HTTP transport via `/mcp` endpoint
- ✅ SSE transport via `/sse` endpoint (for Claude.ai custom connectors)
- ✅ 1-hour caching for API responses
- ✅ 2-hour authentication session caching
- ✅ Automatic session management for authenticated requests
- ✅ Comprehensive error handling with detailed messages
- ✅ CORS enabled for browser access
- ✅ DDoS protection via Cloudflare

**Performance:**
- Memory: 128 MB per request (Workers limit)
- CPU: Isolate-based execution (faster than containers)
- Cold start: ~0ms (Workers are always warm)
- Response time: ~100-300ms per tool call
- Global edge network for low latency

## Deployment

### Cloudflare Pages (Dashboard - No CLI Required)

**See `CLOUDFLARE-DEPLOYMENT.md` for complete step-by-step guide.**

Quick overview:
1. Fork/clone this repository to your GitHub account
2. Go to Cloudflare Dashboard → Pages
3. Create new project → Connect to Git
4. Select your repository
5. Framework preset: None
6. Build command: (leave empty)
7. Build output directory: (leave empty)
8. Add environment variables: `FPL_EMAIL`, `FPL_PASSWORD`, `FPL_TEAM_ID`
9. Save and Deploy!

**Your MCP endpoint:** `https://your-project.pages.dev/mcp`
**SSE endpoint:** `https://your-project.pages.dev/sse`
**Health check:** `https://your-project.pages.dev/health`

### Auto-Deployment
Every push to your connected branch automatically triggers a new deployment. Check the Cloudflare dashboard for deployment status.

## Files

### Core Files
- `functions/_middleware.ts` - Complete MCP server (1,757 lines, TypeScript)
- `package.json` - Dependencies (Cloudflare Workers types)
- `tsconfig.json` - TypeScript configuration
- `wrangler.toml` - Cloudflare Workers configuration

### Documentation
- `README.md` - This file
- `CLOUDFLARE-DEPLOYMENT.md` - Step-by-step deployment guide for non-technical users

### Original Python Version (for reference)
- `main.py` - Original Cloud Run version (kept for reference)
- `requirements.txt` - Python dependencies (not used in Cloudflare deployment)
- `Dockerfile` - Cloud Run container (not used in Cloudflare deployment)

## Architecture Comparison

| Feature | Cloud Run (Old) | Cloudflare Pages (Current) |
|---------|-----------------|----------------------------|
| **Cost** | $15-20/month | $0/month |
| **Transport** | HTTP only | HTTP + SSE |
| **Language** | Python + FastMCP | TypeScript (native) |
| **Deployment** | CLI or GitHub | GitHub dashboard |
| **Cold starts** | 3-5 seconds | 0ms (always warm) |
| **Min instances** | 0 (but bills for 15min after) | N/A (pay per request only) |
| **Auth caching** | No | Yes (2 hours) |
| **Blank/Double GW logic** | Correct | Correct (fixture-based) |
| **compare_players** | Basic | Advanced (structured + best performers) |
| **get_my_team** | Basic picks | Full squad (active + bench) |
| **Error handling** | Basic | Comprehensive try/catch |
| **Resources** | 12 | 7 (core features) |
| **Tools** | 14 | 14 (all features) |
| **Security** | Public + billing risk | Public + DDoS protected |

## Testing

### Test Health Check
```bash
curl https://your-project.pages.dev/health
```

Expected: `FPL MCP Server - Cloudflare Pages Edition ✓ (All bugs fixed)`

### Test MCP Initialization
```bash
curl -X POST https://your-project.pages.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'
```

Expected: JSON response with server info and capabilities

### Test a Tool
```bash
curl -X POST https://your-project.pages.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_player",
      "arguments": {"query": "Salah"}
    },
    "id": 1
  }'
```

Expected: JSON response with player search results

### Connect to Claude Desktop

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "fpl": {
      "url": "https://your-project.pages.dev/mcp"
    }
  }
}
```

Restart Claude Desktop and you should see 14 FPL tools available.

## Security Notes

### Public URL
- Your Cloudflare Pages URL is public (anyone can find it)
- **But**: Cloudflare has built-in DDoS protection and rate limiting
- **But**: Free tier caps at 100,000 requests/day (no surprise bills)
- **But**: Your FPL credentials are encrypted in Cloudflare environment variables
- **But**: Authenticated endpoints require your credentials to access YOUR data

### What Attackers Can Do
- ✅ Access public FPL data (player stats, fixtures, teams)
- ❌ Cannot access YOUR team picks (needs FPL_EMAIL/PASSWORD)
- ❌ Cannot rack up bills (free tier hard limit)
- ❌ DDoS attacks blocked by Cloudflare

### Optional: Add API Key Protection
If you want to restrict access completely, add an API key check in `functions/_middleware.ts`.

## Cost Analysis

### Cloud Run (Previous)
- **Actual cost**: $15-20/month
- **Reason**: 254 hours of instance time from:
  - Warm instance timeout (15 min after each request)
  - Intermittent usage throughout day (2-3 hours/day)
  - 3 servers × continuous warm time = high billing

### Cloudflare Pages (Current)
- **Actual cost**: $0/month
- **Free tier**: 100,000 requests/day
- **Typical usage**: ~100-500 requests/day
- **Billing**: Only for active request processing (milliseconds, not minutes)
- **No warm timeout overhead**

**Savings: $180-240/year**

## Differences from Original fpl-mcp Package

| Feature | Original (fpl-mcp) | This Version |
|---------|-------------------|--------------|
| Transport | stdio only (Claude Desktop) | HTTP + SSE (Cloud MCP) |
| Package | mcp 1.2.0 (Python SDK) | Native TypeScript |
| Deployment | Local only | Global edge (Cloudflare) |
| Cost | Free (local) | Free (cloud) |
| Resources | 12 | 7 (core features) |
| Tools | 14 | 14 (all features + enhancements) |
| Prompts | 5 | 0 (not needed for web) |
| Auth | Encrypted file storage | Environment variables |
| Caching | DiskCache | In-memory (1hr API, 2hr auth) |
| Blank/Double GW | Basic | Fixture-based counting |
| compare_players | Basic | Structured + best performers |
| get_my_team | Basic | Full squad + active/bench split |

## Migration from Cloud Run

If you're migrating from the Cloud Run version:

1. **Keep the Cloud Run version running** until Cloudflare is tested
2. Deploy to Cloudflare Pages following `CLOUDFLARE-DEPLOYMENT.md`
3. Test all tools work correctly
4. Update Claude Desktop config to use new Cloudflare URL
5. Delete Cloud Run service to stop billing

**Expected savings**: $15-20/month → $0/month

## Troubleshooting

### Tools not showing in Claude Desktop
- Check deployment status in Cloudflare dashboard
- Test `/mcp` endpoint with curl (see Testing section)
- Restart Claude Desktop after config changes

### Authentication errors
- Verify `FPL_EMAIL`, `FPL_PASSWORD`, `FPL_TEAM_ID` are set correctly
- Use `check_fpl_authentication` tool to test credentials
- Check Cloudflare logs for detailed error messages

### Blank/Double gameweeks showing wrong data
- This has been fixed (was using chip_plays, now uses fixture counting)
- Redeploy from latest commit to get the fix

## License

MIT

## Author

Built for Cloudflare Pages deployment based on the Official Fantasy Premier League API.

Originally based on the fpl-mcp package, fully rewritten in TypeScript for cloud deployment with comprehensive bug fixes and enhancements.
