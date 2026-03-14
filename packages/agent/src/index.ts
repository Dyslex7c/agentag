import {
  createPublicClient,
  http,
  parseEther,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { Facinet } from "facinet-sdk";
import Groq from "groq-sdk";
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ── Config ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const abiPath = resolve(__dirname, "../../shared/abi/ServiceRegistry.json");
const abi = JSON.parse(readFileSync(abiPath, "utf-8")) as any[];

const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY is required in .env");

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as Address;
if (!CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS is required in .env");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is required in .env");

const SERVICES_URL = process.env.SERVICES_URL ?? "http://localhost:3001";
const MODEL = "llama-3.3-70b-versatile";

// ── Blockchain clients ───────────────────────────────────────────────
const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: avalancheFuji,
  transport: http(),
});

const facinet = new Facinet({
  network: "avalanche-fuji",
  privateKey: PRIVATE_KEY,
});

// ── Groq client ──────────────────────────────────────────────────────
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ── Tool definition for Groq ─────────────────────────────────────────
const tools: Groq.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "call_service",
      description:
        "Call a paid microservice. Available services: 'summarize' (summarizes text in 2 sentences), 'sentiment' (returns sentiment score and label), 'translate' (translates text to any language — specify targetLanguage). Each call requires an on-chain AVAX payment.",
      parameters: {
        type: "object",
        properties: {
          serviceName: {
            type: "string",
            enum: ["summarize", "sentiment", "translate"],
            description: "The name of the service to call",
          },
          text: {
            type: "string",
            description: "The text to process",
          },
          targetLanguage: {
            type: "string",
            description:
              "Required when serviceName is 'translate'. The language to translate into, e.g. 'Hindi', 'French', 'Spanish', 'Bengali', 'Japanese'.",
          },
        },
        required: ["serviceName", "text"],
      },
    },
  },
];

// ── call_service implementation ──────────────────────────────────────
interface PaymentRequiredResponse {
  error: "payment_required";
  service: string;
  priceAvax: number;
  contract: string;
}

interface ServiceSuccessResponse {
  service: string;
  result: string;
}

