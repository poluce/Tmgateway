import { formatCliCommand } from "../cli/command-format.js";

export function isSystemdUnavailableDetail(detail?: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("systemctl --user unavailable") ||
    normalized.includes("systemctl not available") ||
    normalized.includes("not been booted with systemd") ||
    normalized.includes("failed to connect to bus") ||
    normalized.includes("systemd user services are required")
  );
}

export function renderSystemdUnavailableHints(options: { wsl?: boolean } = {}): string[] {
  if (options.wsl) {
    return [
      "WSL2 需要启用 systemd：编辑 /etc/wsl.conf 添加 [boot]\\nsystemd=true",
      "然后运行：wsl --shutdown（从 PowerShell）并重新打开您的发行版。",
      "验证：systemctl --user status",
    ];
  }
  return [
    "systemd 用户服务不可用；请安装/启用 systemd 或在您的进程管理器下运行网关。",
    `如果您在容器中，请在前台运行网关而不是 \`${formatCliCommand("openclaw gateway")}\`。`,
  ];
}
