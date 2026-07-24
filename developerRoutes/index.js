import express from "express";
import messageRouter from "./message.js";
import templateRouter from "./template.js";
import contactRouter from "./contact.js";

const router = express.Router();

router.use("/message", messageRouter);
router.use("/template", templateRouter);
router.use("/contact", contactRouter);

export default router;
