import express from "express";
import messageRouter from "./message.js";
import templateRouter from "./template.js";

const router = express.Router();

router.use("/message", messageRouter);
router.use("/template", templateRouter);

export default router;
