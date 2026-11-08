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
