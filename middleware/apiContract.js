import crypto from "node:crypto";
import { requestContext } from "../helpers/requestContext.js";
import { stripInternalDetails, toApiEnvelope, errorCodeFor } from "../helpers/apiResponse.js";

/**
 * API contract middleware.
 *
 * Every JSON response is the standard envelope:
 *   success → { success: true, message, data, meta? }
 *   failure → HTTP 4xx/5xx { success: false, message, error: { code, message, details? } }
 *
 * Request bodies: plain JSON is accepted on every route. The older encrypted
 * shape { data: "<ciphertext>", key } still works. Decrypt() reads the plain body
 * from the request context, so route handlers need no change.
 *
 * Inbound provider callbacks (/webhook) and the process health check keep the
 * body the caller already expects. File and media routes use streams, not res.json.
 *
 * Every response gets X-Request-Id. Error responses never include SQL errors or
 * stacks; those are logged with the request id instead.
 */

const isLegacyEncryptedBody = (body) =>
    body && typeof body === "object" && typeof body.data === "string" && typeof body.key === "string" && body.key !== "";

/** Paths whose JSON body is not the app API (provider callbacks, process health). */
function keepsRawJson(req) {
    const path = String(req.originalUrl || req.url || "").split("?")[0];
    return path === "/health" || path === "/webhook" || path.startsWith("/webhook/");
}

export function apiContract(req, res, next) {
    const requestId = String(req.headers["x-request-id"] || "").slice(0, 64) || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);

    const body = req.body;
    const plainBody =
        body && typeof body === "object" && !Array.isArray(body) && !isLegacyEncryptedBody(body) && !Buffer.isBuffer(body)
            ? body
            : undefined;

    const rawJson = keepsRawJson(req);
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
        const [clean, removed] = stripInternalDetails(payload);
        if (removed) {
            console.error(`[api] ${requestId} ${req.method} ${req.originalUrl} internal error details:`, removed);
        }
        if (rawJson || res.locals.apiEnvelope) {
            return originalJson(clean);
        }
        const { status, body: envelope } = toApiEnvelope(clean, res.statusCode || 200);
        res.status(status);
        return originalJson(envelope);
    };

    requestContext.run({ req, requestId, plainBody }, next);
}

/** 404 for unknown routes. */
export function notFoundHandler(req, res) {
    return res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}

/** Last-resort error handler (thrown errors, malformed JSON, oversized bodies). */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
    const requestId = req.requestId || "-";
    let status = Number(err?.status || err?.statusCode) || 500;
    if (err?.type === "entity.parse.failed") status = 400;
    if (err?.type === "entity.too.large") status = 413;
    if (status < 400 || status > 599) status = 500;

    if (status >= 500) {
        console.error(`[api] ${requestId} ${req.method} ${req.originalUrl} unhandled error:`, err);
    }

    const message =
        status === 400 && err?.type === "entity.parse.failed" ? "Malformed JSON body"
            : status === 413 ? "Request body is too large"
                : status >= 500 ? "Internal server error"
                    : err?.message || "Request failed";

    if (res.headersSent) return undefined;

    res.locals.apiEnvelope = true;
    const error = {
        code: err?.code && typeof err.code === "string" && /^[A-Z_]+$/.test(err.code) ? err.code : errorCodeFor(status, message),
        message,
    };
    if (err?.details) error.details = err.details;
    return res.status(status).json({ success: false, message, error });
}
