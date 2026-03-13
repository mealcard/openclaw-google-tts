#!/usr/bin/env node
/**
 * One-time OAuth 2.0 setup for Google Cloud TTS.
 *
 * Usage:
 *   node src/oauth-setup.mjs [path-to-client-secret.json]
 *
 * Default client secret path:
 *   ~/Downloads/client_secret_91567999493-*.apps.googleusercontent.com.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, "..", "google-tts-tokens.json");
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];
const REDIRECT_PORT = 8085;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

async function findClientSecret(hint) {
  if (hint) return JSON.parse(await fs.readFile(hint, "utf8"));

  // Auto-discover from ~/Downloads
  const dlDir = path.join(process.env.HOME, "Downloads");
  const files = await fs.readdir(dlDir);
  const match = files.find(
    (f) => f.startsWith("client_secret_") && f.endsWith(".json"),
  );
  if (!match) throw new Error("No client_secret_*.json found in ~/Downloads");
  console.log(`Found: ${path.join(dlDir, match)}`);
  return JSON.parse(await fs.readFile(path.join(dlDir, match), "utf8"));
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

async function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<h2>Authorization denied: ${error}</h2><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth denied: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h2>Authorization successful!</h2><p>You can close this tab.</p>");
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400);
      res.end("Missing code");
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Listening on ${REDIRECT_URI} for OAuth callback...`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for OAuth callback (120s)"));
    }, 120_000);
  });
}

async function exchangeCode(clientId, clientSecret, code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

// --- main ---
const secretFile = process.argv[2] || undefined;
const creds = await findClientSecret(secretFile);
const installed = creds.installed || creds.web;
if (!installed) throw new Error("Invalid client secret JSON structure");

const { client_id, client_secret } = installed;

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", client_id);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("\nOpening browser for Google authorization...\n");
openBrowser(authUrl.toString());

const code = await waitForAuthCode();
console.log("Got authorization code, exchanging for tokens...");

const tokens = await exchangeCode(client_id, client_secret, code);

const stored = {
  client_id,
  client_secret,
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token,
  expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  scope: tokens.scope,
};

await fs.writeFile(TOKEN_PATH, JSON.stringify(stored, null, 2));
console.log(`\nTokens saved to ${TOKEN_PATH}`);
console.log("Setup complete! The google-tts plugin will now use OAuth.");
