// Vercel Serverless Function: GET /api/config — 프론트가 키 유무·지도 키를 받아 초기화
import { getConfig } from "../lib/core.js";

export default function handler(_req, res) {
  res.status(200).json(getConfig());
}
