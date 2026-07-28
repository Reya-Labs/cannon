import { loop as registryLoop } from './registry';
export * from './db';

if (require.main === module) {
  void registryLoop();
}
