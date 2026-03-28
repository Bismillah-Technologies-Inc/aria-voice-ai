import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadEnvFile(environment) {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, `.env.${environment}`),
    path.join(cwd, '.env'),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separator = trimmed.indexOf('=');
      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = parseEnvValue(trimmed.slice(separator + 1));
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }

    return filePath;
  }

  return path.join(cwd, `.env.${environment}`);
}

export function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export function upsertEnvFile(filePath, entries) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  for (const [key, value] of Object.entries(entries)) {
    if (!value) {
      continue;
    }

    const escaped = String(value).replace(/\$/g, '$$$$');
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(content)) {
      content = content.replace(pattern, `${key}=${escaped}`);
    } else {
      if (content && !content.endsWith('\n')) {
        content += '\n';
      }
      content += `${key}=${escaped}\n`;
    }
  }

  fs.writeFileSync(filePath, content);
}

export function getStackOutput(stackName, outputKey, region) {
  return execFileSync(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      stackName,
      '--query',
      `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue`,
      '--output',
      'text',
      '--region',
      region,
      '--no-cli-pager',
    ],
    {
      encoding: 'utf8',
    }
  ).trim();
}
