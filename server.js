import "./helpers/loadEnv.js";
import express from "express";
import cors from "cors";
import messagesRouter from "./routes/messages.js";
import webhookRouter, { startWebhookQueueDaemon } from "./routes/webhook.js";
import accountRouter from "./routes/account.js";
import contactRouter from "./routes/contact.js";
import projectRouter from "./routes/project.js";
import businessRouter from "./routes/business.js";
import templateRouter from "./routes/template.js";
import agentRouter from "./routes/agent.js";
import permissionRouter from "./routes/permission.js";
import campaignRouter from "./routes/campaign.js";
import paymentRouter from "./routes/payment.js";
import companyRouter from "./routes/company.js";
import testRouter from "./routes/test.js";
import adminRouter from "./routes/admin.js";
import botReplyRouter from "./routes/botReply.js";
import path from "path";
import fs from "fs";
import mime from "mime";
import { fileURLToPath } from "url";
import http from "http";
import { isB2Enabled, initB2Storage, getB2PublicBaseUrl, streamB2Object, getContentTypeFromExtension } from "./helpers/b2Storage.js";
import { setupSocketIO } from "./helpers/Socket.js";
import { startCronJobs } from "./routes/cron.js";
import planRouter from "./routes/plan.js";
import developerRouter from "./developerRoutes/index.js";
import developerSettingsRouter from "./routes/developer.js";
import { generateSummary } from "./generate-db-summary.js";
import subscriptionRouter from "./routes/subscription.js";
import qrcodeRouter from "./routes/qrcode.js";

const app = express();

app.use((req, res, next) => {
    console.log(`[DEBUG] API called: ${req.method} ${req.originalUrl}`);
    next();
});

app.use(cors({
    origin: "*",
    credentials: true
}));

app.use(
    express.json({
        limit: "20mb",
        verify: (req, _res, buf) => {
            if (req.originalUrl === "/webhook/wallet-topup") {
                req.rawBody = buf.toString("utf8");
            }
        },
    })
);

/**
 * B2 media proxy — clients use {BASE_DOMAIN}/proxy/chat|templates/...
 * instead of direct backblazeb2.com URLs (blocked on some networks).
 * Express 5 named wildcard: /proxy/*objectKey
 */
async function handleMediaProxy(req, res) {
    try {
        if (!isB2Enabled()) {
            return res.status(503).send("Media storage is not configured");
        }

        const splat = req.params?.objectKey;
        const rawPath = Array.isArray(splat)
            ? splat.join("/")
            : String(splat || req.path || "").replace(/^\/+/, "");

        const objectKey = rawPath
            .split("/")
            .filter(Boolean)
            .map((segment) => {
                try {
                    return decodeURIComponent(segment);
                } catch {
                    return segment;
                }
            })
            .join("/");

        if (!objectKey) {
            return res.status(400).send("Missing media path");
        }

        const { stream, contentType, contentLength } = await streamB2Object(objectKey);

        const ext = path.extname(objectKey);
        const resolvedType =
            contentType || getContentTypeFromExtension(ext.replace(/^\./, "")) || "application/octet-stream";

        res.setHeader("Content-Type", resolvedType);
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", "private, max-age=3600");
        if (contentLength) {
            res.setHeader("Content-Length", contentLength);
        }

        if (req.method === "HEAD") {
            stream.destroy();
            return res.end();
        }

        stream.on("error", (err) => {
            console.error("B2 proxy stream error:", err?.message || err);
            if (!res.headersSent) {
                res.status(502).send("Failed to stream media");
            } else {
                res.destroy();
            }
        });

        stream.pipe(res);
    } catch (error) {
        const status = error?.status || 502;
        console.error("B2 proxy error:", error?.message || error);
        if (!res.headersSent) {
            return res.status(status).send(error?.message || "Failed to fetch media");
        }
    }
}

app.get("/proxy/*objectKey", handleMediaProxy);
app.head("/proxy/*objectKey", handleMediaProxy);

app.use("/message", messagesRouter);
app.use("/webhook", webhookRouter);
app.use("/account", accountRouter);
app.use("/contact", contactRouter);
app.use("/project", projectRouter);
app.use("/business", businessRouter);
app.use("/template", templateRouter);
app.use("/agent", agentRouter);
app.use("/permission", permissionRouter);
app.use("/campaign", campaignRouter);
app.use("/payment", paymentRouter);
app.use("/company", companyRouter);
app.use("/test", testRouter);
app.use("/bot-reply", botReplyRouter);
app.use("/subscription", subscriptionRouter);
app.use("/qrcode", qrcodeRouter);
app.use("/admin/qrcode", qrcodeRouter);

app.use("/admin", adminRouter);
app.use("/plan", planRouter);
app.use("/developer", developerSettingsRouter);
app.use("/developer", developerRouter);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/export/:filename", (req, res) => {
    const filePath = path.join(path.join(__dirname, "/media/export"), req.params.filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found");
    }

    const type = mime.getType(filePath);


    res.setHeader("Content-Type", type || "application/octet-stream");
    res.setHeader("Content-Disposition", "inline");
    fs.createReadStream(filePath).pipe(res);
});

app.get("/error/:filename", (req, res) => {
    const filePath = path.join(path.join(__dirname, "/media/error"), req.params.filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found");
    }

    const type = mime.getType(filePath);

    if (type && type.startsWith("video")) {
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            const chunkSize = end - start + 1;
            const file = fs.createReadStream(filePath, { start, end });

            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": type
            });

            file.pipe(res);
        } else {
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": type
            });
            fs.createReadStream(filePath).pipe(res);
        }
    } else {
        res.setHeader("Content-Type", type || "application/octet-stream");
        res.setHeader("Content-Disposition", "inline");
        fs.createReadStream(filePath).pipe(res);
    }
});

// Legacy local chat media (pre-B2 messages only)
app.use("/chat-media", express.static(path.join(process.cwd(), "/media/chat")));



const server = http.createServer(app);
const WsIo = setupSocketIO(server);

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        connections: WsIo.engine.clientsCount,
        timestamp: new Date().toISOString()
    });
});


if (process.env.GENERATE_DB_SUMMARY === "true") {
    generateSummary();
}

const PORT = 6540;
server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server running on port ${PORT}`);

    if (isB2Enabled()) {
        try {
            await initB2Storage();
            console.log(`📦 Chat media storage: Backblaze B2 (${process.env.B2_BUCKET})`);
            console.log(`   Media proxy: /proxy/chat|templates/...`);
            console.log(`   Public URL base: ${getB2PublicBaseUrl()}`);
        } catch (error) {
            console.error(`⚠️  B2 initialization failed: ${error.message}`);
        }
    } else {
        console.log("⚠️  B2 not configured — chat media uploads will fail until B2 env vars are set");
    }

    startCronJobs();
    startWebhookQueueDaemon({
        intervalMs: Number(process.env.WEBHOOK_QUEUE_INTERVAL_MS) || 3000,
    });
});



export { WsIo };