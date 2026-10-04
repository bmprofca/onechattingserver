import express from "express";
import { getAdminByToken } from "../helpers/adminDb.js";
import { deleteSetting, listSettings, upsertSetting } from "../helpers/settings.js";

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

router.get("/", async (req, res) => {
    try {
        const group = String(req.query.group || "").trim();
        const settings = await listSettings(group ? { group } : {});
        return res.status(200).json({ error: false, settings });
    } catch (error) {
        console.error("admin settings list error:", error);
        return res.status(500).json({ error: "Failed to load settings" });
    }
});

router.post("/", async (req, res) => {
    try {
        const setting = await upsertSetting(req.body || {});
        if (setting?.error) return res.status(400).json({ error: setting.error });
        return res.status(200).json({ error: false, setting, msg: "Setting saved" });
    } catch (error) {
        console.error("admin settings save error:", error);
        return res.status(500).json({ error: "Failed to save setting" });
    }
});

router.put("/:id", async (req, res) => {
    try {
        const setting = await upsertSetting(req.body || {}, req.params.id);
        if (setting?.error) {
            const status = setting.error === "Setting not found" ? 404 : 400;
            return res.status(status).json({ error: setting.error });
        }
        return res.status(200).json({ error: false, setting, msg: "Setting saved" });
    } catch (error) {
        console.error("admin settings update error:", error);
        return res.status(500).json({ error: "Failed to save setting" });
    }
});

router.delete("/:id", async (req, res) => {
    try {
        await deleteSetting(req.params.id);
        return res.status(200).json({ error: false, msg: "Setting deleted" });
    } catch (error) {
        console.error("admin settings delete error:", error);
        return res.status(500).json({ error: "Failed to delete setting" });
    }
});

export default router;
