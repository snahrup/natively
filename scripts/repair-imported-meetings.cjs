const path = require('path');
const fs = require('fs');

function requireElectronModule(relativePath) {
  const fullPath = path.join(process.cwd(), 'dist-electron', 'electron', relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Compiled Electron module not found: ${fullPath}. Run npm run build:electron first.`);
  }
  return require(fullPath);
}

async function main() {
  const { app } = require('electron');
  await app.whenReady();

  const { DatabaseManager } = requireElectronModule(path.join('db', 'DatabaseManager.js'));
  const { RAGManager } = requireElectronModule(path.join('rag', 'RAGManager.js'));
  const { MeetingRepairService } = requireElectronModule(path.join('services', 'MeetingRepairService.js'));
  const { MicrosoftLocalManager } = requireElectronModule(path.join('services', 'MicrosoftLocalManager.js'));

  const dbManager = DatabaseManager.getInstance();
  if (!dbManager.isReady()) {
    throw new Error(dbManager.getInitError() || 'DatabaseManager failed to initialize.');
  }

  const ragManager = new RAGManager({
    db: dbManager.getDb(),
    dbPath: dbManager.getDbPath(),
    extPath: dbManager.getExtPath(),
    ollamaUrl: 'http://localhost:11434',
  });

  await ragManager.getEmbeddingPipeline().waitForReady(30000).catch(() => {});

  const service = new MeetingRepairService();
  const result = await service.repairImportedMeetings({
    allowOutlook: true,
    allowTeams: true,
    ragManager,
  });

  MicrosoftLocalManager.getInstance().stop();

  console.log(JSON.stringify({
    ...result,
    dbPath: dbManager.getDbPath(),
  }, null, 2));

  await app.quit();
}

main().catch((error) => {
  console.error('[repair-imported-meetings] Fatal error:', error);
  process.exitCode = 1;
});
