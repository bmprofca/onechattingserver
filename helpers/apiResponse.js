/**
 * OneChatting API response contract.
 *
 * Success → HTTP 2xx
 *   { success: true, message, data, meta? }
 * Failure → HTTP 4xx/5xx
 *   { success: false, message, error: { code, message, details? } }
 * List meta → { page, limit, total, total_pages, has_more, count?, ...cursor fields }
 *
 * Route handlers may still return their historical JSON. apiContract converts
 * every JSON response into this envelope. New handlers should call
 * sendSuccess() / sendError() directly.
 */

export const ERROR_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    402: "PAYMENT_REQUIRED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    410: "GONE",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
};

// Keys that may leak implementation details; stripped from every error response.
const INTERNAL_KEYS = ["e", "err", "stack", "sql", "sqlMessage", "sqlState", "errno"];

const PAGINATION_KEYS = [
    "page", "page_no", "pageNo", "limit", "total", "total_records", "totalRecords",
    "total_pages", "total_page", "totalPages", "has_more", "hasMore", "is_last_page",
    "isLastPage", "has_more_next", "hasMoreNext", "has_more_previous", "hasMorePrevious",
    "count", "last_id", "first_id", "next_cursor", "prev_cursor",
];

const isPlainObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

export const isErrorBody = (body) =>
    isPlainObject(body) && body.error !== undefined && body.error !== null && body.error !== false && body.error !== "";

