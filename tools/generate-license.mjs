// @ts-check
import { generateLicense } from './license-core.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node tools/generate-license.mjs --email owner@gmail.com --start "2026-09-01T00:00:00+03:00" --months 3');
  process.exit(0);
}
try {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--email', '--start', '--months'].includes(args[i]) || !args[i + 1] || options[args[i].slice(2)]) throw new Error('Invalid or duplicate arguments. Use --help.');
    options[args[i].slice(2)] = args[i + 1];
  }
  const result = generateLicense(options);
  console.log('\nPRIVATE KEY — give this only to the intended account owner:');
  console.log(result.key);
  console.log('\nEmail:', result.boundEmail);
  console.log('Start (UTC):', result.startsAt, '| Calendar months:', result.months, '| Calendars: 5');
  console.log('\nCOPY ONLY THE FOLLOWING SQL INTO SUPABASE:\n');
  console.log(result.sql);
  console.log('\nNothing was uploaded. Keep this terminal output private.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Generation failed.');
  process.exitCode = 1;
}
