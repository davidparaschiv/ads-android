// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('calendar defaults to the current weekday from the phone clock',async()=>{
  const source=await readFile('src/screens/dashboard.js','utf8');
  assert.match(source,/const phoneDay=new Date\(\)\.getDay\(\)/);
  assert.match(source,/const currentPhoneWeekday=phoneDay===0\?7:phoneDay/);
  assert.match(source,/params\.get\('day'\)\|\|currentPhoneWeekday/);
});

test('customer appointments use the server day cutoff and actual appointment descending order',async()=>{
  const source=await readFile('src/services/bookings.js','utf8');
  assert.match(source,/rpc\('get_server_day_start'\)/);
  assert.match(source,/gte\('start_at',currentDayStart\)\.order\('start_at',\{ascending:false\}\)/);
});

test('pending business requests use the server day cutoff without deleting bookings',async()=>{
  const source=await readFile('src/services/businesses.js','utf8');
  assert.match(source,/listPendingBookingRequests[\s\S]*rpc\('get_server_day_start'\)[\s\S]*gte\('start_at',currentDayStart\)/);
  assert.doesNotMatch(source,/listPendingBookingRequests[\s\S]{0,1200}\.delete\(\)/);
});

test('server day cutoff uses the Romanian calendar date',async()=>{
  const migration=await readFile('supabase/migrations/033_server_day_booking_filters.sql','utf8');
  assert.match(migration,/date_trunc\('day',now\(\) at time zone 'Europe\/Bucharest'\) at time zone 'Europe\/Bucharest'/);
  assert.match(migration,/grant execute on function public\.get_server_day_start\(\) to authenticated/);
});