/** Infer an HTTP status for handlers that reported an error with HTTP 200. */
export function inferErrorStatus(message = "") {
    const m = String(message || "").toLowerCase();
    if (/session expired|unauthori[sz]ed|invalid token|expired token|token required|missing token|login again|not logged in/.test(m)) return 401;
    if (/not assigned|permission|not allowed|forbidden|access denied|not authori[sz]ed|blocked|suspended/.test(m)) return 403;
    if (/insufficient (wallet )?balance|insufficient funds|recharge|subscription (has )?expired|plan (has )?expired|no active (plan|subscription)/.test(m)) return 402;
    if (/already exists|already registered|duplicate|already (been )?(used|added|taken|in use)/.test(m)) return 409;
    if (/not found|does not exist|doesn't exist|no valid .* found|no .* found|invalid [a-z_ ]*id\b|no .* match/.test(m)) return 404;
    if (/server error|internal error|something went wrong|database error/.test(m)) return 500;
    return 400;
}

export function errorCodeFor(status, message = "") {
    if (status === 400 && /provide|required|mandatory|invalid|must |missing|not valid|should be/i.test(message)) {
        return "VALIDATION_ERROR";
    }
    return ERROR_CODES[status] || (status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST");
}

/** Remove internal details from an error body. Returns [cleanBody, removed]. */
export function stripInternalDetails(body) {
    if (!isErrorBody(body)) return [body, null];
    const removed = {};
    let changed = false;
    const clean = { ...body };
    for (const key of INTERNAL_KEYS) {
        if (key in clean) {
            removed[key] = clean[key];
            delete clean[key];
            changed = true;
        }
    }
    if (isPlainObject(clean.error)) {
        const inner = { ...clean.error };
        for (const key of INTERNAL_KEYS) {
            if (key in inner) {
                removed[`error.${key}`] = inner[key];
                delete inner[key];
                changed = true;
            }
        }
        clean.error = inner;
    }
    return changed ? [clean, removed] : [body, null];
}

const toNumber = (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
};

/** Normalize historical pagination shapes into one meta object. */
export function normalizeMeta(source = {}) {
    const page = toNumber(source.page ?? source.page_no ?? source.pageNo);
    const limit = toNumber(source.limit);
    const total = toNumber(source.total ?? source.total_records ?? source.totalRecords);
    let totalPages = toNumber(source.total_pages ?? source.total_page ?? source.totalPages);
    if (totalPages === undefined && total !== undefined && limit) totalPages = Math.ceil(total / limit);

    let hasMore;
    if (typeof source.has_more === "boolean") hasMore = source.has_more;
    else if (typeof source.hasMore === "boolean") hasMore = source.hasMore;
    else if (typeof source.has_more_next === "boolean") hasMore = source.has_more_next;
    else if (typeof source.hasMoreNext === "boolean") hasMore = source.hasMoreNext;
    else if (typeof source.is_last_page === "boolean") hasMore = !source.is_last_page;
    else if (typeof source.isLastPage === "boolean") hasMore = !source.isLastPage;
    else if (page !== undefined && totalPages !== undefined) hasMore = page < totalPages;

    const meta = {};
    if (page !== undefined) meta.page = page;
    if (limit !== undefined) meta.limit = limit;
    if (total !== undefined) meta.total = total;
    if (totalPages !== undefined) meta.total_pages = totalPages;
    if (hasMore !== undefined) meta.has_more = hasMore;
    if (typeof source.has_more_previous === "boolean") meta.has_previous = source.has_more_previous;
    else if (typeof source.hasMorePrevious === "boolean") meta.has_previous = source.hasMorePrevious;
    if (source.last_id !== undefined) meta.last_id = source.last_id;
    if (source.first_id !== undefined) meta.first_id = source.first_id;
    if (source.next_cursor !== undefined) meta.next_cursor = source.next_cursor;
    if (source.prev_cursor !== undefined) meta.prev_cursor = source.prev_cursor;
    const count = toNumber(source.count);
    if (count !== undefined) meta.count = count;

    // Keep any non-pagination keys a handler put in meta (e.g. summary counts).
    for (const [key, value] of Object.entries(source)) {
        if (!PAGINATION_KEYS.includes(key) && !(key in meta)) meta[key] = value;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Convert a handler body into the API envelope.
 * Returns { status, body }.
 */
export function toApiEnvelope(body, currentStatus = 200) {
    // A handler that set a 4xx/5xx status is an error even without an `error` key.
    if (!isErrorBody(body) && currentStatus >= 400) {
        const message = (isPlainObject(body) && (body.message || body.msg)) || (typeof body === "string" ? body : "Request failed");
        body = { ...(isPlainObject(body) ? body : {}), error: message };
    }
    if (isErrorBody(body)) {
        const message =
            (typeof body.error === "string" && body.error) ||
            (isPlainObject(body.error) && body.error.message) ||
            body.message || body.msg || "Request failed";
        const status = currentStatus >= 400 ? currentStatus : inferErrorStatus(message);
        const code = (isPlainObject(body.error) && body.error.code) || errorCodeFor(status, message);

        const details = {};
        for (const [key, value] of Object.entries(body)) {
            if (["error", "msg", "message", "success"].includes(key)) continue;
            details[key] = value;
        }
        const error = { code, message };
        if (Object.keys(details).length > 0) error.details = details;
        return { status, body: { success: false, message, error } };
    }

    const status = currentStatus;

    if (!isPlainObject(body)) {
        return { status, body: { success: true, message: null, data: body ?? null } };
    }

    // Already the standard envelope.
    if (body.success === true && "data" in body && !("error" in body)) {
        const envelope = { success: true, message: body.message ?? null, data: body.data };
        const meta = isPlainObject(body.meta) ? normalizeMeta(body.meta) : undefined;
        if (meta) envelope.meta = meta;
        return { status, body: envelope };
    }

    const message = body.msg ?? body.message ?? null;
    const rest = { ...body };
    delete rest.error;
    delete rest.msg;
    delete rest.message;
    delete rest.success;

    const metaSource = isPlainObject(rest.meta) ? { ...rest.meta } : {};
    delete rest.meta;

    let data;
    if ("data" in rest) {
        data = rest.data;
        delete rest.data;
        const extras = {};
        for (const [key, value] of Object.entries(rest)) {
            if (PAGINATION_KEYS.includes(key)) {
                if (!(key in metaSource)) metaSource[key] = value;
            } else {
                extras[key] = value;
            }
        }
        if (Object.keys(extras).length > 0) {
            if (isPlainObject(data)) data = { ...extras, ...data };
            else Object.assign(metaSource, extras);
        }
    } else {
        data = Object.keys(rest).length > 0 ? rest : null;
    }

    const envelope = { success: true, message, data };
    const meta = normalizeMeta(metaSource);
    if (meta) envelope.meta = meta;
    return { status, body: envelope };
}

/** Send a success response. */
export function sendSuccess(res, { data = null, message = null, meta, status = 200 } = {}) {
    const body = { success: true, message, data };
    const normalized = meta ? normalizeMeta(meta) : undefined;
    if (normalized) body.meta = normalized;
    res.locals.apiEnvelope = true;
    return res.status(status).json(body);
}

/** Send an error response with a real HTTP status. */
export function sendError(res, { status = 400, message = "Request failed", code, details } = {}) {
    const error = { code: code || errorCodeFor(status, message), message };
    if (details) error.details = details;
    res.locals.apiEnvelope = true;
    return res.status(status).json({ success: false, message, error });
}

export class ApiError extends Error {
    constructor(status, message, { code, details } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
