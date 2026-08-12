export interface ActiveJavaScriptExecution {
  tid: number;
  finished: Promise<void>;
  stop: () => Promise<void>;
}

export const state = {
  activeExecutions: 0,
  activeJavaScriptExecutions: new Set<ActiveJavaScriptExecution>(),
  backendUnavailable: false,
  pollInProgress: false,
  reinstallScheduled: false,
  tabCreationQueue: Promise.resolve() as Promise<void>,
  tabExecutionQueues: new Map<number, Promise<void>>(),
};
