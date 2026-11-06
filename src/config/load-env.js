import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFile(filePath = resolve(process.cwd(), '.env')) {
    if (!existsSync(filePath)) {
        return false;
    }

    try {
        process.loadEnvFile(filePath);
        return true;
    } catch {
        throw new Error('Failed to load .env file (check syntax and permissions)');
    }
}
