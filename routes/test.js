// server.js
import express from "express";
import axios from "axios";
import { GetAiSensyProjectToken } from "../helpers/function.js";
import pool from "../db.js";
import { AISENSY_API_KEY, AISENSY_PARTNER_ID } from "../helpers/Config.js";

const router = express.Router();


router.get("/", async (req, res) => {
  const project_id = req.query.project_id;


  const options = {
    method: 'PATCH',
    url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/stop-project-billing/${project_id}`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
    }
  };

  try {
    const { data } = await axios.request(options);
    return res.status(200).json({ data: data });
  } catch (error) {
    return res.status(200).json({ error: error.message });
  }
});

export default router;