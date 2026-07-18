// Vercel Serverless Function: POST /api/analyze — 사진 → 장애 요소 후보 (Gemini 프록시)
import { analyze, makeHandler } from "../lib/core.js";

export const config = { maxDuration: 15 };

export default makeHandler(analyze);
