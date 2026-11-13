import express from "express";
import {
    buildSupportPayload,
    getWebsiteContact,
} from "../helpers/websiteContent.js";

const router = express.Router();

router.get("/support", async (_req, res) => {
    try {
        const contact = await getWebsiteContact({ publicOnly: true });
        return res.status(200).json({
            error: false,
            data: buildSupportPayload(contact),
            msg: "Support details fetch successfully",
        });
    } catch (error) {
        console.error("company support error:", error);
        return res.status(500).json({
            error: true,
            message: "Failed to fetch support information",
        });
    }
});

export default router;
