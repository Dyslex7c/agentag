import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPublicClient, http, type Address } from "viem";
import { avalancheFuji } from "viem/chains";
import Groq from "groq-sdk";
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ── Config ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const abiPath = resolve(__dirname, "../../shared/abi/ServiceRegistry.json");
const abi = JSON.parse(readFileSync(abiPath, "utf-8")) as readonly unknown[];

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as Address;
if (!CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS is required in .env");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is required in .env");

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const MODEL = "llama-3.3-70b-versatile";

// ── Clients ──────────────────────────────────────────────────────────
const publicClient = createPublicClient({
  chain: avalancheFuji,
  transport: http(),
});

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ── Service definitions ──────────────────────────────────────────────
interface ServiceDef {
  name: string;
  prompt: string;
  priceAvax: string;
}

const SERVICES: Record<string, ServiceDef> = {
  summarize: {
    name: "summarize",
    prompt: "Summarize the following text in 2 sentences",
    priceAvax: "0.001",
  },
  sentiment: {
    name: "sentiment",
    prompt:
      'Return ONLY valid JSON: { "score": <number between -1 and 1>, "label": "positive" | "negative" | "neutral" }',
    priceAvax: "0.0005",
  },
  translate: {
    name: "translate",
    prompt: "Translate the following text to Hindi",
    priceAvax: "0.0008",
  },
};

// ── Access check ─────────────────────────────────────────────────────
async function checkAccess(
  callerAddress: string,
  serviceName: string
): Promise<boolean> {
  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "hasAccess",
    args: [callerAddress as Address, serviceName],
  });
  return result as boolean;
}

// ── Groq call ────────────────────────────────────────────────────────
async function callGroq(
  systemPrompt: string,
  userText: string
): Promise<string> {
  const response = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.3,
    max_tokens: 512,
  });
  return response.choices[0]?.message?.content ?? "";
}

// ── Hono app ─────────────────────────────────────────────────────────
const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

// Route handler for a given service
async function handleServiceRequest(
  serviceName: string,
  c: { req: { json: <T>() => Promise<T> }; json: (data: unknown, status?: number) => Response }
): Promise<Response> {
  const svc = SERVICES[serviceName]!;
  const body = await c.req.json<{ text: string; callerAddress: string }>();
  const { text, callerAddress } = body;

  if (!text || !callerAddress) {
    return c.json({ error: "Missing text or callerAddress" }, 400);
  }

  console.log(`[${svc.name}] Access check for ${callerAddress}`);

  const hasAccess = await checkAccess(callerAddress, svc.name);

  if (!hasAccess) {
    console.log(`[${svc.name}] Payment required for ${callerAddress}`);
    return c.json(
      {
        error: "payment_required",
        service: svc.name,
        priceAvax: parseFloat(svc.priceAvax),
        contract: CONTRACT_ADDRESS,
      },
      402
    );
  }

  console.log(`[${svc.name}] Access granted — calling Groq...`);
  const result = await callGroq(svc.prompt, text);
  console.log(`[${svc.name}] Done.`);

  return c.json({ service: svc.name, result });
}

app.post("/summarize", (c) => handleServiceRequest("summarize", c));
app.post("/sentiment", (c) => handleServiceRequest("sentiment", c));
app.post("/translate", (c) => handleServiceRequest("translate", c));

// ── Start server ─────────────────────────────────────────────────────
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\n🚀 Agentag Services running on http://localhost:${info.port}`);
  console.log(`   Contract: ${CONTRACT_ADDRESS}`);
  console.log(`   Routes:   POST /summarize  POST /sentiment  POST /translate\n`);
});
