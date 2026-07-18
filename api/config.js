// Vercel Serverless Function: GET /api/config — 프론트가 AI 키 유무를 받아 초기화
import { getConfig } from "../lib/core.js";

export default function handler(_req, res) {
  res.status(200).json(getConfig());
}
