import express from "express";
import messageRouter from "./message.js";
import templateRouter from "./template.js";
import contactRouter from "./contact.js";
import campaignRouter from "./campaign.js";

const router = express.Router();

function dispatch(target, path, { method, apply } = {}) {
    return (req, res, next) => {
        if (typeof apply === "function") apply(req);

        const queryIndex = req.url.indexOf("?");
        const search = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
        const previousUrl = req.url;
        const previousMethod = req.method;

        req.url = path + search;
        if (method) req.method = method;

        target(req, res, (err) => {
            req.url = previousUrl;
            req.method = previousMethod;
            next(err);
        });
    };
}

router.get("/chats", dispatch(messageRouter, "/chat-list"));
router.get("/chats/:number/messages", dispatch(messageRouter, "/chat-history", {
    apply: (req) => {
        req.query.number = req.params.number;
    },
}));
router.get("/media", dispatch(messageRouter, "/media-list", {
    method: "POST",
    apply: (req) => {
        req.body = { ...(req.body || {}), ...req.query };
    },
}));
router.post("/chats/:number/read", dispatch(messageRouter, "/mark-as-read", {
    apply: (req) => {
        req.body = { ...(req.body || {}), number: req.params.number };
    },
}));
router.get("/chats/:number/assignment", dispatch(messageRouter, "/chat-assign-permission", {
    apply: (req) => {
        req.query.number = req.params.number;
    },
}));
router.post("/chats/:number/assignment", dispatch(messageRouter, "/chat-assign", {
    apply: (req) => {
        req.body = { ...(req.body || {}), number: req.params.number };
    },
}));

router.post("/messages/text", dispatch(messageRouter, "/send-text-message"));
router.post("/messages/image", dispatch(messageRouter, "/send-image-message"));
router.post("/messages/video", dispatch(messageRouter, "/send-video-message"));
router.post("/messages/document", dispatch(messageRouter, "/send-document-message"));
router.post("/messages/audio", dispatch(messageRouter, "/send-audio-message"));
router.post("/messages/template", dispatch(messageRouter, "/send-template"));

router.get("/templates", dispatch(templateRouter, "/template-list"));
router.post("/templates", dispatch(templateRouter, "/create-template"));
router.get("/templates/:template_id", dispatch(templateRouter, "/template-details", {
    apply: (req) => {
        req.query.template_id = req.params.template_id;
    },
}));
router.put("/templates/:template_id", dispatch(templateRouter, "/template-edit", {
    method: "POST",
    apply: (req) => {
        req.body = { ...(req.body || {}), template_id: req.params.template_id };
    },
}));
router.delete("/templates/:template_id", dispatch(templateRouter, "/template-delete", {
    method: "POST",
    apply: (req) => {
        req.body = { ...(req.body || {}), template_id: req.params.template_id };
    },
}));

router.post("/contacts/bulk", dispatch(contactRouter, "/bulk-upsert"));
router.get("/contacts/bulk/:job_id", dispatch(contactRouter, "/bulk-upsert-status", {
    apply: (req) => {
        req.query.job_id = req.params.job_id;
    },
}));

router.get("/campaigns", dispatch(campaignRouter, "/list"));
router.post("/campaigns", dispatch(campaignRouter, "/create"));
router.get("/campaigns/:campaign_id/messages", dispatch(campaignRouter, "/messages", {
    apply: (req) => {
        req.query.campaign_id = req.params.campaign_id;
    },
}));
router.get("/campaigns/:campaign_id", dispatch(campaignRouter, "/details", {
    apply: (req) => {
        req.query.campaign_id = req.params.campaign_id;
    },
}));
router.delete("/campaigns/:campaign_id", dispatch(campaignRouter, "/delete", {
    method: "POST",
    apply: (req) => {
        req.body = { ...(req.body || {}), campaign_id: req.params.campaign_id };
    },
}));

export default router;
