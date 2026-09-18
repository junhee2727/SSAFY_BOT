export type FeatureName = 'tasks' | 'mail' | 'summary' | 'delivery';
export type FeatureStatus =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'succeeded'; at: string }
  | { state: 'failed'; at: string };

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// Each awaited unit of work is isolated. Feature adapters must route every
// scheduled/event-driven operation through run(), not launch detached promises.
export class FeatureRunner {
  private readonly statuses = new Map<FeatureName, FeatureStatus>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  status(name: FeatureName): FeatureStatus {
    return this.statuses.get(name) ?? { state: 'idle' };
  }

  async run(name: FeatureName, operation: () => Promise<void>): Promise<boolean> {
    if (this.status(name).state === 'running') return false;
    this.statuses.set(name, { state: 'running' });
    try {
      await operation();
      this.statuses.set(name, { state: 'succeeded', at: new Date().toISOString() });
      return true;
    } catch {
      this.statuses.set(name, { state: 'failed', at: new Date().toISOString() });
      // External errors can contain credentials and message bodies.
      this.logger.error(`${name}: 작업 실패. 해당 기능의 연결 및 인증 설정을 확인하세요.`);
      return false;
    }
  }
}
