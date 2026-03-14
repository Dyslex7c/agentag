import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
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

const walletClient = createWalletClient({
  account,
  chain: avalancheFuji,
  transport: http(),
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
        "Call a paid microservice. Available services: 'summarize' (summarizes text in 2 sentences), 'sentiment' (returns sentiment score and label), 'translate' (translates text to Hindi). Each call may require an on-chain AVAX payment.",
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
  text: string
): Promise<string> {
  const url = `${SERVICES_URL}/${serviceName}`;

  console.log(`\n📡 Calling service: ${serviceName}`);
  console.log(`   URL: ${url}`);

  let response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, callerAddress: account.address }),
  });

  if (response.status === 402) {
    const paymentInfo = (await response.json()) as PaymentRequiredResponse;
    console.log(`\n💰 Payment required for "${serviceName}"`);
    console.log(`   Price: ${paymentInfo.priceAvax} AVAX`);
    console.log(`   Contract: ${paymentInfo.contract}`);

    const valueWei = parseEther(paymentInfo.priceAvax.toString());
    console.log(`\n🔗 Sending payment via viem walletClient...`);

    const hash = await walletClient.writeContract({
      address: CONTRACT_ADDRESS,
      abi,
      functionName: "payForService",
      args: [serviceName],
      value: valueWei,
    });

    console.log(`   ✅ Tx submitted: https://testnet.snowtrace.io/tx/${hash}`);
    console.log(`   ⏳ Waiting for confirmation...`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   ⛽ Gas used: ${receipt.gasUsed}`);
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

    console.log(`\n🔄 Retrying service call: ${serviceName}`);
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, callerAddress: account.address }),
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
- "translate": Translates text to Hindi

The user will give you a task and some text. Figure out which services are needed based on what they ask for, and call only those services in a logical order. If they ask to translate, use "translate". If they ask to summarize, use "summarize". If they ask for sentiment, use "sentiment". Don't call services the user didn't ask for. After receiving all results, compose a clear final response.`,
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
      };

      console.log(`\n🔧 Tool call: ${name}(serviceName="${args.serviceName}")`);

      let result: string;
      try {
        result = await callService(args.serviceName, args.text);
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
  console.log("🤖 AGENTAG — AI Agent with Smart Contract Payments");
  console.log("═".repeat(70));
  console.log(`\n📋 Wallet address: ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`💎 Balance: ${formatEther(balance)} AVAX`);
  console.log(`📝 Contract: ${CONTRACT_ADDRESS}`);
  console.log(`🌐 Network: Avalanche Fuji`);

  console.log(`\nAvailable services:`);
  console.log(`  • summarize  — summarize text into 2 sentences  (0.001 AVAX)`);
  console.log(`  • sentiment  — score sentiment -1 to 1          (0.0005 AVAX)`);
  console.log(`  • translate  — translate text to Hindi          (0.0008 AVAX)`);
  console.log(`\nExample prompts:`);
  console.log(`  > Summarize this: <your text>`);
  console.log(`  > Translate and score the sentiment of this: <your text>`);
  console.log(`  > Summarize, translate to Hindi, and score sentiment: <your text>`);
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