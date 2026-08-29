// @ts-check
import {store} from '../state/store.js';
import {todayIso} from '../data.js';
import {listBusinessBookings,addBusinessEvent} from '../services/businesses.js';
import {calendars,addCalendar,inviteMember,team} from '../services/access.js';
import {navigate} from '../router.js';
import {escapeHtml,formData} from '../ui/dom.js';
import {icon} from '../ui/icons.js';
import {page,bindBack,toast,loadingButton} from '../ui/layout.js';

const days=['L','Ma','Mi','J','V','S','D'];

export async function businessHomeScreen(root,anchor=todayIso()){
  const business=store.get().business;const [from,until]=weekBounds(anchor);
  const [bookings,roster]=await Promise.all([listBusinessBookings(business.id,'',from,until),business.is_owner===false?Promise.resolve({members:[]}):team(business.id)]);
  const counts=Array.from({length:7},(_,index)=>bookings.filter(item=>item.date===addDays(from,index)).length);const max=Math.max(1,...counts);
  root.innerHTML=page({title:'Home',nav:'business',active:'home',content:`
    <section class="draw-section draw-section--center"><h1>Scan QR</h1><button class="draw-button" data-route="/business/scan">Scan</button></section>
    <section class="draw-section"><div class="week-heading"><button data-week="-7">${icon('arrow','icon--back')}</button><h1>Reports</h1><button data-week="7">${icon('arrow')}</button></div><p class="week-range">${formatRange(from,until)}</p><div class="draw-chart">${counts.map((count,index)=>`<div><span style="height:${Math.max(4,Math.round(count/max*120))}px"></span><small>${days[index]}<br>${Number(addDays(from,index).slice(8,10))}</small></div>`).join('')}</div><strong class="chart-label">Rezervări</strong></section>
    ${business.is_owner===false?'':`<section class="draw-section"><h1>Invitații</h1><form id="home-invite" class="draw-inline-form"><label>Invită pe cineva<input name="email" type="email" required></label><button class="draw-button">Trimite</button></form></section><section class="draw-section"><h1>Membri</h1><div class="draw-list">${roster.members.map(item=>`<span>${escapeHtml(item.email)}</span>`).join('')}</div></section>`}`});
  bindBack(root);root.querySelectorAll('[data-week]').forEach(button=>button.addEventListener('click',()=>businessHomeScreen(root,addDays(anchor,Number(button.getAttribute('data-week'))))));
  root.querySelector('#home-invite')?.addEventListener('submit',async event=>{event.preventDefault();const form=/** @type {HTMLFormElement} */(event.currentTarget);const button=/** @type {HTMLButtonElement} */(form.querySelector('button'));try{loadingButton(button,true);await inviteMember(business.id,String(new FormData(form).get('email')),'viewer');await businessHomeScreen(root,anchor);}catch(error){loadingButton(button,false);toast(root,error.message,'error');}});
}

export async function businessCalendarScreen(root){
  const business=store.get().business;const list=await calendars(business.id);
  root.innerHTML=page({title:'Alege calendar',nav:'business',active:'calendar',content:`<section class="draw-section"><h1>Adaugă calendar</h1><form id="calendar-add" class="draw-inline-form"><input name="name" aria-label="Nume calendar" required><button class="draw-button">Gata</button></form></section>${list.length?`<section class="draw-section"><h1>Listă calendare</h1><div class="draw-list">${list.map(item=>`<button class="draw-list-row" data-calendar-view="${escapeHtml(item.id)}"><span>${escapeHtml(item.name)}</span>${icon('eye')}</button>`).join('')}</div></section>`:''}`});
  bindBack(root);root.querySelector('#calendar-add')?.addEventListener('submit',async event=>{event.preventDefault();const form=/** @type {HTMLFormElement} */(event.currentTarget);try{await addCalendar(business.id,String(new FormData(form).get('name')));await businessCalendarScreen(root);}catch(error){toast(root,error.message,'error');}});root.querySelectorAll('[data-calendar-view]').forEach(button=>button.addEventListener('click',()=>navigate(`/business/calendar-view?calendar=${button.getAttribute('data-calendar-view')}`)));
}

