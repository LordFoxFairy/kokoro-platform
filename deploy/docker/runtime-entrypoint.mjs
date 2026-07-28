import process from "node:process";
import { URL } from "node:url";

const serviceEntries = Object.freeze({
  "@kokoro/site": "../../kokoro-site/dist/interfaces/http/main.js",
  "@kokoro/user": "../../kokoro-user/dist/interfaces/http/main.js",
  "@kokoro/model": "../../kokoro-model/dist/interfaces/http/main.js",
  "@kokoro/credit": "../../kokoro-credit/dist/interfaces/http/main.js",
  "@kokoro/payment": "../../kokoro-payment/dist/interfaces/http/main.js",
  "@kokoro/hub": "../../kokoro-hub/dist/interfaces/http/main.js",
  "@kokoro/platform-admin": "../../kokoro-platform-admin/dist/main.js",
});

const selected = process.env.KOKORO_SERVICE_PACKAGE ?? "@kokoro/user";
const entry = serviceEntries[selected];
if (entry === undefined) {
  throw new Error(`Unsupported KOKORO_SERVICE_PACKAGE: ${selected}`);
}

await import(new URL(entry, import.meta.url));
