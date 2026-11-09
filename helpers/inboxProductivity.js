export function isActiveProjectMembership(row, username, projectId) {
    return Boolean(
        row &&
        row.username === username &&
        row.project_id === projectId &&
        String(row.is_deleted) === "0"
    );
}

export function normalizeConversationNumber(value) {
    if (typeof value !== "string") return "";
    const number = value.trim();
    return /^\+?\d{5,24}$/.test(number) ? number : "";
}

export function normalizeBulkConversationNumbers(rawNumbers, maximum = 200) {
    if (!Array.isArray(rawNumbers) || rawNumbers.length === 0 || rawNumbers.length > maximum) {
        throw new Error(`Select between 1 and ${maximum} conversations`);
    }

    const numbers = Array.from(new Set(rawNumbers.map(normalizeConversationNumber)));
    if (numbers.some((number) => !number)) {
        throw new Error("One or more conversation numbers are invalid");
    }
    return numbers;
}

export function normalizeSnooze(payload, now = Date.now()) {
    if (payload?.until_next_reply === true) {
        return { untilNextReply: true, until: null };
    }

    if (typeof payload?.until !== "string" || !payload.until.trim()) {
        throw new Error("Provide a snooze time or until_next_reply");
    }
    const untilMs = Date.parse(payload.until);
    if (!Number.isFinite(untilMs) || untilMs <= now || untilMs > now + 366 * 24 * 60 * 60 * 1000) {
        throw new Error("Snooze time must be in the future and within one year");
    }
    const roundedUntil = new Date(Math.ceil(untilMs / 1000) * 1000);
    return {
        untilNextReply: false,
        until: roundedUntil.toISOString().slice(0, 19).replace("T", " ")
    };
}

export function normalizeCannedReply(payload) {
    const shortcut = typeof payload?.shortcut === "string"
        ? payload.shortcut.trim().replace(/^\/+/, "").toLowerCase()
        : "";
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    const body = typeof payload?.body === "string" ? payload.body.trim() : "";

    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(shortcut)) {
        throw new Error("Shortcut must start with a letter or number and contain only letters, numbers, _ or -");
    }
    if (!title || title.length > 80) {
        throw new Error("Provide a title up to 80 characters");
    }
    if (!body || body.length > 5000) {
        throw new Error("Reply text must be between 1 and 5000 characters");
    }
    return { shortcut, title, body };
}

export function expandContactName(text, contactName) {
    const name = typeof contactName === "string" ? contactName : "";
    return String(text || "").replace(/\{\{\s*contact\.name\s*\}\}/gi, () => name);
}

export async function insertInternalNote(db, note) {
    return db.query(
        `INSERT INTO inbox_internal_notes
         (note_id, project_id, number, note_text, create_date, create_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [note.noteId, note.projectId, note.number, note.noteText, note.createdAt, note.username]
    );
}
