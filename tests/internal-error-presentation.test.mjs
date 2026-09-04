// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {errorMessageForUser} from '../src/ui/error-message.js';

test('internal backend errors are hidden while defined application errors stay readable',async()=>{
  assert.equal(errorMessageForUser({code:'25006',message:'cannot execute SELECT FOR UPDATE in a read-only transaction'}),'Error');
  assert.equal(errorMessageForUser({code:'42P01',message:'relation private_table does not exist',details:'internal schema'}),'Error');
  assert.equal(errorMessageForUser(Object.assign(new Error('request failed'),{name:'AuthApiError',status:500})),'Error');
  assert.equal(errorMessageForUser({code:'P0001',message:'Calendarul nu poate fi șters deoarece are programări'}),'Calendarul nu poate fi șters deoarece are programări');
  assert.equal(errorMessageForUser(new Error('Completează toate câmpurile.')),'Completează toate câmpurile.');

  const screenFiles=(await readdir(new URL('../src/screens/',import.meta.url))).filter(name=>name.endsWith('.js'));
  const sources=await Promise.all([
    readFile(new URL('../src/app.js',import.meta.url),'utf8'),
    ...screenFiles.map(name=>readFile(new URL('../src/screens/'+name,import.meta.url),'utf8')),
  ]);
  assert.doesNotMatch(sources.join('\n'),/toast\([^\n]*error\.message|escapeHtml\(error\.message|instanceof Error \? error\.message/);
});

test('migration 036 removes the locking access check from the stable permission reader',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/036_calendar_permissions_read_only_and_safe_errors.sql',import.meta.url),'utf8');
  const body=sql.match(/create or replace function public\.get_calendar_invitee_permissions[\s\S]*?\n\$\$;/)?.[0]||'';
  assert.match(body,/language plpgsql stable/);
  assert.match(body,/private\.owner_access\(v_owner\)/);
  assert.doesNotMatch(body,/require_business_access|for update/i);
});
