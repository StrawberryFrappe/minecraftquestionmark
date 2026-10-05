import { spawn } from 'child_process';
import { promises as fs, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { flattenTurns, toUserContent } from '../utils/claude_code_format.js';

// Runs each request through the Claude Code CLI in headless mode (`claude -p`).
// Uses whatever account Claude Code is logged in with (Pro/Max subscription or
// API key), so no ANTHROPIC_API_KEY is needed in keys.json.
//
// Profile usage: "model": "claude-code" (Claude Code's default model) or
// "claude-code/sonnet", "claude-code/opus", "claude-code/haiku", "claude-code/<full model id>".
// Optional "params":
//   effort          low | medium | high | xhigh | max   (passed to --effort)
//   fallback_model  model(s) to fall back to when the main one is overloaded
//   max_budget_usd  per-request spending cap (API-key billing only)
//   timeout_ms      kill the request after this long (default 180000)
//   claude_path     path to the claude executable (default: "claude" on PATH, or $CLAUDE_CODE_PATH)
//   extra_args      array of extra CLI arguments
export class ClaudeCode {
    static prefix = 'claude-code';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.claude_path = this.params.claude_path || process.env.CLAUDE_CODE_PATH || 'claude';
        // Run from an empty directory so Claude Code doesn't pick up a project CLAUDE.md.
        this.work_dir = path.join(os.tmpdir(), 'mindcraft-claude-code');
        mkdirSync(this.work_dir, { recursive: true });
    }

    async sendRequest(turns, systemMessage) {
        const content = toUserContent(flattenTurns(turns));
        const promptFile = path.join(this.work_dir, `system-${randomUUID()}.txt`);
        try {
            await fs.writeFile(promptFile, systemMessage || '', 'utf8');
            console.log(`Awaiting Claude Code response${this.model_name ? ' from ' + this.model_name : ''}...`);
            const res = await this._runClaude(promptFile, content);
            console.log('Received.');
            return res;
        }
        catch (err) {
            console.error('Claude Code request failed:', err.message);
            if (err.code === 'ENOENT')
                console.error(`Could not find the "${this.claude_path}" executable. Install Claude Code (https://code.claude.com) and run "claude" once to log in, or set params.claude_path.`);
            return 'My brain disconnected, try again.';
        }
        finally {
            fs.unlink(promptFile).catch(() => {});
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

    _buildArgs(promptFile) {
        const args = [
            '-p',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose', // required by stream-json output in print mode
            '--system-prompt-file', promptFile,
            '--tools', '', // the bot acts through !commands in its reply, not Claude Code tools
            '--strict-mcp-config',
            '--disable-slash-commands',
            '--no-session-persistence',
        ];
        if (this.model_name)
            args.push('--model', this.model_name);
        if (this.params.effort)
            args.push('--effort', String(this.params.effort));
        if (this.params.fallback_model)
            args.push('--fallback-model', String(this.params.fallback_model));
        if (this.params.max_budget_usd)
            args.push('--max-budget-usd', String(this.params.max_budget_usd));
        if (Array.isArray(this.params.extra_args))
            args.push(...this.params.extra_args.map(String));
        return args;
    }

    _runClaude(promptFile, content) {
        const timeout_ms = this.params.timeout_ms || 180000;
        let args = this._buildArgs(promptFile);
        const isWindows = process.platform === 'win32';
        if (isWindows) // npm installs claude as a .cmd shim, which needs a shell; quote args for cmd.exe
            args = args.map(a => (a === '' || /[\s"&|<>^]/.test(a)) ? `"${a.replace(/"/g, '""')}"` : a);

        return new Promise((resolve, reject) => {
            const child = spawn(this.claude_path, args, {
                cwd: this.work_dir,
                env: process.env,
                shell: isWindows,
                windowsHide: true,
            });

            let stdoutBuf = '';
            let stderr = '';
            let result = null;
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
            };

            const timer = setTimeout(() => {
                child.kill();
                finish(reject, new Error(`timed out after ${timeout_ms}ms`));
            }, timeout_ms);

            const handleLine = (line) => {
                if (!line.trim()) return;
                let msg;
                try { msg = JSON.parse(line); } catch { return; }
                if (msg.type === 'result')
                    result = msg;
            };

            child.stdout.on('data', (chunk) => {
                stdoutBuf += chunk.toString();
                let idx;
                while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
                    handleLine(stdoutBuf.slice(0, idx));
                    stdoutBuf = stdoutBuf.slice(idx + 1);
                }
            });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
            child.on('error', (err) => finish(reject, err));
            child.on('close', (code) => {
                handleLine(stdoutBuf);
                if (!result)
                    return finish(reject, new Error(`claude exited with code ${code} and no result. ${stderr.trim()}`));
                if (result.is_error || typeof result.result !== 'string')
                    return finish(reject, new Error(`Claude Code returned an error (${result.subtype || 'unknown'}): ${result.result || result.errors || stderr.trim()}`));
                finish(resolve, result.result);
            });

            child.stdin.on('error', () => {}); // ignore EPIPE if the CLI exits early
            // One user message, then EOF so the CLI exits after this turn.
            child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
        });
    }
}
