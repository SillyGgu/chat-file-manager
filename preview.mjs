// Display-only projection. Never import this module into core.mjs or operations.mjs.
export function previewMessage(message, useDisplayText = true) {
    const original = typeof message?.mes === 'string' ? message.mes : JSON.stringify(message?.mes ?? '');
    if (useDisplayText) {
        // llm-translator-custom keeps its translation here while showing the original.
        for (const text of [message?.extra?.original_translation_backup, message?.extra?.display_text]) {
            if (typeof text === 'string' && text.trim()) return { text, display: true };
        }
    }
    return { text: original, display: false };
}

// Translator display modes may contain HTML. Parse ONLY into an inert template,
// then extract plain text. Never attach template content or use it as rendered HTML.
export function displayPlainText(text, document) {
    const template = document.createElement('template');
    template.innerHTML = text;
    const blocked = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT']);
    const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'BLOCKQUOTE', 'PRE', 'DETAILS', 'SUMMARY', 'H1', 'H2', 'H3']);
    function read(node) {
        if (node.nodeType === 3) return node.textContent;
        if (blocked.has(node.nodeName)) return '';
        if (node.nodeName === 'BR') return '\n';
        const text = Array.from(node.childNodes || [], read).join('');
        return blocks.has(node.nodeName) ? `\n${text}\n` : text;
    }
    return read(template.content).replace(/\n{3,}/gu, '\n\n').trim();
}
