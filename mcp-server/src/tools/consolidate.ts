// memory_consolidate — Trigger chunk consolidation (shells out to consolidate.js)

import { execFile } from 'child_process';
import * as path from 'path';

interface ConsolidateResult {
  success: boolean;
  output: string;
  dryRun: boolean;
}

export async function consolidate(dryRun: boolean = true, days: number = 14): Promise<ConsolidateResult> {
  const scriptPath = path.resolve(__dirname, '../../../consolidate.js');

  const args: string[] = [];
  if (dryRun) args.push('--dry-run');
  args.push('--days', String(days));

  return new Promise((resolve) => {
    execFile('node', [scriptPath, ...args], {
      timeout: 300000, // 5 min max
      cwd: path.dirname(scriptPath),
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          output: `Error: ${error.message}\n${stderr || ''}`,
          dryRun,
        });
        return;
      }
      resolve({
        success: true,
        output: stdout + (stderr ? `\n${stderr}` : ''),
        dryRun,
      });
    });
  });
}

export const consolidateTool = {
  name: 'memory_consolidate',
  description: 'Trigger memory consolidation — compacts old chunks into summaries using LLM. Default is dry-run mode (preview only). Set dry_run=false to execute.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      dry_run: {
        type: 'boolean',
        description: 'Preview what would be consolidated without actually doing it (default: true)',
      },
      days: {
        type: 'number',
        description: 'Consolidate chunks older than N days (default: 14)',
      },
    },
  },
};
