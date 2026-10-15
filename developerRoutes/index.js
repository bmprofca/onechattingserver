import express from "express";
import messageRouter from "./message.js";
import templateRouter from "./template.js";
import contactRouter from "./contact.js";
import campaignRouter from "./campaign.js";
import v1Router from "./v1.js";

const router = express.Router();

router.use("/v1", v1Router);
router.use("/message", messageRouter);
router.use("/template", templateRouter);
router.use("/contact", contactRouter);
router.use("/campaign", campaignRouter);

export default router;
