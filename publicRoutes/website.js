import express from "express";
import { getWebsiteContact, getWebsitePageBySlug, listWebsitePages } from "../helpers/websiteContent.js";

const router = express.Router();

router.get("/", async (_req, res) => {
    try {
        const [contact, pages] = await Promise.all([
            getWebsiteContact({ publicOnly: true }),
            listWebsitePages({ publishedOnly: true }),
        ]);

        return res.status(200).json({
            error: false,
            contact,
            pages: pages.map(({ content_html, ...page }) => page),
        });
    } catch (error) {
        console.error("public website content error:", error);
        return res.status(500).json({ error: "Failed to load website content" });
    }
});

router.get("/pages/:slug", async (req, res) => {
    try {
        const page = await getWebsitePageBySlug(req.params.slug, { publishedOnly: true });
        if (!page) {
            return res.status(404).json({ error: "Page not found" });
        }
        return res.status(200).json({ error: false, page });
    } catch (error) {
        console.error("public website page error:", error);
        return res.status(500).json({ error: "Failed to load website page" });
    }
});

export default router;
