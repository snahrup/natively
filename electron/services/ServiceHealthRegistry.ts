// ServiceHealthRegistry
// Visible health state for background services. Bootstrap failures were
// previously catch-log-continue: a service could be dead for an entire
// 8-12h session with the only evidence buried in the debug log. Init sites
// report here, and the Context Hub status surface renders the result.

export type ServiceHealthStatus = "ok" | "degraded" | "failed";

export interface ServiceHealthEntry {
  name: string;
  status: ServiceHealthStatus;
  detail: string | null;
  updatedAt: string;
}

export class ServiceHealthRegistry {
  private static instance: ServiceHealthRegistry;
  private entries = new Map<string, ServiceHealthEntry>();

  static getInstance(): ServiceHealthRegistry {
    if (!ServiceHealthRegistry.instance) {
      ServiceHealthRegistry.instance = new ServiceHealthRegistry();
    }
    return ServiceHealthRegistry.instance;
  }

  markOk(name: string, detail?: string): void {
    this.set(name, "ok", detail ?? null);
  }

  markDegraded(name: string, detail: string): void {
    this.set(name, "degraded", detail);
  }

  markFailed(name: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error ?? "unknown error");
    this.set(name, "failed", detail);
    console.error(`[ServiceHealth] ${name} FAILED: ${detail}`);
  }

  getAll(): ServiceHealthEntry[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getProblems(): ServiceHealthEntry[] {
    return this.getAll().filter((entry) => entry.status !== "ok");
  }

  private set(name: string, status: ServiceHealthStatus, detail: string | null): void {
    this.entries.set(name, {
      name,
      status,
      detail,
      updatedAt: new Date().toISOString(),
    });
  }
}
