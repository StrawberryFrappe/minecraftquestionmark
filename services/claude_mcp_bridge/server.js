// MCP bridge between mindcraft bots and a live Claude Code session.
//
//   bots (model "claude-mcp")  --POST /bot/request-->  bridge  <--MCP /mcp--  Claude Code
//
// Bots post their prompt and wait. Claude Code calls the `wait_for_request` tool to pick up
// the next prompt and the `respond` tool to send the bot's reply back.
//
// Start:    npm run claude-bridge            (port 7790, or MINDCRAFT_BRIDGE_PORT / --port)
// Connect:  claude mcp add --transport http mindcraft http://127.0.0.1:7790/mcp
// Drive:    in Claude Code, run the /mcp__mindcraft__drive prompt

import express from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { flattenTurns } from '../../src/utils/claude_code_format.js';

const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.MINDCRAFT_BRIDGE_PORT || 7790);
const HOST = process.env.MINDCRAFT_BRIDGE_HOST || '127.0.0.1';

const queue = [];             // requests waiting to be picked up, oldest first
const inFlight = new Map();   // id -> request handed to Claude Code, awaiting respond()
const waiters = [];           // pending wait_for_request calls
let delivered = 0;

function settle(request, payload) {
    if (request.done) return false;
    request.done = true;
    clearTimeout(request.timer);
    const qi = queue.indexOf(request);
    if (qi >= 0) queue.splice(qi, 1);
    inFlight.delete(request.id);
    if (!request.res.writableEnded && !request.res.destroyed)
        request.res.json(payload);
    return true;
}

function enqueue(request) {
    const waiter = waiters.shift();
    if (waiter) waiter(request);
    else queue.push(request);
}

function nextRequest(timeout_ms, signal) {
    if (queue.length > 0)
        return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
        const waiter = (request) => { cleanup(); resolve(request); };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
        };
        const onAbort = () => { cleanup(); resolve(null); };
        const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout_ms);
        signal?.addEventListener('abort', onAbort);
        waiters.push(waiter);
    });
}

function renderRequest(request) {
    const { text, images } = flattenTurns(request.messages);
    const header =
        `request_id: ${request.id}\n` +
        `bot: ${request.bot}\n` +
        `queued_requests: ${queue.length}\n\n` +
        `Act as the bot's language model. Follow the system prompt below exactly and answer with ` +
        `respond(request_id="${request.id}", text=<the bot's output>).\n\n`;
    const content = [{
        type: 'text',
        text: `${header}<system_prompt>\n${request.system}\n</system_prompt>\n\n<input>\n${text}\n</input>`,
    }];
    for (const image of images)
        content.push({ type: 'image', data: image.data, mimeType: image.media_type || 'image/jpeg' });
    return content;
}

const DRIVE_PROMPT = `You are now the brain of the Minecraft bots running in mindcraft, connected through the "mindcraft" MCP server.

Loop until I interrupt you:
1. Call wait_for_request.
2. If it says no request is pending, go back to step 1.
3. Otherwise it gives you a request_id, the bot's system prompt, and its input. Write exactly the output the bot's own language model should produce: follow the system prompt's instructions and format (for example in-game chat replies with !commands, or a code block when asked for code). Write as the bot, not as Claude Code.
4. Call respond with that request_id and your output, then go back to step 1.

Don't use any other tools, don't summarize what you're doing, and don't stop to ask me anything. Keep answers short like in-game chat unless the system prompt asks for something else.`;

function buildMcpServer() {
    const server = new McpServer({ name: 'mindcraft', version: '1.0.0' });

    server.registerTool('wait_for_request', {
        description: 'Wait for the next prompt from a mindcraft bot and return it. Returns immediately if one is already queued, otherwise blocks up to timeout_seconds.',
        inputSchema: {
            timeout_seconds: z.number().int().min(1).max(300).optional()
                .describe('How long to wait for a request before returning empty (default 50).'),
        },
    }, async ({ timeout_seconds }, extra) => {
        const request = await nextRequest((timeout_seconds ?? 50) * 1000, extra?.signal);
        if (!request)
            return { content: [{ type: 'text', text: 'No request pending. Call wait_for_request again.' }] };
        if (extra?.signal?.aborted) { // the tool call was cancelled after we dequeued: put it back
            queue.unshift(request);
            return { content: [{ type: 'text', text: 'Cancelled.' }] };
        }
        inFlight.set(request.id, request);
        delivered++;
        console.log(`[bridge] delivered ${request.id} (${request.bot}) to Claude Code`);
        return { content: renderRequest(request) };
    });

    server.registerTool('respond', {
        description: "Send the bot's output for a request obtained from wait_for_request.",
        inputSchema: {
            request_id: z.string().describe('The request_id from wait_for_request.'),
            text: z.string().describe("The bot's output, exactly as it should be sent."),
        },
    }, ({ request_id, text }) => {
        const request = inFlight.get(request_id);
        if (!request)
            return { content: [{ type: 'text', text: `Request ${request_id} is no longer waiting (expired or already answered). Call wait_for_request for the next one.` }] };
        settle(request, { text });
        console.log(`[bridge] answered ${request_id} (${request.bot})`);
        return { content: [{ type: 'text', text: `Sent to ${request.bot}. Call wait_for_request for the next one.` }] };
    });

    server.registerPrompt('drive', {
        description: 'Start answering mindcraft bot requests in a loop.',
    }, () => ({
        messages: [{ role: 'user', content: { type: 'text', text: DRIVE_PROMPT } }],
    }));

    return server;
}

const app = express();
app.use(express.json({ limit: '50mb' }));

app.post('/bot/request', (req, res) => {
    const { bot, system, messages, timeout_ms } = req.body || {};
    const request = {
        id: randomUUID().slice(0, 8),
        bot: String(bot || 'bot'),
        system: String(system || ''),
        messages: Array.isArray(messages) ? messages : [],
        res,
        done: false,
    };
    const timeout = Math.max(1000, Number(timeout_ms) || 300000);
    request.timer = setTimeout(() => {
        if (settle(request, { error: `Claude Code did not answer within ${timeout / 1000}s. Is a Claude Code session running /mcp__mindcraft__drive?` }))
            console.warn(`[bridge] request ${request.id} (${request.bot}) timed out`);
    }, timeout);
    res.on('close', () => settle(request, {})); // bot went away (restart, shutdown)
    console.log(`[bridge] queued ${request.id} from ${request.bot}`);
    enqueue(request);
});

// Stateless Streamable HTTP: a fresh MCP server and transport per request.
app.post('/mcp', async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
        transport.close();
        server.close();
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error('[bridge] MCP error:', err);
        if (!res.headersSent)
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
});
const methodNotAllowed = (req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

app.get('/', (req, res) => {
    res.json({
        queued: queue.map(r => ({ id: r.id, bot: r.bot })),
        in_flight: [...inFlight.values()].map(r => ({ id: r.id, bot: r.bot })),
        claude_code_waiting: waiters.length,
        delivered,
    });
});

app.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`mindcraft MCP bridge listening on ${url}`);
    console.log(`Connect Claude Code:  claude mcp add --transport http mindcraft ${url}/mcp`);
    console.log('Then in Claude Code run:  /mcp__mindcraft__drive');
});
