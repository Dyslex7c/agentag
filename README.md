# Agentag — AI Agent That Pays Smart Contracts to Access Microservices

An autonomous AI agent powered by Groq SDK that plans and executes multi-step tasks by calling paid microservices. Each microservice is protected by a Solidity smart contract on **Avalanche Fuji testnet**. The agent detects when a service requires payment, pays in test AVAX, and retries — all without human intervention.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  Groq LLM   │◄───►│  Orchestrator    │────►│  Hono Microservice │
│  (tool calls)│     │  Agent (viem)    │     │  /summarize        │
└─────────────┘     │                  │     │  /sentiment        │
                    │  Detects 402 ──► │     │  /translate        │
                    │  Pays contract   │     └────────┬───────────┘
                    │  Retries call    │              │
                    └────────┬─────────┘              │
                             │                        │ hasAccess()
                             │ payForService()        │
                             ▼                        ▼
                    ┌──────────────────────────────────┐
                    │  ServiceRegistry.sol (Fuji)      │
                    │  Avalanche C-Chain Testnet       │
                    └──────────────────────────────────┘
```

## Project Structure

```
/contracts                         ← Foundry project
  src/ServiceRegistry.sol          ← Smart contract
  test/ServiceRegistry.t.sol       ← Foundry tests
  script/Deploy.s.sol              ← Deploy script
  foundry.toml                     ← Fuji config

/packages
  /shared
    abi/ServiceRegistry.json       ← ABI (copied from forge build)
  /services
    src/index.ts                   ← Hono server (3 routes)
  /agent
    src/index.ts                   ← Orchestrator agent

package.json                       ← npm workspaces root
tsconfig.base.json                 ← Shared TS config (strict)
.env.example                       ← Environment variables
```

## Prerequisites

- **Node.js** ≥ 18
- **Foundry** (`forge`, `cast`) — [Install](https://book.getfoundry.sh/getting-started/installation)
- **Funded Avalanche Fuji wallet** — [Faucet](https://faucet.avax.network/)
- **Groq API key** (free tier) — [Console](https://console.groq.com/)

## Quick Start

### 1. Clone & install dependencies

```bash
npm install
```

### 2. Build the smart contract

```bash
cd contracts
forge build
```

### 3. Deploy to Fuji

```bash
forge script script/Deploy.s.sol \
  --rpc-url https://api.avax-test.network/ext/bc/C/rpc \
  --broadcast \
  --private-key $PRIVATE_KEY
```

Copy the deployed contract address from the output.

### 4. Copy ABI (if rebuilding)

```bash
# From the project root:
cp contracts/out/ServiceRegistry.sol/ServiceRegistry.json /tmp/full.json
python3 -c "import json; d=json.load(open('/tmp/full.json')); json.dump(d['abi'], open('packages/shared/abi/ServiceRegistry.json','w'), indent=2)"
```

> The ABI is already included in `packages/shared/abi/` — you only need this step if you modify the contract.

### 5. Configure environment

```bash
cp .env.example .env
# Edit .env with your values:
#   PRIVATE_KEY=0x...
#   CONTRACT_ADDRESS=0x...
#   GROQ_API_KEY=gsk_...
#   SERVICES_URL=http://localhost:3001
```

### 6. Start the microservices

```bash
npm run dev -w @agentag/services
```

### 7. Run the agent (in another terminal)

```bash
npm start -w @agentag/agent
```

## What Happens

1. The agent sends a hardcoded paragraph to Groq with tool definitions
2. Groq plans the execution: summarize → sentiment → translate
3. For each tool call, the agent POSTs to the microservice
4. The service checks `hasAccess()` on-chain and returns **HTTP 402** if not paid
5. The agent reads the 402 response, calls `payForService()` with the exact AVAX amount
6. After payment confirms on-chain, the agent retries the service call
7. Results are sent back to Groq, which composes the final output

## Contract Tests

```bash
cd contracts
forge test -vvv
```

## Environment Variables

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Funded Fuji wallet private key (with `0x` prefix) |
| `CONTRACT_ADDRESS` | Deployed ServiceRegistry address |
| `GROQ_API_KEY` | Groq API key (free tier) |
| `SERVICES_URL` | Microservices URL (default: `http://localhost:3001`) |

## Tech Stack

- **Smart Contract**: Solidity 0.8.24, Foundry
- **Blockchain**: Avalanche Fuji C-Chain (testnet), viem
- **AI**: Groq SDK, llama-3.3-70b-versatile
- **Services**: Hono + @hono/node-server
- **Language**: TypeScript (strict mode), npm workspaces
