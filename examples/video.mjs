import { submitTask } from "../src/task-client.mjs";

const apiKey = process.env.HIAPI_API_KEY;
const webhookUrl = process.env.HIAPI_WEBHOOK_URL;

if (!apiKey || !webhookUrl) {
  throw new Error("HIAPI_API_KEY and HIAPI_WEBHOOK_URL are required");
}

const prompt =
  process.env.HIAPI_VIDEO_PROMPT?.trim() ||
  "A cinematic sunrise over a quiet mountain lake";

const result = await submitTask(
  {
    model: "seedance-2-0",
    input: {
      prompt,
      aspect_ratio: "16:9",
      duration: 4,
      resolution: "480p",
      generate_audio: false,
    },
    callback: { url: webhookUrl, when: "final" },
  },
  { apiKey },
);

console.log(JSON.stringify(result, null, 2));
