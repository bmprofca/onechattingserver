import "./helpers/loadEnv.js";
import express from "express";
import cors from "cors";
import messagesRouter from "./routes/messages.js";
import webhookRouter, { startWebhookQueueDaemon } from "./routes/webhook.js";
import uploadRouter from "./routes/upload.js";
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
import { setupSocketIO } from "./helpers/Socket.js";
import { startCronJobs } from "./routes/cron.js";
import planRouter from "./routes/plan.js";
import developerRouter from "./developerRoutes/index.js";
import { generateSummary } from "./generate-db-summary.js";

const app = express();
app.use(cors({
    origin: "*",
    credentials: true
}));

app.use(
    express.json({
        verify: (req, _res, buf) => {
            if (req.originalUrl === "/webhook/wallet-topup") {
                req.rawBody = buf.toString("utf8");
            }
        },
    })
);
app.use("/message", messagesRouter);
app.use("/webhook", webhookRouter);
app.use("/upload", uploadRouter);
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

app.use("/admin", adminRouter);
app.use("/plan", planRouter);
app.use("/developer", developerRouter);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get("/upload/:filename", (req, res) => {
    const filePath = path.join(path.join(__dirname, "/media/upload/temp"), req.params.filename);

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


generateSummary();

const PORT = 6540;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);

    // Start all cron jobs
    startCronJobs();
    startWebhookQueueDaemon({ intervalMs: 500 });
});



export { WsIo };