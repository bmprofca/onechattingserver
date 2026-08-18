import express from "express";
import axios from "axios";
import { GetAiSensyProjectToken } from "../helpers/function.js";
import pool from "../db.js";
import { getActiveTechProvider } from "../helpers/techProvider.js";

const router = express.Router();


router.get("/", async (req, res) => {
  const project_id = req.query.project_id;
  const activeProvider = await getActiveTechProvider();
  const partnerId = activeProvider.aisensy_partner_id;
  const apiKey = activeProvider.aisensy_api_key;

  const options = {
    method: 'PATCH',
    url: `https://apis.aisensy.com/partner-apis/v1/partner/${partnerId}/stop-project-billing/${project_id}`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-AiSensy-Partner-API-Key': apiKey
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