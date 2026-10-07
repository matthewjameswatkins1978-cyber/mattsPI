export interface ChildModelRoute {
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
}

/** Return only the route chosen for this task; coordinator state is never implicit. */
export function resolveChildModelRoute(explicit: ChildModelRoute): ChildModelRoute {
  return {
    ...(explicit.provider && explicit.modelId
      ? { provider: explicit.provider, modelId: explicit.modelId }
      : {}),
    ...(explicit.thinkingLevel ? { thinkingLevel: explicit.thinkingLevel } : {}),
  };
}
