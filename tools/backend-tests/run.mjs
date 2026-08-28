// @ts-check
import { readConfig, Skip, ensure, consent, safeError, loadState, lock, report } from './core.mjs';
import { smoke } from './smoke.mjs';
import { runDatabase } from './database.mjs';
import { sendEmail, emailStatus, sendSms, checkSms, firebaseToken, fcm } from './providers.mjs';
import { enrollment, invite, booking, cancelBookings, reminders, billing } from './workflows.mjs';

const commands = ['check','db','all','email','email-status','sms-send','sms-check','push','enrollment-start','enrollment-confirm-email','enrollment-sms-send','enrollment-sms-check','enrollment-approval-send','enrollment-approve','invite-send','invite-accept','booking','cancel-bookings','reminders','scheduler','billing'];
const allowedFlags = ['strict','allow-db-writes','allow-writes','allow-messages','allow-worker','allow-billing'];
export async function main(args = process.argv.slice(2)) {
  if(args.includes('--help') || args.includes('-h')) {
    console.log('Backend integration tests (Node 24; Git Bash/CMD/PowerShell).');
    console.log('Commands: '+commands.join(', '));
    console.log('Default: check (no messages, purchases or application-record writes).');
    console.log('Consent flags: '+allowedFlags.map(f=>'--'+f).join(' '));
    console.log('Run npm run test:backend:setup first. Full instructions: SETUP.html#backend-tests.'); return;
  }
  let config = {}, unlock; const rows=[];
  const command=args.find(a=>!a.startsWith('--')) || 'check';
  try {
    ensure(commands.includes(command),'Unknown command; run npm run test:backend -- --help.');
    ensure(args.filter(a=>!a.startsWith('--')).length<=1,'Pass one command at a time. Never pass secrets on the command line.');
    const flags=new Set(args.filter(a=>a.startsWith('--')).map(a=>a.slice(2)));
    ensure([...flags].every(f=>allowedFlags.includes(f)),'Unknown flag.');
    config=await readConfig();
    if(command==='db' || command==='all') consent(flags,'allow-db-writes');
    unlock=await lock();
    console.log(`Backend test command: ${command}. Designated development project: ${config.BACKEND_TEST_PROJECT_REF}.`);
    const state=await loadState(config);
    const check=async(name,body)=>{
      const started=Date.now(); let row;
      try { const detail=await body(); row={name,status:'PASS',...(detail?{detail}:{})}; }
      catch(error) { row={name,status:error instanceof Skip?'SKIP':'FAIL',detail:safeError(error,config)}; }
      row.milliseconds=Date.now()-started; rows.push(row);
      console.log(`${row.status} ${name}${row.detail?' — '+row.detail:''}`);
      return row.status==='PASS';
    };
    if(command==='check' || command==='all') await smoke(config,check);
    if(command==='db' || command==='all') await runDatabase(config,flags,check);
    if(command==='email') await check('Resend live email acceptance',()=>sendEmail(config,flags,state));
    if(command==='email-status') await check('Resend delivery status',()=>emailStatus(config,state));
    if(command==='sms-send') await check('Twilio real SMS request',()=>sendSms(config,flags,state));
    if(command==='sms-check') await check('Twilio real OTP verification',()=>checkSms(config,flags,state));
    if(command==='push') await check('FCM real push acceptance',async()=>{
      consent(flags,'allow-messages'); ensure(config.TEST_DEVICE_OWNED==='true','Set TEST_DEVICE_OWNED=true only for a device you own.');
      await fcm(config,await firebaseToken(config),false);
      return 'FCM accepted the message. Confirm receipt on your phone; acceptance is not device delivery.';
    });
    if(command.startsWith('enrollment-')) await check('Deployed '+command,()=>enrollment(config,flags,state,command.slice('enrollment-'.length)));
    if(command==='invite-send' || command==='invite-accept') await check('Deployed '+command,()=>invite(config,flags,state,command==='invite-accept'));
    if(command==='booking') await check('Deployed booking workflow',()=>booking(config,flags,state));
    if(command==='cancel-bookings') await check('Cancel tracked test bookings',()=>cancelBookings(config,flags,state));
    if(command==='reminders' || command==='scheduler') await check('Deployed '+command,()=>reminders(config,flags,state,command==='scheduler'));
    if(command==='billing') await check('RevenueCat sandbox synchronization/webhook',()=>billing(config,flags,state));
    const result=await report(command,rows);
    console.log(`\n${result.passed} passed; ${result.failed} failed; ${result.skipped} skipped. Report: .backend-test-results/latest.json`);
    if(result.skipped) console.log('INCOMPLETE COVERAGE: skipped integrations have NOT been verified. --strict returns exit code 2 for skips.');
    if(result.failed) process.exitCode=1; else if(flags.has('strict') && result.skipped) process.exitCode=2;
  } catch(error) {
    const detail=safeError(error,config); console.error('FAIL '+detail); process.exitCode=1;
    rows.push({name:'Runner/setup',status:'FAIL',detail}); await report(command,rows).catch(()=>{});
  } finally { await unlock?.(); }
}
// This module is the CLI entrypoint; no tests import it to trigger a run accidentally.
await main();
