#!/usr/bin/env node
import { loadConfig } from '../src/config/index.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { runMaxMindUpdate } from '../src/enrichment/maxmind-updater.js';

const logger = {
    info(context, message) {
        console.log(message ?? context);
    },
    warn(context, message) {
        if (typeof context === 'string') {
            console.warn(context);
            return;
        }
        console.warn(message ?? 'MaxMind update warning');
    },
};

async function main() {
    try {
        loadEnvFile();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
    }

    let config;
    try {
        config = loadConfig();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
    }

    if (!config.maxmind.enabled) {
        console.log('MaxMind is disabled by configuration.');
        return;
    }
    if (!config.maxmind.licenseKey) {
        console.error('MAXMIND_LICENSE_KEY is not configured; no download was attempted.');
        process.exitCode = 2;
        return;
    }

    const force = process.argv.includes('--force');
    console.log(`Starting MaxMind update${force ? ' (force)' : ''}...`);

    try {
        const result = await runMaxMindUpdate({
            config: config.maxmind,
            logger,
            force,
        });

        for (const item of result.results) {
            const detail = item.status === 'updated'
                ? `sha256=${item.sha256.slice(0, 12)}... size=${item.size}`
                : (item.reason ?? '');
            console.log(`${item.edition}: ${item.status}${detail ? ` (${detail})` : ''}`);
        }

        console.log(`Update status: ${result.status}`);
        if (result.status === 'partial_failure') {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(`MaxMind update failed (${error?.code ?? 'update_failed'}).`);
        process.exitCode = 1;
    }
}

main();
