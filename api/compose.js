// Vercel Serverless Function: POST /api/compose — 확인된 정보 → 요청문 초안 (Gemini 프록시)
import { compose, makeHandler } from "../lib/core.js";

export const config = { maxDuration: 15 };

export default makeHandler(compose);
