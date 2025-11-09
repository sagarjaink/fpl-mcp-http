# Deploy FPL MCP Server to Cloudflare Workers

This guide shows you how to deploy your FPL MCP server to Cloudflare using only web dashboards (no terminal needed).

## What You'll Need

1. A Cloudflare account (free tier is fine) - Sign up at https://cloudflare.com
2. Your FPL credentials:
   - FPL_EMAIL: Your Fantasy Premier League email
   - FPL_PASSWORD: Your FPL password
   - FPL_TEAM_ID: Your team ID (find it in the URL when viewing your team)

## Step-by-Step Instructions

### Step 1: Sign Up for Cloudflare (if you haven't already)

1. Go to https://dash.cloudflare.com/sign-up
2. Create a free account
3. Verify your email

### Step 2: Connect Your GitHub Repository

1. Go to https://dash.cloudflare.com
2. Click on "Workers & Pages" in the left sidebar
3. Click "Create Application" button
4. Click the "Pages" tab
5. Click "Connect to Git"
6. Click "Connect GitHub" (you'll be asked to authorize Cloudflare)
7. Select your repository: `sagarjaink/fpl-mcp-http`
8. Select the branch: `claude/deploy-mcp-cloudflare-011CUwcZ8pRKZx26n3m1zVjT`

### Step 3: Configure Build Settings

On the setup page:

1. **Project name**: `fpl-mcp-http` (or whatever you prefer)
2. **Framework preset**: Select "None"
3. **Build command**: Leave empty
4. **Build output directory**: Leave empty
5. Click "Save and Deploy"

**Wait for the first deployment** (this might fail - that's okay, we need to add secrets first)

### Step 4: Add Your FPL Credentials (IMPORTANT!)

1. After the first deployment, you'll be on your project page
2. Click on "Settings" tab at the top
3. Click on "Environment variables" in the left sidebar
4. Click "Add variables" button

Add these three variables:

**Variable 1:**
- Variable name: `FPL_EMAIL`
- Value: Your FPL email (e.g., yourname@example.com)
- Click "Encrypt" to make it a secret
- Click "Save"

**Variable 2:**
- Variable name: `FPL_PASSWORD`
- Value: Your FPL password
- Click "Encrypt" to make it a secret
- Click "Save"

**Variable 3:**
- Variable name: `FPL_TEAM_ID`
- Value: Your FPL team ID (numbers only, e.g., 1234567)
- This one doesn't need to be encrypted
- Click "Save"

### Step 5: Redeploy

1. Go back to "Deployments" tab
2. Click on the latest deployment
3. Click "Manage deployment" → "Retry deployment"
4. Wait for it to finish

### Step 6: Get Your Server URL

1. Once deployed successfully, you'll see a URL like:
   ```
   https://fpl-mcp-http.pages.dev
   ```

2. Your MCP endpoint will be:
   ```
   https://fpl-mcp-http.pages.dev/mcp
   ```

### Step 7: Test Your Server

Open this URL in your browser (replace with your actual URL):
```
https://fpl-mcp-http.pages.dev/health
```

You should see: "FPL MCP Server - Cloudflare Workers Edition"

## How to Find Your FPL Team ID

1. Log into https://fantasy.premierleague.com
2. Click on "Points" or "Transfers"
3. Look at the URL in your browser:
   ```
   https://fantasy.premierleague.com/entry/1234567/event/10
   ```
4. Your team ID is the number after `/entry/` (in this example: `1234567`)

## Costs

**Cloudflare Workers Free Tier:**
- 100,000 requests per day
- No charges for CPU time or memory
- No charges for bandwidth
- Perfect for personal MCP servers

## Automatic Updates

Once set up, every time you push code to the GitHub branch, Cloudflare automatically redeploys your server. No manual steps needed!

## Troubleshooting

**"Deployment failed"**
- Make sure you added all three environment variables (FPL_EMAIL, FPL_PASSWORD, FPL_TEAM_ID)
- Check that you selected the correct branch
- Try "Retry deployment"

**"Authentication failed" when using tools**
- Double-check your FPL_EMAIL and FPL_PASSWORD are correct
- Make sure you marked them as encrypted (secrets)

**Need help?**
- Check the Cloudflare Workers documentation: https://developers.cloudflare.com/workers
- Or open an issue on GitHub

## What's Different from Cloud Run?

| Feature | Google Cloud Run | Cloudflare Workers |
|---------|------------------|-------------------|
| Cost | $15-20/month (your current bill) | $0/month (free tier) |
| Deployment | Cloud Run console | Cloudflare dashboard |
| Code | Python (main.py) | TypeScript (src/index.ts) |
| Auto-deploy | Yes (from GitHub) | Yes (from GitHub) |
| Environment variables | Cloud Run console | Cloudflare dashboard |

Both versions work the same way - this Cloudflare version just saves you money!
