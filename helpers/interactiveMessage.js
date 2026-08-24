export function getInteractiveFromWebhookMessage(message = {}) {
    if (message?.type !== 'interactive' || !message.interactive) return null;
    const raw = message.interactive;
    const reply = raw.button_reply || raw.list_reply || null;
    return {
        type: raw.type || (raw.button_reply ? 'button_reply' : raw.list_reply ? 'list_reply' : 'interactive'),
        header: raw.header || null,
        body: raw.body || null,
        footer: raw.footer || null,
        action: raw.action || null,
        button_reply: raw.button_reply || null,
        list_reply: raw.list_reply || null,
        reply: reply ? {
            type: raw.button_reply ? 'button_reply' : 'list_reply',
            id: reply.id || '',
            title: reply.title || '',
            description: reply.description || ''
        } : null
    };
}

export function getInteractiveFromRawJson(rawJson) {
    try {
        const raw = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        if (raw?.type === 'interactive' && raw.interactive) return getInteractiveFromWebhookMessage(raw);
        const value = raw?.entry?.[0]?.changes?.[0]?.value || {};
        const message = value.messages?.[0] || value.message_echoes?.[0];
        return getInteractiveFromWebhookMessage(message);
    } catch {
        return null;
    }
}

export function getInteractiveDisplayText(interactive, fallback = '') {
    return interactive?.reply?.title
        || interactive?.body?.text
        || fallback
        || 'Interactive message';
}

export function validateInteractivePayload(interactive) {
    if (!interactive || !['button', 'list'].includes(interactive.type)) {
        return 'interactive.type must be button or list';
    }
    if (!interactive.body?.text) return 'interactive.body.text is required';
    if (interactive.type === 'button') {
        const buttons = interactive.action?.buttons;
        if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) {
            return 'interactive buttons must contain 1 to 3 items';
        }
        if (buttons.some((item) => !item?.reply?.id || !item?.reply?.title)) return 'Each button needs reply.id and reply.title';
    }
    if (interactive.type === 'list') {
        const sections = interactive.action?.sections;
        const rows = Array.isArray(sections) ? sections.flatMap((section) => section?.rows || []) : [];
        if (!sections?.length || !rows.length || rows.length > 10) return 'interactive list must contain 1 to 10 rows';
        if (rows.some((item) => !item?.id || !item?.title)) return 'Each list row needs id and title';
    }
    return null;
}