export async function businessCalendarViewScreen(root){
  const business=store.get().business;const params=routeParams();const calendarId=params.get('calendar')||'';const anchor=params.get('week')||todayIso();const selectedDay=Number(params.get('day')||1);const [from,until]=weekBounds(anchor);const list=await calendars(business.id);const calendar=list.find(item=>item.id===calendarId);if(!calendar){navigate('/business/calendar');return;}const date=addDays(from,selectedDay-1);const bookings=await listBusinessBookings(business.id,calendarId,date,date);
  root.innerHTML=page({title:'',nav:'business',active:'calendar',content:`<section class="calendar-view-head"><div class="week-heading"><button data-view-week="-7">${icon('arrow','icon--back')}</button><h1>${formatRange(from,until)}</h1><button data-view-week="7">${icon('arrow')}</button></div><h2>${escapeHtml(calendar.name)}</h2><div class="weekday-tabs">${days.map((day,index)=>`<button class="${selectedDay===index+1?'is-active':''}" data-day="${index+1}">${day}</button>`).join('')}</div></section><section class="draw-section"><h1>Programări</h1><div class="draw-list">${bookings.map(appointmentRow).join('')}</div></section><button class="draw-fab" data-route="/business/add-event?calendar=${escapeHtml(calendarId)}">${icon('plus')}</button>`});
  bindBack(root);root.querySelectorAll('[data-day]').forEach(button=>button.addEventListener('click',()=>navigate(`/business/calendar-view?calendar=${calendarId}&week=${from}&day=${button.getAttribute('data-day')}`)));root.querySelectorAll('[data-view-week]').forEach(button=>button.addEventListener('click',()=>navigate(`/business/calendar-view?calendar=${calendarId}&week=${addDays(from,Number(button.getAttribute('data-view-week')))}&day=${selectedDay}`)));
}

export async function businessAddEventScreen(root){
  const business=store.get().business;const calendarId=routeParams().get('calendar')||'';const list=await calendars(business.id);if(!list.some(item=>item.id===calendarId)){navigate('/business/calendar');return;}const times=Array.from({length:96},(_,index)=>`${String(Math.floor(index/4)).padStart(2,'0')}:${String(index%4*15).padStart(2,'0')}`);const durations=[[10,'10m'],[20,'20m'],[30,'30m'],[40,'40m'],[50,'50m'],[60,'1h'],[120,'2h'],[180,'3h'],[240,'4h'],[300,'5h'],[360,'6h']];
  root.innerHTML=page({title:'Adaugă tip eveniment',nav:'business',active:'calendar',content:`<form class="draw-form" id="event-add"><label>Tip eveniment<textarea name="name" required></textarea></label><fieldset><legend>Zile</legend><div class="weekday-tabs weekday-tabs--checks">${days.map((day,index)=>`<label><input type="checkbox" name="day-${index+1}"><span>${day}</span></label>`).join('')}</div></fieldset><label>Interval orar<select name="startTime">${times.map(time=>`<option>${time}</option>`).join('')}</select></label><label>Durata<select name="duration">${durations.map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><button class="draw-button">Adaugă</button></form>`});
  bindBack(root);root.querySelector('#event-add')?.addEventListener('submit',async event=>{event.preventDefault();const form=/** @type {HTMLFormElement} */(event.currentTarget);const values=formData(form);const weekdays=days.map((_,index)=>/** @type {HTMLInputElement|null} */(form.querySelector(`[name="day-${index+1}"]`))?.checked?index+1:0).filter(Boolean);try{await addBusinessEvent(business.id,calendarId,{name:String(values.name),weekdays,startTime:String(values.startTime),duration:Number(values.duration)});navigate(`/business/calendar-view?calendar=${calendarId}`);}catch(error){toast(root,error.message,'error');}});
}

export async function reportsScreen(root){return businessHomeScreen(root);}
function appointmentRow(item){return `<article class="draw-appointment"><strong>${escapeHtml(item.time)} - ${escapeHtml(item.endTime||'')}</strong><span>${escapeHtml(item.service)}</span><span>${escapeHtml(item.customer)}</span></article>`;}
function weekBounds(value){const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);const from=date.toISOString().slice(0,10);return[from,addDays(from,6)];}
function addDays(value,count){const date=new Date(`${value}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+count);return date.toISOString().slice(0,10);}
function formatRange(from,until){const fmt=new Intl.DateTimeFormat('ro-RO',{day:'2-digit',month:'short'});return `${fmt.format(new Date(`${from}T12:00:00Z`))} - ${fmt.format(new Date(`${until}T12:00:00Z`))}`;}
function routeParams(){return new URLSearchParams(window.location.hash.split('?')[1]||'');}
