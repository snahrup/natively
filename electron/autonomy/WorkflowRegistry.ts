import type { AppAdapter, DesktopContext, WorkflowDescriptor } from "./types";

export class WorkflowRegistry {
  private readonly adapters = new Map<string, AppAdapter>();
  private readonly descriptors = new Map<string, WorkflowDescriptor>();

  public registerAdapter(adapter: AppAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public getAdapter(adapterId: string): AppAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  public getDescriptor(workflowId: string): WorkflowDescriptor | undefined {
    return this.descriptors.get(workflowId);
  }

  public listDescriptors(): WorkflowDescriptor[] {
    return [...this.descriptors.values()];
  }

  public async refresh(ctx: DesktopContext): Promise<WorkflowDescriptor[]> {
    this.descriptors.clear();

    for (const adapter of this.adapters.values()) {
      const matches = await adapter.matchesContext(ctx);
      if (!matches) continue;

      const workflows = await adapter.listWorkflows(ctx);
      for (const workflow of workflows) {
        this.descriptors.set(workflow.workflowId, workflow);
      }
    }

    return this.listDescriptors();
  }
}
