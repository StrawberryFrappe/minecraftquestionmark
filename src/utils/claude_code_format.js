// Helpers shared by the Claude Code backends (src/models/claude_code.js and
// services/claude_mcp_bridge). Claude Code takes one user message per turn, so
// mindcraft's multi-turn history is flattened into a single transcript.

function blockText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return String(content ?? '');
    return content
        .filter(block => block?.type === 'text')
        .map(block => block.text)
        .join('\n');
}

function blockImages(content) {
    if (!Array.isArray(content))
        return [];
    return content
        .filter(block => block?.type === 'image' && block.source?.type === 'base64')
        .map(block => ({ media_type: block.source.media_type, data: block.source.data }));
}

// Converts mindcraft turns ({role, content}) into {text, images}.
// `text` is a transcript ending with an instruction to write the next assistant message;
// `images` are base64 images found anywhere in the turns.
export function flattenTurns(turns) {
    const images = [];
    const entries = [];
    for (const turn of turns || []) {
        const role = turn.role === 'assistant' || turn.role === 'system' ? turn.role : 'user';
        const text = blockText(turn.content).trim();
        images.push(...blockImages(turn.content));
        if (text.length > 0)
            entries.push({ role, text });
    }

    if (entries.length === 0)
        return { text: 'Respond according to your instructions.', images };

    if (entries.length === 1 && entries[0].role !== 'assistant')
        return { text: entries[0].text, images };

    let text = 'Conversation so far, oldest first. "system" turns are game/system output, "user" turns are messages to you, "assistant" turns are your own previous outputs.\n\n';
    for (const entry of entries)
        text += `<${entry.role}>\n${entry.text}\n</${entry.role}>\n`;
    text += '\nWrite your next assistant message. Output only the message itself, exactly as it should be sent, with no tags or commentary.';
    return { text, images };
}

// Builds the content array for a Claude Code stream-json user message.
export function toUserContent({ text, images }) {
    const content = [{ type: 'text', text }];
    for (const image of images || []) {
        content.push({
            type: 'image',
            source: { type: 'base64', media_type: image.media_type || 'image/jpeg', data: image.data }
        });
    }
    return content;
}
