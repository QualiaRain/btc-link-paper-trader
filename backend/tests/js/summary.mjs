// Prints the EXISTING engine.js getSummary() of each account in a JSON array read from stdin.
import {readFileSync} from 'node:fs';
import {getSummary} from '../../../engine.js';

const accounts = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(accounts.map(account => getSummary(account))));