async function callService(
  serviceName: string,
  text: string,
  targetLanguage?: string
): Promise<string> {
  const url = `${SERVICES_URL}/${serviceName}`;

  console.log(`\n📡 Calling service: ${serviceName}${targetLanguage ? ` (→ ${targetLanguage})` : ""}`);
  console.log(`   URL: ${url}`);

  const buildBody = (callerAddress: string): Record<string, string> => {
    const b: Record<string, string> = { text, callerAddress };
    if (targetLanguage) b.targetLanguage = targetLanguage;
    return b;
  };

  // First attempt with agent's own address
  let response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(account.address)),
  });

  if (response.status === 402) {
    const paymentInfo = (await response.json()) as PaymentRequiredResponse;
    console.log(`\n💰 Payment required for "${serviceName}"`);
    console.log(`   Price: ${paymentInfo.priceAvax} AVAX`);
    console.log(`   Contract: ${paymentInfo.contract}`);

    const valueWei = parseEther(paymentInfo.priceAvax.toString());
    console.log(`\n🔗 Submitting via Facinet (gasless)...`);

    const txResult = await facinet.executeContract({
      contractAddress: CONTRACT_ADDRESS,
      functionName: "payForService",
      functionArgs: [serviceName],
      abi,
      value: valueWei.toString(),
    });

    console.log(
      `   ✅ Tx submitted: https://testnet.snowtrace.io/tx/${txResult.txHash}`
    );
    console.log(
      `   🏗️  Facilitator: ${txResult.facilitator.name} (${txResult.facilitator.id.slice(0, 8)}…)`
    );
    if (txResult.gasUsed) {
      console.log(`   ⛽ Gas used: ${txResult.gasUsed} (paid by facilitator)`);
    }

    // The contract records lastPayment[msg.sender] = facilitator wallet.
    // So we retry using the facilitator's wallet address as callerAddress —
    // the service will call hasAccess(facilitatorWallet) which returns true.
    const facilitatorWallet = txResult.facilitator.wallet as string;
    console.log(`   🔑 Access recorded for facilitator: ${facilitatorWallet}`);

    // Wait for chain state to propagate
    await new Promise((r) => setTimeout(r, 3000));

    console.log(`\n🔄 Retrying service call as facilitator wallet...`);
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(facilitatorWallet)),
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Service ${serviceName} failed (${response.status}): ${errText}`
    );
  }

  const data = (await response.json()) as ServiceSuccessResponse;
  console.log(`   ✅ ${serviceName} result received`);
  return data.result;
}

// ── Groq tool-calling loop ───────────────────────────────────────────
async function runAgent(userPrompt: string): Promise<void> {
  console.log("\n🧠 Starting Groq tool-calling loop...\n");

  const messages: Groq.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are an AI orchestrator. You have access to three paid microservices via the call_service tool:
- "summarize": Summarizes text in 2 sentences
- "sentiment": Returns a sentiment score (-1 to 1) and label (positive/negative/neutral)
- "translate": Translates text to any language — you MUST pass the targetLanguage field (e.g. "French", "Hindi", "Bengali", "Japanese"). Infer the target language from the user's request.

Rules:
- Only call services the user explicitly asks for.
- For translate, always include targetLanguage inferred from the user's request.
- Call services in a logical order (e.g. summarize first, then translate the summary).
- After all results are in, compose a clear final response presenting each output.`,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];

  let iteration = 0;
  const MAX_ITERATIONS = 10;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`─── Iteration ${iteration} ───`);

    const response = await groq.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 1024,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("No response from Groq");

    const assistantMessage = choice.message;

    messages.push({
      role: "assistant",
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    if (
      !assistantMessage.tool_calls ||
      assistantMessage.tool_calls.length === 0
    ) {
      console.log("\n" + "═".repeat(70));
      console.log("📊 RESULT");
      console.log("═".repeat(70));
      console.log(assistantMessage.content);
      console.log("═".repeat(70));
      return;
    }

    for (const toolCall of assistantMessage.tool_calls) {
      const { name, arguments: argsStr } = toolCall.function;
      const args = JSON.parse(argsStr) as {
        serviceName: string;
        text: string;
        targetLanguage?: string;
      };

      console.log(
        `\n🔧 Tool call: ${name}(serviceName="${args.serviceName}"${args.targetLanguage ? `, targetLanguage="${args.targetLanguage}"` : ""})`
      );

      let result: string;
      try {
        result = await callService(args.serviceName, args.text, args.targetLanguage);
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`   ❌ ${result}`);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  console.log("⚠️ Max iterations reached without final response.");
}

// ── CLI prompt helper ─────────────────────────────────────────────────
function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Main REPL loop ────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("═".repeat(70));
  console.log("🤖 AGENTAG — AI Agent with Gasless Payments (Facinet)");
  console.log("═".repeat(70));
  console.log(`\n📋 Wallet address: ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`💎 Balance: ${formatEther(balance)} AVAX`);
  console.log(`📝 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`🌐 Network: Avalanche Fuji (gas paid by Facinet facilitator)`);

  console.log(`\nAvailable services:`);
  console.log(`  • summarize  — summarize text into 2 sentences  (0.001 AVAX)`);
  console.log(`  • sentiment  — score sentiment -1 to 1          (0.0005 AVAX)`);
  console.log(`  • translate  — translate to any language        (0.0008 AVAX)`);
  console.log(`\nExample prompts:`);
  console.log(`  > Summarize this: <your text>`);
  console.log(`  > Translate this to French: <your text>`);
  console.log(`  > Translate this to Bengali and score the sentiment: <your text>`);
  console.log(`  > Summarize, translate to Japanese, and score sentiment: <your text>`);
  console.log(`\nType "exit" to quit.\n`);

  while (true) {
    const task = await prompt("❯ ");

    if (task.toLowerCase() === "exit") {
      console.log("\n👋 Goodbye!");
      process.exit(0);
    }

    if (!task) {
      console.log("⚠️  Please enter a task.\n");
      continue;
    }

    try {
      await runAgent(task);
    } catch (err) {
      console.error(
        `\n❌ Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});