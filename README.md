# Ollama Share Gateway

A lightweight proxy server to share your local Ollama instance with other devices on your network. Features include refined logging (Request/Response only), token estimation, and streaming support.

## 🚀 Setup

### 1. Prerequisites
- **Node.js** (v18 or higher)
- **Ollama** installed on the host machine

### 2. Installation
```bash
# Clone or copy the files
cd ollama_share
npm install
```

### 3. Configuration
Rename `.env.example` to `.env` and adjust settings if needed:
```bash
cp .env.example .env
```

### 4. Start the Server
```bash
# For production
npm start

# For development (with auto-restart)
npm run dev
```
The server will:
1. Automatically start the `ollama serve` process.
2. Wait for Ollama to be ready.
3. Warm up the default model (llama3).
4. Start the gateway on port `11435`.

---

## 📱 Connecting Other Devices

To use your Ollama models from another device (phone, tablet, or another laptop), follow these steps:

### 1. Find your Host IP Address
On your Mac (where this server is running):
- Open **System Settings** > **Network** > **Wi-Fi** (or Ethernet) > **Details...**
- Note the **IP Address** (e.g., `192.168.1.15`).
- *Alternatively, run `ipconfig getifaddr en0` in the terminal.*

### 2. Configure Remote Apps
Point your LLM client (like OpenWebUI, Enchanted, or custom apps) to the following URL:

**Base URL:** `http://YOUR_HOST_IP:11435`

For example, if your IP is `192.168.1.15`, use:
`http://192.168.1.15:11435`

### 3. API Compatibility
The gateway is fully compatible with the standard Ollama API:
- `/api/generate`
- `/api/chat`
- `/api/tags` (List models)

---

## 🛠 Troubleshooting

### Connection Refused
- Ensure both devices are on the **same Wi-Fi network**.
- Check if your Mac's Firewall is blocking port `11435` (**System Settings** > **Network** > **Firewall**).

### Model Not Found
- Ensure you have pulled the model on the host machine: `ollama pull <model_name>`.

### High Latency
- Large models require significant RAM/GPU. If generation is slow, try a smaller model like `phi3` or `llama3:8b`.

---

## 📝 Logging
The terminal will strictly show only request and response traffic to help you monitor usage without clutter:
- `[REQUEST]` - Method, Path, Model, and Input Tokens.
- `[RESPONSE]` - Status, Duration, and Output Tokens.
