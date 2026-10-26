import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const MAX_BODY = 4096;
const emailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

export function monitorConfiguration(env) {
  const origin = new URL(env.MONITOR_ORIGIN || "");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("monitor_configuration");
  const expiresAt = Date.parse(env.MONITOR_EXPIRES_AT || "");
  if (!Number.isFinite(expiresAt) || !env.MONITOR_REGION) throw new Error("monitor_configuration");
  return {
    origin: origin.origin,
    expiresAt,
    region: env.MONITOR_REGION,
    bypass: env.MONITOR_PROTECTION_BYPASS || "",
    recipient: env.MONITOR_ALERT_TO || "",
    sender: env.MONITOR_ALERT_FROM || "",
    resendKey: env.MONITOR_RESEND_API_KEY || "",
  };
}

async function boundedJson(response) {
  if (!response.body || Number(response.headers.get("content-length")) > MAX_BODY)
    throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid_response");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function deadline(ms, work) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("monitor_timeout"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function probeAvailability(config, options = {}) {
  const fetcher = options.fetcher || fetch;
  const clock = options.clock || Date.now;
  if (clock() >= config.expiresAt) return { status: "expired" };
  if (!config.bypass) return { status: "configuration_required" };
  const timeout = Math.min(options.timeoutMs || 15000, config.expiresAt - clock());
  try {
    return await deadline(timeout, async (signal) => {
      const path = options.testAlert ? "/api/health/__monitor_test__" : "/api/health";
      const response = await fetcher(`${config.origin}${path}`, {
        redirect: "manual",
        headers: { "x-vercel-protection-bypass": config.bypass, Accept: "application/json" },
        signal,
      });
      if (response.status >= 300 && response.status < 400)
        return { status: "unhealthy", reason: "redirect" };
      if (response.status === 401 || response.status === 403)
        return { status: "unhealthy", reason: "authentication" };
      if (response.status !== 200) return { status: "unhealthy", reason: "http_status" };
      if (!response.headers.get("content-type")?.includes("application/json"))
        return { status: "unhealthy", reason: "invalid_response" };
      const body = await boundedJson(response);
      const time = Date.parse(body?.time || "");
      if (
        body?.status !== "ok" ||
        body?.database !== "Neon PostgreSQL" ||
        body?.region !== config.region ||
        !Number.isFinite(time) ||
        clock() - time > 300000 ||
        time - clock() > 60000
      )
        return { status: "unhealthy", reason: "invalid_response" };
      return { status: "healthy" };
    });
  } catch {
    return { status: "unhealthy", reason: "unreachable_or_invalid" };
  }
}

export function monitorAlert(config, now, testAlert = false) {
  if (
    !emailPattern.test(config.recipient) ||
    config.recipient.length > 254 ||
    !config.sender ||
    /[\r\n]/.test(config.sender) ||
    !config.resendKey
  )
    throw new Error("monitor_configuration");
  const interval = new Date(Math.floor(now / 900000) * 900000).toISOString();
  return {
    key:
      (testAlert ? "ops-external-monitor-test-" : "ops-external-monitor-") +
      createHash("sha256")
        .update(`${config.origin}\n${config.recipient}\n${config.sender}\n${interval}`)
        .digest("hex"),
    body: {
      from: config.sender,
      to: config.recipient,
      subject: testAlert
        ? "Bianchino: prova controllata del monitor (preview)"
        : "Bianchino: controllo esterno non riuscito (preview)",
      text: `${testAlert ? "Questa è la prova controllata del monitor: è stato richiesto un percorso di verifica inesistente, senza fermare l’app. Il controllo è fallito due volte come previsto." : "Il controllo esterno di Bianchino non è riuscito due volte consecutive."}\n\nAmbiente: Preview tecnica\nIndirizzo: ${config.origin}\nIntervallo: ${interval}\n\nVerifica disponibilità, configurazione e servizi secondo la procedura operativa. Mantieni chiusi gli accessi durante un recupero.\n\nL’avviso non contiene dati cliente, credenziali, risposta HTTP o dettagli del guasto. La presa in carico del fornitore email non dimostra la ricezione.`,
    },
  };
}

export async function deliverMonitorAlert(config, options = {}) {
  const clock = options.clock || Date.now;
  if (clock() >= config.expiresAt) return { status: "expired" };
  const message = monitorAlert(config, clock(), options.testAlert);
  try {
    return await deadline(
      Math.min(options.timeoutMs || 10000, config.expiresAt - clock()),
      async (signal) => {
        const response = await (options.fetcher || fetch)("https://api.resend.com/emails", {
          method: "POST",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${config.resendKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.key,
          },
          body: JSON.stringify(message.body),
          signal,
        });
        if (!response.ok) return { status: "unconfirmed" };
        const body = await boundedJson(response);
        return typeof body?.id === "string" && body.id
          ? { status: "provider_accepted" }
          : { status: "unconfirmed" };
      },
    );
  } catch {
    return { status: "unconfirmed" };
  }
}

export async function runAvailabilityMonitor(env, options = {}) {
  let config;
  try {
    config = monitorConfiguration(env);
  } catch {
    return { status: "configuration_required", alert: "not_attempted" };
  }
  const clock = options.clock || Date.now;
  if (clock() >= config.expiresAt) return { status: "expired", alert: "not_attempted" };
  const first = await probeAvailability(config, options);
  if (first.status !== "unhealthy") return { ...first, alert: "not_attempted", attempts: 1 };
  await (options.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(1000);
  const second = await probeAvailability(config, options);
  if (second.status === "healthy")
    return { status: "healthy_after_retry", alert: "not_attempted", attempts: 2 };
  if (second.status !== "unhealthy") return { ...second, alert: "not_attempted", attempts: 2 };
  if (!options.notify)
    return { status: "unhealthy", reason: second.reason, alert: "disabled", attempts: 2 };
  try {
    const delivered = await deliverMonitorAlert(config, {
      ...options,
      fetcher: options.emailFetcher || options.fetcher,
    });
    return {
      status: delivered.status === "expired" ? "expired" : "unhealthy",
      reason: second.reason,
      alert: delivered.status,
      attempts: 2,
    };
  } catch {
    return { status: "configuration_required", alert: "not_attempted", attempts: 2 };
  }
}

export async function monitorMain(args = process.argv.slice(2), env = process.env) {
  try {
    let profile;
    let notify = false;
    let testAlert = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--notify") notify = true;
      else if (args[i] === "--test-alert") testAlert = true;
      else if (args[i] === "--profile" && args[i + 1]) profile = args[++i];
      else throw new Error("monitor_configuration");
    }
    const result = await runAvailabilityMonitor(
      profile ? parseEnv(readFileSync(profile, "utf8")) : env,
      { notify, testAlert },
    );
    console.log(JSON.stringify(result));
    return ["healthy", "healthy_after_retry", "expired"].includes(result.status) ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ status: "configuration_required", alert: "not_attempted" }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void monitorMain().then((code) => {
    process.exitCode = code;
  });
