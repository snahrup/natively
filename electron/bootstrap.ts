const fs = require('fs');
const path = require('path');

const bootstrapTraceFile = path.join(process.env.TEMP || process.cwd(), 'natively_bootstrap_trace.log');

function bootstrapTrace(message: string): void {
  try {
    fs.appendFileSync(bootstrapTraceFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Ignore best-effort bootstrap trace failures.
  }
}

bootstrapTrace('bootstrap entry');

bootstrapTrace(`ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE ?? '(unset)'}`);

process.on('uncaughtException', (error: unknown) => {
  bootstrapTrace(`uncaughtException ${error instanceof Error ? error.stack || error.message : String(error)}`);
});

process.on('unhandledRejection', (reason: unknown) => {
  bootstrapTrace(`unhandledRejection ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});

try {
  require('./main');
  bootstrapTrace('bootstrap required main successfully');
} catch (error) {
  bootstrapTrace(`bootstrap failed requiring main: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  throw error;
}
