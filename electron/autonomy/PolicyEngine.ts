import type { PolicyEvaluationInput, PolicyEvaluationResult } from "./types";

export class PolicyEngine {
  private static instance: PolicyEngine;
  private readonly allowSystemMutations = false;

  public static getInstance(): PolicyEngine {
    if (!PolicyEngine.instance) {
      PolicyEngine.instance = new PolicyEngine();
    }
    return PolicyEngine.instance;
  }

  public evaluate(input: PolicyEvaluationInput): PolicyEvaluationResult {
    const { action, initiatedBy, autonomyLevel } = input;

    if (action.policyClass === "read" || action.policyClass === "verify") {
      return {
        decision: "allow",
        reason: "Read-only evidence collection is allowed automatically.",
      };
    }

    if (action.policyClass === "destructive") {
      return {
        decision: initiatedBy === "user" ? "allow-with-confirmation" : "deny",
        reason: "Destructive actions are never executed automatically.",
      };
    }

    if (action.policyClass === "code-edit") {
      return {
        decision: "allow-with-confirmation",
        reason: "Code edits require an explicit user-triggered confirmation boundary.",
      };
    }

    if (action.policyClass === "control") {
      if (
        initiatedBy === "system" &&
        autonomyLevel === "bounded-auto" &&
        action.safeForBoundedAuto &&
        !action.confirmationRequired &&
        this.allowSystemMutations
      ) {
        return {
          decision: "allow",
          reason: "This control action is marked safe for bounded auto mode.",
        };
      }

      return {
        decision: "allow-with-confirmation",
        reason: "Operational control actions remain user-confirmed in the current passive runtime slice.",
      };
    }

    return {
      decision: "escalate",
      reason: "The action could not be classified confidently and should be escalated.",
    };
  }
}
