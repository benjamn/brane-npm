import { defineCommand } from "citty";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureBraneDir } from "../db/schema.js";
import { getTailscaleHost } from "../tailscale.js";
import { provisionTlsCert } from "../tls.js";

function getCertsDir(): string {
  const dir = join(ensureBraneDir(), "certs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTlsCertPath(): string {
  return join(getCertsDir(), "tls.crt");
}

export function getTlsKeyPath(): string {
  return join(getCertsDir(), "tls.key");
}

export const certifyCommand = defineCommand({
  meta: {
    name: "certify",
    description: "Provision TLS certificates for Tailscale HTTPS access",
  },
  args: {
    host: {
      type: "string",
      description: "Tailscale hostname to certify (default: auto-detect)",
    },
  },
  async run({ args }) {
    const host = args.host ?? getTailscaleHost();
    if (!host) {
      console.error(
        "Could not detect Tailscale hostname. Is Tailscale running?\n" +
        "Use --host to specify the hostname manually.",
      );
      process.exit(1);
    }

    const certPath = getTlsCertPath();
    const keyPath = getTlsKeyPath();

    console.log(`Provisioning TLS certificate for ${host}...`);

    const result = await provisionTlsCert({
      host,
      certPath,
      keyPath,
    });

    if (!result.ok) {
      console.error(`\nFailed to provision certificate (${result.reason}): ${result.message}`);
      if (result.stderr) console.error(result.stderr);
      if (result.reason === "https_not_enabled") {
        console.error(
          "\nEnable HTTPS for your tailnet at https://login.tailscale.com/admin/dns",
        );
      } else if (result.reason === "tailscale_missing") {
        console.error("\nInstall Tailscale: https://tailscale.com/download");
      }
      process.exit(1);
    }

    console.log(`\nCertificate written to ${result.certPath}`);
    console.log(`Key written to ${result.keyPath}`);
    console.log(`Expires: ${result.notAfter.toISOString()}`);
    console.log(
      `\nA running daemon will pick up the new cert automatically via fs.watch — no restart needed.`,
    );
  },
});
