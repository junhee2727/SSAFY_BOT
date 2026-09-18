import type { AppConfig } from '../config/config.ts';
import { openDatabase } from '../storage/database.ts';
import { FeatureRunner } from './feature-runner.ts';
import type { Logger } from './feature-runner.ts';

export function createApplication(config: AppConfig, logger: Logger = console) {
  const database = openDatabase(config.databasePath);
  const features = new FeatureRunner(logger);
  let closed = false;
  return {
    config,
    database,
    features,
    close(): void {
      if (!closed) {
        database.close();
        closed = true;
      }
    },
  };
}
