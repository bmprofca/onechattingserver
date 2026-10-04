import express from "express";
import { getAdminByToken } from "../helpers/adminDb.js";
import {
    deleteWebsitePage,
    getWebsiteContact,
    listWebsitePages,
    saveWebsiteContact,
    saveWebsitePage,
} from "../helpers/websiteContent.js";

const router = express.Router();

const authAdmin = async (req, res, next) => {
    try {
        let token =
            req.headers["x-auth-token"] ||
            req.headers["x-token"] ||
            req.headers["authorization"];

        if (!token) {
            return res.status(401).json({ error: "Auth token required." });
        }

        if (typeof token === "string" && token.startsWith("Bearer ")) {
            token = token.slice(7).trim();
        }

        const admin = await getAdminByToken(token);
        if (!admin) {
            return res.status(401).json({ error: "Invalid or expired token." });
        }

        req.admin = admin;
        next();
    } catch {
        return res.status(500).json({ error: "Server error." });
    }
};

router.use(authAdmin);

router.get("/", async (_req, res) => {
    try {
        const [contact, pages] = await Promise.all([
            getWebsiteContact(),
            listWebsitePages(),
        ]);
        return res.status(200).json({ error: false, contact, pages });
    } catch (error) {
        console.error("admin website content error:", error);
        return res.status(500).json({ error: "Failed to load website content" });
    }
});

router.put("/contact", async (req, res) => {
    try {
        const contact = await saveWebsiteContact(req.body || {});
        return res.status(200).json({ error: false, contact, msg: "Contact details saved" });
    } catch (error) {
        console.error("admin website contact error:", error);
        return res.status(500).json({ error: "Failed to save contact details" });
    }
});

router.post("/pages", async (req, res) => {
    try {
        const page = await saveWebsitePage(req.body || {});
        if (page?.error) return res.status(400).json({ error: page.error });
        return res.status(200).json({ error: false, page, msg: "Page created" });
    } catch (error) {
        console.error("admin website page create error:", error);
        return res.status(500).json({ error: "Failed to create page" });
    }
});

router.put("/pages/:id", async (req, res) => {
    try {
        const page = await saveWebsitePage(req.body || {}, req.params.id);
        if (page?.error) return res.status(400).json({ error: page.error });
        if (!page) return res.status(404).json({ error: "Page not found" });
        return res.status(200).json({ error: false, page, msg: "Page saved" });
    } catch (error) {
        console.error("admin website page save error:", error);
        return res.status(500).json({ error: "Failed to save page" });
    }
});

router.delete("/pages/:id", async (req, res) => {
    try {
        await deleteWebsitePage(req.params.id);
        return res.status(200).json({ error: false, msg: "Page deleted" });
    } catch (error) {
        console.error("admin website page delete error:", error);
        return res.status(500).json({ error: "Failed to delete page" });
    }
});

export default router;
