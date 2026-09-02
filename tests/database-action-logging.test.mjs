// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationUrl=new URL('../supabase/migrations/024_ui_database_action_logging.sql',import.meta.url);
const loggerUrl=new URL('../src/observability/database-action-log.js',import.meta.url);

async function loadLogger(fixture) {
  const fixtureKey=`databaseLoggerFixture${Math.random().toString(36).slice(2)}`;
  globalThis[fixtureKey]=fixture;
  const result=await build({entryPoints:[fileURLToPath(loggerUrl)],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
    name:'database-logger-fixture',setup(builder){
      builder.onResolve({filter:/\/config\.js$/},()=>({path:'config',namespace:'fixture'}));
      builder.onResolve({filter:/\/api\/supabase\.js$/},()=>({path:'supabase',namespace:'fixture'}));
      builder.onResolve({filter:/\/state\/store\.js$/},()=>({path:'store',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='config'
        ? `export const config=globalThis.${fixtureKey}.config;`
        :args.path==='supabase'?`export const getSupabase=()=>globalThis.${fixtureKey}.client;`
          :`export const store={get:()=>globalThis.${fixtureKey}.state};`}));
    },
  }]});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}

test('database logger schema, enum and 13-day cron retention stay explicit',async()=>{
  const [sql,module]=await Promise.all([readFile(migrationUrl,'utf8'),loadLogger({config:{mode:'demo'},client:null,state:{role:'business'}})]);
  const enumBody=sql.match(/create type public\.logger_action_type as enum \(([\s\S]*?)\);/)?.[1]||'';
  const sqlActions=[...enumBody.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map(match=>match[1]);
  assert.deepEqual(sqlActions.sort(),Object.values(module.DATABASE_ACTIONS).sort());
  assert.match(sql,/create table public\.logger_engine[\s\S]*logged_at timestamptz[\s\S]*message jsonb[\s\S]*user_id uuid[\s\S]*status public\.logger_status[\s\S]*action_type public\.logger_action_type/);
  assert.match(sql,/values\('logger_engine',13\)/);
  assert.match(sql,/where logged_at < now\(\)-make_interval\(days=>v_days\)/);
  assert.match(sql,/jobname='rezerva-logger-engine-purge'/);
  assert.match(sql,/'17 2 \* \* \*'/);
  assert.match(sql,/alter table public\.logger_engine enable row level security/);
  assert.match(sql,/revoke all on public\.logger_engine from public,anon,authenticated/);
  assert.match(sql,/exception when others then[\s\S]*return false/);
});

test('migration 024 stores authenticated events and purges rows using config_purge',async t=>{
  const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
  await db.exec(`create extension pgcrypto; create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to authenticated;`);
  const sql=await readFile(migrationUrl,'utf8');
  const withoutHostedCron=sql.replace(/do \$scheduler\$[\s\S]*?\$scheduler\$;\s*commit;/,'commit;');
  await db.exec(withoutHostedCron);
  const user=randomUUID();
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
  await db.exec('set role authenticated');
  assert.equal((await db.query("select public.write_logger_event('CV_CREATE_NEW_BOOKING_REQUEST','ok','{\"event\":\"completed\"}'::jsonb) result")).rows[0].result,true);
  await assert.rejects(db.query('select * from public.logger_engine'),/permission denied/);
  await db.exec('reset role');
  const row=(await db.query('select user_id,status,action_type,message from public.logger_engine')).rows[0];
  assert.equal(row.user_id,user);assert.equal(row.status,'ok');assert.equal(row.action_type,'CV_CREATE_NEW_BOOKING_REQUEST');
  assert.deepEqual(row.message,{event:'completed'});
  await db.query("update public.logger_engine set logged_at=now()-interval '14 days'");
  assert.equal((await db.query('select private.purge_expired_logger_engine_rows() deleted')).rows[0].deleted,1);
  assert.equal((await db.query('select count(*)::int count from public.logger_engine')).rows[0].count,0);
  assert.equal((await db.query("select retention_days from public.config_purge where target_table='logger_engine'")).rows[0].retention_days,13);
});

test('database logging is fire-and-forget, minimal on success and sanitized on errors',async t=>{
  const calls=[];let release;
  const fixture={config:{mode:'live'},state:{role:'customer'},client:{rpc(name,args){calls.push({name,args});return new Promise(resolve=>{release=resolve;});}}};
  const logger=await loadLogger(fixture);
  const action=logger.DATABASE_ACTIONS.CV_CREATE_NEW_BOOKING_REQUEST;

  const result=await logger.loggedDatabaseAction(action,async()=>({id:'booking'}));
  assert.deepEqual(result,{id:'booking'});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'write_logger_event');
  assert.deepEqual(calls[0].args,{p_action_type:action,p_status:'ok',p_message:{event:'completed'}});
  release?.({data:true,error:null});

  await t.test('the original error is rethrown while the stored copy is redacted',async()=>{
    const failure=Object.assign(new Error('token=super-secret user@example.com +40712345678 RZL-ABCDEF123456'),{
      code:'P0001',details:'Bearer private-value',hint:'password=hidden-value',
    });
    await assert.rejects(logger.loggedDatabaseAction(action,async()=>{throw failure;}),error=>error===failure);
    await new Promise(resolve=>setTimeout(resolve,0));
    const payload=JSON.stringify(calls.at(-1).args);
    assert.doesNotMatch(payload,/super-secret|user@example\.com|40712345678|ABCDEF123456|private-value|hidden-value/);
    assert.match(payload,/REDACTED/);
    assert.equal(calls.at(-1).args.p_status,'error');
  });
  await t.test('even a synchronous logger crash cannot affect success or replace an application error',async()=>{
    fixture.client.rpc=()=>{throw new Error('logger unavailable');};
    assert.equal(await logger.loggedDatabaseAction(action,async()=>42),42);
    const applicationError=new Error('primary operation failed');
    await assert.rejects(logger.loggedDatabaseAction(action,async()=>{throw applicationError;}),error=>error===applicationError);
    await new Promise(resolve=>setTimeout(resolve,0));
  });
});

test('every static UI RPC and direct Supabase service has an explicit logger path',async()=>{
  const module=await loadLogger({config:{mode:'demo'},client:null,state:{role:'business'}});
  const serviceDir=new URL('../src/services/',import.meta.url);
  const files=(await readdir(serviceDir)).filter(name=>name.endsWith('.js'));
  for(const name of files){
    const source=await readFile(new URL(name,serviceDir),'utf8');
    if(/\.from\(|functions\.invoke\(|\.rpc\(/.test(source)){
      assert.match(source,/loggedDatabaseAction\(|export async function rpc/,`${name} has an unlogged database boundary`);
    }
    for(const match of source.matchAll(/\brpc\('([^']+)'/g)){
      assert.ok(module.databaseActionForRpc(match[1],{}),`Missing action type for RPC ${match[1]} in ${name}`);
    }
  }
  assert.equal(module.databaseActionForRpc('set_booking_status',{p_status:'confirmed'}),module.DATABASE_ACTIONS.BV_APPROVE_PENDING_CLIENT_BOOKING_REQUEST);
  assert.equal(module.databaseActionForRpc('set_booking_status',{p_status:'rejected'}),module.DATABASE_ACTIONS.BV_REJECT_PENDING_CLIENT_BOOKING_REQUEST);
  assert.equal(module.databaseActionForRpc('set_team_member',{p_remove:true}),module.DATABASE_ACTIONS.BV_REMOVE_BUSINESS_TEAM_MEMBER_FROM_TEAM);
});
