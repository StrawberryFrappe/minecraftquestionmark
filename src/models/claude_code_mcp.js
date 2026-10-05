import http from 'http';

// Sends each request to the mindcraft MCP bridge (services/claude_mcp_bridge/server.js)
// and waits for a live Claude Code session, connected to the bridge over MCP, to answer it.
//
// Profile usage: "model": "claude-mcp". The model is whatever the Claude Code session runs.
// Optional "url": bridge address (default http://127.0.0.1:7790, or $MINDCRAFT_BRIDGE_URL).
// Optional "params":
//   timeout_ms   how long to wait for Claude Code to answer (default 300000)
export class ClaudeCodeMCP {
    static prefix = 'claude-mcp';

    constructor(model_name, url, params) {
        this.params = params || {};
        this.url = url || process.env.MINDCRAFT_BRIDGE_URL || 'http://127.0.0.1:7790';
        this.bot_name = botNameFromArgs() || 'bot';
    }

    async sendRequest(turns, systemMessage) {
        try {
            console.log(`Awaiting Claude Code (via MCP bridge at ${this.url})...`);
            const res = await postJSON(new URL('/bot/request', this.url), {
                bot: this.bot_name,
                system: systemMessage || '',
                messages: turns || [],
                timeout_ms: this.params.timeout_ms || 300000,
            });
            if (res.error)
                throw new Error(res.error);
            console.log('Received.');
            return res.text;
        }
        catch (err) {
            if (err.code === 'ECONNREFUSED')
                console.error(`Claude Code MCP bridge is not running at ${this.url}. Start it with "npm run claude-bridge".`);
            else
                console.error('Claude Code MCP bridge request failed:', err.message);
            return 'My brain disconnected, try again.';
        }
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/jpeg', data: imageBuffer.toString('base64') }
                }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Claude Code.');
    }
}

// Agent processes are started as `init_agent.js -n <name> ...`.
function botNameFromArgs() {
    const i = process.argv.indexOf('-n');
    return i >= 0 ? process.argv[i + 1] : null;
}

// Uses node:http rather than fetch: fetch gives up after 300s without response headers,
// and the bridge holds the request open until Claude Code answers.
function postJSON(url, body) {
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => text += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(text)); }
                catch { reject(new Error(`bad response from bridge (HTTP ${res.statusCode}): ${text.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}
